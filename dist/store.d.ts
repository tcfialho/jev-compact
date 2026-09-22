import type { CallDecision, CompactStats, Message } from './types.js';
export interface SessionState {
    version: 1;
    sessionId: string;
    runId?: string;
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
    runId?: string;
    sessionId: string;
    turnId?: string;
    trigger?: string;
    model?: string;
    provider?: string;
    phase?: 'precompact' | 'postcompact' | 'restore';
    status: 'prepared' | 'ready' | 'restored' | 'skipped' | 'failed';
    stats?: CompactStats;
    decisions?: CallDecision[];
    detail?: string;
    restoreMode?: 'preserve' | 'balanced' | 'minimal';
    restoreLimitChars?: number;
    injectedChars?: number;
    injectedPayloadChars?: number;
    retainedChars?: number;
}
export declare function dataDir(env?: Record<string, string | undefined>): string;
export declare function statePath(sessionId: string, env?: Record<string, string | undefined>): string;
export declare function contextPath(sessionId: string, env?: Record<string, string | undefined>): string;
export declare function messagesPath(sessionId: string, env?: Record<string, string | undefined>): string;
export declare function historyPath(env?: Record<string, string | undefined>): string;
export declare function prepareState(state: Omit<SessionState, 'version' | 'ready' | 'consumed' | 'contextFile' | 'contextChars' | 'messagesFile'>, context: string, env?: Record<string, string | undefined>, messages?: readonly Message[]): Promise<SessionState>;
export declare function discardPendingState(sessionId: string, env?: Record<string, string | undefined>): Promise<void>;
export declare function readState(sessionId: string, env?: Record<string, string | undefined>): Promise<SessionState | undefined>;
export declare function peekReady(sessionId: string, ttlMs: number, env?: Record<string, string | undefined>): Promise<SessionState | undefined>;
export declare function markReady(sessionId: string, turnId?: string, env?: Record<string, string | undefined>): Promise<SessionState | undefined>;
export declare function claimReady(sessionId: string, ttlMs: number, env?: Record<string, string | undefined>, expectedCreatedAt?: string): Promise<SessionState | undefined>;
/** Best-effort cleanup of stale per-session sidecars. History is intentionally retained. */
export declare function sweep(env?: Record<string, string | undefined>, maxAgeMs?: number): Promise<number>;
export declare function appendHistory(row: HistoryRow, env?: Record<string, string | undefined>): Promise<void>;
/** History is observability only; hook correctness must never depend on this write succeeding. */
export declare function tryAppendHistory(row: HistoryRow, env?: Record<string, string | undefined>): Promise<boolean>;
export declare function readHistory(env?: Record<string, string | undefined>): Promise<HistoryRow[]>;
