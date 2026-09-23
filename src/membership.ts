import { createHash } from 'node:crypto';
import { renderMessages } from './render.js';
import type { CallDecision, Message, ToolCall, ToolResult } from './types.js';

interface ToolIndexEntry {
  calls: Set<string>;
  results: Set<string>;
}

export interface DedupeSummary {
  messages: Message[];
  decisions: CallDecision[];
  retainedRenderChars: number;
  missingRenderChars: number;
  nativePresentChars: number;
  textItemsAlreadyPresent: number;
  toolPairsAlreadyPresent: number;
  orphanToolItemsAlreadyPresent: number;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, seen)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key], seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function callSignature(call: ToolCall): string {
  return `${call.name}\u0000${canonical(call.input)}`;
}

function resultSignature(result: ToolResult): string {
  return `${result.isError === true ? '1' : '0'}\u0000${result.output.length}\u0000${sha256(result.output)}`;
}

function textSignature(message: Message): string {
  return `${message.role}\u0000${message.text.length}\u0000${sha256(message.text)}`;
}

function toolIndex(messages: readonly Message[]): Map<string, ToolIndexEntry> {
  const index = new Map<string, ToolIndexEntry>();
  const entry = (id: string): ToolIndexEntry => {
    let value = index.get(id);
    if (!value) {
      value = { calls: new Set(), results: new Set() };
      index.set(id, value);
    }
    return value;
  };
  for (const message of messages) {
    for (const call of message.toolCalls) entry(call.id).calls.add(callSignature(call));
    for (const result of message.toolResults ?? []) entry(result.callId).results.add(resultSignature(result));
  }
  return index;
}

function retainedItems(messages: readonly Message[]): Map<string, { calls: Set<string>; results: Set<string> }> {
  return toolIndex(messages);
}

/**
 * Remove only evidence that is provably present verbatim in the live post-compaction history.
 * A complete tool pair is removed only when both the exact call and exact result survive.
 * Any ambiguity intentionally keeps the retained evidence, trading duplicate text for safety.
 */
export function dedupeRetainedMessages(
  retained: readonly Message[],
  livePostCompaction: readonly Message[],
  decisions: readonly CallDecision[],
): DedupeSummary {
  const liveTools = toolIndex(livePostCompaction);
  const retainedTools = retainedItems(retained);
  const liveTexts = new Set(
    livePostCompaction
      .filter((message) => message.text.trim())
      .map(textSignature),
  );

  const completePairs = new Set<string>();
  const removableOrphans = new Map<string, { calls: Set<string>; results: Set<string> }>();
  let toolPairsAlreadyPresent = 0;
  let orphanToolItemsAlreadyPresent = 0;

  for (const [id, original] of retainedTools) {
    const live = liveTools.get(id);
    if (!live) continue;
    const hasRetainedCall = original.calls.size > 0;
    const hasRetainedResult = original.results.size > 0;
    const exactCall = hasRetainedCall && [...original.calls].every((signature) => live.calls.has(signature));
    const exactResult = hasRetainedResult && [...original.results].every((signature) => live.results.has(signature));

    if (hasRetainedCall && hasRetainedResult) {
      if (exactCall && exactResult) {
        completePairs.add(id);
        toolPairsAlreadyPresent++;
      }
      continue;
    }

    const removable = { calls: new Set<string>(), results: new Set<string>() };
    if (hasRetainedCall) {
      for (const signature of original.calls) if (live.calls.has(signature)) removable.calls.add(signature);
    }
    if (hasRetainedResult) {
      for (const signature of original.results) if (live.results.has(signature)) removable.results.add(signature);
    }
    if (removable.calls.size || removable.results.size) {
      removableOrphans.set(id, removable);
      orphanToolItemsAlreadyPresent += removable.calls.size + removable.results.size;
    }
  }

  let textItemsAlreadyPresent = 0;
  const messages: Message[] = [];
  for (const message of retained) {
    let text = message.text;
    if (text.trim() && liveTexts.has(textSignature(message))) {
      text = '';
      textItemsAlreadyPresent++;
    }

    const toolCalls = message.toolCalls.filter((call) => {
      if (completePairs.has(call.id)) return false;
      return !removableOrphans.get(call.id)?.calls.has(callSignature(call));
    });
    const toolResults = (message.toolResults ?? []).filter((result) => {
      if (completePairs.has(result.callId)) return false;
      return !removableOrphans.get(result.callId)?.results.has(resultSignature(result));
    });

    if (text.trim() || toolCalls.length || toolResults.length) {
      messages.push({
        ...message,
        text,
        toolCalls,
        ...(message.toolResults ? { toolResults } : {}),
      });
    }
  }

  const remainingCallIds = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls) remainingCallIds.add(call.id);
    for (const result of message.toolResults ?? []) remainingCallIds.add(result.callId);
  }
  const filteredDecisions = decisions.filter((decision) => remainingCallIds.has(decision.callId));
  const retainedRenderChars = renderMessages(retained).length;
  const missingRenderChars = renderMessages(messages).length;

  return {
    messages,
    decisions: filteredDecisions,
    retainedRenderChars,
    missingRenderChars,
    nativePresentChars: Math.max(0, retainedRenderChars - missingRenderChars),
    textItemsAlreadyPresent,
    toolPairsAlreadyPresent,
    orphanToolItemsAlreadyPresent,
  };
}
