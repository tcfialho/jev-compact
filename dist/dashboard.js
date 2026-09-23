import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { historyPath, readHistory } from './store.js';
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
    const observedByRun = new Map();
    for (const row of observed)
        observedByRun.set(runKey(row), row);
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
        averageSelectionMs: scored.length ? Math.round(selectionMs / scored.length) : 0,
        settings: userSettings(env),
        byTool: [...byTool.values()].sort((a, b) => b.removedChars - a.removedChars),
        recentDecisions,
        runs: runs.slice(0, 100),
        recentEvents: rows.slice(-100).reverse(),
    };
}
function page() {
    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>jev-compact · measured context impact</title><style>
:root{color-scheme:dark;--bg:#080b12;--panel:#111824;--line:#263247;--text:#f2f5fa;--muted:#94a0b5;--good:#72dfb4;--blue:#86a9ff;--warn:#efc66a;--bad:#ff8a9b}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(900px 500px at 5% -10%,#153541 0%,transparent 62%),radial-gradient(750px 450px at 100% 0%,#1d2851 0%,transparent 64%),var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,sans-serif}main{max-width:1240px;margin:auto;padding:36px 22px 64px}h1{font-size:30px;letter-spacing:-.04em;margin:0}h2{font-size:17px;margin:0}.sub{color:var(--muted);margin-top:6px}.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.live{border:1px solid var(--line);background:#0e1520;border-radius:999px;padding:7px 11px;color:var(--muted);font-size:12px}.live:before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--good);margin-right:7px}.notice{margin:20px 0;padding:13px 15px;border:1px solid #30405b;background:rgba(18,28,43,.82);border-radius:12px;color:#c2cad8}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px}.card,.panel{border:1px solid var(--line);background:linear-gradient(145deg,rgba(23,32,48,.94),rgba(12,18,28,.9));border-radius:15px}.card{padding:17px}.label{color:var(--muted);font-size:12px}.muted{color:var(--muted);font-size:11px;margin-top:3px}.value{font-size:27px;font-weight:760;letter-spacing:-.04em;margin-top:5px}.hint{font-size:11px;color:#748199;margin-top:5px}.section{margin-top:28px}.section-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:10px}.section-note{font-size:12px;color:var(--muted)}.flow{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;gap:10px;align-items:center}.flowbox{padding:15px;border:1px solid var(--line);background:var(--panel);border-radius:13px}.flowbox b{display:block;font-size:22px;margin-top:5px}.arrow{font-size:22px;color:#65738c}.panel{overflow:hidden}table{width:100%;border-collapse:collapse}th,td{padding:11px 13px;border-bottom:1px solid rgba(38,50,71,.8);text-align:left;vertical-align:top}th{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);background:#0d141f}tr:last-child td{border-bottom:0}.num{text-align:right;font-variant-numeric:tabular-nums}.muted{color:var(--muted);font-size:11px}.tag{display:inline-block;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:650}.ok{background:rgba(114,223,180,.12);color:var(--good)}.skip{background:rgba(239,198,106,.12);color:var(--warn)}.fail{background:rgba(255,138,155,.12);color:var(--bad)}.bar{height:5px;background:#202b3e;border-radius:99px;overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--good),var(--blue))}.empty{padding:22px;text-align:center;color:var(--muted)}.foot{margin-top:18px;color:#748199;font-size:11px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}.flow{grid-template-columns:1fr}.arrow{transform:rotate(90deg);text-align:center}.hide-mobile{display:none}}@media(max-width:520px){main{padding:24px 12px 50px}.grid{grid-template-columns:1fr}.top{display:block}.live{display:inline-block;margin-top:12px}.value{font-size:23px}th,td{padding:9px 8px}}
</style></head><body><main>
<div class="top"><div><h1>jev-compact</h1><div class="sub">Measured context retention around Codex compaction</div></div><div class="live">local · refreshes every 5s</div></div>
<div class="notice" id="notice">Loading measured data…</div>
<section class="grid" id="cards"></section>
<section class="section"><div class="section-head"><div><h2>Completed restore flow</h2><div class="section-note">Only runs that reached restore are included here.</div></div></div><div class="flow" id="flow"></div></section>
<section class="section"><div class="section-head"><div><h2>What the decisions mean</h2><div class="section-note">Only completed tool call/result pairs are eligible.</div></div></div><div class="grid"><div class="card"><div class="label">Kept</div><div class="hint">Call and full result stay in the retained archive.</div></div><div class="card"><div class="label">Shortened</div><div class="hint">The call stays, but a long result is reduced to a bounded prefix plus a recovery note.</div></div><div class="card"><div class="label">Removed</div><div class="hint">The call and result are omitted from jev-compact's retained evidence. Codex can rerun the tool if needed.</div></div><div class="card"><div class="label">Pinned</div><div class="hint">Recent messages are protected and never pruned by Jev.</div></div></div></section>
<section class="section"><div class="section-head"><div><h2>Current behavior</h2><div class="section-note">The user-facing settings that materially change what jev-compact measures, preserves, or restores.</div></div></div><div class="grid" id="settings"></div></section>
<section class="section"><div class="section-head"><div><h2>Where retained tool history was reduced</h2><div class="section-note">Exact normalized characters removed from paired tool calls/results in runs that completed restore.</div></div></div><div class="panel"><table><thead><tr><th>Tool</th><th>Calls</th><th>Kept</th><th>Shortened</th><th>Dropped</th><th class="num">Chars removed</th></tr></thead><tbody id="tools"></tbody></table></div></section>
<section class="section"><div class="section-head"><div><h2>Recent Jev decisions</h2><div class="section-note">Loss risk is the 0–1 Jev Noul score jev-compact uses for whether the action would discard information still needed for the task.</div></div></div><div class="panel"><table><thead><tr><th>Tool</th><th>Decision</th><th>Input preview</th><th>Loss risk</th><th class="num">Chars removed</th></tr></thead><tbody id="decisions"></tbody></table></div></section>
<section class="section"><div class="section-head"><div><h2>Recent compactions</h2><div class="section-note">Measured local effects and real Jev usage; no inferred Codex billing savings.</div></div></div><div class="panel"><table><thead><tr><th>When</th><th>Status</th><th>Context reduction</th><th>Tool decisions</th><th>Jev</th><th class="hide-mobile">Restore</th></tr></thead><tbody id="runs"></tbody></table></div></section>
<div class="foot">All dashboard data comes from local jev-compact history. The dashboard binds to 127.0.0.1 only.</div>
</main><script>
const f=n=>Number(n||0).toLocaleString();
const pct=n=>(Number(n||0)*100).toFixed(1)+'%';
const chars=n=>{n=Number(n||0);if(n>=1e6)return (n/1e6).toFixed(2)+'M chars';if(n>=1e3)return (n/1e3).toFixed(1)+'k chars';return f(n)+' chars'};
const ms=n=>n>=1000?(n/1000).toFixed(1)+'s':f(n)+'ms';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tag=s=>s==='failed'?'<span class="tag fail">native fallback</span>':s==='restore_failed'?'<span class="tag fail">restore issue</span>':s==='skipped'?'<span class="tag skip">skipped</span>':s==='ready'?'<span class="tag skip">awaiting restore</span>':s==='observed'?'<span class="tag skip">observed only</span>':s==='restored'?'<span class="tag ok">restored</span>':'<span class="tag ok">prepared</span>';
const action=d=>d.pinned?'<span class="tag ok">pinned</span>':d.action==='drop_call'?'<span class="tag fail">removed</span>':d.action==='truncate_result'?'<span class="tag skip">shortened</span>':'<span class="tag ok">kept</span>';
async function refresh(){const s=await fetch('/api/stats',{cache:'no-store'}).then(r=>r.json());
 document.querySelector('#notice').textContent=s.note;
 document.querySelector('#cards').innerHTML=[
  ['Retained tool-history reduction',chars(s.completedCharsRemoved),pct(s.completedReductionRatio)+' removed across restores that actually completed'],
  ['Duplicate restore avoided',chars(s.nativePresentChars),f(s.verifiedMemberships)+' restores verified against post-compaction history'],
  ['Hook context delivered',chars(s.injectedChars),s.restored+' completed restores · includes recovery header/path'],
  ['Jev usage',s.jevUsageReportedRequests?f(s.jevInputTokens+s.jevOutputTokens)+' reported tokens':'not reported',s.jevUsageReportedRequests?f(s.jevInputTokens)+' input · '+f(s.jevOutputTokens)+' output · '+f(s.jevUsageReportedRequests)+'/'+f(s.jevRequests)+' requests reported usage':f(s.jevRequests)+' Jev requests; provider returned no usage counters'],
  ['Observe mode',f(s.observed)+' completed observations',s.observed?chars(s.wouldInjectPayloadChars)+' evidence would have been returned; Codex context was unchanged':'no completed observation yet'],
  ['Codex fallbacks',f(s.nativeFallbacks)+' / '+f(s.attempts)+' attempts',f(s.skipped)+' skips · '+f(s.restoreFailures)+' restore issues']
 ].map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="value">'+x[1]+'</div><div class="hint">'+x[2]+'</div></div>').join('');
 document.querySelector('#flow').innerHTML=[['Before selection',chars(s.completedCharsBefore),'normalized history for completed restores'],['Retained archive',chars(s.completedCharsAfter),chars(s.nativePresentChars)+' already survived native Codex compaction verbatim'],['Hook context returned',chars(s.injectedChars),s.injectedChars?chars(s.injectedPayloadChars)+' selected evidence + recovery header/path':'no completed restore yet']].map((x,i)=>'<div class="flowbox"><span class="label">'+x[0]+'</span><b>'+x[1]+'</b><span class="hint">'+x[2]+'</span></div>'+(i<2?'<div class="arrow">→</div>':'')).join('');
 const cfg=s.settings;document.querySelector('#settings').innerHTML=[
  ['Mode',cfg.mode,cfg.mode==='observe'?'measure only; no additionalContext is returned to Codex':'active restore after compaction'],
  ['Restore mode',cfg.restoreMode,'preserve = most evidence · balanced = index + excerpt · minimal = index only'],
  ['Restore cap',cfg.restoreMaxChars===0?'unlimited':chars(cfg.restoreMaxChars),'global evidence-payload cap before recovery header/path; mode caps may be lower'],
  ['Recent messages pinned',f(cfg.pinRecentMessages),'newest normalized messages Jev cannot prune'],
  ['Loss threshold',Number(cfg.lossThreshold).toFixed(2),'higher accepts more estimated loss risk and prunes more aggressively'],
  ['Minimum reduction',pct(cfg.minReductionRatio),'below this measured reduction jev-compact skips restore']
 ].map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="value">'+x[1]+'</div><div class="hint">'+x[2]+'</div></div>').join('');
 const max=Math.max(1,...s.byTool.map(x=>x.removedChars));document.querySelector('#tools').innerHTML=s.byTool.slice(0,30).map(x=>'<tr><td><b>'+esc(x.tool)+'</b><div class="bar"><i style="width:'+Math.max(2,Math.round(x.removedChars/max*100))+'%"></i></div></td><td>'+f(x.calls)+'</td><td>'+f(x.kept)+'</td><td>'+f(x.truncated)+'</td><td>'+f(x.dropped)+'</td><td class="num">'+chars(x.removedChars)+'</td></tr>').join('')||'<tr><td colspan="6" class="empty">No completed restores yet.</td></tr>';
 document.querySelector('#decisions').innerHTML=s.recentDecisions.slice(0,50).map(d=>'<tr><td><b>'+esc(d.tool)+'</b><div class="muted">'+esc(new Date(d.at).toLocaleString())+'</div></td><td>'+action(d)+'</td><td><div style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(d.inputPreview)+'">'+esc(d.inputPreview||'—')+'</div></td><td>remove '+pct(d.dropLoss)+'<div class="muted">shorten '+pct(d.truncateLoss)+'</div></td><td class="num">'+chars(d.removedChars)+'</td></tr>').join('')||'<tr><td colspan="5" class="empty">No decisions recorded yet.</td></tr>';
 document.querySelector('#runs').innerHTML=s.runs.slice(0,40).map(r=>'<tr><td>'+esc(new Date(r.at).toLocaleString())+'<div class="muted mono">'+esc(r.sessionId.slice(0,12))+'</div></td><td>'+tag(r.status)+(r.detail?'<div class="muted">'+esc(r.detail)+'</div>':'')+'</td><td><b>'+pct(r.reductionRatio)+'</b><div class="muted">'+chars(r.removedChars)+' removed</div></td><td>'+f(r.dropped)+' dropped · '+f(r.truncated)+' shortened<div class="muted">'+f(r.kept)+' kept · '+f(r.pinned)+' pinned</div></td><td>'+(r.jevUsageReportedRequests?f(r.jevInputTokens+r.jevOutputTokens)+' reported tokens':'usage not reported')+'<div class="muted">'+f(r.jevRequests)+' requests · '+f(r.jevUsageReportedRequests)+' usage reports · '+ms(r.selectionMs)+'</div></td><td class="hide-mobile">'+(r.status==='restored'?(esc(r.restoreMode||'preserve')+'<div class="muted">'+chars(r.injectedPayloadChars||0)+' injected · '+chars(r.nativePresentChars||0)+' already present</div>'):r.status==='observed'?('observe<div class="muted">'+chars(r.wouldInjectPayloadChars||0)+' would inject · '+chars(r.nativePresentChars||0)+' already present</div>'):'—')+'</td></tr>').join('')||'<tr><td colspan="6" class="empty">No compactions recorded yet.</td></tr>';
}
refresh().catch(e=>document.querySelector('#notice').textContent='Dashboard error: '+e);setInterval(()=>refresh().catch(()=>{}),5000);
</script></body></html>`;
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
        const identity = `${await identityPart(historyPath(env))}|${await identityPart(settingsPath(env))}`;
        if (cachedStats && identity === cachedIdentity)
            return cachedStats;
        cachedStats = await stats(env);
        cachedIdentity = identity;
        return cachedStats;
    };
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? '/', `http://${host}`);
            if (url.pathname === '/api/health')
                return json(res, {
                    ok: true,
                    service: 'jev-compact-dashboard',
                    pid: process.pid,
                    instanceId: env.JEV_COMPACT_DASHBOARD_INSTANCE_ID ?? null,
                });
            if (url.pathname === '/api/stats')
                return json(res, await currentStats());
            if (url.pathname === '/api/history')
                return json(res, (await readHistory(env)).slice(-200).reverse());
            if (url.pathname !== '/')
                return json(res, { error: 'not found' }, 404);
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(page());
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
