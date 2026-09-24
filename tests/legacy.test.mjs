import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptLegacyEnvironment } from '../dist/legacy.js';
import { inspectHooks, installHooks } from '../dist/install.js';
import { readHistory } from '../dist/store.js';
import { ensureDashboard, runningDashboard } from '../dist/dashboard-service.js';

test('old JEV_COMPACT_* settings apply unless the new name is set', () => {
  const env = { JEV_COMPACT_MODE: 'observe', JEV_COMPACT_RETRIES: '0', JEVCOMP_RETRIES: '2' };
  adoptLegacyEnvironment(env);
  assert.equal(env.JEVCOMP_MODE, 'observe');
  assert.equal(env.JEVCOMP_RETRIES, '2');
});

test('installing replaces hooks written under the old name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevcomp-legacy-hooks-'));
  const file = join(root, 'hooks.json');
  await writeFile(file, JSON.stringify({ hooks: { PreCompact: [{ hooks: [
    { type: 'command', command: 'node old/cli.js hook --jev-compact' },
    { type: 'command', command: 'node unrelated.js' },
  ] }] } }));
  const env = { CODEX_HOOKS_FILE: file };
  await installHooks('/new/jevcomp/dist/cli.js', env);
  const commands = JSON.parse(await readFile(file, 'utf8')).hooks.PreCompact.flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.equal(commands.some((command) => command.includes('--jev-compact')), false);
  assert.equal(commands.includes('node unrelated.js'), true);
  assert.deepEqual((await inspectHooks(env)).events, ['PostCompact', 'PreCompact', 'SessionStart', 'UserPromptSubmit']);
});

test('history recorded by the old plugin stays visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevcomp-legacy-history-'));
  const oldData = join(root, 'plugins', 'data', 'jev-compact-jev-compact');
  await mkdir(oldData, { recursive: true });
  await writeFile(join(oldData, 'history.jsonl'), `${JSON.stringify({ at: '2026-09-24T00:00:00.000Z', sessionId: 'old', status: 'ready', runId: 'r1' })}\n`);
  const rows = await readHistory({ CODEX_HOME: root, PLUGIN_DATA: join(root, 'plugins', 'data', 'jevcomp-jevcomp') });
  assert.deepEqual(rows.map((row) => row.sessionId), ['old']);
});

test('a dashboard started under another data folder is replaced instead of blocking the port', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jevcomp-orphan-dashboard-'));
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const oldEnv = { ...process.env, JEVCOMP_DATA_DIR: join(root, 'old') };
  const newEnv = { ...process.env, JEVCOMP_DATA_DIR: join(root, 'new') };
  t.after(async () => {
    for (const env of [oldEnv, newEnv]) {
      const running = await runningDashboard(port, env);
      if (running) process.kill(running.pid);
    }
  });
  await ensureDashboard(port, oldEnv);
  const orphan = await runningDashboard(port, oldEnv);
  await ensureDashboard(port, newEnv);
  const current = await runningDashboard(port, newEnv);
  assert.ok(current);
  assert.notEqual(current.pid, orphan.pid);
});
