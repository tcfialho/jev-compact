import { cpSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

export const LEGACY_NAME = 'jev-compact';
export const LEGACY_HOOK_TAG = `--${LEGACY_NAME}`;
export const LEGACY_DASHBOARD_SERVICE = `${LEGACY_NAME}-dashboard`;

/** Honors settings saved under the old JEV_COMPACT_* names unless the JEVCOMP_* name is set. */
export function adoptLegacyEnvironment(env: Env): void {
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('JEV_COMPACT_')) continue;
    const current = `JEVCOMP_${name.slice('JEV_COMPACT_'.length)}`;
    if (env[current] === undefined) env[current] = value;
  }
}

/** Copies the saved key, provider and settings once, leaving the old folder in place. */
export function migrateLegacyConfig(env: Env): void {
  if (env.JEVCOMP_CONFIG_DIR) return;
  const current = join(homedir(), '.config', 'jevcomp');
  const legacy = join(homedir(), '.config', LEGACY_NAME);
  if (existsSync(current) || !existsSync(legacy)) return;
  try { cpSync(legacy, current, { recursive: true, errorOnExist: false }); } catch {}
}

export function legacyHistoryPaths(env: Env): string[] {
  const codexHome = env.CODEX_HOME ?? join(homedir(), '.codex');
  return [
    join(codexHome, LEGACY_NAME, 'history.jsonl'),
    join(codexHome, 'plugins', 'data', `${LEGACY_NAME}-${LEGACY_NAME}`, 'history.jsonl'),
  ];
}
