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
    JEVCOMP_DATA_DIR: join(root, 'data'), JEVCOMP_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'test',
    JEV_BASE_URL: `http://127.0.0.1:${port}`, JEVCOMP_PRESERVE_RECENT: '0', JEVCOMP_MIN_REDUCTION: '0', JEVCOMP_RETRIES: '0'
  };
  const pre = await handleHook({ session_id: 's', turn_id: 't', hook_event_name: 'PreCompact', transcript_path: rollout, trigger: 'manual', model: 'gpt-test' }, env);
  assert.match(pre.systemMessage, /kept what still matters/);
  const post = await handleHook({ session_id: 's', turn_id: 't', hook_event_name: 'PostCompact', trigger: 'manual' }, env);
  assert.equal(post.continue, true);
  const start = await handleHook({ session_id: 's', hook_event_name: 'SessionStart', source: 'compact' }, env);
  assert.match(start.hookSpecificOutput.additionalContext, /Fix login/);
  assert.ok(start.hookSpecificOutput.additionalContext.length < 3000);
});

test('restore leaves out old developer instructions and the previous jevcomp restore', async (t) => {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const answers = Object.fromEntries(Object.keys(JSON.parse(body).questions).map((key) => [key, { noul: 0.01 }]));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = await mkdtemp(join(tmpdir(), 'jev-hook-dev-'));
  const rollout = join(root, 'rollout.jsonl');
  const developer = (text) => ({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text }] } });
  const rows = [
    developer('<skills_instructions>old skills list</skills_instructions>'),
    developer('Codex compacted this session. Jev selected useful pre-compaction evidence. [user] earlier restore'),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'Fix login and preserve this constraint.' }] } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'grep', arguments: '{"q":"old"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'x'.repeat(3000) } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Diagnosis complete.' }] } }
  ];
  await writeFile(rollout, rows.map(JSON.stringify).join('\n'));
  const env = {
    JEVCOMP_DATA_DIR: join(root, 'data'), JEVCOMP_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'test',
    JEV_BASE_URL: `http://127.0.0.1:${server.address().port}`, JEVCOMP_PRESERVE_RECENT: '0', JEVCOMP_MIN_REDUCTION: '0', JEVCOMP_RETRIES: '0'
  };
  await handleHook({ session_id: 's', turn_id: 't', hook_event_name: 'PreCompact', transcript_path: rollout, trigger: 'manual' }, env);
  await handleHook({ session_id: 's', turn_id: 't', hook_event_name: 'PostCompact', trigger: 'manual' }, env);
  const start = await handleHook({ session_id: 's', hook_event_name: 'SessionStart', source: 'compact' }, env);
  const injected = start.hookSpecificOutput.additionalContext;
  assert.match(injected, /Diagnosis complete/);
  assert.doesNotMatch(injected, /old skills list/);
  assert.doesNotMatch(injected, /earlier restore/);
});
