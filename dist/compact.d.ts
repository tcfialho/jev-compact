import { type JevClientOptions } from './provider.js';
import type { CompactResult, JevAsker, Message } from './types.js';
export interface CompactOptions {
    goal?: string;
    keepThreshold?: number;
    preserveRecentMessages?: number;
    maxStateTokens?: number;
    maxRequestTokens?: number;
    truncateHeadChars?: number;
    maxConcurrentRequests?: number;
}
export declare function estimateTokens(text: string): number;
export declare function reductionRatio(r: Pick<CompactResult, 'stats'>): number;
export declare function compact(messages: readonly Message[], asker: JevAsker, input?: CompactOptions): Promise<CompactResult>;
export declare function compactMessages(messages: readonly Message[], opts?: CompactOptions & JevClientOptions): Promise<CompactResult>;
