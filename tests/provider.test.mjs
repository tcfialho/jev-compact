import test from 'node:test';
import assert from 'node:assert/strict';
import { JevClient, noul, resolveProvider, resolveApiKey, saveProviderConfiguration } from '../dist/provider.js';

test('OpenRouter uses Decisions endpoint and latest Jev alias', async () => {
  let seen;
  const client = new JevClient({ provider: 'openrouter', apiKey: 'test', retries: 0, fetch: async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, text: async () => JSON.stringify({ answers: { x: { noul: 0.8 } } }) };
  } });
  const result = await client.ask({ task: 'x' }, { x: { type: 'noul', instructions: 'keep?' } });
  assert.equal(result.answers.x.noul, 0.8);
  assert.equal(seen.url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(JSON.parse(seen.init.body).model, '~typesafe/jev-latest');
});

test('direct TypeSafe uses System One endpoint', async () => {
  let url;
  const client = new JevClient({ provider: 'typesafe', apiKey: 'test', retries: 0, fetch: async (u) => {
    url = u; return { ok: true, status: 200, text: async () => JSON.stringify({ answers: { x: { noul: 1 } } }) };
  } });
  await client.ask({}, { x: { type: 'noul', instructions: 'x' } });
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
});

test('retries rate limits using retry-after-ms', async () => {
  let calls = 0;
  const client = new JevClient({ provider: 'typesafe', apiKey: 'test', retries: 1, fetch: async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, headers: { get: (name) => name === 'retry-after-ms' ? '1' : null }, text: async () => 'busy' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ answers: { x: { noul: 0.7 } }, usage: { input_tokens: 50, output_tokens: 2 } }) };
  } });
  const result = await client.ask({}, { x: { type: 'noul', instructions: 'x' } });
  assert.equal(calls, 2);
  assert.equal(result.usage.input_tokens, 50);
});

test('retries transient connection failures', async () => {
  let calls = 0;
  const client = new JevClient({ provider: 'typesafe', apiKey: 'test', retries: 1, fetch: async () => {
    calls++;
    if (calls === 1) throw new TypeError('connection reset');
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ answers: { x: { noul: 0.6 } } }) };
  } });
  await client.ask({}, { x: { type: 'noul', instructions: 'x' } });
  assert.equal(calls, 2);
});

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('provider can resolve API key from a configured key file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-key-'));
  const keyFile = join(root, 'key');
  await writeFile(keyFile, 'file-secret\n');
  let auth;
  const client = new JevClient({
    provider: 'typesafe',
    env: { TYPESAFE_API_KEY_FILE: keyFile },
    retries: 0,
    fetch: async (_url, init) => {
      auth = init.headers.authorization;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ answers: { x: { noul: 1 } } }) };
    },
  });
  await client.ask({}, { x: { type: 'noul', instructions: 'x' } });
  assert.equal(auth, 'Bearer file-secret');
});

test('saved configuration selects provider and key without shell environment variables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-config-'));
  const env = { JEV_COMPACT_CONFIG_DIR: root };
  await saveProviderConfiguration('openrouter', 'saved-openrouter-key', env);
  assert.equal(resolveProvider({ env }), 'openrouter');
  assert.equal(resolveApiKey('openrouter', { env }), 'saved-openrouter-key');
});


test('provider serializes a shared Jev state once across batches', async () => {
  let serializations = 0;
  const state = {
    toJSON() { serializations++; return { history: [{ text: 'x'.repeat(1000) }] }; },
  };
  const client = new JevClient({ provider: 'typesafe', apiKey: 'test', retries: 0, cacheStateSerialization: true, fetch: async () => ({
    ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ answers: { x: { noul: 0.5 } } }),
  }) });
  await client.ask(state, { x: { type: 'noul', instructions: 'x' } });
  await client.ask(state, { x: { type: 'noul', instructions: 'x again' } });
  assert.equal(serializations, 1);
});

test('Noul rejects probabilities outside the documented 0..1 range', () => {
  assert.throws(() => noul({ x: { noul: 1.1 } }, 'x'), /Invalid Jev answer/);
  assert.throws(() => noul({ x: { noul: -0.01 } }, 'x'), /Invalid Jev answer/);
});


test('provider does not cache mutable state serialization unless explicitly enabled', async () => {
  const bodies = [];
  const client = new JevClient({ provider: 'typesafe', apiKey: 'test', retries: 0, fetch: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ answers: { x: { noul: 0.5 } } }) };
  } });
  const state = { version: 1 };
  await client.ask(state, { x: { type: 'noul', instructions: 'x' } });
  state.version = 2;
  await client.ask(state, { x: { type: 'noul', instructions: 'x' } });
  assert.equal(bodies[0].state.version, 1);
  assert.equal(bodies[1].state.version, 2);
});

test('generic key-file override follows the saved provider preference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-generic-key-'));
  const keyFile = join(root, 'generic-key');
  await writeFile(keyFile, 'generic-openrouter-key\n');
  const env = { JEV_COMPACT_CONFIG_DIR: root, JEV_COMPACT_KEY_FILE: keyFile };
  await saveProviderConfiguration('openrouter', 'old-key', env);
  assert.equal(resolveApiKey('openrouter', { env }), 'generic-openrouter-key');
  assert.notEqual(resolveApiKey('typesafe', { env }), 'generic-openrouter-key');
});
