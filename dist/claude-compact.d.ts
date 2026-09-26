/** Claude Code hands its transcript over from its function hook; Jev decides what the compacted conversation keeps. */
export declare function compactForClaude(body: Record<string, unknown>, baseEnv: Record<string, string | undefined>): Promise<Record<string, unknown>>;
