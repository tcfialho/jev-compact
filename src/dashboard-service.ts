import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './store.js';

type Env = Record<string, string | undefined>;
interface DashboardInstance { pid: number; instanceId: string; url: string }

export const DEFAULT_DASHBOARD_PORT = 43127;
const defaultCliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

export function dashboardPort(env: Env = process.env): number {
  const port = Number(env.JEV_COMPACT_DASHBOARD_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_DASHBOARD_PORT;
}

export function dashboardAutostart(env: Env = process.env): boolean {
  return env.JEV_COMPACT_DASHBOARD !== 'off';
}

export function dashboardInstancePath(port: number, env: Env = process.env): string {
  return join(dataDir(env), `dashboard-${port}.json`);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !!error && typeof error === 'object' && 'code' in error && error.code === 'EPERM'; }
}

export async function runningDashboard(port: number, env: Env = process.env): Promise<DashboardInstance | undefined> {
  if (port === 0) return undefined;
  let instance: DashboardInstance;
  try { instance = JSON.parse(await readFile(dashboardInstancePath(port, env), 'utf8')); }
  catch { return undefined; }
  if (!Number.isSafeInteger(instance?.pid) || instance.pid <= 0 ||
      typeof instance.instanceId !== 'string' || !instance.instanceId ||
      typeof instance.url !== 'string') return undefined;
  // Windows retries refused loopback connections for about a second, so skip the request when the process is gone.
  if (!processAlive(instance.pid)) return undefined;
  try {
    const url = new URL(instance.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port || url.pathname !== '/') return undefined;
    const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return undefined;
    const health = await response.json();
    return health.service === 'jev-compact-dashboard' && health.pid === instance.pid && health.instanceId === instance.instanceId
      ? instance : undefined;
  } catch { return undefined; }
}

async function stopDashboard(port: number, env: Env): Promise<void> {
  const previous = await runningDashboard(port, env);
  if (!previous) return;
  try { process.kill(previous.pid); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) throw error;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await fetch(new URL('/api/health', previous.url), { signal: AbortSignal.timeout(500) }); }
    catch { return; }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`previous Jev dashboard did not stop on port ${port}`);
}

async function spawnDashboard(port: number, env: Env, cliPath: string): Promise<string> {
  const instanceId = randomUUID();
  const child = spawn(process.execPath, [cliPath, 'dashboard', '--port', String(port), '--background'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...env, JEV_COMPACT_DASHBOARD_INSTANCE_ID: instanceId },
  });
  child.unref();

  return new Promise<string>((resolve, reject) => {
    let output = '';
    let errorOutput = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('dashboard did not start within 5 seconds')), 5000);
    const finish = (error?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error) reject(error);
      else resolve(url ?? '');
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      const line = output.split(/\r?\n/, 1)[0];
      if (line) finish(undefined, line);
    });
    child.stderr?.on('data', (chunk: string) => { errorOutput += chunk; });
    child.once('error', (error: Error) => finish(error));
    child.once('exit', (code: number | null) => finish(new Error(errorOutput.trim() || `dashboard process exited (${code})`)));
  });
}

/** Replaces any dashboard already on the port, so an explicit launch always serves the current code. */
export async function restartDashboard(port: number, env: Env = process.env, cliPath = defaultCliPath): Promise<string> {
  await stopDashboard(port, env);
  return spawnDashboard(port, env, cliPath);
}

/** Reuses a healthy dashboard; each check also counts as activity and postpones its idle shutdown. */
export async function ensureDashboard(port: number, env: Env = process.env, cliPath = defaultCliPath): Promise<string> {
  const running = await runningDashboard(port, env);
  return running ? running.url : spawnDashboard(port, env, cliPath);
}
