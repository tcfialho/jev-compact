import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, utimes, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareState, markReady, claimReady, dataDir, messagesPath, statePath, sweep } from '../dist/store.js';
import { installHooks, inspectHooks, installRuntime, runtimeDir, uninstallHooks } from '../dist/install.js';

const stats = { messagesBefore: 2, messagesAfter: 1, charsBefore: 1000, charsAfter: 300, calls: 1, kept: 0, resultsTruncated: 0, callsDropped: 1, pinned: 0, stateTokens: 100, stateStage: 'full', requests: 1, jevInputTokens: 0, jevOutputTokens: 0, ms: 5 };

test('restore state is only claimable once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-state-'));
  const env = { JEVCOMP_DATA_DIR: root };
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
  await installHooks('/repo/jevcomp/dist/cli.js', env);
  await installHooks('/repo/jevcomp/dist/cli.js', env);
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.hooks.PreCompact.filter((x) => x.hooks.some((h) => h.command.includes('jevcomp'))).length, 1);
  assert.equal(config.hooks.PreCompact.some((x) => x.hooks.some((h) => h.command === 'echo existing')), true);
  assert.equal(config.hooks.UserPromptSubmit.length, 1);
  assert.match(config.hooks.PreCompact.at(-1).hooks[0].commandWindows, /jevcomp/);
  assert.equal(config.hooks.SessionStart.at(-1).hooks[0].additionalContextLimit, 0);
  assert.equal(config.hooks.UserPromptSubmit.at(-1).hooks[0].additionalContextLimit, 0);
  assert.equal((await readdir(root)).filter((name) => name.startsWith('hooks.json.bak.')).length, 1);
  const inspected = await inspectHooks(env);
  assert.equal(inspected.installed, true);
  assert.deepEqual(inspected.events, ['PostCompact', 'PreCompact', 'SessionStart', 'UserPromptSubmit']);
});

test('installer never overwrites an existing malformed hooks file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-install-invalid-'));
  const file = join(root, 'hooks.json');
  const broken = '{ this is not valid json';
  await writeFile(file, broken);
  await assert.rejects(installHooks('/repo/jevcomp/dist/cli.js', { CODEX_HOOKS_FILE: file }), /invalid JSON/);
  assert.equal(await readFile(file, 'utf8'), broken);
});

test('custom Codex home keeps hooks, runtime and data together', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-codex-home-'));
  const env = { CODEX_HOME: root };
  assert.equal((await inspectHooks(env)).path, join(root, 'hooks.json'));
  assert.equal(runtimeDir(env), join(root, 'jevcomp', 'runtime'));
  assert.equal(dataDir(env), join(root, 'jevcomp'));
});

test('legacy hook removal preserves other commands in the same entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-mixed-hooks-'));
  const file = join(root, 'hooks.json');
  await writeFile(file, JSON.stringify({ hooks: { PreCompact: [{ matcher: 'manual', hooks: [
    { type: 'command', command: 'node legacy hook --jevcomp' },
    { type: 'command', command: 'node unrelated.js' },
  ] }] } }));
  await uninstallHooks({ CODEX_HOOKS_FILE: file });
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.hooks.PreCompact[0].matcher, 'manual');
  assert.deepEqual(config.hooks.PreCompact[0].hooks, [{ type: 'command', command: 'node unrelated.js' }]);
  assert.equal((await readdir(root)).filter((name) => name.startsWith('hooks.json.bak.')).length, 1);
});

import { handleHook } from '../dist/hooks.js';

test('plugin migrates legacy hooks without running twice in the same session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-plugin-migration-'));
  const file = join(root, 'hooks.json');
  await writeFile(file, JSON.stringify({ hooks: { PreCompact: [{ hooks: [
    { type: 'command', command: 'node legacy hook --jevcomp' },
  ] }] } }));
  const env = { PLUGIN_ROOT: join(root, 'plugin'), CODEX_HOME: root, CODEX_HOOKS_FILE: file, JEVCOMP_DATA_DIR: join(root, 'data') };
  const event = { session_id: 'migration-session', hook_event_name: 'PreCompact', transcript_path: null };
  const first = await handleHook({ session_id: 'migration-session', hook_event_name: 'SessionStart', source: 'startup' }, env);
  assert.equal(first.systemMessage, undefined);
  assert.equal((await inspectHooks(env)).events.length, 0);
  const sameSession = await handleHook(event, env);
  assert.equal(sameSession.systemMessage, undefined);
  await handleHook({ session_id: 'migration-session', hook_event_name: 'SessionStart', source: 'resume' }, env);
  const nextSession = await handleHook(event, env);
  assert.match(nextSession.systemMessage, /compacts without jevcomp/);
});

