import type { CallDecision, Message } from './types.js';

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return '[unserializable]'; }
}

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 80) return text;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} chars omitted …]\n${text.slice(-tail)}`;
}

export function renderMessages(messages: readonly Message[]): string {
  return render(messages, 0, 0);
}

/** Render for model reinjection while preventing one giant result from crowding out everything else. */
export function renderMessagesForInjection(messages: readonly Message[], resultHead = 8_000, resultTail = 2_000): string {
  return render(messages, resultHead, resultTail);
}

function render(messages: readonly Message[], resultHead: number, resultTail: number): string {
  const out: string[] = [];
  for (const message of messages) {
    if (message.text.trim()) out.push(`[${message.role}]\n${message.text}`);
    for (const call of message.toolCalls) out.push(`[tool ${call.name} ${call.id}]\n${stringify(call.input)}`);
    for (const result of message.toolResults ?? []) {
      const text = resultHead > 0 ? abridge(result.output, resultHead, resultTail) : result.output;
      out.push(`[result ${result.callId}${result.isError ? ' error' : ''}]\n${text}`);
    }
  }
  return out.join('\n\n');
}

export function capContext(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) return text;
  const marker = `\n\n[… ${text.length - limit} chars omitted from middle; full retained context is on disk …]\n\n`;
  const usable = Math.max(0, limit - marker.length);
  const head = Math.floor(usable * 0.2);
  return text.slice(0, head) + marker + text.slice(-(usable - head));
}

export function renderIndex(messages: readonly Message[], decisions: readonly CallDecision[], maxChars = 12_000): string {
  const resultById = new Map(messages.flatMap((m) => m.toolResults ?? []).map((r) => [r.callId, r]));
  const lines: string[] = ['Jev-retained context index:'];
  const protectedText = messages.filter((m) => (m.role === 'user' || m.role === 'developer' || m.role === 'system') && m.text.trim()).slice(-5);
  if (protectedText.length) {
    lines.push('', 'Recent protected instructions/prompts (verbatim excerpts):');
    for (const m of protectedText) lines.push(`- [${m.role}] ${m.text.length <= 500 ? m.text : `${m.text.slice(0, 499)}…`}`);
  }

  const kept = decisions.filter((d) => d.action !== 'drop_call');
  if (kept.length) lines.push('', `Retained tool history (${kept.length} calls, newest first):`);
  let shown = 0;
  for (const d of [...kept].reverse()) {
    const result = resultById.get(d.callId);
    const preview = result?.output ? result.output.replace(/\s+/g, ' ').slice(0, 180) : '';
    const line = `- ${d.action === 'keep' ? 'KEEP' : 'TRUNC'} ${d.name} ${d.inputPreview} -> ${result?.output.length ?? 0} chars${result?.isError ? ' ERROR' : ''}${preview ? ` | ${preview}` : ''}`;
    const projected = [...lines, line].join('\n').length;
    if (maxChars > 0 && projected > maxChars) break;
    lines.push(line);
    shown++;
  }
  if (shown < kept.length) lines.push(`- … ${kept.length - shown} older retained calls omitted from this injected index; full retained context is on disk.`);
  const rendered = lines.join('\n');
  return maxChars > 0 && rendered.length > maxChars ? capContext(rendered, maxChars) : rendered;
}
