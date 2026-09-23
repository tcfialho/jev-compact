#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactMessages, reductionRatio } from './compact.js';
import { startDashboard, stats } from './dashboard.js';
import { handleHook } from './hooks.js';
import { resetUserSettings, setUserSetting, userSettings } from './settings.js';
import { inspectHooks, installHooks, installRuntime, uninstallHooks } from './install.js';
import { providerConfig, resolveApiKey, resolveProvider, saveProviderConfiguration } from './provider.js';
import { renderMessages } from './render.js';
import { loadCodexRollout } from './rollout.js';
import { dataDir } from './store.js';
async function stdin() { let s = ''; for await (const chunk of process.stdin)
    s += chunk; return s; }
function flag(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function fmt(n) { return Number(n || 0).toLocaleString(); }
function chars(n) { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M chars` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k chars` : `${fmt(n)} chars`; }
function dashboardInstancePath(port) {
    return join(dataDir(process.env), `dashboard-${port}.json`);
}
async function previousDashboard(port) {
    if (port === 0)
        return undefined;
    let instance;
    try {
        instance = JSON.parse(await readFile(dashboardInstancePath(port), 'utf8'));
    }
    catch {
        return undefined;
    }
    if (!Number.isSafeInteger(instance?.pid) || instance.pid <= 0 ||
        typeof instance.instanceId !== 'string' || !instance.instanceId ||
        typeof instance.url !== 'string')
        return undefined;
    try {
        const url = new URL(instance.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port || url.pathname !== '/')
            return undefined;
        const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(1000) });
        if (!response.ok)
            return undefined;
        const health = await response.json();
        return health.service === 'jev-compact-dashboard' && health.pid === instance.pid && health.instanceId === instance.instanceId
            ? instance : undefined;
    }
    catch {
        return undefined;
    }
}
async function stopPreviousDashboard(port) {
    const previous = await previousDashboard(port);
    if (!previous)
        return;
    try {
        process.kill(previous.pid);
    }
    catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'))
            throw error;
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        try {
            await fetch(new URL('/api/health', previous.url), { signal: AbortSignal.timeout(500) });
        }
        catch {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`previous Jev dashboard did not stop on port ${port}`);
}
async function launchDashboard(port) {
    await stopPreviousDashboard(port);
    const instanceId = randomUUID();
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'dashboard', '--port', String(port), '--background'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, JEV_COMPACT_DASHBOARD_INSTANCE_ID: instanceId },
    });
    child.unref();
    return new Promise((resolve, reject) => {
        let output = '';
        let errorOutput = '';
        let settled = false;
        const timeout = setTimeout(() => finish(new Error('dashboard did not start within 5 seconds')), 5000);
        const finish = (error, url) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            child.stdout?.destroy();
            child.stderr?.destroy();
            if (error)
                reject(error);
            else
                resolve(url ?? '');
        };
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => {
            output += chunk;
            const line = output.split(/\r?\n/, 1)[0];
            if (line)
                finish(undefined, line);
        });
        child.stderr?.on('data', (chunk) => { errorOutput += chunk; });
        child.once('error', (error) => finish(error));
        child.once('exit', (code) => finish(new Error(errorOutput.trim() || `dashboard process exited (${code})`)));
    });
}
function help() {
    console.log(`jev-compact

First-time setup:
  jev-compact setup                  TypeSafe: save key + install Codex hooks
  jev-compact setup openrouter       OpenRouter: save key + install Codex hooks
  jev-compact configure PROVIDER     Change provider/key without reinstalling hooks
  jev-compact install                Point Codex hooks at this checkout (development/local use)
  jev-compact doctor                 Verify everything is ready
  jev-compact config                 Show the five user-facing settings
  jev-compact config NAME VALUE      Save a setting (works with desktop Codex too)
  jev-compact config reset           Reset saved user settings to defaults

Useful commands:
  jev-compact dashboard [--port N]   Local measured-impact dashboard
  jev-compact stats [--json]         Measured local compaction statistics
  jev-compact compact FILE [--context FILE] [--json FILE]
                                     Preview Jev selection on a Codex rollout
  jev-compact uninstall              Remove only jev-compact hooks

Environment variables remain supported and override saved configuration.
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
        dataDir: dataDir(process.env),
        settings,
    };
}
function printSettings(settings) {
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
            throw new Error('usage: jev-compact config <restore-mode|restore-max-chars|pin-recent-messages|loss-threshold|min-reduction-ratio> <value>');
        const name = args[0];
        if (!['restore-mode', 'restore-max-chars', 'pin-recent-messages', 'loss-threshold', 'min-reduction-ratio'].includes(name))
            throw new Error(`unknown setting: ${args[0]}`);
        const settings = await setUserSetting(name, args[1], process.env);
        console.log(`Saved ${name}=${args[1]}`);
        printSettings(settings);
        return;
    }
    if (cmd === 'setup') {
        const provider = (args[0] ?? 'typesafe');
        if (provider !== 'typesafe' && provider !== 'openrouter')
            throw new Error('usage: jev-compact setup [typesafe|openrouter]');
        await configureProvider(provider);
        const runtimeCli = await installRuntime(fileURLToPath(import.meta.url), process.env);
        console.log(`Runtime installed: ${runtimeCli}`);
        await installAndExplain(runtimeCli, `node \"${runtimeCli}\"`);
        return;
    }
    if (cmd === 'install') {
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
        console.log(`${value.hooksInstalled ? 'OK' : 'MISSING'}  Codex hooks (${value.hookEvents.join(', ') || 'none'})`);
        console.log(`OK  Node ${value.node}`);
        console.log(`    Model: ${value.model}`);
        console.log(`    Hooks: ${value.hooksFile}`);
        console.log(`    Data:  ${value.dataDir}`);
        console.log(`    Restore: ${value.settings.restoreMode} · max ${fmt(value.settings.restoreMaxChars)} chars`);
        console.log(`    Pruning: loss <= ${value.settings.lossThreshold.toFixed(2)} · pin ${fmt(value.settings.pinRecentMessages)} recent messages · require ${(value.settings.minReductionRatio * 100).toFixed(0)}% reduction`);
        if (value.settings.restoreModeWarning)
            console.log(`WARN  ${value.settings.restoreModeWarning}`);
        if (!value.apiKeyConfigured && !value.hooksInstalled) {
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
        console.log(`Compaction attempts: ${fmt(value.attempts)} · restored: ${fmt(value.restored)} · skips: ${fmt(value.skipped)} · native fallbacks: ${fmt(value.nativeFallbacks)} · restore issues: ${fmt(value.restoreFailures)}`);
        console.log(`Completed retained-copy reduction: ${chars(value.completedCharsRemoved)} (${(value.completedReductionRatio * 100).toFixed(1)}%)`);
        console.log(`Hook context delivered after compaction: ${chars(value.injectedChars)}`);
        console.log(`  selected evidence inside it: ${chars(value.injectedPayloadChars)}`);
        if (value.jevUsageReportedRequests)
            console.log(`Jev provider usage reported: ${fmt(value.jevInputTokens)} input + ${fmt(value.jevOutputTokens)} output tokens (${fmt(value.jevUsageReportedRequests)}/${fmt(value.jevRequests)} requests reported usage)`);
        else
            console.log(`Jev provider usage: not reported (${fmt(value.jevRequests)} requests observed)`);
        console.log(`Average Jev selection time: ${fmt(value.averageSelectionMs)} ms`);
        return;
    }
    if (cmd === 'dashboard') {
        const requested = flag(args, '--port') ?? args.find((x) => /^\d+$/.test(x));
        const port = requested ? Number(requested) : 43127;
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
            process.stdout.write(`${url}\n`);
            return;
        }
        const url = await launchDashboard(port);
        console.log(`Dashboard: ${url}`);
        return;
    }
    throw new Error(`unknown command: ${cmd}`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
