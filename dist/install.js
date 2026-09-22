import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
const TAG = '--jev-compact';
function unixCommand(cliPath) { return `node ${JSON.stringify(cliPath)} hook --jev-compact`; }
function windowsCommand(cliPath) { return `node "${cliPath.replace(/"/g, '""')}" hook --jev-compact`; }
function ours(entry) {
    return entry.hooks.some((hook) => (typeof hook.command === 'string' && hook.command.includes(TAG)) ||
        (typeof hook.commandWindows === 'string' && hook.commandWindows.includes(TAG)));
}
function commandHook(command, commandWindows, extra = {}) {
    return { type: 'command', command, commandWindows, ...extra };
}
export async function installHooks(cliPath, env = process.env) {
    const path = env.CODEX_HOOKS_FILE ?? join(homedir(), '.codex', 'hooks.json');
    let config = {};
    let existed = false;
    try {
        config = JSON.parse(await readFile(path, 'utf8'));
        existed = true;
    }
    catch { }
    const before = JSON.stringify(config);
    config.hooks ??= {};
    const resolved = resolve(cliPath);
    const command = unixCommand(resolved);
    const commandWindows = windowsCommand(resolved);
    const add = (name, entry) => {
        const list = config.hooks[name] ?? [];
        config.hooks[name] = [...list.filter((candidate) => !ours(candidate)), entry];
    };
    add('PreCompact', { matcher: 'manual|auto', hooks: [commandHook(command, commandWindows, { timeout: 120, statusMessage: 'Selecting retained context with Jev' })] });
    add('PostCompact', { matcher: 'manual|auto', hooks: [commandHook(command, commandWindows, { timeout: 10 })] });
    add('SessionStart', { matcher: 'compact', hooks: [commandHook(command, commandWindows, { timeout: 10, additionalContextLimit: 65536, statusMessage: 'Restoring Jev-retained context' })] });
    add('UserPromptSubmit', { hooks: [commandHook(command, commandWindows, { timeout: 10, additionalContextLimit: 65536 })] });
    if (JSON.stringify(config) === before)
        return path;
    await mkdir(dirname(path), { recursive: true });
    if (existed)
        await copyFile(path, `${path}.bak.${Date.now()}`);
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return path;
}
export async function uninstallHooks(env = process.env) {
    const path = env.CODEX_HOOKS_FILE ?? join(homedir(), '.codex', 'hooks.json');
    let config = {};
    try {
        config = JSON.parse(await readFile(path, 'utf8'));
    }
    catch {
        return path;
    }
    if (config.hooks)
        for (const key of Object.keys(config.hooks))
            config.hooks[key] = (config.hooks[key] ?? []).filter((entry) => !ours(entry));
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return path;
}
