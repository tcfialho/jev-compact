import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

interface HookEntry { matcher?: string; hooks: Array<Record<string, unknown>> }
interface HookConfig { description?: string; hooks?: Record<string, HookEntry[]>; [key: string]: unknown }
const TAG = 'jev-compact';

function unixCommand(cliPath: string): string { return `node ${JSON.stringify(cliPath)} hook --jev-compact`; }
function windowsCommand(cliPath: string): string { return `node "${cliPath.replace(/"/g, '""')}" hook --jev-compact`; }
function ours(entry: HookEntry): boolean {
  return entry.hooks.some((hook) =>
    (typeof hook.command === 'string' && hook.command.includes(TAG)) ||
    (typeof hook.commandWindows === 'string' && hook.commandWindows.includes(TAG)));
}

function commandHook(command: string, commandWindows: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'command', command, commandWindows, ...extra };
}

export async function installHooks(cliPath: string, env = process.env): Promise<string> {
  const path = env.CODEX_HOOKS_FILE ?? join(homedir(), '.codex', 'hooks.json');
  let config: HookConfig = {};
  try { config = JSON.parse(await readFile(path, 'utf8')) as HookConfig; } catch {}
  if (await fileExists(path)) await copyFile(path, `${path}.bak.${Date.now()}`);
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
  add('SessionStart', { matcher: 'compact', hooks: [commandHook(command, commandWindows, { timeout: 10, additionalContextLimit: 65536, statusMessage: 'Restoring Jev-retained context' })] });
  add('UserPromptSubmit', { hooks: [commandHook(command, commandWindows, { timeout: 10, additionalContextLimit: 65536 })] });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function uninstallHooks(env = process.env): Promise<string> {
  const path = env.CODEX_HOOKS_FILE ?? join(homedir(), '.codex', 'hooks.json');
  let config: HookConfig = {};
  try { config = JSON.parse(await readFile(path, 'utf8')) as HookConfig; } catch { return path; }
  if (config.hooks) for (const key of Object.keys(config.hooks)) config.hooks[key] = (config.hooks[key] ?? []).filter((entry) => !ours(entry));
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function fileExists(path: string): Promise<boolean> { try { await readFile(path, 'utf8'); return true; } catch { return false; } }
