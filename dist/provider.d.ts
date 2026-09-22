import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';
export type JevProvider = 'auto' | 'typesafe' | 'openrouter';
export type Env = Record<string, string | undefined>;
export interface JevClientOptions {
    provider?: JevProvider;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
    retries?: number;
    fetch?: typeof fetch;
    env?: Env;
    /** Cache serialization only when callers keep Jev state objects immutable between asks. */
    cacheStateSerialization?: boolean;
}
export declare function resolveApiKey(provider: Exclude<JevProvider, 'auto'>, options?: Pick<JevClientOptions, 'apiKey' | 'env'>): string;
export declare function resolveProvider(options?: Pick<JevClientOptions, 'provider' | 'env' | 'apiKey'>): Exclude<JevProvider, 'auto'>;
export declare function providerConfig(options?: JevClientOptions): {
    provider: Exclude<JevProvider, 'auto'>;
    apiKey: string;
    model: string;
    baseUrl: string;
};
export declare class JevClient implements JevAsker {
    private readonly options;
    private resolved?;
    private readonly serializedStates;
    constructor(options?: JevClientOptions);
    private config;
    private body;
    ask(state: JevState, questions: JevQuestions): Promise<JevResponse>;
}
export declare function noul(answers: JevResponse['answers'], key: string): number;