test('plugin startup reports a missing key from its own environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-plugin-key-'));
  const env = { PLUGIN_ROOT: join(root, 'plugin'), CODEX_HOME: root, JEVCOMP_CONFIG_DIR: join(root, 'config') };
  const result = await handleHook({ session_id: 'missing-key', hook_event_name: 'SessionStart', source: 'startup' }, env);
  assert.match(result.systemMessage, /needs an API key/);
});

test('plugin reports a migration error and preserves older hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-migration-error-'));
  const hookFile = join(root, 'hooks.json');
  await writeFile(hookFile, JSON.stringify({ hooks: { PreCompact: [{ hooks: [
    { type: 'command', command: 'node legacy hook --jevcomp' },
  ] }] } }));
  await mkdir(join(root, 'jevcomp'));
  await writeFile(join(root, 'jevcomp', 'migrations'), 'blocked');
  const env = { PLUGIN_ROOT: join(root, 'plugin'), CODEX_HOME: root, CODEX_HOOKS_FILE: hookFile };
  const result = await handleHook({ session_id: 'migration-error', hook_event_name: 'SessionStart', source: 'startup' }, env);
  assert.match(result.systemMessage, /could not migrate older hooks/);
  assert.deepEqual((await inspectHooks(env)).events, ['PreCompact']);
});

test('index restore mode injects compact index once, not full retained archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-restore-'));
  const env = { JEVCOMP_DATA_DIR: root, JEVCOMP_RESTORE_MODE: 'index' };
  await prepareState({ sessionId: 's2', turnId: 't2', createdAt: new Date().toISOString(), stats, decisions: [], index: 'SMALL INDEX' }, 'x'.repeat(20000), env);
  await markReady('s2', 't2', env);
  const first = await handleHook({ session_id: 's2', hook_event_name: 'SessionStart', source: 'compact' }, env);
  const text = first.hookSpecificOutput.additionalContext;
  assert.ok(text.includes('SMALL INDEX'));
  assert.ok(text.length < 2000);
  const second = await handleHook({ session_id: 's2', hook_event_name: 'UserPromptSubmit' }, env);
  assert.equal(second.hookSpecificOutput, undefined);
});

import { capContext, renderIndex } from '../dist/render.js';

test('compact index has an internal character budget', () => {
  const messages = [{ role: 'user', text: 'constraint', toolCalls: [], toolResults: Array.from({ length: 50 }, (_, i) => ({ callId: `c${i}`, output: 'x'.repeat(500) })) }];
  const decisions = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, callId: `c${i}`, name: 'read', inputPreview: `file-${i}`, dropLoss: 0.9, truncateLoss: 0.9, action: 'keep', resultChars: 500, savedChars: 0, pinned: false }));
  const index = renderIndex(messages, decisions, 2000);
  assert.ok(index.length <= 2000);
  assert.match(index, /older retained calls omitted/);
});

test('context cap is a hard cap even when smaller than the omission marker', () => {
  const source = 'abcdefghijklmnopqrstuvwxyz'.repeat(100);
  for (const limit of [1, 5, 16, 40, 80]) {
    const capped = capContext(source, limit);
    assert.ok(capped.length <= limit, `limit ${limit} produced ${capped.length} chars`);
    assert.notEqual(capped, source);
  }
});


test('PLUGIN_DATA wins and stale sidecars are swept', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-plugin-data-'));
  const other = join(root, 'other');
  const env = { PLUGIN_DATA: join(root, 'plugin'), JEVCOMP_DATA_DIR: other };
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
  const env = { JEVCOMP_DATA_DIR: root };
  await prepareState({ sessionId: 'sfull', createdAt: new Date().toISOString(), stats, decisions: [], index: 'INDEX ONLY' }, 'verbatim retained evidence', env, [{ role: 'developer', text: 'verbatim retained evidence', toolCalls: [] }]);
  await markReady('sfull', undefined, env);
  const restored = await handleHook({ session_id: 'sfull', hook_event_name: 'SessionStart', source: 'compact' }, env);
  assert.match(restored.hookSpecificOutput.additionalContext, /verbatim retained evidence/);
});

