#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactMessages, reductionRatio } from './compact.js';
import { startDashboard, stats } from './dashboard.js';
import { dashboardInstancePath, dashboardPort, restartDashboard, runningDashboard } from './dashboard-service.js';
import { handleHook } from './hooks.js';
import { resetUserSettings, setUserSetting, userSettings } from './settings.js';
import { inspectHooks, installHooks, installRuntime, uninstallHooks } from './install.js';
import { enabledPluginRoot } from './plugin-installation.js';
import { hasSavedProviderKey, providerConfig, resolveApiKey, resolveProvider, saveProviderConfiguration } from './provider.js';
import { renderMessages } from './render.js';
import { loadCodexRollout } from './rollout.js';
import { dataDir } from './store.js';
async function stdin() { let s = ''; for await (const chunk of process.stdin)
    s += chunk; return s; }
function flag(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function fmt(n) { return Number(n || 0).toLocaleString(); }
function chars(n) { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M chars` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k chars` : `${fmt(n)} chars`; }
function help() {
    const pluginRoot = enabledPluginRoot();
    if (pluginRoot) {
        const command = `node "${join(pluginRoot, 'dist', 'cli.js')}"`;
        console.log(`Jev Compact plugin

First-time setup:
  ${command} setup openrouter    Save an OpenRouter API key
  ${command} setup typesafe      Save a TypeSafe API key
  ${command} doctor              Check provider, key and plugin hooks

Useful commands:
  ${command} config              Show settings
  ${command} stats               Show measured compaction statistics
  ${command} dashboard           Open the local dashboard

Open /hooks in Codex to review the plugin hooks.`);
        return;
    }
    console.log(`jev-compact

First-time setup:
  jev-compact setup                  TypeSafe: save key + install Codex hooks
  jev-compact setup openrouter       OpenRouter: save key + install Codex hooks
  jev-compact configure PROVIDER     Change provider/key without reinstalling hooks
  jev-compact install                Point Codex hooks at this checkout (development/local use)
  jev-compact doctor                 Verify everything is ready
  jev-compact config                 Show user-facing settings
  jev-compact config NAME VALUE      Save a setting (works with desktop Codex too)
  jev-compact config reset           Reset saved user settings to defaults

Useful commands:
  jev-compact dashboard [--port N]   Local measured-impact dashboard
  jev-compact stats [--json]         Measured local compaction statistics
  jev-compact compact FILE [--context FILE] [--json FILE]
                                     Preview Jev selection on a Codex rollout
  jev-compact uninstall              Remove only jev-compact hooks

Environment variables remain supported and override saved configuration.
Tip: "jev-compact config mode observe" runs Jev and measures what would happen without changing Codex context.
Run "jev-compact doctor --json" for machine-readable readiness details.`);
}
async function secret(prompt) {
    if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function')
        return (await stdin()).trim();
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise((resolve, reject) => {
        let value = '';
        const cleanup = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); };
        const onData = (chunk) => {
            const text = String(chunk);
            for (const ch of text) {
                if (ch === '\u0003') {
                    cleanup();
                    process.stdout.write('\n');
                    reject(new Error('cancelled'));
                    return;
                }
                if (ch === '\r' || ch === '\n') {
                    cleanup();
                    process.stdout.write('\n');
                    resolve(value.trim());
                    return;
                }
                if (ch === '\u007f' || ch === '\b') {
                    if (value) {
                        value = value.slice(0, -1);
                        process.stdout.write('\b \b');
                    }
                    continue;
                }
                if (ch >= ' ') {
                    value += ch;
                    process.stdout.write('*');
                }
            }
        };
        process.stdin.on('data', onData);
    });
}
async function readiness() {
    const provider = resolveProvider({ provider: process.env.JEV_COMPACT_PROVIDER, env: process.env });
    const config = providerConfig({ provider, env: process.env });
    const hooks = await inspectHooks(process.env);
    const settings = userSettings(process.env);
    return {
        node: process.version ?? 'unknown',
        provider,
        apiKeyConfigured: !!resolveApiKey(provider, { env: process.env }),
        model: config.model,
        baseUrl: config.baseUrl,
        hooksInstalled: hooks.installed,
        hookEvents: hooks.events,
        hooksFile: hooks.path,
        pluginRoot: enabledPluginRoot(),
        dataDir: dataDir(process.env),
        dashboardUrl: (await runningDashboard(dashboardPort(process.env), process.env))?.url ?? null,
        settings,
    };
}
function printSettings(settings) {
    console.log(`mode                  ${settings.mode}`);
    console.log(`restore-mode          ${settings.restoreMode}`);
    console.log(`restore-max-chars     ${settings.restoreMaxChars}`);
    console.log(`pin-recent-messages   ${settings.pinRecentMessages}`);
    console.log(`loss-threshold        ${settings.lossThreshold}`);
    console.log(`min-reduction-ratio   ${settings.minReductionRatio}`);
    if (settings.restoreModeWarning)
        console.log(`warning               ${settings.restoreModeWarning}`);
}
async function configureProvider(provider) {
    const key = await secret(`${provider === 'typesafe' ? 'TypeSafe' : 'OpenRouter'} API key: `);
    const saved = await saveProviderConfiguration(provider, key, process.env);
    if (enabledPluginRoot())
        await uninstallHooks();
    console.log(`Configured ${provider}.\nKey saved: ${saved.keyFile}\nProvider preference saved: ${saved.providerFile}`);
}
async function installAndExplain(cliPath = fileURLToPath(import.meta.url), commandPrefix = 'jev-compact') {
    const path = await installHooks(cliPath);
    const ready = await readiness();
    console.log(`jev-compact hooks installed: ${path}`);
    console.log(`Provider: ${ready.provider} · API key: ${ready.apiKeyConfigured ? 'configured' : 'MISSING'}`);
    if (!ready.apiKeyConfigured)
        console.log(`Configure it with: ${commandPrefix} configure ${ready.provider}`);
    console.log('Next: restart Codex, open /hooks once, and enable/trust the jev-compact hooks.');
    console.log(`Then run: ${commandPrefix} doctor`);
}
function stopWhenIdle(server, port) {
    const idleMinutes = Number(process.env.JEV_COMPACT_DASHBOARD_IDLE_MINUTES);
    const idleMs = (Number.isFinite(idleMinutes) && idleMinutes > 0 ? idleMinutes : 120) * 60_000;
    let lastActivity = Date.now();
    server.on('request', () => { lastActivity = Date.now(); });
    const idleCheck = setInterval(async () => {
        if (Date.now() - lastActivity < idleMs)
            return;
        server.close();
        if (port !== 0)
            await rm(dashboardInstancePath(port), { force: true }).catch(() => { });
        process.exit(0);
    }, Math.min(60_000, idleMs));
    idleCheck.unref();
}
async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h')
        return help();
    if (cmd === 'hook') {
        const out = await handleHook(JSON.parse(await stdin()));
        process.stdout.write(`${JSON.stringify(out)}\n`);
        return;
    }
    if (cmd === 'configure') {
        const provider = args[0];
        if (provider !== 'typesafe' && provider !== 'openrouter')
            throw new Error('usage: jev-compact configure <typesafe|openrouter>');
        await configureProvider(provider);
        return;
    }
    if (cmd === 'config') {
        if (!args.length) {
            printSettings(userSettings(process.env));
            return;
        }
        if (args[0] === 'reset') {
            await resetUserSettings(process.env);
            console.log('Saved jev-compact settings reset to defaults.');
            printSettings(userSettings(process.env));
            return;
        }
        if (args.length < 2)
            throw new Error('usage: jev-compact config <mode|restore-mode|restore-max-chars|pin-recent-messages|loss-threshold|min-reduction-ratio> <value>');
        const name = args[0];
        if (!['mode', 'restore-mode', 'restore-max-chars', 'pin-recent-messages', 'loss-threshold', 'min-reduction-ratio'].includes(name))
            throw new Error(`unknown setting: ${args[0]}`);
        const settings = await setUserSetting(name, args[1], process.env);
        console.log(`Saved ${name}=${args[1]}`);
        printSettings(settings);
        return;
    }
    if (cmd === 'setup') {
        const provider = (args[0] ?? resolveProvider({ env: process.env }));
        if (provider !== 'typesafe' && provider !== 'openrouter')
            throw new Error('usage: jev-compact setup [typesafe|openrouter]');
        if (!hasSavedProviderKey(provider, process.env))
            await configureProvider(provider);
        if (enabledPluginRoot()) {
            await uninstallHooks();
            console.log('Open /hooks in Codex and confirm the four Jev Compact hooks are active.');
            return;
        }
        const runtimeCli = await installRuntime(fileURLToPath(import.meta.url), process.env);
        console.log(`Runtime installed: ${runtimeCli}`);
        await installAndExplain(runtimeCli, `node \"${runtimeCli}\"`);
        return;
    }
    if (cmd === 'install') {
        if (enabledPluginRoot()) {
            await uninstallHooks();
            console.log('Jev Compact hooks are supplied by the plugin. Open /hooks in Codex to review them.');
            return;
        }
        await installAndExplain();
        return;
    }
    if (cmd === 'uninstall') {
        console.log(`Updated: ${await uninstallHooks()}`);
        return;
    }
    if (cmd === 'doctor') {
        const value = await readiness();
        if (args.includes('--json')) {
            console.log(JSON.stringify(value, null, 2));
            return;
        }
        console.log(`jev-compact doctor\n`);
        console.log(`${value.apiKeyConfigured ? 'OK' : 'MISSING'}  API key (${value.provider})`);
        if (value.pluginRoot)
            console.log('CHECK  Plugin hooks: open /hooks and confirm four active');
        else
            console.log(`${value.hooksInstalled ? 'OK' : 'MISSING'}  Codex hooks (${value.hookEvents.join(', ') || 'none'})`);
        console.log(`OK  Node ${value.node}`);
        console.log(`    Model: ${value.model}`);
        console.log(`    Hooks: ${value.pluginRoot ? join(value.pluginRoot, 'hooks', 'hooks.json') : value.hooksFile}`);
        console.log(`    Data:  ${value.dataDir}`);
        console.log(`    Dashboard: ${value.dashboardUrl ?? 'not running (the plugin starts it with the next Codex session or prompt)'}`);
        console.log(`    Mode: ${value.settings.mode}${value.settings.mode === 'observe' ? ' (measures only; no restore context is injected)' : ''}`);
        console.log(`    Restore: ${value.settings.restoreMode} · max ${fmt(value.settings.restoreMaxChars)} chars`);
        console.log(`    Pruning: loss <= ${value.settings.lossThreshold.toFixed(2)} · pin ${fmt(value.settings.pinRecentMessages)} recent messages · require ${(value.settings.minReductionRatio * 100).toFixed(0)}% reduction`);
        if (value.settings.restoreModeWarning)
            console.log(`WARN  ${value.settings.restoreModeWarning}`);
        if (value.pluginRoot) {
            if (!value.apiKeyConfigured)
                console.log(`\nFix API key: node "${fileURLToPath(import.meta.url)}" configure ${value.provider}`);
        }
        else if (!value.apiKeyConfigured && !value.hooksInstalled) {
            console.log(`\nFix both: jev-compact setup${value.provider === 'openrouter' ? ' openrouter' : ''}`);
        }
        else {
            if (!value.apiKeyConfigured)
                console.log(`\nFix API key: jev-compact configure ${value.provider}`);
            if (!value.hooksInstalled)
                console.log('\nFix hooks: jev-compact install');
        }
        return;
    }
    if (cmd === 'compact') {
        if (!args[0])
            throw new Error('compact requires a rollout JSONL path');
        const messages = await loadCodexRollout(args[0]);
        const result = await compactMessages(messages);
        const rendered = renderMessages(result.messages);
        const contextFile = flag(args, '--context');
        const jsonFile = flag(args, '--json');
        if (contextFile)
            await writeFile(contextFile, `${rendered}\n`);
        else
            process.stdout.write(`${rendered}\n`);
        if (jsonFile)
            await writeFile(jsonFile, `${JSON.stringify({ messages: result.messages, decisions: result.decisions, stats: result.stats }, null, 2)}\n`);
        console.error(JSON.stringify({ ...result.stats, reductionRatio: reductionRatio(result) }, null, 2));
        return;
    }
    if (cmd === 'stats') {
        const value = await stats();
        if (args.includes('--json')) {
            console.log(JSON.stringify(value, null, 2));
            return;
        }
        console.log(`Compaction attempts: ${fmt(value.attempts)} · restored: ${fmt(value.restored)} · observed: ${fmt(value.observed)} · skips: ${fmt(value.skipped)} · native fallbacks: ${fmt(value.nativeFallbacks)} · restore issues: ${fmt(value.restoreFailures)}`);
        console.log(`Completed retained-copy reduction: ${chars(value.completedCharsRemoved)} (${(value.completedReductionRatio * 100).toFixed(1)}%)`);
        console.log(`Exact evidence already present after native compaction: ${chars(value.nativePresentChars)}`);
        console.log(`Hook context delivered after compaction: ${chars(value.injectedChars)}`);
        console.log(`  selected evidence inside it: ${chars(value.injectedPayloadChars)}`);
        if (value.observed)
            console.log(`Observe mode would have delivered: ${chars(value.wouldInjectChars)} (${chars(value.wouldInjectPayloadChars)} selected evidence)`);
        if (value.jevUsageReportedRequests)
            console.log(`Jev provider usage reported: ${fmt(value.jevInputTokens)} input + ${fmt(value.jevOutputTokens)} output tokens (${fmt(value.jevUsageReportedRequests)}/${fmt(value.jevRequests)} requests reported usage)`);
        else
            console.log(`Jev provider usage: not reported (${fmt(value.jevRequests)} requests observed)`);
        console.log(`Average Jev selection time: ${fmt(value.averageSelectionMs)} ms`);
        return;
    }
    if (cmd === 'dashboard') {
        const requested = flag(args, '--port') ?? args.find((x) => /^\d+$/.test(x));
        const port = requested ? Number(requested) : dashboardPort(process.env);
        if (args.includes('--background')) {
            const instanceId = process.env.JEV_COMPACT_DASHBOARD_INSTANCE_ID ?? randomUUID();
            process.env.JEV_COMPACT_DASHBOARD_INSTANCE_ID = instanceId;
            const { server, url } = await startDashboard(port);
            if (port !== 0) {
                try {
                    await mkdir(dataDir(process.env), { recursive: true, mode: 0o700 });
                    await writeFile(dashboardInstancePath(port), JSON.stringify({ pid: process.pid, instanceId, url }), { mode: 0o600 });
                }
                catch (error) {
                    server.close();
                    throw error;
                }
            }
            stopWhenIdle(server, port);
            process.stdout.write(`${url}\n`);
            return;
        }
        const url = await restartDashboard(port, process.env);
        console.log(`Dashboard: ${url}`);
        return;
    }
    throw new Error(`unknown command: ${cmd}`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
