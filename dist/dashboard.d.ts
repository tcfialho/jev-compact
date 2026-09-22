export declare function stats(env?: Record<string, string | undefined>): Promise<{
    compactions: number;
    restores: number;
    failures: number;
    jevInputTokens: number;
    jevOutputTokens: number;
    prunedChars: number;
    estimatedPrunedTokens: number;
    avoidedRestoreChars: number;
    estimatedRestoreTokensAvoided: number;
    byTool: {
        calls: number;
        savedChars: number;
        dropped: number;
        truncated: number;
        tool: string;
    }[];
    last: import("./store.js").HistoryRow | null;
}>;
export declare function startDashboard(port?: number, env?: Record<string, string | undefined>): Promise<void>;
