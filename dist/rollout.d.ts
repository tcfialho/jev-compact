import type { Message } from './types.js';
export declare function appendResponseItem(messages: Message[], value: unknown): void;
export declare class UnsupportedCodexRolloutError extends Error {
    constructor(message: string);
}
export declare function parseCodexRollout(jsonl: string): Message[];
/**
 * Finds the newest safe modern compaction checkpoint without repeatedly copying
 * a giant JSONL record that crosses many read chunks. A crossing line is kept
 * as buffer fragments and concatenated only once, when its leading newline is found.
 */
export declare function loadCodexRollout(path: string, chunkBytes?: number): Promise<Message[]>;
