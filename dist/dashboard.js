import { createServer } from 'node:http';
import { readHistory } from './store.js';
export async function stats(env = process.env) {
    const rows = await readHistory(env);
    const prepared = rows.filter((r) => r.status === 'prepared' && r.stats);
    const restored = rows.filter((r) => r.status === 'restored');
    const prunedChars = prepared.reduce((n, r) => n + Math.max(0, (r.stats?.charsBefore ?? 0) - (r.stats?.charsAfter ?? 0)), 0);
    const avoidedRestoreChars = restored.reduce((n, r) => n + Math.max(0, (r.retainedChars ?? 0) - (r.injectedChars ?? 0)), 0);
    const jevInputTokens = prepared.reduce((n, r) => n + (r.stats?.jevInputTokens ?? 0), 0);
    const jevOutputTokens = prepared.reduce((n, r) => n + (r.stats?.jevOutputTokens ?? 0), 0);
    const byTool = new Map();
    for (const row of prepared) {
        for (const decision of row.decisions ?? []) {
            const current = byTool.get(decision.name) ?? { calls: 0, savedChars: 0, dropped: 0, truncated: 0 };
            current.calls++;
            current.savedChars += decision.savedChars;
            current.dropped += Number(decision.action === 'drop_call');
            current.truncated += Number(decision.action === 'truncate_result');
            byTool.set(decision.name, current);
        }
    }
    return {
        compactions: prepared.length,
        restores: restored.length,
        failures: rows.filter((r) => r.status === 'failed').length,
        jevInputTokens,
        jevOutputTokens,
        prunedChars,
        estimatedPrunedTokens: Math.round(prunedChars / 4),
        avoidedRestoreChars,
        estimatedRestoreTokensAvoided: Math.round(avoidedRestoreChars / 4),
        byTool: [...byTool].map(([tool, value]) => ({ tool, ...value })).sort((a, b) => b.savedChars - a.savedChars),
        last: rows.at(-1) ?? null,
    };
}
export async function startDashboard(port = 43127, env = process.env) {
    const server = createServer(async (req, res) => {
        const s = await stats(env);
        if (req.url === '/api/health') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (req.url === '/api/stats') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(s));
            return;
        }
        const tools = s.byTool.slice(0, 12).map((x) => `<tr><td>${escapeHtml(x.tool)}</td><td>${x.calls}</td><td>${x.dropped}</td><td>${x.truncated}</td><td>${x.savedChars.toLocaleString()}</td></tr>`).join('');
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><meta charset="utf-8"><title>codex-jev-compact</title><style>body{font:16px system-ui;max-width:900px;margin:60px auto;padding:0 20px}strong{font-size:2rem}pre{background:#111;color:#eee;padding:16px;overflow:auto}table{border-collapse:collapse;width:100%}td,th{text-align:left;border-bottom:1px solid #ddd;padding:7px}</style><h1>codex-jev-compact</h1><p><strong>${s.estimatedRestoreTokensAvoided.toLocaleString()}</strong> estimated reinjection tokens avoided</p><p>${s.compactions} compactions · ${s.restores} restores · ${s.failures} failures · ${s.jevInputTokens.toLocaleString()} measured Jev input tokens</p><h2>By tool</h2><table><thead><tr><th>Tool</th><th>Calls</th><th>Dropped</th><th>Truncated</th><th>Chars removed</th></tr></thead><tbody>${tools}</tbody></table><h2>Last event</h2><pre>${escapeHtml(JSON.stringify(s.last, null, 2))}</pre>`);
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    console.log(`Dashboard: http://127.0.0.1:${port}/`);
}
function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
