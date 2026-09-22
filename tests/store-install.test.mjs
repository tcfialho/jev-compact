import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareState, markReady, claimReady, dataDir, messagesPath, statePath, sweep } from '../dist/store.js';
import { installHooks } from '../dist/install.js';

const stats = { messagesBefore: 2, messagesAfter: 1, charsBefore: 1000, charsAfter: 300, calls: 1, kept: 0, resultsTruncated: 0, callsDropped: 1, pinned: 0, stateTokens: 100, stateStage: 'full', requests: 1, jevInputTokens: 0, jevOutputTokens: 0, ms: 5 };

test('restore state is only claimable once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-state-'));
  const env = { JEV_COMPACT_DATA_DIR: root };
  await prepareState({ sessionId: 's1', turnId: 't1', createdAt: new Date().toISOString(), stats, decisions: [], index: 'index' }, 'context', env, [{ role: 'developer', text: 'constraint', toolCalls: [] }]);
  assert.match(await readFile(messagesPath('s1', env), 'utf8'), /developer/);
  assert.ok(await markReady('s1', 't1', env));
  assert.ok(await claimReady('s1', 60000, env));
  assert.equal(await claimReady('s1', 60000, env), undefined);
});

test('installer preserves existing hooks and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-install-'));
  const file = join(root, 'hooks.json');
  await writeFile(file, JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } }));
  const env = { CODEX_HOOKS_FILE: file };
  await installHooks('/repo/jev-compact/dist/cli.js', env);
  await installHooks('/repo/jev-compact/dist/cli.js', env);
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.hooks.PreCompact.filter((x) => x.hooks.some((h) => h.command.includes('jev-compact'))).length, 1);
  assert.equal(config.hooks.PreCompact.some((x) => x.hooks.some((h) => h.command === 'echo existing')), true);
  assert.equal(config.hooks.UserPromptSubmit.length, 1);
  assert.match(config.hooks.PreCompact.at(-1).hooks[0].commandWindows, /jev-compact/);
});

import { handleHook } from '../dist/hooks.js';

test('index restore mode injects compact index once, not full retained archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-restore-'));
  const env = { JEV_COMPACT_DATA_DIR: root, JEV_COMPACT_RESTORE_MODE: 'index' };
  await prepareState({ sessionId: 's2', turnId: 't2', createdAt: new Date().toISOString(), stats, decisions: [], index: 'SMALL INDEX' }, 'x'.repeat(20000), env);
  await markReady('s2', 't2', env);
  const first = await handleHook({ session_id: 's2', hook_event_name: 'SessionStart', source: 'compact' }, env);
  const text = first.hookSpecificOutput.additionalContext;
  assert.ok(text.includes('SMALL INDEX'));
  assert.ok(text.length < 2000);
  const second = await handleHook({ session_id: 's2', hook_event_name: 'UserPromptSubmit' }, env);
  assert.equal(second.hookSpecificOutput, undefined);
});

import { renderIndex } from '../dist/render.js';

test('compact index has an internal character budget', () => {
  const messages = [{ role: 'user', text: 'constraint', toolCalls: [], toolResults: Array.from({ length: 50 }, (_, i) => ({ callId: `c${i}`, output: 'x'.repeat(500) })) }];
  const decisions = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, callId: `c${i}`, name: 'read', inputPreview: `file-${i}`, dropLoss: 0.9, truncateLoss: 0.9, action: 'keep', resultChars: 500, savedChars: 0, pinned: false }));
  const index = renderIndex(messages, decisions, 2000);
  assert.ok(index.length <= 2000);
  assert.match(index, /older retained calls omitted/);
});


test('PLUGIN_DATA wins and stale sidecars are swept', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-plugin-data-'));
  const other = join(root, 'other');
  const env = { PLUGIN_DATA: join(root, 'plugin'), JEV_COMPACT_DATA_DIR: other };
  assert.equal(dataDir(env), env.PLUGIN_DATA);
  await prepareState({ sessionId: 'old', createdAt: new Date(0).toISOString(), stats, decisions: [], index: 'x' }, 'context', env);
  const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
  await utimes(statePath('old', env), old, old);
  const removed = await sweep(env, 48 * 60 * 60 * 1000);
  assert.ok(removed >= 1);
  await assert.rejects(access(statePath('old', env)));
});


test('full restore remains the default base-compatible behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-full-default-'));
  const env = { JEV_COMPACT_DATA_DIR: root };
  await prepareState({ sessionId: 'sfull', createdAt: new Date().toISOString(), stats, decisions: [], index: 'INDEX ONLY' }, 'verbatim retained evidence', env, [{ role: 'developer', text: 'verbatim retained evidence', toolCalls: [] }]);
  await markReady('sfull', undefined, env);
  const restored = await handleHook({ session_id: 'sfull', hook_event_name: 'SessionStart', source: 'compact' }, env);
  assert.match(restored.hookSpecificOutput.additionalContext, /verbatim retained evidence/);
});

test('a new PreCompact invalidates stale pending state before any early fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-stale-state-'));
  const env = { JEV_COMPACT_DATA_DIR: root };
  await prepareState({ sessionId: 'stale', turnId: 'old-turn', createdAt: new Date().toISOString(), stats, decisions: [], index: 'old index' }, 'old retained context', env);
  const pre = await handleHook({ session_id: 'stale', turn_id: 'new-turn', hook_event_name: 'PreCompact', transcript_path: null }, env);
  assert.match(pre.systemMessage, /native compaction only/);
  await handleHook({ session_id: 'stale', turn_id: 'new-turn', hook_event_name: 'PostCompact' }, env);
  const restored = await handleHook({ session_id: 'stale', hook_event_name: 'SessionStart', source: 'compact' }, env);
  assert.equal(restored.hookSpecificOutput, undefined);
});

test('full restore global cap stays within configured character budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-cap-'));
  const env = { JEV_COMPACT_DATA_DIR: root, JEV_COMPACT_CONTEXT_CHARS: '1000' };
  await prepareState({ sessionId: 'cap', createdAt: new Date().toISOString(), stats, decisions: [], index: 'index' }, 'z'.repeat(5000), env);
  await markReady('cap', undefined, env);
  const restored = await handleHook({ session_id: 'cap', hook_event_name: 'SessionStart', source: 'compact' }, env);
  const injected = restored.hookSpecificOutput.additionalContext;
  assert.match(injected, /chars omitted from middle/);
  assert.ok(injected.length < 1500);
});
