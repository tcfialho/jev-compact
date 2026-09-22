export declare function runtimeDir(env?: Record<string, string | undefined>): string;
/** Copy the compiled runtime to a stable location so setup does not depend on the extracted checkout. */
export declare function installRuntime(cliPath: string, env?: Record<string, string | undefined>): Promise<string>;
export declare function inspectHooks(env?: Record<string, string | undefined>): Promise<{
    path: string;
    installed: boolean;
    events: string[];
}>;
export declare function installHooks(cliPath: string, env?: Record<string, string | undefined>): Promise<string>;
export declare function uninstallHooks(env?: Record<string, string | undefined>): Promise<string>;
