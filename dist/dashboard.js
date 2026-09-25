import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { applySettingsChange, settingsSnapshot } from './dashboard-settings.js';
import { readableHistoryPaths, readHistory } from './store.js';
import { settingsPath, userSettings } from './settings.js';
function positive(value) {
    return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}
function ratio(removed, before) {
    return before > 0 ? removed / before : 0;
}
function runKey(row) {
    return row.runId ?? `${row.sessionId}:${row.turnId ?? ''}:${row.at}`;
}
/** Build only measured statistics. No chars/4 or claimed Codex billing-token savings. */
export async function stats(env = process.env) {
    const rows = await readHistory(env);
    const prepared = rows.filter((r) => r.status === 'prepared' && r.stats);
    const skipped = rows.filter((r) => r.status === 'skipped' && r.phase !== 'restore');
    const precompactFailures = rows.filter((r) => r.status === 'failed' && (r.phase === 'precompact' || !r.phase));
    const restoreFailures = rows.filter((r) => r.status === 'failed' && r.phase === 'restore');
    const ready = rows.filter((r) => r.status === 'ready' && r.stats);
    const restored = rows.filter((r) => r.status === 'restored' && r.stats);
    const restoredRunKeys = new Set(restored.map(runKey));
    const completedPrepared = prepared.filter((r) => restoredRunKeys.has(runKey(r)));
    const transcriptCharsBefore = prepared.reduce((n, r) => n + positive(r.stats?.charsBefore), 0);
    const transcriptCharsAfter = prepared.reduce((n, r) => n + positive(r.stats?.charsAfter), 0);
    const transcriptCharsRemoved = Math.max(0, transcriptCharsBefore - transcriptCharsAfter);
    const completedCharsBefore = completedPrepared.reduce((n, r) => n + positive(r.stats?.charsBefore), 0);
    const completedCharsAfter = completedPrepared.reduce((n, r) => n + positive(r.stats?.charsAfter), 0);
    const completedCharsRemoved = Math.max(0, completedCharsBefore - completedCharsAfter);
    const retainedArchiveChars = prepared.reduce((n, r) => n + positive(r.retainedChars ?? r.stats?.charsAfter), 0);
    const injectedChars = restored.reduce((n, r) => n + positive(r.injectedChars), 0);
    const injectedPayloadChars = restored.reduce((n, r) => n + positive(r.injectedPayloadChars), 0);
    const restoreEligibleChars = restored.reduce((n, r) => n + positive(r.retainedChars), 0);
    const restoreCharsNotInjected = Math.max(0, restoreEligibleChars - injectedPayloadChars);
    const nativePresentChars = restored.reduce((n, r) => n + positive(r.nativePresentChars), 0);
    const restoreCandidateChars = restored.reduce((n, r) => n + positive(r.restoreCandidateChars), 0);
    const verifiedMemberships = restored.filter((r) => r.membershipStatus === 'verified').length;
    // A skip happens after Jev has already judged the transcript, so its provider
    // usage is real cost even though no retained sidecar is applied.
    const scored = [...prepared, ...skipped].filter((r) => r.stats);
    const jevInputTokens = scored.reduce((n, r) => n + positive(r.stats?.jevInputTokens), 0);
    const jevOutputTokens = scored.reduce((n, r) => n + positive(r.stats?.jevOutputTokens), 0);
    const jevRequests = scored.reduce((n, r) => n + positive(r.stats?.requests), 0);
    const jevUsageReportedRequests = scored.reduce((n, r) => {
        const stats = r.stats;
        if (!stats)
            return n;
        const explicit = stats.jevUsageReportedRequests;
        if (Number.isFinite(explicit))
            return n + positive(explicit);
        return n + ((positive(stats.jevInputTokens) + positive(stats.jevOutputTokens)) > 0 ? positive(stats.requests) : 0);
    }, 0);
    const selectionMs = scored.reduce((n, r) => n + positive(r.stats?.ms), 0);
    const byTool = new Map();
    // Tool-level "removed" figures should represent runs that actually made it
    // through restore, not merely a prepared sidecar that native compaction or
    // the process lifecycle never consumed.
    for (const row of completedPrepared) {
        for (const decision of row.decisions ?? []) {
            const current = byTool.get(decision.name) ?? { tool: decision.name, calls: 0, kept: 0, dropped: 0, truncated: 0, originalChars: 0, removedChars: 0 };
            current.calls++;
            current.kept += Number(decision.action === 'keep');
            current.dropped += Number(decision.action === 'drop_call');
            current.truncated += Number(decision.action === 'truncate_result');
            current.originalChars += positive(decision.originalChars);
            current.removedChars += positive(decision.savedChars);
            byTool.set(decision.name, current);
        }
    }
    const recentDecisions = prepared
        .slice()
        .reverse()
        .flatMap((row) => (row.decisions ?? []).slice().reverse().map((decision) => ({
        at: row.at,
        sessionId: row.sessionId,
        tool: decision.name,
        inputPreview: decision.inputPreview,
        action: decision.action,
        removedChars: positive(decision.savedChars),
        originalChars: positive(decision.originalChars),
        dropLoss: decision.dropLoss,
        truncateLoss: decision.truncateLoss,
        pinned: decision.pinned,
    })))
        .slice(0, 100);
    const readyByRun = new Map();
    for (const row of ready)
        readyByRun.set(runKey(row), row);
    const restoresByRun = new Map();
    for (const row of restored)
        restoresByRun.set(runKey(row), row);
    const restoreFailuresByRun = new Map();
    for (const row of restoreFailures)
        restoreFailuresByRun.set(runKey(row), row);
    const runs = [];
    for (const row of [...prepared, ...skipped, ...precompactFailures]) {
        const s = row.stats;
        const before = positive(s?.charsBefore);
        const after = positive(s?.charsAfter);
        const key = runKey(row);
        const restore = restoresByRun.get(key);
        const restoreFailure = restoreFailuresByRun.get(key);
        const readyRow = readyByRun.get(key);
        runs.push({
            runId: key,
            at: row.at,
            sessionId: row.sessionId,
            trigger: row.trigger,
            model: row.model,
            provider: row.provider,
            status: row.status === 'prepared'
                ? restore ? 'restored' : restoreFailure ? 'restore_failed' : readyRow ? 'ready' : 'prepared'
                : row.status,
            reductionRatio: ratio(Math.max(0, before - after), before),
            charsBefore: before,
            charsAfter: after,
            removedChars: Math.max(0, before - after),
            calls: positive(s?.calls),
            kept: positive(s?.kept),
            truncated: positive(s?.resultsTruncated),
            dropped: positive(s?.callsDropped),
            pinned: positive(s?.pinned),
            jevRequests: positive(s?.requests),
            jevInputTokens: positive(s?.jevInputTokens),
            jevOutputTokens: positive(s?.jevOutputTokens),
            jevUsageReportedRequests: Number.isFinite(s?.jevUsageReportedRequests) ? positive(s?.jevUsageReportedRequests) : ((positive(s?.jevInputTokens) + positive(s?.jevOutputTokens)) > 0 ? positive(s?.requests) : 0),
            selectionMs: positive(s?.ms),
            restoreMode: restore?.restoreMode,
            injectedPayloadChars: restore?.injectedPayloadChars,
            retainedChars: restore?.retainedChars ?? row.retainedChars,
            nativePresentChars: restore?.nativePresentChars,
            restoreCandidateChars: restore?.restoreCandidateChars,
            membershipStatus: restore?.membershipStatus,
            detail: restoreFailure?.detail ?? row.detail,
        });
    }
    runs.sort((a, b) => b.at.localeCompare(a.at));
    return {
        measured: true,
        note: 'Primary context-reduction figures are measured from local transcript characters. Jev token usage is reported by the Jev provider. Codex billing-token savings are not inferred.',
        attempts: prepared.length + skipped.length + precompactFailures.length,
        prepared: prepared.length,
        ready: ready.length,
        restored: restored.length,
        latestRestoredAt: restored.reduce((latest, row) => row.at > latest ? row.at : latest, ''),
        skipped: skipped.length,
        nativeFallbacks: precompactFailures.length,
        restoreFailures: restoreFailures.length,
        transcriptCharsBefore,
        transcriptCharsAfter,
        transcriptCharsRemoved,
        transcriptReductionRatio: ratio(transcriptCharsRemoved, transcriptCharsBefore),
        completedCharsBefore,
        completedCharsAfter,
        completedCharsRemoved,
        completedReductionRatio: ratio(completedCharsRemoved, completedCharsBefore),
        retainedArchiveChars,
        injectedChars,
        injectedPayloadChars,
        restoreEligibleChars,
        restoreCharsNotInjected,
        nativePresentChars,
        restoreCandidateChars,
        verifiedMemberships,
        jevInputTokens,
        jevOutputTokens,
        jevRequests,
        jevUsageReportedRequests,
        jevUsageCoverage: jevRequests ? jevUsageReportedRequests / jevRequests : 0,
        evaluatedSelections: scored.length,
        averageSelectionMs: scored.length ? Math.round(selectionMs / scored.length) : 0,
        settings: userSettings(env),
        byTool: [...byTool.values()].sort((a, b) => b.removedChars - a.removedChars),
        recentDecisions,
        runs: runs.slice(0, 100),
        recentEvents: rows.slice(-100).reverse(),
    };
}
function page(token) {
    return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="jevcomp-token" content="${token}">
<title>jevcomp · dashboard</title>
<style>
:root{color-scheme:dark;--bg:#151514;--panel:#20201f;--panel2:#252524;--line:#393936;--text:#f3f3f1;--muted:#a2a29e;--green:#5bc66b;--bar:#73816e;--orange:#ee7847;--amber:#e2ac42;--blue:#8cacfa}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1160px;margin:auto;padding:22px 18px 56px}
h1,h2,p{margin:0}h1{font-size:18px;letter-spacing:-.03em}h2{font-size:15px;font-weight:680}
.top{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:20px}
.top-left{display:flex;align-items:baseline;gap:13px}.top-note,.sub,.muted{color:var(--muted)}.top-note{font-size:11px}
.live{font-size:11px;color:var(--muted)}.section{margin-top:18px}
.panel,.metric{background:var(--panel);border:1px solid var(--line);border-radius:11px}
.panel{padding:18px;min-width:0}.sub{font-size:12px;margin-top:4px;line-height:1.45}
.hero,.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.reduction-card{display:grid;grid-template-rows:auto 1fr auto}
.reduction-number{align-self:center;font-size:clamp(64px,7vw,96px);line-height:1;letter-spacing:-.06em;color:var(--green)}
.reduction-foot p{margin-top:12px}.reduction-foot b{font-size:16px}.reduction-foot .muted{font-size:11px}
.track{height:11px;background:#353b35;border-radius:7px;overflow:hidden}
.track i{display:block;height:100%;background:var(--green);border-radius:7px}
.hero-metrics{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:12px}
.metric{padding:16px;display:flex;flex-direction:column;justify-content:center;min-width:0}
.metric-label{font-size:11px;color:var(--muted)}.metric-number{font-size:26px;font-weight:760;line-height:1.2;margin:9px 0;color:var(--green)}
.metric-detail{font-size:11px;color:var(--muted);line-height:1.4}
.flow-panel{margin-top:18px}.flow{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;align-items:center;gap:9px;margin-top:16px}
.flow-node{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:13px;min-width:0}
.flow-node .label{font-size:11px;color:var(--muted)}.flow-node strong{display:block;font-size:20px;line-height:1.25;margin-top:5px}
.flow-node .detail{font-size:11px;color:var(--muted);margin-top:4px}.arrow{color:var(--muted);font-size:17px}
details{margin-top:14px}summary{cursor:pointer;color:var(--green);font-size:12px}details p{font-size:12px;color:var(--muted);margin-top:7px}
.pair>.panel{min-height:255px}.bar-key{display:flex;gap:16px;margin:13px 0;color:var(--muted);font-size:11px}
.swatch{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px}.swatch.before{background:var(--bar)}.swatch.after{background:var(--green)}
.chart-run{display:grid;grid-template-columns:52px minmax(0,1fr);gap:8px;margin-top:14px;align-items:start}
.chart-time{font-size:11px;color:var(--muted)}.chart-lines{min-width:0}.chart-line{display:grid;grid-template-columns:minmax(0,1fr) 95px;gap:6px;align-items:center;margin-bottom:5px}
.bar-track{height:12px}.bar{display:block;height:12px;border-radius:3px}.bar.before{background:var(--bar)}.bar.after{background:var(--green)}
.chart-value{font-size:11px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.stat{display:flex;justify-content:space-between;gap:10px;padding:11px 0;border-bottom:1px solid var(--line)}
.stat b{font-variant-numeric:tabular-nums}.empty{padding:20px;color:var(--muted);text-align:center}
.section-heading{margin-bottom:10px}.detail-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}
.detail-grid .metric{min-height:104px}.detail-grid .metric-number{font-size:23px}
.table-panel{padding:0;overflow-x:auto}table{width:100%;border-collapse:collapse}
th,td{padding:10px 12px;border-bottom:1px solid #353532;text-align:left;vertical-align:top}
th{font-size:10px;color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}tr:hover td{background:#262624}
.num{text-align:right;font-variant-numeric:tabular-nums}.cell-note{font-size:11px;color:var(--muted);margin-top:3px}
.preview{max-width:330px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tag{display:inline-block;border:1px solid var(--line);border-radius:5px;padding:2px 7px;font-size:11px;font-weight:650;white-space:nowrap}
.tag.success{border-color:#316e3b;color:var(--green);background:#1a3020}.tag.fallback{border-color:#81462f;color:var(--orange);background:#34241d}
.tag.pending{border-color:#775b2b;color:var(--amber);background:#332b1c}.tag.neutral{border-color:#485370;color:var(--blue);background:#232a39}
.tag.protected{border-color:#66567b;color:#bda2e8;background:#2b2532}
.error{margin-bottom:16px;padding:12px 16px;border:1px solid #81462f;border-radius:8px;color:var(--orange)}
footer{color:var(--muted);font-size:11px;margin-top:18px}
@media(max-width:850px){.hero,.pair{grid-template-columns:1fr}.reduction-number{margin:30px 0}.detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:540px){main{padding:18px 12px 42px}.top{align-items:flex-start}.top-left{display:block}.hero-metrics{grid-template-rows:auto}.flow{grid-template-columns:1fr}.arrow{display:none}.detail-grid{grid-template-columns:1fr 1fr}table{min-width:660px}}
h3{margin:0;font-size:13px;font-weight:650}.small{font-size:11px}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:18px}
.tab{background:none;border:0;border-bottom:2px solid transparent;color:var(--muted);font:inherit;font-weight:600;padding:9px 12px;cursor:pointer;margin-bottom:-1px}
.tab[aria-selected="true"]{color:var(--text);border-bottom-color:var(--green)}.tab:hover{color:var(--text)}
.tab:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.settings{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:12px;align-items:start}
.settings-side{display:grid;gap:12px}
.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 18px;align-items:center;padding:14px 0;border-bottom:1px solid var(--line)}
.row p{grid-column:1;font-size:11px;color:var(--muted);line-height:1.45;max-width:62ch}
.row .control{grid-column:2;grid-row:1/span 2;justify-self:end}
.seg{display:inline-flex;flex-wrap:wrap;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:2px;gap:2px}
.seg button{background:none;border:1px solid transparent;border-radius:6px;color:var(--muted);font:inherit;font-size:12px;font-weight:600;padding:5px 10px;cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums}
.seg button:hover{color:var(--text)}
.seg button[aria-pressed="true"]{background:#1a3020;border-color:#316e3b;color:var(--green)}
.seg button:disabled{cursor:not-allowed;opacity:.55}
.locked{grid-column:1/-1;font-size:11px;color:var(--amber)}
.kv{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:12px}
.kv:last-child{border-bottom:0}.kv>span:first-child{color:var(--muted)}.kv b{text-align:right;overflow-wrap:anywhere}
.btn{background:var(--panel2);border:1px solid var(--line);border-radius:7px;color:var(--text);font:inherit;font-size:12px;font-weight:600;padding:6px 11px;cursor:pointer}
.btn:hover{border-color:#55554f}.btn.primary{background:#1a3020;border-color:#316e3b;color:var(--green)}
.btn.danger{color:var(--orange);border-color:#81462f;background:#34241d}
.key-edit{display:grid;gap:8px;margin-top:10px}
.key-edit input{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:7px;color:var(--text);font:12px ui-monospace,"Cascadia Code",Consolas,monospace;padding:8px 10px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}
.group-title{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}
.note{font-size:11px;color:var(--amber);margin-top:8px}
.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#1a3020;border:1px solid #316e3b;color:var(--green);border-radius:8px;padding:8px 14px;font-weight:650;font-size:12px}
.toast.bad{background:#34241d;border-color:#81462f;color:var(--orange)}
@media(max-width:850px){.settings{grid-template-columns:1fr}}
@media(max-width:540px){.row{grid-template-columns:1fr}.row .control{grid-column:1;grid-row:auto;justify-self:start}}
</style></head><body><main>
<header class="top"><div class="top-left"><h1>jevcomp</h1><span class="top-note">compactação do Codex</span></div><span class="live" id="live">dados locais · atualização a cada 5s</span></header>
<nav class="tabs" role="tablist" aria-label="Seções"><button class="tab" role="tab" id="tab-resumo" aria-selected="true" aria-controls="view-resumo">Resumo</button><button class="tab" role="tab" id="tab-config" aria-selected="false" aria-controls="view-config">Configurações</button></nav>
<div id="error"></div>
<div id="view-resumo" role="tabpanel" aria-labelledby="tab-resumo">
<section class="hero" aria-label="Resumo do Jev">
 <div class="panel reduction-card"><div><h2>Quanto texto foi reduzido?</h2><p class="sub">Nas compactações em que o jevcomp enviou texto ao Codex.</p></div><strong class="reduction-number" id="reduction">—</strong><div class="reduction-foot"><div class="track"><i id="reduction-bar"></i></div><p><b id="removed">—</b><br><span class="muted">do texto lido nessas compactações</span></p></div></div>
 <div class="hero-metrics">
  <div class="metric"><span class="metric-label">Chamadas ao modelo Jev</span><strong class="metric-number" id="jev-requests">—</strong><span class="metric-detail">Pedidos feitos ao Jev para escolher o que guardar.</span></div>
  <div class="metric"><span class="metric-label">Último envio ao Codex</span><strong class="metric-number" id="last-delivery">—</strong><span class="metric-detail" id="last-delivery-detail">O jevcomp ainda não enviou texto ao Codex.</span></div>
  <div class="metric"><span class="metric-label">Compactações registradas</span><strong class="metric-number" id="attempts">—</strong><span class="metric-detail">Vezes em que o Codex iniciou uma compactação.</span></div>
  <div class="metric"><span class="metric-label">Texto retirado</span><strong class="metric-number" id="removed-count">—</strong><span class="metric-detail">Caracteres cortados nessas compactações.</span></div>
 </div>
</section>
<section class="panel flow-panel"><h2>De onde vem essa redução?</h2><p class="sub">O Jev escolhe o que guardar da conversa para o Codex continuar depois da compactação.</p><div class="flow" id="flow"></div><details><summary>Por que os dois últimos números são diferentes?</summary><p>O Jev primeiro guarda o que importa; depois o jevcomp envia ao Codex só o que o resumo perdeu, dentro do limite configurado.</p></details></section>
<section class="section pair">
 <div class="panel"><h2>Texto por compactação</h2><p class="sub">Antes e depois do corte, em caracteres, nas compactações com envio ao Codex.</p><div class="bar-key"><span><i class="swatch before"></i>Antes</span><span><i class="swatch after"></i>Depois</span></div><div id="rounds-chart"></div></div>
 <div class="panel"><h2>Decisões de retenção</h2><p class="sub" id="decision-caption">Nas compactações com envio ao Codex.</p><div id="decision-stats"></div><details><summary>Entenda estas decisões</summary><p>Guardado inteiro mantém o comando e toda a saída. Guardado encurtado mantém o começo da saída. Descartado fica de fora do que o Jev guarda. Mensagens recentes nunca são cortadas e não entram nesses percentuais.</p></details></div>
</section>
<section class="section"><div class="section-heading"><h2>Detalhes da integração</h2><p class="sub">Informações adicionais registradas pelos hooks locais.</p></div><div class="detail-grid" id="details"></div></section>
<section class="section"><div class="section-heading"><h2>Compactações recentes</h2><p class="sub">O que aconteceu em cada compactação.</p></div><div class="panel table-panel"><table><thead><tr><th>Quando</th><th>Resultado</th><th>Texto enviado ao Codex</th></tr></thead><tbody id="runs"></tbody></table></div></section>
<section class="section"><div class="section-heading"><h2>Decisões recentes</h2><p class="sub">Os dois percentuais de cada linha estimam o risco de perder informação útil ao remover ou resumir o resultado. Quanto maior o percentual, maior o risco.</p></div><div class="panel table-panel"><table><thead><tr><th>Ferramenta</th><th>Decisão</th><th>Entrada</th><th>Risco de remover / resumir</th><th class="num">Caracteres retirados</th></tr></thead><tbody id="decisions"></tbody></table></div></section>
</div>
<div id="view-config" role="tabpanel" aria-labelledby="tab-config" hidden>
 <div class="settings">
  <div class="settings-side">
   <section class="panel" aria-labelledby="h-conexao">
    <h2 id="h-conexao">Conexão</h2><p class="sub">Quem o jevcomp usa para decidir o que manter.</p>
    <div class="seg" role="group" aria-label="Provedor" id="provider-seg" style="margin-top:14px"><button type="button" data-provider="openrouter" aria-pressed="false">OpenRouter</button><button type="button" data-provider="typesafe" aria-pressed="false">TypeSafe</button></div>
    <div id="provider-note"></div>
    <div style="margin-top:12px" id="connection"></div>
    <div class="actions"><button class="btn" type="button" id="change-key">Trocar chave</button></div>
    <form class="key-edit" id="key-form" hidden>
     <label class="muted small" for="key-input" id="key-label">Nova chave</label>
     <input id="key-input" type="password" autocomplete="off" spellcheck="false">
     <div class="actions" style="margin-top:0"><button class="btn primary" type="submit">Salvar chave</button><button class="btn" type="button" id="cancel-key">Cancelar</button></div>
    </form>
   </section>
   <section class="panel" aria-labelledby="h-codex"><h2 id="h-codex">Codex</h2><p class="sub">Como o jevcomp está ligado ao Codex.</p><div style="margin-top:12px" id="codex-info"></div></section>
  </div>
  <section class="panel" aria-labelledby="h-comport">
   <div class="group-title"><h2 id="h-comport">Comportamento</h2><span class="muted small">Cada mudança é salva na hora e vale a partir da próxima compactação.</span></div>
   <div id="behavior"></div>
   <div class="actions" id="reset-area"></div>
  </section>
 </div>
</div>
<footer>Dados do histórico local do jevcomp. Caracteres retirados não representam economia de tokens cobrados pelo Codex. A dashboard escuta somente em 127.0.0.1.</footer>
</main><div class="toast" id="toast" role="status" hidden></div><script>
const f=n=>Number(n||0).toLocaleString('pt-BR');
const pct=n=>(Number(n||0)*100).toFixed(1)+'%';
const chars=n=>f(n)+' caracteres';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when=s=>{const d=new Date(s);return Number.isNaN(d.getTime())?'—':d.toLocaleString('pt-BR')};
const time=s=>{const d=new Date(s);return Number.isNaN(d.getTime())?'—':d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})};
const metric=(label,number,detail)=>'<div class="metric"><span class="metric-label">'+label+'</span><strong class="metric-number">'+number+'</strong><span class="metric-detail">'+detail+'</span></div>';
const actionTag=d=>d.pinned?'<span class="tag protected">Recente, não cortado</span>':d.action==='drop_call'?'<span class="tag neutral">Descartado</span>':d.action==='truncate_result'?'<span class="tag pending">Guardado encurtado</span>':'<span class="tag success">Guardado inteiro</span>';
 const statusTag=status=>status==='restored'?'<span class="tag success">Enviado ao Codex</span>':status==='failed'?'<span class="tag fallback">Codex compactou sem o jevcomp</span>':status==='restore_failed'?'<span class="tag fallback">Falha ao enviar</span>':status==='skipped'?'<span class="tag neutral">Não enviado: corte pequeno</span>':status==='ready'?'<span class="tag pending">Aguardando envio</span>':'<span class="tag pending">Aguardando a compactação</span>';
 const textAdditional=r=>r.status==='restored'?chars(r.injectedPayloadChars):r.status==='prepared'||r.status==='ready'?'Aguardando':'Não enviado';
function renderChart(runs){
 const completed=runs.filter(r=>r.status==='restored'&&r.charsBefore>0).slice(0,8);
 if(!completed.length)return '<div class="empty">Ainda não houve compactação com envio ao Codex.</div>';
 const max=Math.max(...completed.map(r=>r.charsBefore));
 return completed.map(r=>{
  const line=(value,kind)=>'<div class="chart-line"><div class="bar-track"><i class="bar '+kind+'" style="width:'+Math.max(1,Math.min(100,value/max*100))+'%"></i></div><span class="chart-value">'+f(value)+'</span></div>';
  return '<div class="chart-run"><span class="chart-time">'+time(r.at)+'</span><div class="chart-lines">'+line(r.charsBefore,'before')+line(r.charsAfter,'after')+'</div></div>';
 }).join('');
}
function renderDecisions(byTool){
 const totals=byTool.reduce((sum,tool)=>({calls:sum.calls+tool.calls,kept:sum.kept+tool.kept,truncated:sum.truncated+tool.truncated,dropped:sum.dropped+tool.dropped}),{calls:0,kept:0,truncated:0,dropped:0});
 document.querySelector('#decision-caption').textContent=totals.calls?'Sobre '+f(totals.calls)+' comandos e leituras de arquivo nas compactações com envio ao Codex.':'Ainda não houve compactação com envio ao Codex.';
 if(!totals.calls)return '<div class="empty">Nenhuma decisão registrada ainda.</div>';
 return [['Guardados inteiros',totals.kept],['Guardados encurtados',totals.truncated],['Descartados',totals.dropped]].map(([label,count])=>'<div class="stat"><span>'+label+'</span><b>'+f(count)+' · '+pct(count/totals.calls)+'</b></div>').join('');
}
function refresh(){
 return fetch('/api/stats',{cache:'no-store'}).then(response=>{if(!response.ok)throw Error('HTTP '+response.status);return response.json()}).then(s=>{
  document.querySelector('#error').innerHTML='';
  const completed=s.restored>0;
  document.querySelector('#reduction').textContent=completed&&s.completedCharsBefore?pct(s.completedReductionRatio):'—';
  document.querySelector('#reduction-bar').style.width=completed?Math.max(0,Math.min(100,s.completedReductionRatio*100))+'%':'0%';
  document.querySelector('#removed').textContent=completed?chars(s.completedCharsRemoved)+' retirados':'Aguardando o primeiro envio ao Codex';
  document.querySelector('#jev-requests').textContent=f(s.jevRequests);
  document.querySelector('#attempts').textContent=f(s.attempts);
  document.querySelector('#removed-count').textContent=completed?f(s.completedCharsRemoved):'—';
  document.querySelector('#last-delivery').textContent=s.latestRestoredAt?time(s.latestRestoredAt):'—';
  document.querySelector('#last-delivery-detail').textContent=s.latestRestoredAt?'Em '+new Date(s.latestRestoredAt).toLocaleDateString('pt-BR')+'.':'O jevcomp ainda não enviou texto ao Codex.';
  const flowItems=[['Texto da conversa analisado',s.completedCharsBefore,'caracteres antes do corte'],['Texto guardado pelo Jev',s.completedCharsAfter,'caracteres depois do corte'],['Texto enviado ao Codex',s.injectedPayloadChars,'caracteres, dentro do limite configurado']];
  document.querySelector('#flow').innerHTML=flowItems.map(item=>'<div class="flow-node"><span class="label">'+item[0]+'</span><strong>'+(completed?f(item[1]):'—')+'</strong><div class="detail">'+item[2]+'</div></div>').join('<span class="arrow">→</span>');
  document.querySelector('#rounds-chart').innerHTML=renderChart(s.runs);
  document.querySelector('#decision-stats').innerHTML=renderDecisions(s.byTool);
  const usage=s.jevUsageReportedRequests?f(s.jevUsageReportedRequests)+' de '+f(s.jevRequests)+' requisições com uso reportado':'Uso não reportado pelo provedor';
   document.querySelector('#details').innerHTML=[
    metric('Codex compactou sem o jevcomp',f(s.nativeFallbacks),'compactação nativa após falha do Jev'),
    metric('Tokens de entrada Jev',s.jevUsageReportedRequests?f(s.jevInputTokens):'—',usage),
    metric('Tokens de saída Jev',s.jevUsageReportedRequests?f(s.jevOutputTokens):'—',usage),
    metric('Tempo médio do Jev',s.evaluatedSelections?f(s.averageSelectionMs)+' ms':'—','não inclui toda a compactação'),
    metric('Duplicatas evitadas',s.nativePresentChars?chars(s.nativePresentChars):'—',s.verifiedMemberships?f(s.verifiedMemberships)+' restores conferidos após a compactação':'nenhum restore conferido ainda')
   ].join('');
  document.querySelector('#runs').innerHTML=s.runs.slice(0,50).map(r=>'<tr><td>'+when(r.at)+'</td><td>'+statusTag(r.status)+'</td><td>'+textAdditional(r)+'</td></tr>').join('')||'<tr><td colspan="3" class="empty">Nenhuma compactação registrada ainda.</td></tr>';
  document.querySelector('#decisions').innerHTML=s.recentDecisions.slice(0,50).map(d=>'<tr><td>'+esc(d.tool)+'<div class="cell-note">'+when(d.at)+'</div></td><td>'+actionTag(d)+'</td><td><div class="preview" title="'+esc(d.inputPreview)+'">'+esc(d.inputPreview||'—')+'</div></td><td>'+pct(d.dropLoss)+' / '+pct(d.truncateLoss)+'</td><td class="num">'+chars(d.removedChars)+'</td></tr>').join('')||'<tr><td colspan="5" class="empty">Nenhuma decisão registrada ainda.</td></tr>';
  document.querySelector('#live').textContent='dados locais · atualizado '+new Date().toLocaleTimeString('pt-BR');
 });
}
function showError(error){document.querySelector('#error').innerHTML='<div class="error">Erro ao ler dados: '+esc(String(error))+'</div>'}
refresh().catch(showError);
setInterval(()=>refresh().catch(showError),5000);
const token=document.querySelector('meta[name="jevcomp-token"]').content;
const SETTING_TEXT={
 'restore-mode':{title:'Quanto texto enviar ao Codex',help:'Depois da compactação, o jevcomp envia ao Codex o que o resumo perdeu. Todo o texto: envia tudo, até o limite abaixo. Parte do texto: envia a lista e um trecho. Só a lista: envia apenas os nomes dos comandos e arquivos guardados e onde estão salvos no seu computador; o Codex abre o texto completo só se precisar.',label:v=>({preserve:'Todo o texto',balanced:'Parte do texto',minimal:'Só a lista'})[v]||v},
 'restore-max-chars':{title:'Limite de texto enviado ao Codex',help:'O máximo de texto que o jevcomp envia ao Codex depois de cada compactação, em caracteres. Mais alto mantém mais detalhes, mas ocupa mais espaço na conversa.',label:v=>Number(v)===0?'Sem limite':f(Number(v)/1000)+' mil'},
 'pin-recent-messages':{title:'Mensagens recentes que nunca são cortadas',help:'As mensagens mais novas ficam sempre inteiras. Mais alto é mais seguro; mais baixo deixa o jevcomp cortar mais.',label:v=>String(v)},
 'loss-threshold':{title:'Quanto cortar',help:'O Jev estima o risco de cortar algo que o Codex ainda vai usar. Pouco: só corta o que tem risco baixo. Muito: corta mais.',label:v=>({0.3:'Pouco',0.5:'Normal',0.7:'Muito'})[Number(v)]||String(v)},
 'min-reduction-ratio':{title:'Só agir se cortar pelo menos',help:'Se o corte diminuir o texto menos que isso, o jevcomp não faz nada naquela compactação.',label:v=>Math.round(Number(v)*100)+'%'}
};
const PROVIDER_NAME={openrouter:'OpenRouter',typesafe:'TypeSafe'};
let settingsState=null,keyTarget=null,toastTimer;
function toast(text,bad){const el=document.querySelector('#toast');el.textContent=text;el.className='toast'+(bad?' bad':'');el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true},2200)}
function ago(iso){if(!iso)return null;const m=Math.round((Date.now()-new Date(iso).getTime())/60000);if(m<1)return 'agora';if(m<60)return 'há '+m+' min';const h=Math.round(m/60);return h<24?'há '+h+' h':when(iso)}
function keyText(k){if(k.source==='none')return 'Nenhuma chave';const end=k.ending?'••••'+k.ending:'••••';return k.source==='environment'?end+' · da variável '+k.variable:end+' · salva neste computador'}
const kv=(label,value)=>'<div class="kv"><span>'+label+'</span><b>'+value+'</b></div>';
const same=(a,b)=>String(a)===String(b)||(!Number.isNaN(Number(a))&&Number(a)===Number(b));
function renderSettings(s){
 settingsState=s;
 document.querySelectorAll('#provider-seg button').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.provider===s.provider));b.disabled=!!s.providerLockedBy});
 document.querySelector('#provider-note').innerHTML=s.providerLockedBy?'<p class="note">Definido pela variável '+esc(s.providerLockedBy)+' no seu sistema.</p>':'';
 const key=s.keys[s.provider];
 const last=s.lastJev?(s.lastJev.ok?'Funcionou · '+when(s.lastJev.at):'Falhou · '+when(s.lastJev.at)):'Ainda nenhuma';
 document.querySelector('#connection').innerHTML=kv('Chave '+PROVIDER_NAME[s.provider],esc(keyText(key)))+kv('Última chamada ao Jev',esc(last))+(key.source==='environment'?'<p class="note">A variável '+esc(key.variable)+' do seu sistema tem prioridade sobre uma chave salva aqui.</p>':'');
 document.querySelector('#change-key').textContent=key.source==='none'?'Adicionar chave':'Trocar chave';
 const latest=Object.values(s.hooks.activity||{}).sort().pop();
 const hooksTag=s.hooks.installed>=s.hooks.total?'tag success':'tag fallback';
 document.querySelector('#codex-info').innerHTML=kv('Instalação',(s.installation.kind==='plugin'?'Plugin do Codex':'Comando jevcomp')+' · '+esc(s.installation.version))
  +kv('Hooks','<span class="'+hooksTag+'">'+s.hooks.installed+' de '+s.hooks.total+' instalados</span>')
  +kv('Último sinal dos hooks',latest?esc(ago(latest)):'Ainda nenhum')
  +kv('Dashboard',esc(s.dashboardUrl));
 document.querySelector('#behavior').innerHTML=s.settings.map(item=>{
  const text=SETTING_TEXT[item.name];
  const choices=item.choices.some(c=>same(c,item.value))?item.choices:item.choices.concat([item.value]);
  const buttons=choices.map(c=>'<button type="button" data-value="'+esc(c)+'" aria-pressed="'+same(c,item.value)+'"'+(item.lockedBy?' disabled':'')+'>'+esc(text.label(c))+'</button>').join('');
  const locked=item.lockedBy?'<span class="locked">Definido pela variável '+esc(item.lockedBy)+' no seu sistema. Remova a variável para mudar aqui.</span>':'';
  return '<div class="row"><h3>'+text.title+'</h3><p>'+text.help+'</p><div class="control seg" role="group" aria-label="'+text.title+'" data-name="'+item.name+'">'+buttons+'</div>'+locked+'</div>';
 }).join('');
}
function loadSettings(){return fetch('/api/settings',{cache:'no-store'}).then(r=>r.json()).then(renderSettings).catch(e=>toast('Erro ao ler as configurações: '+e.message,true))}
function send(body,message){return fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json','x-jevcomp-token':token},body:JSON.stringify(body)}).then(r=>r.json().then(j=>{if(!r.ok)throw Error(j.error||'HTTP '+r.status);return j})).then(s=>{renderSettings(s);toast(message||'Salvo');return true}).catch(e=>{toast('Não salvo: '+e.message,true);return false})}
function openKeyForm(provider){keyTarget=provider;document.querySelector('#key-label').textContent='Chave '+PROVIDER_NAME[provider];document.querySelector('#key-input').value='';document.querySelector('#key-form').hidden=false;document.querySelector('#key-input').focus()}
document.querySelector('#provider-seg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled||!settingsState)return;const p=b.dataset.provider;if(p===settingsState.provider)return;if(settingsState.keys[p].source==='none'){openKeyForm(p);return}send({action:'provider',provider:p},'Agora usando '+PROVIDER_NAME[p])});
document.querySelector('#change-key').addEventListener('click',()=>{if(settingsState)openKeyForm(settingsState.provider)});
document.querySelector('#cancel-key').addEventListener('click',()=>{document.querySelector('#key-form').hidden=true});
document.querySelector('#key-form').addEventListener('submit',e=>{e.preventDefault();const input=document.querySelector('#key-input');const key=input.value.trim();if(!key){toast('Cole a chave antes de salvar.',true);return}send({action:'key',provider:keyTarget,key},'Chave salva').then(ok=>{if(ok){document.querySelector('#key-form').hidden=true;input.value=''}})});
document.querySelector('#behavior').addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;send({action:'setting',name:b.closest('.seg').dataset.name,value:b.dataset.value})});
function showReset(){const area=document.querySelector('#reset-area');area.innerHTML='<button class="btn danger" type="button" id="reset">Restaurar padrões</button>';document.querySelector('#reset').addEventListener('click',()=>{area.innerHTML='<span class="muted">Voltar as opções acima ao padrão? Provedor e chave continuam como estão.</span><button class="btn danger" type="button" id="reset-yes">Restaurar</button><button class="btn" type="button" id="reset-no">Cancelar</button>';document.querySelector('#reset-yes').addEventListener('click',()=>send({action:'reset'},'Padrões restaurados').then(showReset));document.querySelector('#reset-no').addEventListener('click',showReset)})}
showReset();
function showTab(name){document.querySelectorAll('.tab').forEach(t=>{const on=t.id==='tab-'+name;t.setAttribute('aria-selected',String(on));document.getElementById(t.getAttribute('aria-controls')).hidden=!on});if(name==='config')loadSettings();history.replaceState(null,'',name==='config'?'#configuracoes':'#resumo')}
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>showTab(t.id.slice(4))));
showTab(location.hash==='#configuracoes'?'config':'resumo');
setInterval(()=>{if(!document.querySelector('#view-config').hidden&&document.querySelector('#key-form').hidden)loadSettings()},15000);
</script></body></html>`;
}
async function jsonBody(req) {
    let text = '';
    for await (const chunk of req) {
        text += chunk;
        if (text.length > 16_384)
            throw new Error('request too large');
    }
    const value = JSON.parse(text || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('request must be a JSON object');
    return value;
}
function json(res, value, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
}
export async function startDashboard(port = 43127, env = process.env) {
    const host = '127.0.0.1';
    let cachedIdentity = '';
    let cachedStats;
    const currentStats = async () => {
        const identityPart = async (path) => {
            try {
                const info = await stat(path);
                return `${info.size}:${info.mtimeMs}`;
            }
            catch {
                return 'missing';
            }
        };
        // Dashboard content depends on both history and the persisted user-facing settings.
        const historyIdentity = await Promise.all(readableHistoryPaths(env).map(identityPart));
        const identity = `${historyIdentity.join('|')}|${await identityPart(settingsPath(env))}`;
        if (cachedStats && identity === cachedIdentity)
            return cachedStats;
        cachedStats = await stats(env);
        cachedIdentity = identity;
        return cachedStats;
    };
    const token = randomUUID();
    // Checking Host blocks DNS-rebinding pages; the token and Origin stop other sites from changing settings.
    const trustedHost = (req) => {
        const listening = server.address()?.port;
        return req.headers.host === `${host}:${listening}` || req.headers.host === `localhost:${listening}`;
    };
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? '/', `http://${host}`);
            if (!trustedHost(req))
                return json(res, { error: 'forbidden' }, 403);
            if (url.pathname === '/api/settings' && req.method === 'POST') {
                const origin = req.headers.origin;
                if (req.headers['x-jevcomp-token'] !== token || (origin && origin !== `http://${req.headers.host}`))
                    return json(res, { error: 'forbidden' }, 403);
                try {
                    await applySettingsChange(await jsonBody(req), env);
                }
                catch (error) {
                    return json(res, { error: error instanceof Error ? error.message : String(error) }, 400);
                }
                return json(res, await settingsSnapshot(env));
            }
            if (url.pathname === '/api/settings')
                return json(res, await settingsSnapshot(env));
            if (url.pathname === '/api/health')
                return json(res, {
                    ok: true,
                    service: 'jevcomp-dashboard',
                    pid: process.pid,
                    instanceId: env.JEVCOMP_DASHBOARD_INSTANCE_ID ?? null,
                    entry: process.argv[1] ?? null,
                });
            if (url.pathname === '/api/stats')
                return json(res, await currentStats());
            if (url.pathname === '/api/history')
                return json(res, (await readHistory(env)).slice(-200).reverse());
            if (url.pathname !== '/')
                return json(res, { error: 'not found' }, 404);
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(page(token));
        }
        catch (error) {
            json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('dashboard did not bind to a TCP port');
    return { server, url: `http://${host}:${address.port}/` };
}
