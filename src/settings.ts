import { readFileSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configDir, type Env } from './provider.js';

export type RestoreMode = 'preserve' | 'balanced' | 'minimal';
export type SettingName = 'restore-mode' | 'restore-max-chars' | 'pin-recent-messages' | 'loss-threshold' | 'min-reduction-ratio';

interface SavedSettings {
  restoreMode?: RestoreMode;
  restoreMaxChars?: number;
  pinRecentMessages?: number;
  lossThreshold?: number;
  minReductionRatio?: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeSavedSettings(value: unknown): SavedSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const restoreMode = typeof record.restoreMode === 'string' ? normalizedMode(record.restoreMode) : undefined;
  const restoreMaxChars = finiteNumber(record.restoreMaxChars);
  const pinRecentMessages = finiteNumber(record.pinRecentMessages);
  const lossThreshold = finiteNumber(record.lossThreshold);
  const minReductionRatio = finiteNumber(record.minReductionRatio);
  return {
    ...(restoreMode ? { restoreMode } : {}),
    ...(restoreMaxChars !== undefined && restoreMaxChars >= 0 ? { restoreMaxChars: Math.floor(restoreMaxChars) } : {}),
    ...(pinRecentMessages !== undefined && pinRecentMessages >= 0 ? { pinRecentMessages: Math.floor(pinRecentMessages) } : {}),
    ...(lossThreshold !== undefined && lossThreshold >= 0 && lossThreshold <= 1 ? { lossThreshold } : {}),
    ...(minReductionRatio !== undefined && minReductionRatio >= 0 && minReductionRatio <= 1 ? { minReductionRatio } : {}),
  };
}

export interface UserSettings {
  restoreMode: RestoreMode;
  restoreModeWarning?: string;
  restoreMaxChars: number;
  pinRecentMessages: number;
  lossThreshold: number;
  minReductionRatio: number;
}

export function settingsPath(env: Env = process.env): string {
  return env.JEV_COMPACT_SETTINGS_FILE ?? join(configDir(env), 'settings.json');
}

function saved(env: Env): SavedSettings {
  try {
    return sanitizeSavedSettings(JSON.parse(String(readFileSync(settingsPath(env), 'utf8'))));
  } catch { return {}; }
}

function envNumber(env: Env, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function normalizedMode(value: string | undefined): RestoreMode | undefined {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'preserve' || v === 'full') return 'preserve';
  if (v === 'balanced' || v === 'hybrid') return 'balanced';
  if (v === 'minimal' || v === 'index') return 'minimal';
  return undefined;
}

export function userSettings(env: Env = process.env): UserSettings {
  const stored = saved(env);
  const rawMode = env.JEV_COMPACT_RESTORE_MODE;
  const modeFromEnv = normalizedMode(rawMode);
  const mode = modeFromEnv ?? stored.restoreMode ?? 'preserve';
  const rawModeNormalized = (rawMode ?? '').trim().toLowerCase();
  const restoreModeWarning = rawMode !== undefined && rawModeNormalized !== '' && !modeFromEnv
    ? `unknown restore mode ${JSON.stringify(rawModeNormalized)}; using ${stored.restoreMode ?? 'preserve'}`
    : undefined;
  const restoreMax = envNumber(env, ['JEV_COMPACT_RESTORE_MAX_CHARS', 'JEV_COMPACT_CONTEXT_CHARS']) ?? stored.restoreMaxChars ?? 60_000;
  const pinRecent = envNumber(env, ['JEV_COMPACT_PIN_RECENT_MESSAGES', 'JEV_COMPACT_PRESERVE_RECENT']) ?? stored.pinRecentMessages ?? 6;
  const loss = envNumber(env, ['JEV_COMPACT_LOSS_THRESHOLD', 'JEV_COMPACT_KEEP_THRESHOLD']) ?? stored.lossThreshold ?? 0.5;
  const minReduction = envNumber(env, ['JEV_COMPACT_MIN_REDUCTION_RATIO', 'JEV_COMPACT_MIN_REDUCTION']) ?? stored.minReductionRatio ?? 0.15;
  return {
    restoreMode: mode,
    restoreModeWarning,
    restoreMaxChars: Math.max(0, Math.floor(restoreMax)),
    pinRecentMessages: Math.max(0, Math.floor(pinRecent)),
    lossThreshold: Math.min(1, Math.max(0, loss)),
    minReductionRatio: Math.min(1, Math.max(0, minReduction)),
  };
}

export async function setUserSetting(name: SettingName, rawValue: string, env: Env = process.env): Promise<UserSettings> {
  const current = saved(env);
  if (name === 'restore-mode') {
    const mode = normalizedMode(rawValue);
    if (!mode) throw new Error('restore-mode must be preserve, balanced, or minimal');
    current.restoreMode = mode;
  } else if (name === 'restore-max-chars' || name === 'pin-recent-messages') {
    const n = Number(rawValue);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) throw new Error(`${name} must be a non-negative integer`);
    if (name === 'restore-max-chars') current.restoreMaxChars = n;
    else current.pinRecentMessages = n;
  } else {
    const n = Number(rawValue);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${name} must be between 0 and 1`);
    if (name === 'loss-threshold') current.lossThreshold = n;
    else current.minReductionRatio = n;
  }
  const path = settingsPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  try { await chmod(path, 0o600); } catch {}
  return userSettings(env);
}

export async function resetUserSettings(env: Env = process.env): Promise<void> {
  await rm(settingsPath(env), { force: true });
}
