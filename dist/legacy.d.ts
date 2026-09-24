type Env = Record<string, string | undefined>;
export declare const LEGACY_NAME = "jev-compact";
export declare const LEGACY_HOOK_TAG = "--jev-compact";
export declare const LEGACY_DASHBOARD_SERVICE = "jev-compact-dashboard";
/** Honors settings saved under the old JEV_COMPACT_* names unless the JEVCOMP_* name is set. */
export declare function adoptLegacyEnvironment(env: Env): void;
/** Copies the saved key, provider and settings once, leaving the old folder in place. */
export declare function migrateLegacyConfig(env: Env): void;
export declare function legacyHistoryPaths(env: Env): string[];
export {};
