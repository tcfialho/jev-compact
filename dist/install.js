import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { LEGACY_HOOK_TAG } from './legacy.js';
const TAGS = ['--jevcomp', LEGACY_HOOK_TAG];
function errorCode(error) {
    return error && typeof error === 'object' && 'code' in error ? String(error.code ?? '') : undefined;
}
async function loadHookConfig(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return { config: {}, existed: false };
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw new Error(`Cannot update ${path}: existing hooks file is invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error(`Cannot update ${path}: existing hooks file must contain a JSON object`);
    return { config: parsed, existed: true };
}
function unixCommand(cliPath) { return `node ${JSON.stringify(cliPath)} hook --jevcomp`; }
function windowsCommand(cliPath) { return `node "${cliPath.replace(/"/g, '""')}" hook --jevcomp`; }
function oursHook(hook) {
    return (TAGS.some((tag) => typeof hook.command === 'string' && hook.command.includes(tag)) ||
        TAGS.some((tag) => typeof hook.commandWindows === 'string' && hook.commandWindows.includes(tag)));
}
function ours(entry) { return entry.hooks.some(oursHook); }
function withoutOurs(entry) {
    const hooks = entry.hooks.filter((hook) => !oursHook(hook));
    return hooks.length ? { ...entry, hooks } : undefined;
}
function codexHome(env) { return env.CODEX_HOME ?? join(homedir(), '.codex'); }
export function runtimeDir(env = process.env) {
    return env.JEVCOMP_RUNTIME_DIR ?? join(codexHome(env), 'jevcomp', 'runtime');
}
/** Copy the compiled runtime to a stable location so setup does not depend on the extracted checkout. */
export async function installRuntime(cliPath, env = process.env) {
    const sourceDist = dirname(resolve(cliPath));
    const root = runtimeDir(env);
    const target = join(root, 'dist');
    if (resolve(sourceDist) === resolve(target))
        return join(target, 'cli.js');
    const staging = join(root, `.dist.${process.pid}.tmp`);
    const backup = join(root, `.dist.${process.pid}.bak`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await rm(staging, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
    await cp(sourceDist, staging, { recursive: true, force: true });
    let hadTarget = false;
    try {
        await rename(target, backup);
        hadTarget = true;
    }
    catch (error) {
        if (errorCode(error) !== 'ENOENT') {
            await rm(staging, { recursive: true, force: true });
            throw error;
        }
    }
    try {
        await rename(staging, target);
    }
    catch (error) {
        if (hadTarget) {
            try {
                await rename(backup, target);
            }
            catch { }
        }
        await rm(staging, { recursive: true, force: true });
        throw error;
    }
    if (hadTarget)
        await rm(backup, { recursive: true, force: true });
    return join(target, 'cli.js');
}
export async function inspectHooks(env = process.env) {
    const path = env.CODEX_HOOKS_FILE ?? join(codexHome(env), 'hooks.json');
    let config;
    try {
        ({ config } = await loadHookConfig(path));
    }
    catch {
        return { path, installed: false, events: [] };
    }
    const events = Object.entries(config.hooks ?? {})
        .filter(([, entries]) => (entries ?? []).some((entry) => ours(entry)))
        .map(([name]) => name)
        .sort();
    const required = ['PostCompact', 'PreCompact', 'SessionStart', 'UserPromptSubmit'];
    return { path, installed: required.every((event) => events.includes(event)), events };
}
function commandHook(command, commandWindows, extra = {}) {
    return { type: 'command', command, commandWindows, ...extra };
}
export async function installHooks(cliPath, env = process.env) {
    const path = env.CODEX_HOOKS_FILE ?? join(codexHome(env), 'hooks.json');
    const { config, existed } = await loadHookConfig(path);
    const before = JSON.stringify(config);
    config.hooks ??= {};
    const resolved = resolve(cliPath);
    const command = unixCommand(resolved);
    const commandWindows = windowsCommand(resolved);
    const add = (name, entry) => {
        const list = config.hooks[name] ?? [];
        config.hooks[name] = [...list.map(withoutOurs).filter((candidate) => candidate !== undefined), entry];
    };
    add('PreCompact', { matcher: 'manual|auto', hooks: [commandHook(command, commandWindows, { timeout: 120, statusMessage: 'Selecting retained context with Jev' })] });
    add('PostCompact', { matcher: 'manual|auto', hooks: [commandHook(command, commandWindows, { timeout: 10 })] });
    add('SessionStart', { matcher: 'startup|resume|clear|compact', hooks: [commandHook(command, commandWindows, { timeout: 10, additionalContextLimit: 0, statusMessage: 'Loading jevcomp' })] });
    add('UserPromptSubmit', { hooks: [commandHook(command, commandWindows, { timeout: 10, additionalContextLimit: 0 })] });
    if (JSON.stringify(config) === before)
        return path;
    await mkdir(dirname(path), { recursive: true });
    if (existed)
        await copyFile(path, `${path}.bak.${Date.now()}`);
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return path;
}
export async function uninstallHooks(env = process.env) {
    const path = env.CODEX_HOOKS_FILE ?? join(codexHome(env), 'hooks.json');
    let loaded;
    try {
        loaded = await loadHookConfig(path);
    }
    catch (error) {
        throw error;
    }
    if (!loaded.existed)
        return path;
    const { config } = loaded;
    const before = JSON.stringify(config);
    if (config.hooks)
        for (const key of Object.keys(config.hooks))
            config.hooks[key] = (config.hooks[key] ?? []).map(withoutOurs).filter((entry) => entry !== undefined);
    if (JSON.stringify(config) === before)
        return path;
    await copyFile(path, `${path}.bak.${Date.now()}`);
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return path;
}