test('a new PreCompact invalidates stale pending state before any early fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-stale-state-'));
  const env = { JEVCOMP_DATA_DIR: root };
  await prepareState({ sessionId: 'stale', turnId: 'old-turn', createdAt: new Date().toISOString(), stats, decisions: [], index: 'old index' }, 'old retained context', env);
  const pre = await handleHook({ session_id: 'stale', turn_id: 'new-turn', hook_event_name: 'PreCompact', transcript_path: null }, env);
  assert.match(pre.systemMessage, /compacts without jevcomp/);
  await handleHook({ session_id: 'stale', turn_id: 'new-turn', hook_event_name: 'PostCompact' }, env);
  const restored = await handleHook({ session_id: 'stale', hook_event_name: 'SessionStart', source: 'compact' }, env);
  assert.equal(restored.hookSpecificOutput, undefined);
});

test('full restore global cap stays within configured character budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-cap-'));
  const env = { JEVCOMP_DATA_DIR: root, JEVCOMP_CONTEXT_CHARS: '1000' };
  await prepareState({ sessionId: 'cap', createdAt: new Date().toISOString(), stats, decisions: [], index: 'index' }, 'z'.repeat(5000), env);
  await markReady('cap', undefined, env);
  const restored = await handleHook({ session_id: 'cap', hook_event_name: 'SessionStart', source: 'compact' }, env);
  const injected = restored.hookSpecificOutput.additionalContext;
  assert.match(injected, /chars omitted from middle/);
  assert.ok(injected.length < 1500);
});


test('restore does not consume ready state when retained archive is temporarily unreadable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-restore-retry-'));
  const env = { JEVCOMP_DATA_DIR: root };
  await prepareState({ sessionId: 'retry', createdAt: new Date().toISOString(), stats, decisions: [], index: 'index' }, 'recoverable context', env);
  await markReady('retry', undefined, env);
  const contextFile = join(root, 'sessions', 'retry.context.txt');
  await rm(contextFile);
  const first = await handleHook({ session_id: 'retry', hook_event_name: 'SessionStart', source: 'compact' }, env);
  assert.equal(first.hookSpecificOutput, undefined);
  const stateAfterFailure = JSON.parse(await readFile(statePath('retry', env), 'utf8'));
  assert.equal(stateAfterFailure.consumed, false);
  await writeFile(contextFile, 'recoverable context');
  const second = await handleHook({ session_id: 'retry', hook_event_name: 'UserPromptSubmit' }, env);
  assert.match(second.hookSpecificOutput.additionalContext, /recoverable context/);
});

test('unknown restore mode defaults to full instead of silently using aggressive index mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-restore-mode-'));
  const env = { JEVCOMP_DATA_DIR: root, JEVCOMP_RESTORE_MODE: 'typo' };
  await prepareState({ sessionId: 'mode', createdAt: new Date().toISOString(), stats, decisions: [], index: 'INDEX ONLY' }, 'full retained evidence', env);
  await markReady('mode', undefined, env);
  const restored = await handleHook({ session_id: 'mode', hook_event_name: 'SessionStart', source: 'compact' }, env);
  assert.match(restored.hookSpecificOutput.additionalContext, /full retained evidence/);
});

test('preferred restore names and max-char option are accepted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-preferred-options-'));
  const minimalEnv = { JEVCOMP_DATA_DIR: root, JEVCOMP_RESTORE_MODE: 'minimal' };
  await prepareState({ sessionId: 'preferred-minimal', createdAt: new Date().toISOString(), stats, decisions: [], index: 'SMALL PREFERRED INDEX' }, 'x'.repeat(5000), minimalEnv);
  await markReady('preferred-minimal', undefined, minimalEnv);
  const minimal = await handleHook({ session_id: 'preferred-minimal', hook_event_name: 'SessionStart', source: 'compact' }, minimalEnv);
  assert.match(minimal.hookSpecificOutput.additionalContext, /SMALL PREFERRED INDEX/);
  assert.ok(minimal.hookSpecificOutput.additionalContext.length < 1500);

  const preserveEnv = { JEVCOMP_DATA_DIR: root, JEVCOMP_RESTORE_MODE: 'preserve', JEVCOMP_RESTORE_MAX_CHARS: '900' };
  await prepareState({ sessionId: 'preferred-preserve', createdAt: new Date().toISOString(), stats, decisions: [], index: 'index' }, 'z'.repeat(5000), preserveEnv);
  await markReady('preferred-preserve', undefined, preserveEnv);
  const preserve = await handleHook({ session_id: 'preferred-preserve', hook_event_name: 'SessionStart', source: 'compact' }, preserveEnv);
  assert.match(preserve.hookSpecificOutput.additionalContext, /chars omitted from middle/);
  assert.ok(preserve.hookSpecificOutput.additionalContext.length < 1400);
});


