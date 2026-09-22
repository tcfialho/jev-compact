import { open } from 'node:fs/promises';
const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'tool_search_call', 'web_search_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output', 'tool_search_output', 'web_search_call_output']);
function record(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function textOf(value) {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value)) {
        const text = value.flatMap((item) => record(item) && typeof item.text === 'string' ? [item.text] : []).join('');
        if (text)
            return text;
        try {
            return JSON.stringify(value);
        }
        catch {
            return String(value);
        }
    }
    if (record(value)) {
        try {
            return JSON.stringify(value);
        }
        catch {
            return String(value);
        }
    }
    return '';
}
function callInput(item) {
    const raw = item.arguments ?? item.input ?? item.action ?? {};
    if (typeof raw !== 'string')
        return raw;
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
function isCall(item) {
    const type = typeof item.type === 'string' ? item.type : '';
    return CALL_TYPES.has(type) || (type.endsWith('_call') && !type.endsWith('_output') && typeof (item.call_id ?? item.id) === 'string');
}
function isOutput(item) {
    const type = typeof item.type === 'string' ? item.type : '';
    return OUTPUT_TYPES.has(type) || (type.endsWith('_output') && typeof (item.call_id ?? item.id) === 'string');
}
function pushCall(messages, call) {
    const last = messages.at(-1);
    if (last?.role === 'assistant')
        last.toolCalls.push(call);
    else
        messages.push({ role: 'assistant', text: '', toolCalls: [call] });
}
function pushResult(messages, result) {
    const last = messages.at(-1);
    if (last?.role === 'user' && !last.text && last.toolResults)
        last.toolResults.push(result);
    else
        messages.push({ role: 'user', text: '', toolCalls: [], toolResults: [result] });
}
export function appendResponseItem(messages, value) {
    if (!record(value))
        return;
    const type = typeof value.type === 'string' ? value.type : '';
    if (type === 'message' || type === 'agent_message') {
        const roleValue = type === 'agent_message' ? 'assistant' : value.role;
        const rawRole = roleValue === 'system' || roleValue === 'developer' || roleValue === 'user' || roleValue === 'assistant' || roleValue === 'tool'
            ? roleValue
            : 'unknown';
        if (type === 'agent_message' && Array.isArray(value.content)) {
            const hasPlaintext = value.content.some((item) => record(item) && typeof item.text === 'string' && item.text.length > 0);
            const hasEncrypted = value.content.some((item) => record(item) && typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0);
            if (hasEncrypted && !hasPlaintext)
                throw new UnsupportedCodexRolloutError('encrypted agent message cannot be judged by Jev');
        }
        const text = textOf(value.content ?? value.message);
        if (text)
            messages.push({ role: rawRole, text, toolCalls: [] });
        return;
    }
    if (isCall(value)) {
        const id = value.call_id ?? value.id;
        if (typeof id !== 'string' || !id)
            return;
        pushCall(messages, { id, name: typeof value.name === 'string' ? value.name : type || 'tool', input: callInput(value) });
        return;
    }
    if (isOutput(value)) {
        const id = value.call_id ?? value.id;
        if (typeof id !== 'string' || !id)
            return;
        const status = typeof value.status === 'string' ? value.status : '';
        pushResult(messages, {
            callId: id,
            output: textOf(value.output ?? value.result ?? value.content ?? value.tools ?? value),
            isError: value.is_error === true || status === 'failed' || status === 'error',
        });
    }
}
function payload(row) {
    return record(row.payload) ? row.payload : undefined;
}
function isRollback(row) {
    if (row.type !== 'event_msg')
        return false;
    const body = payload(row);
    return body?.type === 'thread_rolled_back';
}
function replacementHistory(row) {
    if (row.type !== 'compacted')
        return undefined;
    const replacement = payload(row)?.replacement_history;
    return Array.isArray(replacement) ? replacement : undefined;
}
function hasModernWindow(row) {
    const body = payload(row);
    return typeof body?.window_number === 'number' || typeof body?.window_id === 'number';
}
function isBoundedCheckpoint(row) {
    return !!replacementHistory(row) && hasModernWindow(row);
}
function applyLegacyCompaction(messages, row) {
    const body = payload(row);
    const summary = typeof body?.message === 'string' ? body.message : '';
    const users = messages.filter((message) => message.role === 'user' && message.text.trim() && !(message.toolResults?.length));
    messages.length = 0;
    messages.push(...users);
    if (summary)
        messages.push({ role: 'assistant', text: summary, toolCalls: [] });
}
export class UnsupportedCodexRolloutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UnsupportedCodexRolloutError';
    }
}
export function parseCodexRollout(jsonl) {
    const messages = [];
    for (const line of jsonl.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        let row;
        try {
            row = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (!record(row))
            continue;
        if (isRollback(row))
            throw new UnsupportedCodexRolloutError('legacy Codex rollback requires native compaction');
        if (row.type === 'compacted') {
            const replacement = replacementHistory(row);
            if (replacement) {
                messages.length = 0;
                for (const item of replacement)
                    appendResponseItem(messages, item);
            }
            else {
                applyLegacyCompaction(messages, row);
            }
            continue;
        }
        if (row.type === 'inter_agent_communication') {
            const communication = payload(row);
            const content = communication?.content;
            if (typeof content === 'string' && content) {
                appendResponseItem(messages, {
                    type: 'agent_message',
                    author: communication?.author,
                    recipient: communication?.recipient,
                    content: [{ text: content }],
                });
            }
            else if (typeof communication?.encrypted_content === 'string' && communication.encrypted_content) {
                throw new UnsupportedCodexRolloutError('encrypted inter-agent context cannot be judged by Jev');
            }
            continue;
        }
        if (row.type === 'response_item')
            appendResponseItem(messages, row.payload);
    }
    return messages;
}
function parseRow(bytes) {
    const line = bytes.toString('utf8').trim();
    if (!line)
        return undefined;
    try {
        const row = JSON.parse(line);
        return record(row) ? row : undefined;
    }
    catch {
        return undefined;
    }
}
function inspectNewestFirst(buffer, baseOffset, unsafeNewerHistory) {
    let end = buffer.length;
    while (end > 0) {
        if (buffer[end - 1] === 0x0a)
            end--;
        if (end <= 0)
            break;
        const newline = buffer.lastIndexOf(0x0a, end - 1);
        const start = newline + 1;
        const row = parseRow(buffer.subarray(start, end));
        if (row) {
            if (isRollback(row))
                unsafeNewerHistory = true;
            if (row.type === 'compacted') {
                if (!isBoundedCheckpoint(row))
                    unsafeNewerHistory = true;
                else if (!unsafeNewerHistory)
                    return { checkpoint: baseOffset + start, unsafe: false };
            }
        }
        end = newline;
    }
    return { unsafe: unsafeNewerHistory };
}
async function readRange(file, start, length) {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
        const result = await file.read(buffer, offset, length - offset, start + offset);
        if (!result.bytesRead)
            break;
        offset += result.bytesRead;
    }
    return offset === length ? buffer : buffer.subarray(0, offset);
}
export async function loadCodexRollout(path, chunkBytes = 1024 * 1024) {
    const file = await open(path, 'r');
    try {
        const size = Number((await file.stat()).size);
        let end = size;
        let carry = Buffer.alloc(0);
        let unsafeNewerHistory = false;
        let checkpoint;
        while (end > 0 && checkpoint === undefined && !unsafeNewerHistory) {
            const start = Math.max(0, end - chunkBytes);
            const chunk = await readRange(file, start, end - start);
            const combined = carry.length ? Buffer.concat([chunk, carry]) : chunk;
            const firstNewline = start === 0 ? -1 : combined.indexOf(0x0a);
            const completeStart = start === 0 ? 0 : firstNewline >= 0 ? firstNewline + 1 : combined.length;
            const complete = combined.subarray(completeStart);
            const inspected = inspectNewestFirst(complete, start + completeStart, unsafeNewerHistory);
            checkpoint = inspected.checkpoint;
            unsafeNewerHistory = inspected.unsafe;
            carry = start === 0 ? Buffer.alloc(0) : combined.subarray(0, completeStart);
            end = start;
        }
        const from = checkpoint ?? 0;
        return parseCodexRollout((await readRange(file, from, size - from)).toString('utf8'));
    }
    finally {
        await file.close();
    }
}
