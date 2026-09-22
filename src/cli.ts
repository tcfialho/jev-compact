#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compactMessages, reductionRatio } from './compact.js';
import { startDashboard, stats } from './dashboard.js';
import { handleHook } from './hooks.js';
import { installHooks, uninstallHooks } from './install.js';
import { providerConfig, resolveApiKey, resolveProvider } from './provider.js';
import { renderMessages } from './render.js';
import { loadCodexRollout } from './rollout.js';
import { dataDir } from './store.js';

async function stdin(): Promise<string> { let s = ''; for await (const chunk of process.stdin) s += chunk; return s; }
function flag(args: string[], name: string): string | undefined { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function help(): void {
  console.log(`codex-jev-compact

Commands:
  install                 Install user-level Codex hooks
  uninstall               Remove only codex-jev-compact hooks
  doctor                  Show provider/config readiness
  compact <rollout.jsonl> [--context FILE] [--json FILE]
                          Preview pruning without changing Codex
  stats [--json]          Show measured local savings
  dashboard [port]        Start local read-only dashboard
  hook                    Internal Codex hook entrypoint

Provider:
  TYPESAFE_API_KEY=...                         direct TypeSafe
  OPENROUTER_API_KEY=... CODEX_JEV_PROVIDER=openrouter
  CODEX_JEV_KEY_FILE=/path/to/key              file fallback for explicitly selected provider
  TYPESAFE_API_KEY_FILE=/path/to/key           TypeSafe-specific file fallback
  OPENROUTER_API_KEY_FILE=/path/to/key         OpenRouter-specific file fallback
`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return help();
  if (cmd === 'hook') { const out = await handleHook(JSON.parse(await stdin())); process.stdout.write(`${JSON.stringify(out)}\n`); return; }
  if (cmd === 'install') { const path = await installHooks(fileURLToPath(import.meta.url)); console.log(`Installed hooks: ${path}\nOpen /hooks in Codex once to review/trust them.`); return; }
  if (cmd === 'uninstall') { console.log(`Updated: ${await uninstallHooks()}`); return; }
  if (cmd === 'doctor') {
    const provider = resolveProvider({ provider: process.env.CODEX_JEV_PROVIDER as any, env: process.env });
    const config = providerConfig({ provider, env: process.env });
    console.log(JSON.stringify({
      node: process.version ?? 'unknown',
      provider,
      apiKey: resolveApiKey(provider, { env: process.env }) ? 'configured' : 'missing',
      model: config.model,
      baseUrl: config.baseUrl,
      dataDir: dataDir(process.env),
    }, null, 2));
    return;
  }
  if (cmd === 'compact') {
    if (!args[0]) throw new Error('compact requires a rollout JSONL path');
    const messages = await loadCodexRollout(args[0]);
    const result = await compactMessages(messages);
    const rendered = renderMessages(result.messages);
    const contextFile = flag(args, '--context');
    const jsonFile = flag(args, '--json');
    if (contextFile) await writeFile(contextFile, `${rendered}\n`);
    else process.stdout.write(`${rendered}\n`);
    if (jsonFile) await writeFile(jsonFile, `${JSON.stringify({ messages: result.messages, decisions: result.decisions, stats: result.stats }, null, 2)}\n`);
    console.error(JSON.stringify({ ...result.stats, reductionRatio: reductionRatio(result) }, null, 2));
    return;
  }
  if (cmd === 'stats') {
    const value = await stats();
    if (args.includes('--json')) console.log(JSON.stringify(value, null, 2));
    else console.log(`${value.estimatedPrunedTokens.toLocaleString()} estimated retained-history tokens pruned · ${value.estimatedRestoreTokensAvoided.toLocaleString()} reinjection tokens avoided vs full restore · ${value.jevInputTokens.toLocaleString()} measured Jev input tokens · ${value.compactions} compactions · ${value.failures} failures`);
    return;
  }
  if (cmd === 'dashboard') { await startDashboard(Number(args[0]) || 43127); return; }
  throw new Error(`unknown command: ${cmd}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
