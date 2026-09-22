import { readFile } from 'node:fs/promises';
import { compactMessages, reductionRatio } from './compact.js';
import { providerConfig, resolveProvider, type JevProvider } from './provider.js';
import { userSettings } from './settings.js';
import { loadCodexRollout } from './rollout.js';
import { capContext, renderIndex, renderMessages, renderMessagesForInjection } from './render.js';
import { claimReady, discardPendingState, markReady, peekReady, prepareState, sweep, tryAppendHistory } from './store.js';
import type { Message } from './types.js';

interface HookInput {
  session_id: string;
  turn_id?: string;
  transcript_path?: string | null;
  hook_event_name: string;
  source?: string;
  trigger?: string;
  model?: string;
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function numAny(env: Record<string, string | undefined>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}


function parseInput(value: unknown): HookInput {
  if (!value || typeof value !== 'object') throw new Error('invalid hook input');
  const v = value as Record<string, unknown>;
  if (typeof v.session_id !== 'string' || typeof v.hook_event_name !== 'string') throw new Error('invalid hook input');
  return {
    session_id: v.session_id,
    hook_event_name: v.hook_event_name,
    turn_id: typeof v.turn_id === 'string' ? v.turn_id : undefined,
    transcript_path: typeof v.transcript_path === 'string' || v.transcript_path === null ? v.transcript_path : undefined,
    source: typeof v.source === 'string' ? v.source : undefined,
    trigger: typeof v.trigger === 'string' ? v.trigger : undefined,
    model: typeof v.model === 'string' ? v.model : undefined,
  };
}

function requestedProvider(env: Record<string, string | undefined>): JevProvider | undefined {
  const value = env.JEV_COMPACT_PROVIDER;
  return value === 'typesafe' || value === 'openrouter' || value === 'auto' ? value : undefined;
}

function providerName(env: Record<string, string | undefined>): string {
  return resolveProvider({ provider: requestedProvider(env), env });
}

async function injectableArchive(messagesFile: string | undefined, contextFile: string): Promise<string> {
  if (messagesFile) {
    try {
      const messages = JSON.parse(await readFile(messagesFile, 'utf8')) as Message[];
      if (Array.isArray(messages)) return renderMessagesForInjection(messages);
    } catch {}
  }
  return readFile(contextFile, 'utf8');
}

async function restore(input: HookInput, event: 'SessionStart' | 'UserPromptSubmit', env: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const ttl = Math.max(0, num(env, 'JEV_COMPACT_RESTORE_TTL_MS', 86_400_000));
  const preview = await peekReady(input.session_id, ttl, env);
  if (!preview) return { continue: true, suppressOutput: true };

  const settings = userSettings(env);
  const mode = settings.restoreMode;
  const cap = settings.restoreMaxChars;
  let payload: string;
  try {
    payload = preview.index;
    if (mode === 'preserve') payload = await injectableArchive(preview.messagesFile, preview.contextFile);
    else if (mode === 'balanced') payload = `${preview.index}\n\nSelected evidence excerpt:\n${capContext(await injectableArchive(preview.messagesFile, preview.contextFile), 12_000)}`;
    // A single setting now means one thing in every mode: maximum evidence payload.
    if (cap > 0) payload = capContext(payload, cap);
  } catch (error) {
    await tryAppendHistory({ at: new Date().toISOString(), runId: preview.runId ?? preview.createdAt, sessionId: input.session_id, turnId: input.turn_id, phase: 'restore', status: 'failed', stats: preview.stats, detail: `restore archive unavailable: ${error instanceof Error ? error.message : String(error)}` }, env);
    return { continue: true, suppressOutput: true };
  }

  // Consume only after the archive is known to be readable. If a newer state replaced the
  // preview between these operations, expectedCreatedAt prevents injecting the stale archive.
  const state = await claimReady(input.session_id, ttl, env, preview.createdAt);
  if (!state) return { continue: true, suppressOutput: true };
  const header = mode === 'preserve'
    ? 'Codex compacted this session. Jev selected useful pre-compaction evidence. Selected retained context is injected below; very large individual results may be head/tail abridged in the injected payload, while the full retained normalized archive remains on disk. Missing tool calls were judged stale and can be rerun.'
    : mode === 'balanced'
      ? 'Codex compacted this session. Jev selected useful pre-compaction evidence. A compact index plus a bounded evidence excerpt is injected below; the full retained normalized archive remains on disk.'
      : 'Codex compacted this session. Jev selected useful pre-compaction evidence. A compact index is injected below; the full retained normalized archive remains on disk.';
  const structured = state.messagesFile ? `\nStructured retained messages: ${state.messagesFile}` : '';
  const injected = `${header}\n\n${payload}\n\nFull retained context: ${state.contextFile}${structured}`;
  await tryAppendHistory({ at: new Date().toISOString(), runId: state.runId ?? state.createdAt, sessionId: input.session_id, turnId: input.turn_id, phase: 'restore', status: 'restored', stats: state.stats, restoreMode: mode, restoreLimitChars: cap, injectedChars: injected.length, injectedPayloadChars: payload.length, retainedChars: state.contextChars }, env);
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: event, additionalContext: injected },
  };
}


