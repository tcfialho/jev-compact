import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeRetainedMessages } from '../dist/membership.js';

const decision = (callId, name = 'read') => ({
  id: `d-${callId}`, callId, name, inputPreview: callId,
  dropLoss: 0.9, truncateLoss: 0.9, action: 'keep',
  resultChars: 10, originalChars: 20, savedChars: 0, pinned: false,
});

test('dedupe removes only exact post-compaction text and complete tool pairs', () => {
  const retained = [
    { role: 'user', text: 'never edit generated files', toolCalls: [] },
    { role: 'assistant', text: '', toolCalls: [
      { id: 'c1', name: 'read', input: { path: 'a.ts', line: 1 } },
      { id: 'c2', name: 'read', input: { path: 'b.ts' } },
    ] },
    { role: 'user', text: '', toolCalls: [], toolResults: [
      { callId: 'c1', output: 'exact result one' },
      { callId: 'c2', output: 'important result two' },
    ] },
  ];
  const live = [
    { role: 'user', text: 'never edit generated files', toolCalls: [] },
    // Object key order differs deliberately: canonical input equality should still match.
    { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'read', input: { line: 1, path: 'a.ts' } }, { id: 'c2', name: 'read', input: { path: 'b.ts' } }] },
    { role: 'user', text: '', toolCalls: [], toolResults: [
      { callId: 'c1', output: 'exact result one' },
      { callId: 'c2', output: 'important result tw…' },
    ] },
  ];

  const result = dedupeRetainedMessages(retained, live, [decision('c1'), decision('c2')]);
  assert.equal(result.textItemsAlreadyPresent, 1);
  assert.equal(result.toolPairsAlreadyPresent, 1);
  assert.ok(result.nativePresentChars > 0);
  assert.deepEqual(result.decisions.map((d) => d.callId), ['c2']);
  assert.equal(result.messages.some((m) => m.text.includes('never edit')), false);
  assert.equal(result.messages.flatMap((m) => m.toolCalls).some((c) => c.id === 'c1'), false);
  assert.equal(result.messages.flatMap((m) => m.toolResults ?? []).some((r) => r.callId === 'c1'), false);
  // c2 must remain as a complete pair because its result did not survive exactly.
  assert.equal(result.messages.flatMap((m) => m.toolCalls).some((c) => c.id === 'c2'), true);
  assert.equal(result.messages.flatMap((m) => m.toolResults ?? []).some((r) => r.callId === 'c2' && r.output === 'important result two'), true);
});

test('same prefix is never enough to suppress a retained result', () => {
  const head = 'x'.repeat(1000);
  const retained = [
    { role: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'bash', input: { command: 'cat log' } }] },
    { role: 'user', text: '', toolCalls: [], toolResults: [{ callId: 'c', output: `${head}TAIL-A` }] },
  ];
  const live = [
    { role: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'bash', input: { command: 'cat log' } }] },
    { role: 'user', text: '', toolCalls: [], toolResults: [{ callId: 'c', output: `${head}TAIL-B` }] },
  ];
  const result = dedupeRetainedMessages(retained, live, [decision('c', 'bash')]);
  assert.equal(result.toolPairsAlreadyPresent, 0);
  assert.equal(result.nativePresentChars, 0);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.messages.flatMap((m) => m.toolResults ?? [])[0].output.endsWith('TAIL-A'), true);
});
