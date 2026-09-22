import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
const TAG = 'codex-jev-compact';
function command(cliPath) { return `node ${JSON.stringify(cliPath)} hook --codex-jev-compact`; }
function ours(entry) { return entry.hooks.some((h) => (typeof h.command === 'string' && h.command.includes(TAG)) || (typeof h.commandWindows === 'string' && h.commandWindows.includes(TAG))); }
function commandHook(cmd, extra = {}) {
    return { type: 'command', command: cmd, commandWindows: cmd, ...extra };
}
export async function installHooks(cliPath, env = process.env) {
    const path = env.CODEX_HOOKS_FILE ?? join(homedir(), '.codex', 'hooks.json');
    let config = {};
    try {
        config = JSON.parse(await readFile(path, 'utf8'));
    }
    catch { }
    if (await fileExists(path))
        await copyFile(path, `${path}.bak.${Date.now()}`);
    config.hooks ??= {};
    const cmd = command(resolve(cliPath));
    const add = (name, entry) => {
        const list = config.hooks[name] ?? [];
        config.hooks[name] = [...list.filter((x) => !ours(x)), entry];
    };
    add('PreCompact', { matcher: 'manual|auto', hooks: [commandHook(cmd, { timeout: 120, statusMessage: 'Selecting retained context with Jev' })] });
    add('PostCompact', { matcher: 'manual|auto', hooks: [commandHook(cmd, { timeout: 10 })] });
    add('SessionStart', { matcher: 'compact', hooks: [commandHook(cmd, { timeout: 10, additionalContextLimit: 65536, statusMessage: 'Restoring Jev-retained context' })] });
    add('UserPromptSubmit', { hooks: [commandHook(cmd, { timeout: 10, additionalContextLimit: 65536 })] });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return path;
}
export async function uninstallHooks(env = process.env) {
    const path = env.CODEX_HOOKS_FILE ?? join(homedir(), '.codex', 'hooks.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    if (config.hooks)
        for (const key of Object.keys(config.hooks))
            config.hooks[key] = (config.hooks[key] ?? []).filter((x) => !ours(x));
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return path;
}
async function fileExists(path) { try {
    await readFile(path, 'utf8');
    return true;
}
catch {
    return false;
} }
