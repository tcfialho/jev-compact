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
const UNJUDGABLE_CONTENT_TYPES = new Set(['input_image', 'input_audio', 'encrypted_content']);
function hasUnjudgableContent(value) {
    if (!Array.isArray(value))
        return false;
    return value.some((item) => record(item) && ((typeof item.type === 'string' && UNJUDGABLE_CONTENT_TYPES.has(item.type)) ||
        (typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0)));
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
        if (type === 'agent_message' && hasUnjudgableContent(value.content)) {
            throw new UnsupportedCodexRolloutError('encrypted agent message cannot be judged by Jev');
        }
        if (type === 'message' && hasUnjudgableContent(value.content)) {
            throw new UnsupportedCodexRolloutError('non-text Codex message content cannot be judged by Jev');
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
        const rawOutput = value.output ?? value.result ?? value.content ?? value.tools ?? value;
        if (hasUnjudgableContent(rawOutput))
            throw new UnsupportedCodexRolloutError('non-text tool output cannot be judged by Jev');
        const status = typeof value.status === 'string' ? value.status : '';
        pushResult(messages, {
            callId: id,
            output: textOf(rawOutput),
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
    const protectedMessages = messages.filter((message) => (message.role === 'user' || message.role === 'developer' || message.role === 'system') &&
        message.text.trim() && !(message.toolResults?.length));
    messages.length = 0;
    messages.push(...protectedMessages);
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
            if (typeof communication?.encrypted_content === 'string' && communication.encrypted_content) {
                throw new UnsupportedCodexRolloutError('encrypted inter-agent context cannot be judged by Jev');
            }
            if (typeof content === 'string' && content) {
                appendResponseItem(messages, {
                    type: 'agent_message',
                    author: communication?.author,
                    recipient: communication?.recipient,
                    content: [{ text: content }],
                });
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
function inspectRow(bytes, offset, unsafeNewerHistory) {
    const row = parseRow(bytes);
    if (!row)
        return { unsafe: unsafeNewerHistory };
    if (isRollback(row))
        unsafeNewerHistory = true;
    if (row.type === 'compacted') {
        if (!isBoundedCheckpoint(row))
            unsafeNewerHistory = true;
        else if (!unsafeNewerHistory)
            return { checkpoint: offset, unsafe: false };
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
/**
 * Finds the newest safe modern compaction checkpoint without repeatedly copying
 * a giant JSONL record that crosses many read chunks. A crossing line is kept
 * as buffer fragments and concatenated only once, when its leading newline is found.
 */
export async function loadCodexRollout(path, chunkBytes = 1024 * 1024) {
    const file = await open(path, 'r');
    try {
        const size = Number((await file.stat()).size);
        let end = size;
        let unsafeNewerHistory = false;
        let checkpoint;
        let pending = [];
        let pendingBytes = 0;
        let rightBoundaryEndsLine = true;
        const inspect = (bytes, offset) => {
            if (!bytes.length || checkpoint !== undefined || unsafeNewerHistory)
                return checkpoint !== undefined || unsafeNewerHistory;
            const result = inspectRow(bytes, offset, unsafeNewerHistory);
            checkpoint = result.checkpoint;
            unsafeNewerHistory = result.unsafe;
            return checkpoint !== undefined || unsafeNewerHistory;
        };
        while (end > 0 && checkpoint === undefined && !unsafeNewerHistory) {
            const start = Math.max(0, end - Math.max(1, chunkBytes));
            const chunk = await readRange(file, start, end - start);
            let right = chunk.length;
            let newline = chunk.lastIndexOf(0x0a, right - 1);
            if (pending.length) {
                if (newline < 0) {
                    if (start === 0) {
                        const line = Buffer.concat([chunk, ...pending], chunk.length + pendingBytes);
                        inspect(line, 0);
                        pending = [];
                        pendingBytes = 0;
                    }
                    else {
                        pending.unshift(chunk);
                        pendingBytes += chunk.length;
                    }
                    end = start;
                    continue;
                }
                const prefix = chunk.subarray(newline + 1, right);
                const line = Buffer.concat([prefix, ...pending], prefix.length + pendingBytes);
                if (inspect(line, start + newline + 1))
                    break;
                pending = [];
                pendingBytes = 0;
                right = newline;
            }
            else if (rightBoundaryEndsLine) {
                if (newline < 0) {
                    if (start === 0)
                        inspect(chunk, 0);
                    else {
                        pending = [chunk];
                        pendingBytes = chunk.length;
                        rightBoundaryEndsLine = false;
                    }
                    end = start;
                    continue;
                }
                const suffix = chunk.subarray(newline + 1, right);
                if (suffix.length && inspect(suffix, start + newline + 1))
                    break;
                right = newline;
            }
            while (right > 0 && checkpoint === undefined && !unsafeNewerHistory) {
                const previous = chunk.lastIndexOf(0x0a, right - 1);
                if (previous < 0)
                    break;
                if (inspect(chunk.subarray(previous + 1, right), start + previous + 1))
                    break;
                right = previous;
            }
            if (checkpoint !== undefined || unsafeNewerHistory)
                break;
            if (start === 0) {
                if (right > 0)
                    inspect(chunk.subarray(0, right), 0);
            }
            else if (right > 0) {
                pending = [chunk.subarray(0, right)];
                pendingBytes = right;
                rightBoundaryEndsLine = false;
            }
            else {
                rightBoundaryEndsLine = true;
            }
            end = start;
        }
        const from = checkpoint ?? 0;
        return parseCodexRollout((await readRange(file, from, size - from)).toString('utf8'));
    }
    finally {
        await file.close();
    }
}
