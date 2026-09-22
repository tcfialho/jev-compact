import test from 'node:test';
import assert from 'node:assert/strict';
import { compact, reductionRatio } from '../dist/compact.js';

test('drops stale calls and truncates result while preserving text', async () => {
  const long = 'x'.repeat(1200);
  const messages = [
    { role: 'user', text: 'Fix login. Do not edit generated files.', toolCalls: [] },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'grep', input: { q: 'obsolete' } }] },
    { role: 'user', text: '', toolCalls: [], toolResults: [{ callId: 'c1', output: long }] },
    { role: 'assistant', text: 'Current diagnosis', toolCalls: [{ id: 'c2', name: 'test', input: { cmd: 'npm test' } }] },
    { role: 'user', text: '', toolCalls: [], toolResults: [{ callId: 'c2', output: long }] },
    { role: 'assistant', text: 'Proceeding with the fix', toolCalls: [] }
  ];
  const asker = { async ask(_state, questions) {
    const answers = {};
    for (const key of Object.keys(questions)) {
      if (key.includes('t1')) answers[key] = { noul: 0.01 };
      else answers[key] = { noul: key.startsWith('drop_') ? 0.99 : 0.01 };
    }
    return { answers, usage: { input_tokens: 321, output_tokens: 17 } };
  } };
  const result = await compact(messages, asker, { preserveRecentMessages: 0, truncateHeadChars: 100, maxConcurrentRequests: 2 });
  assert.equal(result.messages.flatMap((m) => m.toolCalls).some((c) => c.id === 'c1'), false);
  assert.equal(result.messages.flatMap((m) => m.toolCalls).some((c) => c.id === 'c2'), true);
  const c2 = result.messages.flatMap((m) => m.toolResults ?? []).find((r) => r.callId === 'c2');
  assert.ok(c2.output.includes('omitted'));
  assert.ok(result.messages.some((m) => m.text.includes('Do not edit generated files')));
  assert.ok(reductionRatio(result) > 0.5);
  assert.equal(result.stats.jevInputTokens, 321);
  assert.equal(result.stats.jevOutputTokens, 17);
});

test('untouched messages retain object identity and protected roles remain in Jev state', async () => {
  const developer = { role: 'developer', text: 'Never edit generated files.', toolCalls: [] };
  const user = { role: 'user', text: 'Fix login', toolCalls: [] };
  const call = { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'read', input: { path: 'a' } }] };
  const resultMessage = { role: 'user', text: '', toolCalls: [], toolResults: [{ callId: 'c1', output: 'contents' }] };
  let seenState;
  const result = await compact([developer, user, call, resultMessage], { async ask(state, questions) {
    seenState = state;
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 1 }])) };
  } }, { preserveRecentMessages: 0 });
  assert.equal(result.messages[0], developer);
  assert.equal(result.messages[1], user);
  assert.match(JSON.stringify(seenState), /Never edit generated files/);
});

test('conservative ordering keeps full result when truncate-loss is high even if drop-loss is low', async () => {
  const messages = [
    { role: 'user', text: 'task', toolCalls: [] },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'read', input: { path: 'x', api_key: 'secret-value' } }] },
    { role: 'user', text: '', toolCalls: [], toolResults: [{ callId: 'c1', output: 'important exact data'.repeat(30) }] },
  ];
  const result = await compact(messages, { async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: key.startsWith('drop_') ? 0.1 : 0.9 }])) };
  } }, { preserveRecentMessages: 0 });
  assert.equal(result.decisions[0].action, 'keep');
  assert.doesNotMatch(result.decisions[0].inputPreview, /secret-value/);
  assert.match(result.decisions[0].inputPreview, /redacted/);
});
