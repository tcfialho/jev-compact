import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDashboard, runningDashboard } from '../dist/dashboard-service.js';
import { handleHook } from '../dist/hooks.js';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('plugin session start opens one shared dashboard and later prompts reuse it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-dashboard-service-'));
  const port = await freePort();
  const env = {
    ...process.env,
    PLUGIN_ROOT: join(root, 'plugin'),
    PLUGIN_DATA: join(root, 'data'),
    CODEX_HOME: join(root, 'codex-home'),
    JEV_COMPACT_CONFIG_DIR: join(root, 'config'),
    OPENROUTER_API_KEY: 'test-key',
    JEV_COMPACT_PROVIDER: 'openrouter',
    JEV_COMPACT_DASHBOARD_PORT: String(port),
  };
  t.after(async () => {
    const running = await runningDashboard(port, env);
    if (running) process.kill(running.pid);
  });

  const started = await handleHook({ session_id: 'dashboard', hook_event_name: 'SessionStart', source: 'startup' }, env);
  assert.equal(started.systemMessage, `Jev Compact dashboard: http://127.0.0.1:${port}/`);
  const first = await runningDashboard(port, env);
  assert.ok(first);

  const prompt = await handleHook({ session_id: 'dashboard', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, env);
  assert.equal(prompt.systemMessage, undefined);
  assert.equal(await ensureDashboard(port, env), first.url);
  assert.equal((await runningDashboard(port, env)).pid, first.pid);
});

test('an unused dashboard stops itself and removes its instance file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-dashboard-idle-'));
  const port = await freePort();
  const env = { ...process.env, JEV_COMPACT_DATA_DIR: join(root, 'data'), JEV_COMPACT_DASHBOARD_IDLE_MINUTES: '0.02' };
  await ensureDashboard(port, env);
  assert.ok(await runningDashboard(port, env));
  // Health checks count as activity, so wait without polling.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  assert.equal(await runningDashboard(port, env), undefined);
  await assert.rejects(access(join(root, 'data', `dashboard-${port}.json`)));
});
