import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type Env = Record<string, string | undefined>;

function codexHome(env: Env): string { return resolve(env.CODEX_HOME ?? join(homedir(), '.codex')); }
function pluginCacheRoot(env: Env): string { return join(codexHome(env), 'plugins', 'cache'); }

function runningPluginRoot(env: Env): string | undefined {
  const relativeModule = relative(pluginCacheRoot(env), fileURLToPath(import.meta.url));
  if (isAbsolute(relativeModule)) return undefined;
  const parts = relativeModule.split(sep);
  if (parts.length !== 5 || parts[0] === '..' || parts[1] !== 'jevcomp' || parts[3] !== 'dist') return undefined;
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  return existsSync(join(root, 'hooks', 'hooks.json')) ? root : undefined;
}

function cachedPluginRoot(env: Env): string | undefined {
  try {
    for (const marketplace of readdirSync(pluginCacheRoot(env))) {
      const versions = join(pluginCacheRoot(env), marketplace, 'jevcomp');
      if (!existsSync(versions)) continue;
      for (const version of readdirSync(versions).sort((left: string, right: string) => right.localeCompare(left, undefined, { numeric: true }))) {
        const root = join(versions, version);
        if (existsSync(join(root, 'hooks', 'hooks.json'))) return root;
      }
    }
  } catch {}
  return undefined;
}

const detectedRoots = new Map<string, string | null>();

export function enabledPluginRoot(env: Env = process.env): string | undefined {
  const currentRoot = runningPluginRoot(env);
  if (currentRoot) return currentRoot;
  const home = codexHome(env);
  if (detectedRoots.has(home)) return detectedRoots.get(home) ?? undefined;
  detectedRoots.set(home, null);
  if (!existsSync(home)) return undefined;
  try {
    const output = execFileSync('codex', ['plugin', 'list', '--json'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 2_000_000,
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, CODEX_HOME: home },
    });
    const installed = JSON.parse(output).installed as Array<{ name: string; marketplaceName: string; version: string; enabled: boolean }>;
    for (const plugin of installed ?? []) {
      if (plugin.name !== 'jevcomp' || !plugin.enabled) continue;
      if (![plugin.marketplaceName, plugin.name, plugin.version].every((part) => /^[\w.+-]+$/.test(part))) continue;
      const root = join(pluginCacheRoot(env), plugin.marketplaceName, plugin.name, plugin.version);
      if (existsSync(join(root, 'hooks', 'hooks.json'))) {
        detectedRoots.set(home, root);
        return root;
      }
    }
  } catch {
    const root = cachedPluginRoot(env);
    detectedRoots.set(home, root ?? null);
    return root;
  }
  return undefined;
}

export function enabledPluginDataDir(env: Env = process.env): string | undefined {
  const root = enabledPluginRoot(env);
  if (!root) return undefined;
  const relativeRoot = relative(pluginCacheRoot(env), root);
  if (isAbsolute(relativeRoot)) return undefined;
  const parts = relativeRoot.split(sep);
  if (parts.length !== 3 || parts[0] === '..' || parts[1] !== 'jevcomp') return undefined;
  return join(codexHome(env), 'plugins', 'data', `${parts[1]}-${parts[0]}`);
}
