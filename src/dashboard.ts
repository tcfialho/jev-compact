import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { historyPath, readHistory, type HistoryRow } from './store.js';
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
  status: 'prepared' | 'ready' | 'restored' | 'skipped' | 'failed' | 'restore_failed';
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
  injectedPayloadChars?: number;
  retainedChars?: number;
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
  const restoreFailuresByRun = new Map<string, HistoryRow>();
  for (const row of restoreFailures) restoreFailuresByRun.set(runKey(row), row);
  const runs: RunSummary[] = [];
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
      restoreMode: restore?.restoreMode,
      injectedPayloadChars: restore?.injectedPayloadChars,
      retainedChars: restore?.retainedChars ?? row.retainedChars,
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
    jevInputTokens,
    jevOutputTokens,
    jevRequests,
    jevUsageReportedRequests,
    jevUsageCoverage: jevRequests ? jevUsageReportedRequests / jevRequests : 0,
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
<title>jev-compact · dashboard</title>
<style>
:root{color-scheme:dark;--bg:#151514;--panel:#20201f;--panel2:#252524;--line:#393936;--text:#f3f3f1;--muted:#a2a29e;--green:#5bc66b;--orange:#ee7847;--amber:#e2ac42;--blue:#8cacfa}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1160px;margin:auto;padding:22px 18px 56px}
h1,h2,p{margin:0}h1{font-size:18px;letter-spacing:-.03em}h2{font-size:15px;font-weight:680}
.top{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:20px}
.top-left{display:flex;align-items:baseline;gap:13px}.top-note,.sub,.muted{color:var(--muted)}.top-note{font-size:11px}
.live{font-size:11px;color:var(--muted)}
.section{margin-top:18px}
.section-head{display:flex;justify-content:space-between;align-items:end;gap:14px;margin:0 0 10px}
.sub{font-size:11px;margin-top:3px}
.status-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.status-card,.metric,.panel{background:var(--panel);border:1px solid var(--line);border-radius:11px}
.status-card{min-height:136px;padding:15px;border-left:3px solid var(--line)}
.status-card.success{border-left-color:var(--green)}.status-card.fallback{border-left-color:var(--orange)}.status-card.pending{border-left-color:var(--amber)}
.status-card .label{font-size:11px;color:var(--muted)}.status-card .headline{font-size:21px;font-weight:750;line-height:1.25;margin-top:12px}
.status-card .detail{font-size:12px;color:var(--muted);margin-top:7px;overflow-wrap:anywhere}
.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.metric{min-height:102px;padding:13px}.metric .label{font-size:11px;color:var(--muted)}
.metric .number{font-size:23px;font-weight:760;letter-spacing:-.035em;margin-top:5px;line-height:1.2}
.metric .detail{font-size:11px;color:var(--muted);margin-top:5px}
.twocol{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.panel{padding:15px;min-width:0}.panel h2{margin-bottom:5px}
.panel .sub{line-height:1.45}
.segment{display:flex;height:15px;overflow:hidden;border-radius:5px;background:#393936;margin:16px 0 11px}
.segment>i{display:block;min-width:0;height:100%}.seg-jev{background:var(--green)}.seg-fallback{background:var(--orange)}.seg-skip{background:#70706b}
.legend{display:flex;flex-wrap:wrap;gap:7px 16px;color:var(--muted);font-size:11px}
.dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px}
.ratio-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-top:14px}
.ratio-row strong{font-size:21px;letter-spacing:-.03em}
.track{height:8px;background:#3c3c39;border-radius:5px;overflow:hidden;margin-top:7px}
.track>i{display:block;height:100%;background:var(--green);border-radius:5px}
.flow{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;align-items:center;gap:9px}
.flow-node{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:13px;min-width:0}
.flow-node .label{font-size:11px;color:var(--muted)}.flow-node strong{display:block;font-size:20px;margin-top:5px;line-height:1.25}
.flow-node .detail{font-size:11px;color:var(--muted);margin-top:4px}.arrow{color:var(--muted);font-size:17px}
.note{color:var(--muted);font-size:11px;margin-top:10px}
.decision-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:12px}
.decision{border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--panel2)}
.decision b{font-size:12px}.decision p{color:var(--muted);font-size:11px;margin-top:5px}
.tag{display:inline-block;border:1px solid var(--line);border-radius:5px;padding:2px 7px;font-size:11px;font-weight:650;white-space:nowrap}
.tag.success{border-color:#316e3b;color:var(--green);background:#1a3020}
.tag.fallback{border-color:#81462f;color:var(--orange);background:#34241d}
.tag.pending{border-color:#775b2b;color:var(--amber);background:#332b1c}
.tag.neutral{border-color:#485370;color:var(--blue);background:#232a39}
.tag.protected{border-color:#66567b;color:#bda2e8;background:#2b2532}
.table-panel{padding:0;overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:730px}
th,td{padding:9px 11px;border-bottom:1px solid #353532;text-align:left;vertical-align:top}
th{font-size:10px;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
tr:hover td{background:#262624}
.num{text-align:right;font-variant-numeric:tabular-nums}.muted{font-size:11px;margin-top:3px}
.preview{max-width:330px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.empty{padding:22px;color:var(--muted);text-align:center}
.settings{display:flex;flex-wrap:wrap;gap:7px}
.setting{border:1px solid var(--line);border-radius:6px;padding:6px 9px;background:var(--panel2);font-size:11px}
.setting b{color:var(--text);margin-left:5px}
footer{color:var(--muted);font-size:11px;margin-top:17px}
@media(max-width:850px){.status-grid{grid-template-columns:1fr}.status-card{min-height:0}.metric-grid,.decision-grid{grid-template-columns:repeat(2,1fr)}.twocol{grid-template-columns:1fr}}
@media(max-width:540px){main{padding:18px 12px 42px}.top{align-items:flex-start}.top-left{display:block}.metric-grid,.decision-grid{grid-template-columns:1fr 1fr}.flow{grid-template-columns:1fr}.arrow{display:none}}
</style></head><body><main>
<header class="top"><div class="top-left"><h1>jev-compact</h1><span class="top-note">compactação do Codex</span></div><span class="live" id="live">dados locais · atualização a cada 5s</span></header>
<section class="status-grid" id="status" aria-label="Estado da compactação"></section>
<section class="section"><div class="section-head"><div><h2>Números da integração</h2><p class="sub">Totais registrados pelos hooks locais.</p></div></div><div class="metric-grid" id="metrics"></div></section>
<section class="section twocol">
 <div class="panel"><h2>O que aconteceu em cada tentativa</h2><p class="sub">Seleção feita pelo Jev, fallback nativo ou execução ignorada.</p><div class="segment" id="segments"></div><div class="legend" id="legend"></div></div>
 <div class="panel"><h2>Redução nas restaurações concluídas</h2><p class="sub">Caracteres do histórico normalizado antes e depois da seleção do Jev.</p><div class="ratio-row"><strong id="reduction">—</strong><span class="muted" id="removed"></span></div><div class="track"><i id="reduction-bar"></i></div><p class="note">Não representa economia de tokens cobrados pelo Codex.</p></div>
</section>
<section class="section"><div class="section-head"><div><h2>Do histórico à restauração</h2><p class="sub">Somente execuções que chegaram à restauração.</p></div></div><div class="flow" id="flow"></div></section>
<section class="section"><div class="panel"><h2>Como ler as decisões</h2><p class="sub">Estas categorias descrevem o que aconteceu com cada par completo de chamada e resultado de ferramenta. São decisões de retenção, não estados de falha.</p><div class="decision-grid">
 <div class="decision"><span class="tag success">Preservado</span><p>Chamada e resultado completo ficam no arquivo retido.</p></div>
 <div class="decision"><span class="tag pending">Resumido</span><p>A chamada fica; o resultado longo é reduzido a um trecho recuperável.</p></div>
 <div class="decision"><span class="tag neutral">Removido</span><p>O par não entra nas evidências retidas. É uma decisão normal, não um erro.</p></div>
 <div class="decision"><span class="tag protected">Protegido</span><p>Uma mensagem recente fica fora da poda do Jev.</p></div>
 </div><p class="note">Se precisar de uma ferramenta removida, o Codex pode executá-la novamente. O arquivo retido completo fica no disco.</p></div></section>
<section class="section"><div class="section-head"><div><h2>Por ferramenta</h2><p class="sub">Decisões e caracteres retirados nas restaurações concluídas.</p></div></div><div class="panel table-panel"><table><thead><tr><th>Ferramenta</th><th>Chamadas</th><th>Preservadas</th><th>Resumidas</th><th>Removidas</th><th class="num">Caracteres retirados</th></tr></thead><tbody id="tools"></tbody></table></div></section>
<section class="section"><div class="section-head"><div><h2>Compactações recentes</h2><p class="sub">O estado do fluxo aparece aqui; fallback significa que o Codex continuou com a compactação nativa.</p></div></div><div class="panel table-panel"><table><thead><tr><th>Quando</th><th>Estado</th><th>Redução Jev</th><th>Decisões</th><th>Uso Jev</th><th>Restauração</th></tr></thead><tbody id="runs"></tbody></table></div></section>
<section class="section"><div class="section-head"><div><h2>Decisões recentes</h2><p class="sub">Risco estimado de perder informação necessária: 0 a 1.</p></div></div><div class="panel table-panel"><table><thead><tr><th>Ferramenta</th><th>Decisão</th><th>Entrada</th><th>Risco de remover / resumir</th><th class="num">Caracteres retirados</th></tr></thead><tbody id="decisions"></tbody></table></div></section>
<section class="section"><div class="section-head"><div><h2>Configuração atual</h2></div></div><div class="settings" id="settings"></div></section>
<footer>Dados do histórico local do jev-compact. A dashboard escuta somente em 127.0.0.1.</footer>
</main><script>
const f=n=>Number(n||0).toLocaleString('pt-BR');
const pct=n=>(Number(n||0)*100).toFixed(1)+'%';
const chars=n=>f(n)+' caracteres';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when=s=>{const d=new Date(s);return Number.isNaN(d.getTime())?'—':d.toLocaleString('pt-BR')};
const statusTag=s=>s==='failed'?'<span class="tag fallback">Fallback nativo</span>':s==='restore_failed'?'<span class="tag fallback">Falha na restauração</span>':s==='skipped'?'<span class="tag pending">Ignorada</span>':s==='ready'?'<span class="tag pending">Aguardando restauração</span>':s==='restored'?'<span class="tag success">Restaurada</span>':'<span class="tag neutral">Preparada</span>';
const actionTag=d=>d.pinned?'<span class="tag protected">Protegido</span>':d.action==='drop_call'?'<span class="tag neutral">Removido</span>':d.action==='truncate_result'?'<span class="tag pending">Resumido</span>':'<span class="tag success">Preservado</span>';
const metric=(label,number,detail)=>'<div class="metric"><div class="label">'+label+'</div><div class="number">'+number+'</div><div class="detail">'+detail+'</div></div>';
const latestDescription=r=>r.status==='failed'?'O Jev falhou; a compactação nativa do Codex continuou.':r.status==='restore_failed'?'A seleção foi feita, mas a restauração falhou.':r.status==='restored'?'O hook retornou o contexto selecionado depois da compactação.':r.status==='skipped'?'O Jev não aplicou seleção nesta tentativa.':'A seleção foi preparada; aguardando o restante do ciclo.';
async function refresh(){
 const response=await fetch('/api/stats',{cache:'no-store'});if(!response.ok)throw Error('HTTP '+response.status);
 const s=await response.json(),latest=s.runs[0];
 const latestClass=latest?.status==='failed'||latest?.status==='restore_failed'?'fallback':latest?.status==='restored'?'success':'pending';
 document.querySelector('#status').innerHTML=[
  '<div class="status-card '+latestClass+'"><div class="label">Última tentativa'+(latest?' · '+when(latest.at):'')+'</div><div class="headline">'+(latest?statusTag(latest.status):'Aguardando compactação')+'</div><div class="detail">'+(latest?latestDescription(latest):'Nenhuma tentativa registrada no histórico local.')+'</div></div>',
  '<div class="status-card success"><div class="label">Seleção Jev</div><div class="headline">'+f(s.prepared)+' preparada(s)</div><div class="detail">'+f(s.jevRequests)+' requisição(ões) Jev reportadas nas execuções avaliadas; '+f(s.skipped)+' tentativa(s) ignorada(s).</div></div>',
  '<div class="status-card '+(s.restoreFailures?'fallback':'success')+'"><div class="label">Contexto devolvido pelo hook</div><div class="headline">'+f(s.restored)+' restauração(ões)</div><div class="detail">'+chars(s.injectedPayloadChars)+' de evidências; '+f(s.restoreFailures)+' falha(s) de restauração.</div></div>'
 ].join('');
 document.querySelector('#metrics').innerHTML=[
  metric('Tentativas',f(s.attempts),'compactações registradas'),
  metric('Fallback nativo',f(s.nativeFallbacks),'Jev falhou; Codex prosseguiu'),
  metric('Contexto retirado',chars(s.completedCharsRemoved),'em restaurações concluídas'),
  metric('Contexto devolvido',chars(s.injectedPayloadChars),'evidências retornadas pelo hook'),
  metric('Requisições Jev',f(s.jevRequests),'nas seleções avaliadas'),
  metric('Tokens Jev de entrada',s.jevUsageReportedRequests?f(s.jevInputTokens):'—',f(s.jevUsageReportedRequests)+' requisições com uso reportado'),
  metric('Tokens Jev de saída',s.jevUsageReportedRequests?f(s.jevOutputTokens):'—','informados pelo provedor'),
  metric('Tempo médio de seleção',f(s.averageSelectionMs)+' ms','execuções avaliadas')
 ].join('');
 const total=s.attempts||0;
 document.querySelector('#segments').innerHTML=total?[
  '<i class="seg-jev" style="width:'+(s.prepared/total*100)+'%"></i>',
  '<i class="seg-fallback" style="width:'+(s.nativeFallbacks/total*100)+'%"></i>',
  '<i class="seg-skip" style="width:'+(s.skipped/total*100)+'%"></i>'
 ].join(''):'';
 document.querySelector('#legend').innerHTML='<span><i class="dot seg-jev"></i>Jev preparou '+f(s.prepared)+'</span><span><i class="dot seg-fallback"></i>Fallback '+f(s.nativeFallbacks)+'</span><span><i class="dot seg-skip"></i>Ignorada '+f(s.skipped)+'</span>';
 document.querySelector('#reduction').textContent=total?pct(s.completedReductionRatio):'—';
 document.querySelector('#removed').textContent=chars(s.completedCharsRemoved)+' retirados';
 document.querySelector('#reduction-bar').style.width=Math.max(0,Math.min(100,s.completedReductionRatio*100))+'%';
 const flowItems=[['Histórico original',s.completedCharsBefore,'antes da seleção Jev'],['Evidências retidas',s.completedCharsAfter,'arquivo após seleção'],['Contexto devolvido',s.injectedPayloadChars,'payload retornado pelo hook']];
 document.querySelector('#flow').innerHTML=flowItems.map(x=>'<div class="flow-node"><div class="label">'+x[0]+'</div><strong>'+chars(x[1])+'</strong><div class="detail">'+x[2]+'</div></div>').join('<span class="arrow">→</span>');
 const cfg=s.settings;
 document.querySelector('#settings').innerHTML=[
  ['Restauração',cfg.restoreMode],['Limite',cfg.restoreMaxChars===0?'sem limite':chars(cfg.restoreMaxChars)],
  ['Mensagens protegidas',f(cfg.pinRecentMessages)],['Limiar de perda',Number(cfg.lossThreshold).toFixed(2)],
  ['Redução mínima',pct(cfg.minReductionRatio)]
 ].map(x=>'<div class="setting">'+x[0]+'<b>'+esc(x[1])+'</b></div>').join('');
 document.querySelector('#tools').innerHTML=s.byTool.slice(0,30).map(x=>'<tr><td><b>'+esc(x.tool)+'</b></td><td>'+f(x.calls)+'</td><td>'+f(x.kept)+'</td><td>'+f(x.truncated)+'</td><td>'+f(x.dropped)+'</td><td class="num">'+chars(x.removedChars)+'</td></tr>').join('')||'<tr><td colspan="6" class="empty">Nenhuma restauração concluída ainda.</td></tr>';
 document.querySelector('#runs').innerHTML=s.runs.slice(0,40).map(r=>'<tr><td>'+when(r.at)+'<div class="muted">'+esc(r.sessionId.slice(0,12))+'</div></td><td>'+statusTag(r.status)+(r.detail?'<div class="muted">'+esc(r.detail)+'</div>':'')+'</td><td>'+pct(r.reductionRatio)+'<div class="muted">'+chars(r.removedChars)+'</div></td><td>'+f(r.kept)+' preservadas · '+f(r.truncated)+' resumidas · '+f(r.dropped)+' removidas</td><td>'+f(r.jevRequests)+' requisições<div class="muted">'+f(r.jevInputTokens+r.jevOutputTokens)+' tokens reportados</div></td><td>'+(r.status==='restored'?chars(r.injectedPayloadChars||0):'—')+'</td></tr>').join('')||'<tr><td colspan="6" class="empty">Nenhuma compactação registrada ainda.</td></tr>';
 document.querySelector('#decisions').innerHTML=s.recentDecisions.slice(0,50).map(d=>'<tr><td>'+esc(d.tool)+'<div class="muted">'+when(d.at)+'</div></td><td>'+actionTag(d)+'</td><td><div class="preview" title="'+esc(d.inputPreview)+'">'+esc(d.inputPreview||'—')+'</div></td><td>'+pct(d.dropLoss)+' / '+pct(d.truncateLoss)+'</td><td class="num">'+chars(d.removedChars)+'</td></tr>').join('')||'<tr><td colspan="5" class="empty">Nenhuma decisão registrada ainda.</td></tr>';
 document.querySelector('#live').textContent='dados locais · atualizado '+new Date().toLocaleTimeString('pt-BR');
}
refresh().catch(e=>{document.querySelector('#status').innerHTML='<div class="status-card fallback"><div class="label">Dashboard</div><div class="headline">Erro ao ler dados</div><div class="detail">'+esc(String(e))+'</div></div>'});
setInterval(()=>refresh().catch(()=>{}),5000);
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
    const identity = `${await identityPart(historyPath(env))}|${await identityPart(settingsPath(env))}`;
    if (cachedStats && identity === cachedIdentity) return cachedStats;
    cachedStats = await stats(env);
    cachedIdentity = identity;
    return cachedStats;
  };
  const server = createServer(async (req: any, res: any) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname === '/api/health') return json(res, { ok: true });
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
