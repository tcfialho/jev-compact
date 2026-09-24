import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { readableHistoryPaths, readHistory, type HistoryRow } from './store.js';
import { settingsPath, userSettings } from './settings.js';

interface ToolSummary {
  tool: string;
  calls: number;
  kept: number;
  dropped: number;
  truncated: number;
  originalChars: number;
  removedChars: number;
}

interface RunSummary {
  runId: string;
  at: string;
  sessionId: string;
  trigger?: string;
  model?: string;
  provider?: string;
  status: 'prepared' | 'ready' | 'restored' | 'observed' | 'skipped' | 'failed' | 'restore_failed';
  reductionRatio: number;
  charsBefore: number;
  charsAfter: number;
  removedChars: number;
  calls: number;
  kept: number;
  truncated: number;
  dropped: number;
  pinned: number;
  jevRequests: number;
  jevInputTokens: number;
  jevOutputTokens: number;
  jevUsageReportedRequests: number;
  selectionMs: number;
  restoreMode?: string;
  operationMode?: string;
  injectedPayloadChars?: number;
  wouldInjectPayloadChars?: number;
  retainedChars?: number;
  nativePresentChars?: number;
  restoreCandidateChars?: number;
  membershipStatus?: string;
  detail?: string;
}

function positive(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function ratio(removed: number, before: number): number {
  return before > 0 ? removed / before : 0;
}

function runKey(row: HistoryRow): string {
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
  const observed = rows.filter((r) => r.status === 'observed' && r.stats);
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
  const wouldInjectChars = observed.reduce((n, r) => n + positive(r.wouldInjectChars), 0);
  const wouldInjectPayloadChars = observed.reduce((n, r) => n + positive(r.wouldInjectPayloadChars), 0);
  const observedNativePresentChars = observed.reduce((n, r) => n + positive(r.nativePresentChars), 0);
  const observedRestoreCandidateChars = observed.reduce((n, r) => n + positive(r.restoreCandidateChars), 0);
  // A skip happens after Jev has already judged the transcript, so its provider
  // usage is real cost even though no retained sidecar is applied.
  const scored = [...prepared, ...skipped].filter((r) => r.stats);
  const jevInputTokens = scored.reduce((n, r) => n + positive(r.stats?.jevInputTokens), 0);
  const jevOutputTokens = scored.reduce((n, r) => n + positive(r.stats?.jevOutputTokens), 0);
  const jevRequests = scored.reduce((n, r) => n + positive(r.stats?.requests), 0);
  const jevUsageReportedRequests = scored.reduce((n, r) => {
    const stats = r.stats;
    if (!stats) return n;
    const explicit = stats.jevUsageReportedRequests;
    if (Number.isFinite(explicit)) return n + positive(explicit);
    return n + ((positive(stats.jevInputTokens) + positive(stats.jevOutputTokens)) > 0 ? positive(stats.requests) : 0);
  }, 0);
  const selectionMs = scored.reduce((n, r) => n + positive(r.stats?.ms), 0);

  const byTool = new Map<string, ToolSummary>();
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

  const readyByRun = new Map<string, HistoryRow>();
  for (const row of ready) readyByRun.set(runKey(row), row);
  const restoresByRun = new Map<string, HistoryRow>();
  for (const row of restored) restoresByRun.set(runKey(row), row);
  const observedByRun = new Map<string, HistoryRow>();
  for (const row of observed) observedByRun.set(runKey(row), row);
  const restoreFailuresByRun = new Map<string, HistoryRow>();
  for (const row of restoreFailures) restoreFailuresByRun.set(runKey(row), row);
  const runs: RunSummary[] = [];
  for (const row of [...prepared, ...skipped, ...precompactFailures]) {
    const s = row.stats;
    const before = positive(s?.charsBefore);
    const after = positive(s?.charsAfter);
    const key = runKey(row);
    const restore = restoresByRun.get(key);
    const observation = observedByRun.get(key);
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
        ? restore ? 'restored' : observation ? 'observed' : restoreFailure ? 'restore_failed' : readyRow ? 'ready' : 'prepared'
        : row.status as RunSummary['status'],
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
      restoreMode: restore?.restoreMode ?? observation?.restoreMode,
      operationMode: row.operationMode ?? restore?.operationMode ?? observation?.operationMode,
      injectedPayloadChars: restore?.injectedPayloadChars,
      wouldInjectPayloadChars: observation?.wouldInjectPayloadChars,
      retainedChars: restore?.retainedChars ?? observation?.retainedChars ?? row.retainedChars,
      nativePresentChars: restore?.nativePresentChars ?? observation?.nativePresentChars,
      restoreCandidateChars: restore?.restoreCandidateChars ?? observation?.restoreCandidateChars,
      membershipStatus: restore?.membershipStatus ?? observation?.membershipStatus,
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
    observed: observed.length,
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
    wouldInjectChars,
    wouldInjectPayloadChars,
    observedNativePresentChars,
    observedRestoreCandidateChars,
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

function page(): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
.section-heading{margin-bottom:10px}.detail-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
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
</style></head><body><main>
<header class="top"><div class="top-left"><h1>jevcomp</h1><span class="top-note">compactação do Codex</span></div><span class="live" id="live">dados locais · atualização a cada 5s</span></header>
<div id="error"></div>
<section class="hero" aria-label="Resumo do Jev">
 <div class="panel reduction-card"><div><h2>Quanto texto foi reduzido?</h2><p class="sub">Nas seleções entregues ao Codex.</p></div><strong class="reduction-number" id="reduction">—</strong><div class="reduction-foot"><div class="track"><i id="reduction-bar"></i></div><p><b id="removed">—</b><br><span class="muted">do texto analisado nessas seleções</span></p></div></div>
 <div class="hero-metrics">
  <div class="metric"><span class="metric-label">Chamadas ao modelo Jev</span><strong class="metric-number" id="jev-requests">—</strong><span class="metric-detail">Requisições feitas para selecionar o texto.</span></div>
  <div class="metric"><span class="metric-label">Última entrega</span><strong class="metric-number" id="last-delivery">—</strong><span class="metric-detail" id="last-delivery-detail">Ainda não houve entrega ao Codex.</span></div>
  <div class="metric"><span class="metric-label">Compactações registradas</span><strong class="metric-number" id="attempts">—</strong><span class="metric-detail">Vezes em que o Codex iniciou uma compactação.</span></div>
  <div class="metric"><span class="metric-label">Texto retirado</span><strong class="metric-number" id="removed-count">—</strong><span class="metric-detail">Caracteres nas seleções entregues.</span></div>
 </div>
</section>
<section class="panel flow-panel"><h2>De onde vem essa redução?</h2><p class="sub">O Jev seleciona material da conversa para ajudar o Codex a continuar após a compactação.</p><div class="flow" id="flow"></div><details><summary>Por que os dois últimos números são diferentes?</summary><p>Selecionar o material e enviar texto ao Codex são etapas diferentes. O limite de envio pode ser menor que o texto guardado pelo Jev.</p></details></section>
<section class="section pair">
 <div class="panel"><h2>Texto por compactação</h2><p class="sub">Antes e depois da seleção, em caracteres, nas entregas concluídas.</p><div class="bar-key"><span><i class="swatch before"></i>Antes</span><span><i class="swatch after"></i>Depois</span></div><div id="rounds-chart"></div></div>
 <div class="panel"><h2>Decisões de retenção</h2><p class="sub" id="decision-caption">Nas entregas concluídas.</p><div id="decision-stats"></div><details><summary>Entenda estas decisões</summary><p>Preservado mantém chamada e resultado. Resumido encurta o resultado. Removido deixa o par fora do texto selecionado. Mensagens recentes protegidas são outra unidade e não entram nesses percentuais.</p></details></div>
</section>
<section class="section"><div class="section-heading"><h2>Detalhes da integração</h2><p class="sub">Informações adicionais registradas pelos hooks locais.</p></div><div class="detail-grid" id="details"></div></section>
<section class="section"><div class="section-heading"><h2>Compactações recentes</h2><p class="sub">O que aconteceu em cada compactação.</p></div><div class="panel table-panel"><table><thead><tr><th>Quando</th><th>Resultado</th><th>Texto adicional</th></tr></thead><tbody id="runs"></tbody></table></div></section>
<section class="section"><div class="section-heading"><h2>Decisões recentes</h2><p class="sub">Os dois percentuais de cada linha estimam o risco de perder informação útil ao remover ou resumir o resultado. Quanto maior o percentual, maior o risco.</p></div><div class="panel table-panel"><table><thead><tr><th>Ferramenta</th><th>Decisão</th><th>Entrada</th><th>Risco de remover / resumir</th><th class="num">Caracteres retirados</th></tr></thead><tbody id="decisions"></tbody></table></div></section>
<footer>Dados do histórico local do jevcomp. Caracteres retirados não representam economia de tokens cobrados pelo Codex. A dashboard escuta somente em 127.0.0.1.</footer>
</main><script>
const f=n=>Number(n||0).toLocaleString('pt-BR');
const pct=n=>(Number(n||0)*100).toFixed(1)+'%';
const chars=n=>f(n)+' caracteres';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when=s=>{const d=new Date(s);return Number.isNaN(d.getTime())?'—':d.toLocaleString('pt-BR')};
const time=s=>{const d=new Date(s);return Number.isNaN(d.getTime())?'—':d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})};
const metric=(label,number,detail)=>'<div class="metric"><span class="metric-label">'+label+'</span><strong class="metric-number">'+number+'</strong><span class="metric-detail">'+detail+'</span></div>';
const actionTag=d=>d.pinned?'<span class="tag protected">Protegido</span>':d.action==='drop_call'?'<span class="tag neutral">Removido</span>':d.action==='truncate_result'?'<span class="tag pending">Resumido</span>':'<span class="tag success">Preservado</span>';
 const statusTag=status=>status==='restored'?'<span class="tag success">Enviado ao Codex</span>':status==='observed'?'<span class="tag neutral">Somente observado</span>':status==='failed'?'<span class="tag fallback">Codex seguiu sem o Jev</span>':status==='restore_failed'?'<span class="tag fallback">Falha ao enviar</span>':status==='skipped'?'<span class="tag neutral">Jev não aplicado</span>':status==='ready'?'<span class="tag pending">Aguardando envio</span>':'<span class="tag pending">Seleção preparada</span>';
 const textAdditional=r=>r.status==='restored'?chars(r.injectedPayloadChars):r.status==='observed'?'Não injetado · seria '+chars(r.wouldInjectPayloadChars):r.status==='prepared'||r.status==='ready'?'Aguardando':'Não enviado';
function renderChart(runs){
 const completed=runs.filter(r=>r.status==='restored'&&r.charsBefore>0).slice(0,8);
 if(!completed.length)return '<div class="empty">Ainda não há seleção entregue para comparar.</div>';
 const max=Math.max(...completed.map(r=>r.charsBefore));
 return completed.map(r=>{
  const line=(value,kind)=>'<div class="chart-line"><div class="bar-track"><i class="bar '+kind+'" style="width:'+Math.max(1,Math.min(100,value/max*100))+'%"></i></div><span class="chart-value">'+f(value)+'</span></div>';
  return '<div class="chart-run"><span class="chart-time">'+time(r.at)+'</span><div class="chart-lines">'+line(r.charsBefore,'before')+line(r.charsAfter,'after')+'</div></div>';
 }).join('');
}
function renderDecisions(byTool){
 const totals=byTool.reduce((sum,tool)=>({calls:sum.calls+tool.calls,kept:sum.kept+tool.kept,truncated:sum.truncated+tool.truncated,dropped:sum.dropped+tool.dropped}),{calls:0,kept:0,truncated:0,dropped:0});
 document.querySelector('#decision-caption').textContent=totals.calls?'Sobre '+f(totals.calls)+' pares de chamada e resultado nas entregas concluídas.':'Ainda não há decisões em entregas concluídas.';
 if(!totals.calls)return '<div class="empty">Nenhuma decisão registrada ainda.</div>';
 return [['Preservados por inteiro',totals.kept],['Resultados resumidos',totals.truncated],['Removidos do texto selecionado',totals.dropped]].map(([label,count])=>'<div class="stat"><span>'+label+'</span><b>'+f(count)+' · '+pct(count/totals.calls)+'</b></div>').join('');
}
function refresh(){
 return fetch('/api/stats',{cache:'no-store'}).then(response=>{if(!response.ok)throw Error('HTTP '+response.status);return response.json()}).then(s=>{
  document.querySelector('#error').innerHTML='';
  const completed=s.restored>0;
  document.querySelector('#reduction').textContent=completed&&s.completedCharsBefore?pct(s.completedReductionRatio):'—';
  document.querySelector('#reduction-bar').style.width=completed?Math.max(0,Math.min(100,s.completedReductionRatio*100))+'%':'0%';
  document.querySelector('#removed').textContent=completed?chars(s.completedCharsRemoved)+' retirados':'Aguardando seleção entregue';
  document.querySelector('#jev-requests').textContent=f(s.jevRequests);
  document.querySelector('#attempts').textContent=f(s.attempts);
  document.querySelector('#removed-count').textContent=completed?f(s.completedCharsRemoved):'—';
  document.querySelector('#last-delivery').textContent=s.latestRestoredAt?time(s.latestRestoredAt):'—';
  document.querySelector('#last-delivery-detail').textContent=s.latestRestoredAt?'Em '+new Date(s.latestRestoredAt).toLocaleDateString('pt-BR')+'.':'Ainda não houve entrega ao Codex.';
  const flowItems=[['Texto da conversa analisado',s.completedCharsBefore,'caracteres antes da seleção'],['Texto guardado pelo Jev',s.completedCharsAfter,'caracteres após a seleção'],['Texto adicional enviado ao Codex',s.injectedPayloadChars,'caracteres, respeitando o limite configurado']];
  document.querySelector('#flow').innerHTML=flowItems.map(item=>'<div class="flow-node"><span class="label">'+item[0]+'</span><strong>'+(completed?f(item[1]):'—')+'</strong><div class="detail">'+item[2]+'</div></div>').join('<span class="arrow">→</span>');
  document.querySelector('#rounds-chart').innerHTML=renderChart(s.runs);
  document.querySelector('#decision-stats').innerHTML=renderDecisions(s.byTool);
  const usage=s.jevUsageReportedRequests?f(s.jevUsageReportedRequests)+' de '+f(s.jevRequests)+' requisições com uso reportado':'Uso não reportado pelo provedor';
   document.querySelector('#details').innerHTML=[
    metric('Codex prosseguiu sem Jev',f(s.nativeFallbacks),'compactação nativa após falha do Jev'),
    metric('Tokens de entrada Jev',s.jevUsageReportedRequests?f(s.jevInputTokens):'—',usage),
    metric('Tokens de saída Jev',s.jevUsageReportedRequests?f(s.jevOutputTokens):'—',usage),
    metric('Tempo médio da seleção',s.evaluatedSelections?f(s.averageSelectionMs)+' ms':'—','não inclui toda a compactação'),
    metric('Duplicatas evitadas',s.nativePresentChars?chars(s.nativePresentChars):'—',s.verifiedMemberships?f(s.verifiedMemberships)+' restores conferidos após a compactação':'nenhum restore conferido ainda'),
    metric('Modo observe',s.observed?f(s.observed):'—',s.observed?chars(s.wouldInjectPayloadChars)+' seriam enviados; o contexto ficou intacto':'nenhuma observação concluída')
   ].join('');
  document.querySelector('#runs').innerHTML=s.runs.slice(0,50).map(r=>'<tr><td>'+when(r.at)+'</td><td>'+statusTag(r.status)+'</td><td>'+textAdditional(r)+'</td></tr>').join('')||'<tr><td colspan="3" class="empty">Nenhuma compactação registrada ainda.</td></tr>';
  document.querySelector('#decisions').innerHTML=s.recentDecisions.slice(0,50).map(d=>'<tr><td>'+esc(d.tool)+'<div class="cell-note">'+when(d.at)+'</div></td><td>'+actionTag(d)+'</td><td><div class="preview" title="'+esc(d.inputPreview)+'">'+esc(d.inputPreview||'—')+'</div></td><td>'+pct(d.dropLoss)+' / '+pct(d.truncateLoss)+'</td><td class="num">'+chars(d.removedChars)+'</td></tr>').join('')||'<tr><td colspan="5" class="empty">Nenhuma decisão registrada ainda.</td></tr>';
  document.querySelector('#live').textContent='dados locais · atualizado '+new Date().toLocaleTimeString('pt-BR');
 });
}
function showError(error){document.querySelector('#error').innerHTML='<div class="error">Erro ao ler dados: '+esc(String(error))+'</div>'}
refresh().catch(showError);
setInterval(()=>refresh().catch(showError),5000);
</script></body></html>`;
}

function json(res: any, value: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function startDashboard(port = 43127, env = process.env): Promise<{ server: any; url: string }> {
  const host = '127.0.0.1';
  let cachedIdentity = '';
  let cachedStats: Awaited<ReturnType<typeof stats>> | undefined;
  const currentStats = async (): Promise<Awaited<ReturnType<typeof stats>>> => {
    const identityPart = async (path: string): Promise<string> => {
      try { const info = await stat(path); return `${info.size}:${info.mtimeMs}`; } catch { return 'missing'; }
    };
    // Dashboard content depends on both history and the persisted user-facing settings.
    const historyIdentity = await Promise.all(readableHistoryPaths(env).map(identityPart));
    const identity = `${historyIdentity.join('|')}|${await identityPart(settingsPath(env))}`;
    if (cachedStats && identity === cachedIdentity) return cachedStats;
    cachedStats = await stats(env);
    cachedIdentity = identity;
    return cachedStats;
  };
  const server = createServer(async (req: any, res: any) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname === '/api/health') return json(res, {
        ok: true,
        service: 'jevcomp-dashboard',
        pid: process.pid,
        instanceId: env.JEVCOMP_DASHBOARD_INSTANCE_ID ?? null,
        entry: process.argv[1] ?? null,
      });
      if (url.pathname === '/api/stats') return json(res, await currentStats());
      if (url.pathname === '/api/history') return json(res, (await readHistory(env)).slice(-200).reverse());
      if (url.pathname !== '/') return json(res, { error: 'not found' }, 404);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page());
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('dashboard did not bind to a TCP port');
  return { server, url: `http://${host}:${address.port}/` };
}
