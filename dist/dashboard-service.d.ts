type Env = Record<string, string | undefined>;
interface DashboardInstance {
    pid: number;
    instanceId: string;
    url: string;
    entry?: string;
}
export declare const DEFAULT_DASHBOARD_PORT = 43127;
export declare function dashboardPort(env?: Env): number;
export declare function dashboardAutostart(env?: Env): boolean;
export declare function dashboardInstancePath(port: number, env?: Env): string;
export declare function runningDashboard(port: number, env?: Env): Promise<DashboardInstance | undefined>;
export declare function stopDashboard(port: number, env: Env): Promise<void>;
/** Replaces any dashboard already on the port, so an explicit launch always serves the current code. */
export declare function restartDashboard(port: number, env?: Env, cliPath?: any): Promise<string>;
/** Reuses a healthy dashboard, replacing one left running by another installed version. */
export declare function ensureDashboard(port: number, env?: Env, cliPath?: any): Promise<string>;
export {};
