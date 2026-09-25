import { type KeyStatus } from './provider.js';
import { type SettingName } from './settings.js';
import { type HookActivity } from './store.js';
type Env = Record<string, string | undefined>;
type Provider = 'openrouter' | 'typesafe';
export interface SettingsSnapshot {
    provider: Provider;
    providerLockedBy?: string;
    keys: Record<Provider, KeyStatus>;
    lastJev: {
        at: string;
        ok: boolean;
        detail?: string;
    } | null;
    installation: {
        kind: 'plugin' | 'command';
        version: string;
    };
    hooks: {
        installed: number;
        total: number;
        activity: HookActivity;
    };
    dashboardUrl: string;
    settings: Array<{
        name: SettingName;
        value: string;
        choices: string[];
        lockedBy?: string;
    }>;
}
export declare function settingsSnapshot(env?: Env): Promise<SettingsSnapshot>;
/** Applies one change sent by the settings page. */
export declare function applySettingsChange(body: Record<string, unknown>, env?: Env): Promise<void>;
export {};