export async function handleHook(value: unknown, env: Record<string, string | undefined> = process.env): Promise<Record<string, unknown>> {
  const input = parseInput(value);
  if (input.hook_event_name === 'PreCompact') {
    const createdAt = new Date().toISOString();
    const runId = `${input.session_id}:${input.turn_id ?? 'compact'}:${createdAt}`;
    await discardPendingState(input.session_id, env);
    if (!input.transcript_path) {
      await tryAppendHistory({ at: new Date().toISOString(), runId, sessionId: input.session_id, turnId: input.turn_id, trigger: input.trigger, model: input.model, provider: providerName(env), phase: 'precompact', status: 'failed', detail: 'transcript path unavailable' }, env);
      return { continue: true, systemMessage: 'jev-compact: no transcript path; native compaction only' };
    }
    try {
      await sweep(env, num(env, 'JEV_COMPACT_STATE_MAX_AGE_MS', 48 * 60 * 60 * 1000));
      const messages = await loadCodexRollout(input.transcript_path);
      if (messages.length < 2) {
        await tryAppendHistory({ at: new Date().toISOString(), runId, sessionId: input.session_id, turnId: input.turn_id, trigger: input.trigger, model: input.model, provider: providerName(env), phase: 'precompact', status: 'skipped', detail: 'transcript has fewer than 2 messages' }, env);
        return { continue: true, suppressOutput: true };
      }
      const provider = resolveProvider({ provider: requestedProvider(env), env });
      const transport = providerConfig({ provider, env });
      const settings = userSettings(env);
      const result = await compactMessages(messages, {
        provider,
        env,
        model: transport.model,
        goal: env.JEV_COMPACT_GOAL,
        baseUrl: transport.baseUrl,
        lossThreshold: settings.lossThreshold,
        preserveRecentMessages: settings.pinRecentMessages,
        maxStateTokens: Math.max(1_000, num(env, 'JEV_COMPACT_MAX_STATE_TOKENS', 24_000)),
        maxRequestTokens: Math.max(2_000, num(env, 'JEV_COMPACT_MAX_REQUEST_TOKENS', 30_000)),
        truncateHeadChars: Math.max(0, num(env, 'JEV_COMPACT_TRUNCATE_HEAD_CHARS', 300)),
        maxConcurrentRequests: Math.max(1, num(env, 'JEV_COMPACT_CONCURRENCY', 4)),
        timeoutMs: Math.max(1, num(env, 'JEV_COMPACT_TIMEOUT_MS', 20_000)),
        retries: Math.max(0, num(env, 'JEV_COMPACT_RETRIES', 1)),
      });
      const minimum = settings.minReductionRatio;
      if (reductionRatio(result) < minimum) {
        await tryAppendHistory({ at: new Date().toISOString(), runId, sessionId: input.session_id, turnId: input.turn_id, trigger: input.trigger, model: input.model, provider, phase: 'precompact', status: 'skipped', stats: result.stats, decisions: result.decisions, detail: `reduction below ${minimum}` }, env);
        return { continue: true, suppressOutput: true };
      }
      const prepared = await prepareState(
        { sessionId: input.session_id, turnId: input.turn_id, trigger: input.trigger, model: input.model, createdAt, runId, stats: result.stats, decisions: result.decisions, index: renderIndex(result.messages, result.decisions, numAny(env, ['JEV_COMPACT_INDEX_MAX_CHARS', 'JEV_COMPACT_INDEX_CHARS'], 12_000)) },
        renderMessages(result.messages),
        env,
        result.messages,
      );
      await tryAppendHistory({ at: new Date().toISOString(), runId, sessionId: input.session_id, turnId: input.turn_id, trigger: input.trigger, model: input.model, provider, phase: 'precompact', status: 'prepared', stats: result.stats, decisions: result.decisions, retainedChars: prepared.contextChars }, env);
      return { continue: true, systemMessage: `jev-compact: prepared ${Math.round(reductionRatio(result) * 100)}% smaller retained context (${result.stats.callsDropped} calls dropped, ${result.stats.resultsTruncated} results truncated)` };
    } catch (error) {
      await tryAppendHistory({ at: new Date().toISOString(), runId, sessionId: input.session_id, turnId: input.turn_id, trigger: input.trigger, model: input.model, provider: providerName(env), phase: 'precompact', status: 'failed', detail: error instanceof Error ? error.message : String(error) }, env);
      return { continue: true, systemMessage: `jev-compact: native compaction fallback (${error instanceof Error ? error.message : String(error)})` };
    }
  }
  if (input.hook_event_name === 'PostCompact') {
    try {
      const state = await markReady(input.session_id, input.turn_id, env);
      if (state) await tryAppendHistory({ at: new Date().toISOString(), runId: state.runId ?? state.createdAt, sessionId: input.session_id, turnId: input.turn_id, trigger: input.trigger, model: input.model, provider: providerName(env), phase: 'postcompact', status: 'ready', stats: state.stats }, env);
    } catch {
      // Compaction already succeeded. A sidecar persistence failure must not abort Codex.
    }
    return { continue: true, suppressOutput: true };
  }
  if (input.hook_event_name === 'SessionStart' && input.source === 'compact') return restore(input, 'SessionStart', env);
  if (input.hook_event_name === 'UserPromptSubmit') return restore(input, 'UserPromptSubmit', env);
  return { continue: true, suppressOutput: true };
}
