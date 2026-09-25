#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactMessages, reductionRatio } from './compact.js';
import { startDashboard } from './dashboard.js';
import { dashboardInstancePath, dashboardPort, restartDashboard, runningDashboard, stopDashboard } from './dashboard-service.js';
import { handleHook } from './hooks.js';
import { resetUserSettings, setUserSetting, userSettings } from './settings.js';
import { describeSettings, runSettingsMenu, SETTINGS_ITEMS } from './settings-menu.js';
import { inspectHooks, installHooks, installRuntime, runtimeDir, uninstallHooks } from './install.js';
import { adoptLegacyEnvironment, migrateLegacyConfig } from './legacy.js';
import { enabledPluginRoot } from './plugin-installation.js';
import { configDir, hasSavedProviderKey, providerConfig, resolveApiKey, resolveProvider, saveProviderConfiguration } from './provider.js';
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
    const command = pluginRoot ? `node "${join(pluginRoot, 'dist', 'cli.js')}"` : 'jevcomp';
    console.log(`jevcomp

  ${command} install      Connect jevcomp to Codex: choose OpenRouter or TypeSafe and enter your key
  ${' '.repeat(command.length)}              (run it again to change them)
  ${command} settings     Change how jevcomp behaves
  ${command} doctor       Check that everything works
  ${command} dashboard    Restart the dashboard
  ${command} uninstall    Remove jevcomp from Codex (your key and history are kept)

Dashboard: ${dashboardAddress()} (opens with each Codex session)`);
}
function dashboardAddress() { return `http://127.0.0.1:${dashboardPort(process.env)}/`; }
async function ask(question) {
    process.stdout.write(question);
    process.stdin.resume();
    return new Promise((resolve) => {
        process.stdin.once('data', (chunk) => { process.stdin.pause(); resolve(String(chunk).trim()); });
    });
}
function interactive() { return !!process.stdin.isTTY && !!process.stdout.isTTY; }
async function chooseProvider(requested) {
    if (requested === 'openrouter' || requested === 'typesafe')
        return requested;
    if (requested)
        throw new Error('usage: jevcomp install [openrouter|typesafe]');
    const current = resolveProvider({ env: process.env });
    if (!interactive())
        return current;
    const answer = await ask(`Provider: 1) OpenRouter  2) TypeSafe  [${current === 'openrouter' ? 1 : 2}]: `);
    if (!answer)
        return current;
    if (answer === '1' || /^openrouter$/i.test(answer))
        return 'openrouter';
    if (answer === '2' || /^typesafe$/i.test(answer))
        return 'typesafe';
    throw new Error(`unknown provider: ${answer}`);
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
    const provider = resolveProvider({ provider: process.env.JEVCOMP_PROVIDER, env: process.env });
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
function printSettings() {
    const rows = describeSettings(process.env);
    const width = Math.max(...rows.map((row) => row.title.length)) + 4;
    for (const row of rows)
        console.log(`${row.title.padEnd(width)}${row.value}${row.lockedBy ? ` (set by ${row.lockedBy})` : ''}`);
}
async function saveKey(provider) {
    const label = provider === 'typesafe' ? 'TypeSafe' : 'OpenRouter';
    const saved = hasSavedProviderKey(provider, process.env);
    if (saved && !interactive())
        return;
    const key = await secret(`${label} API key${saved ? ' (Enter keeps the saved key)' : ''}: `);
    if (key) {
        await saveProviderConfiguration(provider, key, process.env);
        console.log(`${label} key saved.`);
        return;
    }
    if (saved)
        return;
    if (resolveApiKey(provider, { env: process.env })) {
        console.log(`Using the ${label} key from this terminal's environment; Codex opened elsewhere may not see it.`);
        return;
    }
    throw new Error(`${label} API key is required`);
}
async function install(requestedProvider) {
    const provider = await chooseProvider(requestedProvider);
    await saveKey(provider);
    if (enabledPluginRoot()) {
        await uninstallHooks();
        console.log('Codex plugin detected. In Codex, type /hooks and approve the four jevcomp hooks.');
    }
    else {
        const runtimeCli = await installRuntime(fileURLToPath(import.meta.url), process.env);
        await installHooks(runtimeCli);
        console.log('Connected to Codex. Restart Codex, type /hooks and approve the four jevcomp hooks.');
    }
    console.log(`Dashboard: ${dashboardAddress()} (opens with each Codex session)`);
}
function pluginId(pluginRoot) {
    return `jevcomp@${basename(dirname(dirname(pluginRoot)))}`;
}
async function uninstall() {
    const pluginRoot = enabledPluginRoot();
    await stopDashboard(dashboardPort(process.env), process.env);
    await uninstallHooks();
    if (pluginRoot)
        execFileSync('codex', ['plugin', 'remove', pluginId(pluginRoot)], { stdio: 'inherit', windowsHide: true });
    else
        await rm(runtimeDir(process.env), { recursive: true, force: true });
    console.log('jevcomp was removed from Codex.');
    console.log(`Kept your key and settings: ${configDir(process.env)}`);
    console.log(`Kept your history: ${dataDir(process.env)}`);
    console.log('Delete those folders to erase them too.');
    if (fileURLToPath(import.meta.url).includes(`node_modules${sep}jevcomp${sep}`))
        console.log('To remove the jevcomp command as well: npm uninstall -g jevcomp');
}
async function main() {
    adoptLegacyEnvironment(process.env);
    migrateLegacyConfig(process.env);
    const [cmd, ...args] = process.argv.slice(2);
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h')
        return help();
    if (cmd === 'hook') {
        const out = await handleHook(JSON.parse(await stdin()), process.env, { startDashboard: true });
        process.stdout.write(`${JSON.stringify(out)}\n`);
        return;
    }
    if (cmd === 'settings') {
        if (args[0] === 'reset') {
            await resetUserSettings(process.env);
            printSettings();
            return;
        }
        if (args.length >= 2) {
            const name = args[0];
            if (!SETTINGS_ITEMS.some((item) => item.name === name))
                throw new Error(`unknown setting: ${args[0]}`);
            await setUserSetting(name, args[1], process.env);
            printSettings();
            return;
        }
        if (!interactive()) {
            printSettings();
            return;
        }
        await runSettingsMenu({ input: process.stdin, output: process.stdout }, process.env);
        return;
    }
    if (cmd === 'install') {
        await install(args[0]);
        return;
    }
    if (cmd === 'uninstall') {
        await uninstall();
        return;
    }
    if (cmd === 'doctor') {
        const value = await readiness();
        if (args.includes('--json')) {
            console.log(JSON.stringify(value, null, 2));
            return;
        }
        console.log(`jevcomp doctor\n`);
        console.log(`${value.apiKeyConfigured ? 'OK' : 'MISSING'}  API key (${value.provider})`);
        if (value.pluginRoot)
            console.log('CHECK  Plugin hooks: open /hooks and confirm four active');
        else
            console.log(`${value.hooksInstalled ? 'OK' : 'MISSING'}  Codex hooks (${value.hookEvents.join(', ') || 'none'})`);
        console.log(`OK  Node ${value.node}`);
        console.log(`    Model: ${value.model}`);
        console.log(`    Hooks: ${value.pluginRoot ? join(value.pluginRoot, 'hooks', 'hooks.json') : value.hooksFile}`);
        console.log(`    Data:  ${value.dataDir}`);
        console.log(`    Dashboard: ${value.dashboardUrl ?? `${dashboardAddress()} (not running; starts with the next Codex session)`}`);
        console.log(`    Restore: ${value.settings.restoreMode} · max ${fmt(value.settings.restoreMaxChars)} chars`);
        console.log(`    Pruning: loss <= ${value.settings.lossThreshold.toFixed(2)} · pin ${fmt(value.settings.pinRecentMessages)} recent messages · require ${(value.settings.minReductionRatio * 100).toFixed(0)}% reduction`);
        if (value.settings.restoreModeWarning)
            console.log(`WARN  ${value.settings.restoreModeWarning}`);
        if (!value.apiKeyConfigured || (!value.pluginRoot && !value.hooksInstalled)) {
            console.log(`\nFix: ${value.pluginRoot ? `node "${fileURLToPath(import.meta.url)}"` : 'jevcomp'} install`);
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
    if (cmd === 'dashboard') {
        const requested = flag(args, '--port') ?? args.find((x) => /^\d+$/.test(x));
        const port = requested ? Number(requested) : dashboardPort(process.env);
        if (args.includes('--background')) {
            const instanceId = process.env.JEVCOMP_DASHBOARD_INSTANCE_ID ?? randomUUID();
            process.env.JEVCOMP_DASHBOARD_INSTANCE_ID = instanceId;
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
        const url = await restartDashboard(port, process.env);
        console.log(`Dashboard: ${url}`);
        return;
    }
    throw new Error(`unknown command: ${cmd}`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
