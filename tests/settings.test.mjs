import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetUserSettings, setUserSetting, settingsPath, userSettings } from '../dist/settings.js';

test('user-facing settings persist without shell environment variables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-settings-'));
  const env = { JEVCOMP_CONFIG_DIR: root };
  await setUserSetting('mode', 'observe', env);
  await setUserSetting('restore-mode', 'balanced', env);
  await setUserSetting('restore-max-chars', '42000', env);
  await setUserSetting('pin-recent-messages', '9', env);
  await setUserSetting('loss-threshold', '0.35', env);
  await setUserSetting('min-reduction-ratio', '0.2', env);
  const value = userSettings(env);
  assert.deepEqual({
    mode: value.mode,
    restoreMode: value.restoreMode,
    restoreMaxChars: value.restoreMaxChars,
    pinRecentMessages: value.pinRecentMessages,
    lossThreshold: value.lossThreshold,
    minReductionRatio: value.minReductionRatio,
  }, { mode: 'observe', restoreMode: 'balanced', restoreMaxChars: 42000, pinRecentMessages: 9, lossThreshold: 0.35, minReductionRatio: 0.2 });
  assert.match(await readFile(settingsPath(env), 'utf8'), /"mode": "observe"/);
  assert.match(await readFile(settingsPath(env), 'utf8'), /"restoreMode": "balanced"/);
});

test('environment variables override saved user settings and reset restores defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-settings-override-'));
  const base = { JEVCOMP_CONFIG_DIR: root };
  await setUserSetting('mode', 'observe', base);
  await setUserSetting('restore-mode', 'minimal', base);
  await setUserSetting('loss-threshold', '0.2', base);
  const overridden = userSettings({ ...base, JEVCOMP_MODE: 'active', JEVCOMP_RESTORE_MODE: 'preserve', JEVCOMP_LOSS_THRESHOLD: '0.7' });
  assert.equal(overridden.mode, 'active');
  assert.equal(overridden.restoreMode, 'preserve');
  assert.equal(overridden.lossThreshold, 0.7);
  await resetUserSettings(base);
  const defaults = userSettings(base);
  assert.equal(defaults.mode, 'active');
  assert.equal(defaults.restoreMode, 'preserve');
  assert.equal(defaults.lossThreshold, 0.5);
});

test('invalid persisted values are rejected before they can affect hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-settings-invalid-'));
  const env = { JEVCOMP_CONFIG_DIR: root };
  await assert.rejects(setUserSetting('loss-threshold', '2', env), /between 0 and 1/);
  await assert.rejects(setUserSetting('mode', 'turbo', env), /active or observe/);
  await assert.rejects(setUserSetting('restore-max-chars', '-1', env), /non-negative integer/);
  await assert.rejects(setUserSetting('restore-mode', 'fastest', env), /must be preserve/);
});

test('manually corrupted settings file is sanitized back to safe defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-settings-corrupt-'));
  const env = { JEVCOMP_CONFIG_DIR: root };
  await writeFile(settingsPath(env), JSON.stringify({
    mode: 'turbo',
    restoreMode: 'turbo',
    restoreMaxChars: 'huge',
    pinRecentMessages: -3,
    lossThreshold: 8,
    minReductionRatio: null,
  }));
  const value = userSettings(env);
  assert.equal(value.mode, 'active');
  assert.equal(value.restoreMode, 'preserve');
  assert.equal(value.restoreMaxChars, 60000);
  assert.equal(value.pinRecentMessages, 6);
  assert.equal(value.lossThreshold, 0.5);
  assert.equal(value.minReductionRatio, 0.15);
});

test('shadow remains a compatible alias for observe mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-settings-shadow-'));
  const env = { JEVCOMP_CONFIG_DIR: root, JEVCOMP_MODE: 'shadow' };
  assert.equal(userSettings(env).mode, 'observe');
});
