type Env = Record<string, string | undefined>;
interface DashboardInstance {
    pid: number;
    instanceId: string;
    url: string;
}
export declare const DEFAULT_DASHBOARD_PORT = 43127;
export declare function dashboardPort(env?: Env): number;
export declare function dashboardAutostart(env?: Env): boolean;
export declare function dashboardInstancePath(port: number, env?: Env): string;
export declare function runningDashboard(port: number, env?: Env): Promise<DashboardInstance | undefined>;
/** Replaces any dashboard already on the port, so an explicit launch always serves the current code. */
export declare function restartDashboard(port: number, env?: Env, cliPath?: any): Promise<string>;
/** Reuses a healthy dashboard; each check also counts as activity and postpones its idle shutdown. */
export declare function ensureDashboard(port: number, env?: Env, cliPath?: any): Promise<string>;
export {};
