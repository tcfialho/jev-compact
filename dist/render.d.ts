import type { CallDecision, Message } from './types.js';
export declare function renderMessages(messages: readonly Message[]): string;
/** Render for model reinjection while preventing one giant result from crowding out everything else. */
export declare function renderMessagesForInjection(messages: readonly Message[], resultHead?: number, resultTail?: number): string;
export declare function capContext(text: string, limit: number): string;
export declare function renderIndex(messages: readonly Message[], decisions: readonly CallDecision[], maxChars?: number): string;
