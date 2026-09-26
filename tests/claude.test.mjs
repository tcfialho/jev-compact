import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyJevCut, toJevMessages } from '../dist/claude.js';
import { stats } from '../dist/dashboard.js';
import { handleHook } from '../dist/hooks.js';

const use = (id, text) => ({ tool_use_id: id, tool: 'Read', input: { file_path: id }, text });
const result = (id, text) => ({ tool_use_id: id, text, isError: false });
const transcript = () => [
  { role: 'user', text: 'Fix the login bug.', toolUses: [], handle: 'h0' },
  { role: 'assistant', text: '', toolUses: [use('a', 'x'.repeat(4000)), use('b', 'y'.repeat(4000))], handle: 'h1' },
  { role: 'user', text: '', toolUses: [], toolResults: [result('a', 'x'.repeat(4000)), result('b', 'y'.repeat(4000))], handle: 'h2' },
  { role: 'assistant', text: 'Found it.', toolUses: [], handle: 'h3' },
];

test('a Jev cut keeps untouched Claude messages as the engine gave them and rebuilds edited ones', () => {
  const messages = transcript();
  const out = applyJevCut(messages, { dropped: ['a'], truncated: { b: 'yyy [omitted]' } });
  assert.equal(out[0], messages[0]);
  assert.equal(out[3], messages[3]);
  assert.equal(out[1].handle, undefined);
  assert.deepEqual(out[1].toolUses.map((u) => u.tool_use_id), ['b']);
  assert.deepEqual(out[2].toolResults, [{ tool_use_id: 'b', text: 'yyy [omitted]', isError: false }]);
  assert.deepEqual(toJevMessages(messages)[2].toolResults.map((r) => r.callId), ['a', 'b']);
});

test('the claude-compact command runs Jev on a Claude transcript and records it as a Claude run', async (t) => {
  const jev = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const answers = Object.fromEntries(Object.keys(JSON.parse(body).questions).map((key) => [key, { noul: 0.01 }]));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers }));
  });
  await new Promise((resolve) => jev.listen(0, '127.0.0.1', resolve));
  t.after(() => jev.close());
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-'));
  const env = {
    ...process.env, JEVCOMP_DATA_DIR: join(root, 'data'), JEVCOMP_CONFIG_DIR: join(root, 'config'), JEVCOMP_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'test',
    JEV_BASE_URL: `http://127.0.0.1:${jev.address().port}`, JEVCOMP_PIN_RECENT_MESSAGES: '0', JEVCOMP_MIN_REDUCTION_RATIO: '0', JEVCOMP_RETRIES: '0',
  };
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'claude-compact'], { env });
  child.stdin.end(JSON.stringify({ messages: toJevMessages(transcript()) }));
  let output = '';
  for await (const chunk of child.stdout) output += chunk;
  const cut = JSON.parse(output);
  assert.equal(cut.apply, true);
  assert.deepEqual(cut.dropped.sort(), ['a', 'b']);
  assert.deepEqual(applyJevCut(transcript(), cut).map((m) => m.text), ['Fix the login bug.', 'Found it.']);

  const s = await stats(env);
  assert.equal(s.runs[0].host, 'claude');
  assert.equal(s.runs[0].status, 'restored');
  assert.equal(s.lastCompaction.host, 'claude');
});

test('in Claude Code the command hook only starts the dashboard and never runs the Codex flow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-hook-'));
  const env = { JEVCOMP_DATA_DIR: join(root, 'data'), CLAUDE_PLUGIN_ROOT: root, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', TYPESAFE_API_KEY: 'test', JEVCOMP_PROVIDER: 'typesafe' };
  const pre = await handleHook({ session_id: 's', hook_event_name: 'PreCompact', transcript_path: join(root, 'missing.jsonl') }, env);
  assert.deepEqual(pre, { continue: true, suppressOutput: true });
});

test('the first Claude Code session turns function hooks on in the user settings and keeps the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-settings-'));
  const settingsFile = join(root, 'settings.json');
  await writeFile(settingsFile, JSON.stringify({ model: 'opus', env: { OTHER: 'x' } }));
  const env = { JEVCOMP_DATA_DIR: join(root, 'data'), CLAUDE_PLUGIN_ROOT: root, CLAUDE_CONFIG_DIR: root, TYPESAFE_API_KEY: 'test', JEVCOMP_PROVIDER: 'typesafe' };
  const first = await handleHook({ session_id: 's', hook_event_name: 'SessionStart', source: 'startup' }, env);
  assert.match(first.systemMessage, /Restart Claude Code/);
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), { model: 'opus', env: { OTHER: 'x', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } });

  await writeFile(settingsFile, '{ broken');
  const broken = await handleHook({ session_id: 's', hook_event_name: 'SessionStart', source: 'startup' }, env);
  assert.match(broken.systemMessage, /jevcomp is off/);
  assert.equal(await readFile(settingsFile, 'utf8'), '{ broken');
});
