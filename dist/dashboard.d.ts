import { type HistoryRow } from './store.js';
interface ToolSummary {
    tool: string;
    calls: number;
    kept: number;
    dropped: number;
    truncated: number;
    originalChars: number;
    removedChars: number;
}
interface RunSummary {
    runId: string;
    at: string;
    sessionId: string;
    trigger?: string;
    model?: string;
    provider?: string;
    status: 'prepared' | 'ready' | 'restored' | 'skipped' | 'failed' | 'restore_failed';
    reductionRatio: number;
    charsBefore: number;
    charsAfter: number;
    removedChars: number;
    calls: number;
    kept: number;
    truncated: number;
    dropped: number;
    pinned: number;
    jevRequests: number;
    jevInputTokens: number;
    jevOutputTokens: number;
    jevUsageReportedRequests: number;
    selectionMs: number;
    restoreMode?: string;
    injectedPayloadChars?: number;
    retainedChars?: number;
    detail?: string;
}
/** Build only measured statistics. No chars/4 or claimed Codex billing-token savings. */
export declare function stats(env?: Record<string, string | undefined>): Promise<{
    measured: boolean;
    note: string;
    attempts: number;
    prepared: number;
    ready: number;
    restored: number;
    skipped: number;
    nativeFallbacks: number;
    restoreFailures: number;
    transcriptCharsBefore: number;
    transcriptCharsAfter: number;
    transcriptCharsRemoved: number;
    transcriptReductionRatio: number;
    completedCharsBefore: number;
    completedCharsAfter: number;
    completedCharsRemoved: number;
    completedReductionRatio: number;
    retainedArchiveChars: number;
    injectedChars: number;
    injectedPayloadChars: number;
    restoreEligibleChars: number;
    restoreCharsNotInjected: number;
    jevInputTokens: number;
    jevOutputTokens: number;
    jevRequests: number;
    jevUsageReportedRequests: number;
    jevUsageCoverage: number;
    averageSelectionMs: number;
    settings: import("./settings.js").UserSettings;
    byTool: ToolSummary[];
    recentDecisions: {
        at: string;
        sessionId: string;
        tool: string;
        inputPreview: string;
        action: import("./types.js").DecisionAction;
        removedChars: number;
        originalChars: number;
        dropLoss: number;
        truncateLoss: number;
        pinned: boolean;
    }[];
    runs: RunSummary[];
    recentEvents: HistoryRow[];
}>;
export declare function startDashboard(port?: number, env?: Record<string, string | undefined>): Promise<{
    server: any;
    url: string;
}>;
export {};
