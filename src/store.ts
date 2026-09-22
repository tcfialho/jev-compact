import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CallDecision, CompactStats, Message } from './types.js';

export interface SessionState {
  version: 1;
  sessionId: string;
  turnId?: string;
  trigger?: string;
  model?: string;
  createdAt: string;
  ready: boolean;
  consumed: boolean;
  contextFile: string;
  messagesFile?: string;
  index: string;
  contextChars: number;
  stats: CompactStats;
  decisions: CallDecision[];
}

export interface HistoryRow {
  at: string;
  sessionId: string;
  turnId?: string;
  trigger?: string;
  model?: string;
  provider?: string;
  status: 'prepared' | 'ready' | 'restored' | 'skipped' | 'failed';
  stats?: CompactStats;
  decisions?: CallDecision[];
  detail?: string;
  injectedChars?: number;
  injectedPayloadChars?: number;
  retainedChars?: number;
}

function safe(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180); }
export function dataDir(env = process.env): string { return env.PLUGIN_DATA ?? env.JEV_COMPACT_DATA_DIR ?? join(homedir(), '.codex', 'jev-compact'); }
export function statePath(sessionId: string, env = process.env): string { return join(dataDir(env), 'sessions', `${safe(sessionId)}.json`); }
export function contextPath(sessionId: string, env = process.env): string { return join(dataDir(env), 'sessions', `${safe(sessionId)}.context.txt`); }
export function messagesPath(sessionId: string, env = process.env): string { return join(dataDir(env), 'sessions', `${safe(sessionId)}.messages.json`); }
export function historyPath(env = process.env): string { return join(dataDir(env), 'history.jsonl'); }

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}

export async function prepareState(
  state: Omit<SessionState, 'version' | 'ready' | 'consumed' | 'contextFile' | 'contextChars' | 'messagesFile'>,
  context: string,
  env = process.env,
  messages?: readonly Message[],
): Promise<SessionState> {
  const cp = contextPath(state.sessionId, env);
  const mp = messages?.length ? messagesPath(state.sessionId, env) : undefined;
  const full: SessionState = {
    version: 1,
    ...state,
    ready: false,
    consumed: false,
    contextFile: cp,
    ...(mp ? { messagesFile: mp } : {}),
    contextChars: context.length,
  };
  const archiveWrites = [atomicWrite(cp, context)];
  if (mp) archiveWrites.push(atomicWrite(mp, `${JSON.stringify(messages)}\n`));
  // Publish the state only after both archives are durable; archive writes are independent.
  await Promise.all(archiveWrites);
  await atomicWrite(statePath(state.sessionId, env), JSON.stringify(full));
  return full;
}

export async function discardPendingState(sessionId: string, env = process.env): Promise<void> {
  try { await rm(statePath(sessionId, env), { force: true }); } catch {}
}

export async function readState(sessionId: string, env = process.env): Promise<SessionState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(statePath(sessionId, env), 'utf8')) as SessionState;
    return parsed?.version === 1 ? parsed : undefined;
  } catch { return undefined; }
}


function validReadyState(parsed: SessionState, ttlMs: number): boolean {
  const age = Date.now() - Date.parse(parsed.createdAt);
  return parsed.version === 1 && parsed.ready && !parsed.consumed && Number.isFinite(age) && age >= 0 && age <= ttlMs;
}

export async function peekReady(sessionId: string, ttlMs: number, env = process.env): Promise<SessionState | undefined> {
  const state = await readState(sessionId, env);
  return state && validReadyState(state, ttlMs) ? state : undefined;
}

export async function markReady(sessionId: string, turnId?: string, env = process.env): Promise<SessionState | undefined> {
  const state = await readState(sessionId, env);
  if (!state || (state.turnId && turnId && state.turnId !== turnId)) return undefined;
  const next = { ...state, ready: true };
  await atomicWrite(statePath(sessionId, env), JSON.stringify(next));
  return next;
}

export async function claimReady(sessionId: string, ttlMs: number, env = process.env, expectedCreatedAt?: string): Promise<SessionState | undefined> {
  const path = statePath(sessionId, env);
  const claim = `${path}.${process.pid}.claim`;
  try { await rename(path, claim); } catch { return undefined; }
  let state: SessionState | undefined;
  try {
    const parsed = JSON.parse(await readFile(claim, 'utf8')) as SessionState;
    if (validReadyState(parsed, ttlMs) && (!expectedCreatedAt || parsed.createdAt === expectedCreatedAt)) state = parsed;
    const next = { ...parsed, consumed: !!state || parsed.consumed };
    await atomicWrite(path, JSON.stringify(next));
  } catch {
    try { await rename(claim, path); } catch {}
    return undefined;
  }
  try { await rm(claim, { force: true }); } catch {}
  return state;
}

/** Best-effort cleanup of stale per-session sidecars. History is intentionally retained. */
export async function sweep(env = process.env, maxAgeMs = 48 * 60 * 60 * 1000): Promise<number> {
  const dir = join(dataDir(env), 'sessions');
  const cutoff = Date.now() - Math.max(0, maxAgeMs);
  let removed = 0;
  let names: string[];
  try { names = await readdir(dir); } catch { return 0; }
  for (const name of names) {
    if (!/\.(?:json|txt|claim)$/.test(name)) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.mtimeMs < cutoff) { await rm(path, { force: true }); removed++; }
    } catch {}
  }
  return removed;
}

export async function appendHistory(row: HistoryRow, env = process.env): Promise<void> {
  const path = historyPath(env);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

/** History is observability only; hook correctness must never depend on this write succeeding. */
export async function tryAppendHistory(row: HistoryRow, env = process.env): Promise<boolean> {
  try { await appendHistory(row, env); return true; } catch { return false; }
}

export async function readHistory(env = process.env): Promise<HistoryRow[]> {
  try {
    return (await readFile(historyPath(env), 'utf8')).split(/\r?\n/).filter(Boolean).flatMap((line: string) => {
      try { return [JSON.parse(line) as HistoryRow]; } catch { return []; }
    });
  } catch { return []; }
}
