import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

interface HookEntry { matcher?: string; hooks: Array<Record<string, unknown>> }
interface HookConfig { description?: string; hooks?: Record<string, HookEntry[]>; [key: string]: unknown }
const TAG = '--jev-compact';

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : undefined;
}

async function loadHookConfig(path: string): Promise<{ config: HookConfig; existed: boolean }> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return { config: {}, existed: false };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new Error(`Cannot update ${path}: existing hooks file is invalid JSON (${error instanceof Error ? error.message : String(error)})`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Cannot update ${path}: existing hooks file must contain a JSON object`);
  return { config: parsed as HookConfig, existed: true };
}

function unixCommand(cliPath: string): string { return `node ${JSON.stringify(cliPath)} hook --jev-compact`; }
function windowsCommand(cliPath: string): string { return `node "${cliPath.replace(/"/g, '""')}" hook --jev-compact`; }
function ours(entry: HookEntry): boolean {
  return entry.hooks.some((hook) =>
    (typeof hook.command === 'string' && hook.command.includes(TAG)) ||
    (typeof hook.commandWindows === 'string' && hook.commandWindows.includes(TAG)));
}


export function runtimeDir(env = process.env): string {
  return env.JEV_COMPACT_RUNTIME_DIR ?? join(homedir(), '.codex', 'jev-compact', 'runtime');
}

/** Copy the compiled runtime to a stable location so setup does not depend on the extracted checkout. */
export async function installRuntime(cliPath: string, env = process.env): Promise<string> {
  const sourceDist = dirname(resolve(cliPath));
  const root = runtimeDir(env);
  const target = join(root, 'dist');
  if (resolve(sourceDist) === resolve(target)) return join(target, 'cli.js');
  const staging = join(root, `.dist.${process.pid}.tmp`);
  const backup = join(root, `.dist.${process.pid}.bak`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await rm(staging, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await cp(sourceDist, staging, { recursive: true, force: true });
  let hadTarget = false;
  try { await rename(target, backup); hadTarget = true; }
  catch (error) { if (errorCode(error) !== 'ENOENT') { await rm(staging, { recursive: true, force: true }); throw error; } }
  try { await rename(staging, target); }
  catch (error) {
    if (hadTarget) { try { await rename(backup, target); } catch {} }
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  if (hadTarget) await rm(backup, { recursive: true, force: true });
  return join(target, 'cli.js');
}
export async function inspectHooks(env = process.env): Promise<{ path: string; installed: boolean; events: string[] }> {
  const path = env.CODEX_HOOKS_FILE ?? join(homedir(), '.codex', 'hooks.json');
  let config: HookConfig;
  try { ({ config } = await loadHookConfig(path)); } catch { return { path, installed: false, events: [] }; }
  const events = Object.entries(config.hooks ?? {})
    .filter(([, entries]) => (entries ?? []).some((entry) => ours(entry)))
    .map(([name]) => name)
    .sort();
  const required = ['PostCompact', 'PreCompact', 'SessionStart', 'UserPromptSubmit'];
  return { path, installed: required.every((event) => events.includes(event)), events };
}

function commandHook(command: string, commandWindows: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'command', command, commandWindows, ...extra };
}

export async function installHooks(cliPath: string, env = process.env): Promise<string> {
  const path = env.CODEX_HOOKS_FILE ?? join(homedir(), '.codex', 'hooks.json');
  const { config, existed } = await loadHookConfig(path);
  const before = JSON.stringify(config);
  config.hooks ??= {};
  const resolved = resolve(cliPath);
  const command = unixCommand(resolved);
  const commandWindows = windowsCommand(resolved);
  const add = (name: string, entry: HookEntry) => {
    const list = config.hooks![name] ?? [];
    config.hooks![name] = [...list.filter((candidate) => !ours(candidate)), entry];
  };
  add('PreCompact', { matcher: 'manual|auto', hooks: [commandHook(command, commandWindows, { timeout: 120, statusMessage: 'Selecting retained context with Jev' })] });
  add('PostCompact', { matcher: 'manual|auto', hooks: [commandHook(command, commandWindows, { timeout: 10 })] });
  add('SessionStart', { matcher: 'compact', hooks: [commandHook(command, commandWindows, { timeout: 10, additionalContextLimit: 0, statusMessage: 'Restoring Jev-retained context' })] });
  add('UserPromptSubmit', { hooks: [commandHook(command, commandWindows, { timeout: 10, additionalContextLimit: 0 })] });
  if (JSON.stringify(config) === before) return path;
  await mkdir(dirname(path), { recursive: true });
  if (existed) await copyFile(path, `${path}.bak.${Date.now()}`);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function uninstallHooks(env = process.env): Promise<string> {
  const path = env.CODEX_HOOKS_FILE ?? join(homedir(), '.codex', 'hooks.json');
  let loaded: { config: HookConfig; existed: boolean };
  try { loaded = await loadHookConfig(path); } catch (error) { throw error; }
  if (!loaded.existed) return path;
  const { config } = loaded;
  const before = JSON.stringify(config);
  if (config.hooks) for (const key of Object.keys(config.hooks)) config.hooks[key] = (config.hooks[key] ?? []).filter((entry) => !ours(entry));
  if (JSON.stringify(config) === before) return path;
  await copyFile(path, `${path}.bak.${Date.now()}`);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}
