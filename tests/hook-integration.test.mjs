import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleHook } from '../dist/hooks.js';

test('PreCompact -> PostCompact -> SessionStart works end to end', async (t) => {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const answers = Object.fromEntries(Object.keys(payload.questions).map((key) => [key, { noul: 0.01 }]));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const root = await mkdtemp(join(tmpdir(), 'jev-hook-'));
  const rollout = join(root, 'rollout.jsonl');
  const rows = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'Fix login and preserve this constraint.' }] } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'grep', arguments: '{"q":"old"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'x'.repeat(3000) } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Diagnosis complete.' }] } }
  ];
  await writeFile(rollout, rows.map(JSON.stringify).join('\n'));
  const env = {
    JEV_COMPACT_DATA_DIR: join(root, 'data'), JEV_COMPACT_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'test',
    JEV_BASE_URL: `http://127.0.0.1:${port}`, JEV_COMPACT_PRESERVE_RECENT: '0', JEV_COMPACT_MIN_REDUCTION: '0', JEV_COMPACT_RETRIES: '0'
  };
  const pre = await handleHook({ session_id: 's', turn_id: 't', hook_event_name: 'PreCompact', transcript_path: rollout, trigger: 'manual', model: 'gpt-test' }, env);
  assert.match(pre.systemMessage, /prepared/);
  const post = await handleHook({ session_id: 's', turn_id: 't', hook_event_name: 'PostCompact', trigger: 'manual' }, env);
  assert.equal(post.continue, true);
  const start = await handleHook({ session_id: 's', hook_event_name: 'SessionStart', source: 'compact' }, env);
  assert.match(start.hookSpecificOutput.additionalContext, /Fix login/);
  assert.ok(start.hookSpecificOutput.additionalContext.length < 3000);
});

test('observe mode runs the full compaction analysis but never injects context', async (t) => {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const answers = Object.fromEntries(Object.keys(payload.questions).map((key) => [key, { noul: 0.01 }]));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers, usage: { input_tokens: 123, output_tokens: 4 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const root = await mkdtemp(join(tmpdir(), 'jev-hook-observe-'));
  const rollout = join(root, 'rollout.jsonl');
  const rows = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'Keep this exact constraint.' }] } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'grep', arguments: '{"q":"old"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'x'.repeat(3000) } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Diagnosis complete.' }] } },
  ];
  const before = rows.map(JSON.stringify).join('\n');
  await writeFile(rollout, before);
  const env = {
    JEV_COMPACT_DATA_DIR: join(root, 'data'), JEV_COMPACT_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'test',
    JEV_BASE_URL: `http://127.0.0.1:${port}`, JEV_COMPACT_PRESERVE_RECENT: '0',
    JEV_COMPACT_MIN_REDUCTION: '1', JEV_COMPACT_RETRIES: '0', JEV_COMPACT_MODE: 'observe',
  };
  const pre = await handleHook({ session_id: 'observe-e2e', turn_id: 't', hook_event_name: 'PreCompact', transcript_path: rollout, trigger: 'manual' }, env);
  assert.equal(pre.systemMessage, undefined);
  assert.equal(pre.continue, true);

  const compacted = { type: 'compacted', payload: { window_number: 2, replacement_history: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep this exact constraint.' }] },
  ] } };
  await writeFile(rollout, `${before}\n${JSON.stringify(compacted)}\n`);
  await handleHook({ session_id: 'observe-e2e', turn_id: 't', hook_event_name: 'PostCompact', trigger: 'manual' }, env);
  const start = await handleHook({ session_id: 'observe-e2e', hook_event_name: 'SessionStart', source: 'compact', transcript_path: rollout }, env);
  assert.equal(start.hookSpecificOutput, undefined);

  const history = (await readFile(join(env.JEV_COMPACT_DATA_DIR, 'history.jsonl'), 'utf8')).trim().split(/\n/).map(JSON.parse);
  const prepared = history.find((row) => row.status === 'prepared');
  const observed = history.find((row) => row.status === 'observed');
  assert.equal(prepared.operationMode, 'observe');
  assert.equal(prepared.wouldApply, false); // active mode would have skipped at the 100% minimum.
  assert.equal(observed.membershipStatus, 'verified');
  assert.equal(observed.wouldApply, false);
  assert.equal(observed.wouldInjectPayloadChars, 0);
});
