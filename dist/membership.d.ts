import type { CallDecision, Message } from './types.js';
export interface DedupeSummary {
    messages: Message[];
    decisions: CallDecision[];
    retainedRenderChars: number;
    missingRenderChars: number;
    nativePresentChars: number;
    textItemsAlreadyPresent: number;
    toolPairsAlreadyPresent: number;
    orphanToolItemsAlreadyPresent: number;
}
/**
 * Remove only evidence that is provably present verbatim in the live post-compaction history.
 * A complete tool pair is removed only when both the exact call and exact result survive.
 * Any ambiguity intentionally keeps the retained evidence, trading duplicate text for safety.
 */
export declare function dedupeRetainedMessages(retained: readonly Message[], livePostCompaction: readonly Message[], decisions: readonly CallDecision[]): DedupeSummary;