test('history logging failure never blocks restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-history-failure-'));
  const env = { JEVCOMP_DATA_DIR: root };
  await prepareState({ sessionId: 'history-fail', createdAt: new Date().toISOString(), stats, decisions: [], index: 'index' }, 'retained despite logging failure', env);
  await markReady('history-fail', undefined, env);
  await mkdir(join(root, 'history.jsonl')); // appendFile will fail with EISDIR/illegal operation.
  const restored = await handleHook({ session_id: 'history-fail', hook_event_name: 'SessionStart', source: 'compact' }, env);
  assert.match(restored.hookSpecificOutput.additionalContext, /retained despite logging failure/);
  const consumed = JSON.parse(await readFile(statePath('history-fail', env), 'utf8'));
  assert.equal(consumed.consumed, true);
});


test('setup runtime copy survives moving the original checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-runtime-'));
  const source = join(root, 'source-dist');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'cli.js'), 'console.log("runtime")\n');
  await writeFile(join(source, 'hooks.js'), 'export const ok = true;\n');
  const env = { JEVCOMP_RUNTIME_DIR: join(root, 'stable-runtime') };
  const cli = await installRuntime(join(source, 'cli.js'), env);
  assert.equal(await readFile(cli, 'utf8'), 'console.log("runtime")\n');
  await rm(source, { recursive: true, force: true });
  assert.equal(await readFile(cli, 'utf8'), 'console.log("runtime")\n');
});

test('orphaned restore claim is recovered after the claiming process is gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-orphan-claim-'));
  const env = { JEVCOMP_DATA_DIR: root };
  await prepareState({ sessionId: 'orphan', createdAt: new Date().toISOString(), stats, decisions: [], index: 'index' }, 'recover me', env);
  await markReady('orphan', undefined, env);
  const stateFile = statePath('orphan', env);
  const claim = `${stateFile}.99999999.claim`;
  await (await import('node:fs/promises')).rename(stateFile, claim);
  const recovered = await claimReady('orphan', 60000, env);
  assert.ok(recovered);
  assert.equal(recovered.sessionId, 'orphan');
});

test('setup runtime upgrades atomically to the new compiled copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-runtime-upgrade-'));
  const env = { JEVCOMP_RUNTIME_DIR: join(root, 'runtime') };
  const v1 = join(root, 'v1');
  const v2 = join(root, 'v2');
  await mkdir(v1, { recursive: true });
  await mkdir(v2, { recursive: true });
  await writeFile(join(v1, 'cli.js'), 'v1\n');
  await writeFile(join(v2, 'cli.js'), 'v2\n');
  await installRuntime(join(v1, 'cli.js'), env);
  const stable = await installRuntime(join(v2, 'cli.js'), env);
  assert.equal(await readFile(stable, 'utf8'), 'v2\n');
  assert.deepEqual((await readdir(join(root, 'runtime'))).sort(), ['dist']);
});

test('restore-max-chars is a hard evidence-payload cap in every restore mode', async () => {
  for (const mode of ['preserve', 'balanced', 'minimal']) {
    const root = await mkdtemp(join(tmpdir(), `jev-global-cap-${mode}-`));
    const env = { JEVCOMP_DATA_DIR: root, JEVCOMP_RESTORE_MODE: mode, JEVCOMP_RESTORE_MAX_CHARS: '300' };
    await prepareState({ sessionId: `global-${mode}`, createdAt: new Date().toISOString(), stats, decisions: [], index: 'I'.repeat(2000) }, 'C'.repeat(5000), env);
    await markReady(`global-${mode}`, undefined, env);
    const restored = await handleHook({ session_id: `global-${mode}`, hook_event_name: 'SessionStart', source: 'compact' }, env);
    const full = restored.hookSpecificOutput.additionalContext;
    const marker = '\n\nFull retained context:';
    const payloadStart = full.indexOf('\n\n') + 2;
    const payloadEnd = full.indexOf(marker, payloadStart);
    const payload = full.slice(payloadStart, payloadEnd);
    assert.ok(payload.length <= 300, `${mode} payload was ${payload.length}`);
  }
});

