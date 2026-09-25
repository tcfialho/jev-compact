import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { runningDashboard } from '../dist/dashboard-service.js';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
const handlers = Object.values(manifest.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Codex runs plugin hooks through the session's user shell, so the command must not rely on one shell's variable syntax.
function codexShells() {
  if (process.platform !== 'win32') {
    return ['sh', 'bash', 'zsh']
      .filter((program) => spawnSync(program, ['-c', 'exit 0']).status === 0)
      .map((program) => ({ name: program, run: (command, options) => spawnSync(program, ['-c', command], options) }));
  }
  const comspec = process.env.ComSpec ?? 'cmd.exe';
  const shells = [{ name: 'cmd', run: (command, options) => spawnSync(comspec, ['/C', `"${command}"`], { ...options, windowsVerbatimArguments: true }) }];
  for (const program of ['powershell.exe', 'pwsh.exe']) {
    if (spawnSync(program, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status !== 0) continue;
    shells.push({ name: program, run: (command, options) => spawnSync(program, ['-NoProfile', '-Command', command], options) });
  }
  return shells;
}

test('plugin hook commands avoid shell-specific variable expansion', () => {
  for (const handler of handlers) {
    assert.equal(handler.commandWindows, undefined);
    assert.doesNotMatch(handler.command, /%PLUGIN_ROOT%|\$\{?PLUGIN_ROOT|\$env:/);
    assert.match(handler.command, /--jevcomp$/);
  }
});

test('plugin hook command runs from any working directory in every shell Codex may use', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-hook-shells-'));
  const port = await freePort();
  const env = {
    ...process.env,
    JEVCOMP_DASHBOARD_PORT: String(port),
    PLUGIN_ROOT: pluginRoot,
    PLUGIN_DATA: join(root, 'data'),
    CODEX_HOME: join(root, 'codex-home'),
    JEVCOMP_CONFIG_DIR: join(root, 'config'),
    OPENROUTER_API_KEY: '',
    TYPESAFE_API_KEY: '',
  };
  t.after(async () => {
    const running = await runningDashboard(port, env);
    if (running) process.kill(running.pid);
  });
  const events = [
    { session_id: 'shell-check', hook_event_name: 'SessionStart', source: 'startup', transcript_path: null, cwd: root },
    { session_id: 'shell-check', hook_event_name: 'UserPromptSubmit', prompt: 'hello', transcript_path: null, cwd: root },
  ];
  const commands = [...new Set(handlers.map((handler) => handler.command))];
  for (const shell of codexShells()) {
    for (const command of commands) {
      for (const event of events) {
        const result = shell.run(command, { cwd: root, env, input: JSON.stringify(event), encoding: 'utf8', windowsHide: true, timeout: 30_000 });
        const context = `${shell.name} ${event.hook_event_name}: ${result.error ?? ''} ${result.stderr}`;
        assert.equal(result.status, 0, context);
        assert.equal(JSON.parse(result.stdout.trim()).continue, true, context);
      }
    }
  }
});
