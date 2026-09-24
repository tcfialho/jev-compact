export interface HookOptions {
    startDashboard?: boolean;
}
export declare function handleHook(value: unknown, env?: Record<string, string | undefined>, options?: HookOptions): Promise<Record<string, unknown>>;