test('post-compaction dedupe injects only retained evidence still missing verbatim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-dedupe-'));
  const rollout = join(root, 'rollout.jsonl');
  const prefix = `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old context' }] } })}\n`;
  const retainedMessages = [
    { role: 'user', text: 'never edit generated files', toolCalls: [] },
    { role: 'assistant', text: '', toolCalls: [
      { id: 'c1', name: 'read', input: { path: 'a.ts' } },
      { id: 'c2', name: 'read', input: { path: 'b.ts' } },
    ] },
    { role: 'user', text: '', toolCalls: [], toolResults: [
      { callId: 'c1', output: 'already survived result' },
      { callId: 'c2', output: 'still missing result' },
    ] },
  ];
  const compacted = {
    type: 'compacted',
    payload: {
      window_number: 2,
      replacement_history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'never edit generated files' }] },
        { type: 'function_call', call_id: 'c1', name: 'read', arguments: JSON.stringify({ path: 'a.ts' }) },
        { type: 'function_call_output', call_id: 'c1', output: 'already survived result' },
      ],
    },
  };
  await writeFile(rollout, prefix + JSON.stringify(compacted) + '\n');
  const env = { JEVCOMP_DATA_DIR: join(root, 'data') };
  const decisions = [
    { id: 'd1', callId: 'c1', name: 'read', inputPreview: 'a.ts', dropLoss: 0.9, truncateLoss: 0.9, action: 'keep', resultChars: 23, originalChars: 30, savedChars: 0, pinned: false },
    { id: 'd2', callId: 'c2', name: 'read', inputPreview: 'b.ts', dropLoss: 0.9, truncateLoss: 0.9, action: 'keep', resultChars: 20, originalChars: 30, savedChars: 0, pinned: false },
  ];
  await prepareState({
    sessionId: 'dedupe', createdAt: new Date().toISOString(), stats, decisions, index: 'old index',
    transcriptPath: rollout,
    transcriptBytesAtScore: Buffer.byteLength(prefix),
  }, 'retained context', env, retainedMessages);
  await markReady('dedupe', undefined, env);

  const restored = await handleHook({ session_id: 'dedupe', hook_event_name: 'SessionStart', source: 'compact', transcript_path: rollout }, env);
  const text = restored.hookSpecificOutput.additionalContext;
  assert.match(text, /still missing result/);
  assert.doesNotMatch(text, /already survived result/);
  assert.doesNotMatch(text, /never edit generated files/);

  const history = (await readFile(join(env.JEVCOMP_DATA_DIR, 'history.jsonl'), 'utf8')).trim().split(/\n/).map(JSON.parse);
  const row = history.at(-1);
  assert.equal(row.membershipStatus, 'verified');
  assert.equal(row.dedupedToolPairs, 1);
  assert.equal(row.dedupedTextItems, 1);
  assert.ok(row.nativePresentChars > 0);
  assert.ok(row.restoreCandidateChars > 0);
});

test('stale post-compaction checkpoint never suppresses retained evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-dedupe-stale-'));
  const rollout = join(root, 'rollout.jsonl');
  const compacted = `${JSON.stringify({ type: 'compacted', payload: { window_number: 1, replacement_history: [
    { type: 'message', role: 'assistant', content: [{ text: 'older summary' }] },
  ] } })}\n`;
  await writeFile(rollout, compacted);
  const env = { JEVCOMP_DATA_DIR: join(root, 'data') };
  const retainedMessages = [{ role: 'developer', text: 'critical retained evidence', toolCalls: [] }];
  await prepareState({
    sessionId: 'dedupe-stale', createdAt: new Date().toISOString(), stats, decisions: [], index: 'index',
    transcriptPath: rollout,
    // Deliberately after the only checkpoint: this proves the checkpoint is older than our PreCompact snapshot.
    transcriptBytesAtScore: Buffer.byteLength(compacted) + 100,
  }, 'critical retained evidence', env, retainedMessages);
  await markReady('dedupe-stale', undefined, env);
  const restored = await handleHook({ session_id: 'dedupe-stale', hook_event_name: 'SessionStart', source: 'compact', transcript_path: rollout }, env);
  assert.match(restored.hookSpecificOutput.additionalContext, /critical retained evidence/);
  const rows = (await readFile(join(env.JEVCOMP_DATA_DIR, 'history.jsonl'), 'utf8')).trim().split(/\n/).map(JSON.parse);
  assert.equal(rows.at(-1).membershipStatus, 'stale');
});
