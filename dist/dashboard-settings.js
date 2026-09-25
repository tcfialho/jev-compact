import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dashboardPort } from './dashboard-service.js';
import { inspectHooks } from './install.js';
import { enabledPluginRoot } from './plugin-installation.js';
import { keyStatus, resolveProvider, savePreferredProvider, saveProviderConfiguration } from './provider.js';
import { SETTINGS_ITEMS } from './settings-menu.js';
import { resetUserSettings, setUserSetting, settingOverride, userSettings } from './settings.js';
import { readHistory, readHookActivity } from './store.js';
import { VERSION } from './version.js';
async function pluginHookCount(pluginRoot) {
    try {
        const manifest = JSON.parse(await readFile(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
        return Object.keys(manifest.hooks ?? {}).length;
    }
    catch {
        return 0;
    }
}
export async function settingsSnapshot(env = process.env) {
    const settings = userSettings(env);
    const pluginRoot = enabledPluginRoot(env);
    const history = await readHistory(env);
    const lastJev = [...history].reverse().find((row) => row.phase === 'precompact' || (!row.phase && row.status === 'failed'));
    const settingValue = {
        'restore-mode': settings.restoreMode,
        'restore-max-chars': String(settings.restoreMaxChars),
        'pin-recent-messages': String(settings.pinRecentMessages),
        'loss-threshold': String(settings.lossThreshold),
        'min-reduction-ratio': String(settings.minReductionRatio),
    };
    return {
        provider: resolveProvider({ env }),
        providerLockedBy: env.JEVCOMP_PROVIDER ? 'JEVCOMP_PROVIDER' : undefined,
        keys: { openrouter: keyStatus('openrouter', env), typesafe: keyStatus('typesafe', env) },
        lastJev: lastJev ? { at: lastJev.at, ok: lastJev.status !== 'failed', detail: lastJev.status === 'failed' ? lastJev.detail : undefined } : null,
        installation: { kind: pluginRoot ? 'plugin' : 'command', version: VERSION },
        hooks: {
            installed: pluginRoot ? await pluginHookCount(pluginRoot) : (await inspectHooks(env)).events.length,
            total: 4,
            activity: await readHookActivity(env),
        },
        dashboardUrl: `http://127.0.0.1:${dashboardPort(env)}/`,
        settings: SETTINGS_ITEMS.map((item) => ({
            name: item.name,
            value: settingValue[item.name],
            choices: item.choices.map((choice) => choice.value),
            lockedBy: settingOverride(item.name, env),
        })),
    };
}
function provider(value) {
    if (value === 'openrouter' || value === 'typesafe')
        return value;
    throw new Error('provider must be openrouter or typesafe');
}
/** Applies one change sent by the settings page. */
export async function applySettingsChange(body, env = process.env) {
    if (body.action === 'setting') {
        const name = body.name;
        if (!SETTINGS_ITEMS.some((item) => item.name === name))
            throw new Error(`unknown setting: ${String(body.name)}`);
        const lockedBy = settingOverride(name, env);
        if (lockedBy)
            throw new Error(`${lockedBy} decides this value`);
        await setUserSetting(name, String(body.value), env);
    }
    else if (body.action === 'reset') {
        await resetUserSettings(env);
    }
    else if (body.action === 'provider') {
        const target = provider(body.provider);
        if (keyStatus(target, env).source === 'none')
            throw new Error('enter a key for this provider first');
        await savePreferredProvider(target, env);
    }
    else if (body.action === 'key') {
        const key = typeof body.key === 'string' ? body.key.trim() : '';
        if (!key)
            throw new Error('the key is empty');
        await saveProviderConfiguration(provider(body.provider), key, env);
    }
    else {
        throw new Error('unknown action');
    }
}
