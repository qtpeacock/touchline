// Shared by both AI builders (Practices and Drills): following a build while it works, the live
// activity feed, the token meter, the daily allowance left, the reviewer's verdict and the history table.
import { api } from './api.js';
import { esc, fmtDate, toast, uid } from './ui.js';
import { boardThumb } from './field.js';
import { suggestAnimation } from './animate.js';

export const SHIELD = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/></svg>';
const AVATAR = {
  'Coach': ['You', 'coach'],
  'Head Coach': ['HC', 'hc'],
  'Attendance Scout': ['AS', 'as'],
  'Drill Designer': ['DD', 'dd'],
  'Plan Reviewer': ['PR', 'pr'],
  'Drill Reviewer': ['DR', 'pr'],
  'Guardrail': ['', 'gr'],
};
const AGENT_ORDER = ['Head Coach', 'Attendance Scout', 'Drill Designer', 'Plan Reviewer', 'Drill Reviewer'];
const POLL_MS = 1000;

export const num = n => Number(n || 0).toLocaleString();
export const kTok = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));
export const usd = n => `$${Number(n || 0).toFixed(4)}`;
const localTime = utc => new Date(`${utc.replace(' ', 'T')}Z`).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** New drills get an animation from their arrows, the same way the whiteboard's "Suggest animation" does. */
export function animationsFor(items) {
  const out = {};
  for (const it of items) {
    if (it.source !== 'new') continue;
    const s = suggestAnimation(it.board, uid);
    if (s?.phases?.length) out[it.new_drill_number] = s.phases;
  }
  return out;
}

/** The small pill in the page header. */
export const allowancePill = a => `${SHIELD}<span>Daily AI allowance left: <b>${a.runs_left}</b> of ${a.run_limit} builds · <b>${kTok(a.tokens_left)}</b> of ${kTok(a.token_limit)} tokens</span>`;

function allowanceCard(a, running) {
  const bar = (left, limit) => {
    const pct = limit ? Math.max(0, Math.min(100, (left / limit) * 100)) : 0;
    return `<span class="allow-bar ${pct < 10 ? 'low' : pct < 25 ? 'warn' : ''}"><i style="width:${pct.toFixed(1)}%"></i></span>`;
  };
  return `
    <div class="allow-head"><h2>${SHIELD} Daily AI allowance left</h2>${running ? '<span class="allow-live"><span class="dot"></span>Live</span>' : ''}</div>
    <div class="allow-row"><span>Builds</span><b>${a.runs_left} of ${a.run_limit} left</b></div>${bar(a.runs_left, a.run_limit)}
    <div class="allow-row"><span>Tokens</span><b>${num(a.tokens_left)} of ${num(a.token_limit)} left</b></div>${bar(a.tokens_left, a.token_limit)}
    <p class="muted small">Shared by the practice and drill builders${running ? ', and counting this build as it runs' : ''}. Each build frees up 24 hours after it ran.</p>`;
}

function feedItem(step) {
  const [label, cls] = AVATAR[step.agent] || ['?', ''];
  const face = step.agent === 'Guardrail' ? SHIELD : esc(label);
  if (step.kind === 'model') {
    return `<li class="feed-item k-model"><span class="feed-av mini ${cls}">${face}</span><span>${esc(step.agent)} · ${esc(step.text)}</span></li>`;
  }
  const who = step.agent === 'Coach' ? 'You asked' : step.agent === 'Guardrail' ? 'App check' : step.agent;
  return `<li class="feed-item k-${step.kind} ${step.level || ''}">
    <span class="feed-av ${cls}" title="${esc(step.agent)}">${face}</span>
    <div class="feed-body">
      <div class="feed-head"><strong>${esc(who)}</strong>${step.to ? `<span class="feed-to">→ ${esc(step.to)}</span>` : ''}<span class="feed-t">${step.t}s</span></div>
      <p>${esc(step.text)}</p>
      ${step.board ? `<div class="feed-thumb">${boardThumb(step.board, { mini: true })}</div>` : ''}
    </div>
  </li>`;
}

function meterHtml(run) {
  const u = run.usage || { agents: {}, total: {} };
  const t = u.total || {};
  const rows = AGENT_ORDER.filter(a => u.agents?.[a]).map(a => {
    const r = u.agents[a];
    const [label, cls] = AVATAR[a];
    return `<tr><td><span class="feed-av mini ${cls}">${label}</span>${esc(a)}</td><td>${r.requests}</td><td>${num(r.input_tokens)}</td><td>${num(r.cache_read_tokens)}</td><td>${num(r.output_tokens)}</td><td>${usd(r.cost_usd)}</td></tr>`;
  }).join('');
  const prices = u.prices_per_million_usd;
  return `
    <h2>Tokens and cost</h2>
    <p class="muted small">Measured on this build, straight from the model's usage reports.</p>
    <div class="meter-tiles">
      <div><span>Model calls</span><strong>${t.requests || 0}</strong></div>
      <div><span>Input tokens</span><strong>${kTok(t.input_tokens)}</strong><small>${kTok(t.cache_read_tokens)} cached</small></div>
      <div><span>Output tokens</span><strong>${kTok(t.output_tokens)}</strong>${t.reasoning_tokens ? `<small>${kTok(t.reasoning_tokens)} reasoning</small>` : ''}</div>
      <div class="cost"><span>Cost</span><strong>${usd(t.cost_usd)}</strong></div>
    </div>
    ${rows ? `<table class="meter-table"><thead><tr><th>Agent</th><th>Calls</th><th>Input</th><th>Cached</th><th>Output</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    ${prices ? `<p class="muted small meter-foot">${esc(u.model)} · per 1M tokens: $${prices.input.toFixed(2)} input, $${prices.cached_input.toFixed(2)} cached, $${prices.output.toFixed(2)} output</p>` : ''}`;
}

/** The reviewer's verdict box under a proposal. */
export function reviewHtml(review, { who, revised }) {
  return `<div class="ai-review ${review.verdict}">
    <h3>${esc(who)}${revised ? ' <span class="muted small">(after one round of changes)</span>' : ''}</h3>
    ${review.strengths.length ? `<p class="small"><b>Strengths</b></p><ul>${review.strengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
    ${review.issues.length ? `<p class="small"><b>${review.verdict === 'approve' ? 'Small tweaks to consider' : 'To consider before you use it'}</b></p><ul>${review.issues.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

/**
 * The live run panel: activity feed, allowance left, token meter and the page's own result card.
 * renderResult(run, box) draws the proposal; onRunning(bool) and onAllowance(a) let the page update its button and header.
 */
export function mountRunView(box, { renderResult, onRunning, onAllowance, onFinished }) {
  box.hidden = true;
  box.innerHTML = `
    <div class="ai-run-grid">
      <div class="card card-pad ai-feed-card">
        <div class="card-head">
          <div><h2>Agent activity</h2><p class="muted small">Each agent's steps, live. Shield lines are checks the app runs in code.</p></div>
          <div class="ai-run-tools"><label class="check small"><input type="checkbox" data-calls> Show model calls</label><span class="allow-mini" data-allow-mini></span><span class="run-status" data-status></span></div>
        </div>
        <ol class="feed" data-feed></ol>
      </div>
      <div class="ai-side">
        <div class="card card-pad ai-allow" data-allow></div>
        <div class="card card-pad ai-meter" data-meter></div>
      </div>
    </div>
    <div data-result></div>`;
  const feed = box.querySelector('[data-feed]');
  let timer = null, stopped = false, shown = '', showCalls = false, last = null;

  function drawFeed(run) {
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    feed.innerHTML = run.trace.filter(s => showCalls || s.kind !== 'model').map(feedItem).join('')
      + (run.status === 'running' ? '<li class="feed-item k-wait"><span class="spinner"></span><span>Working…</span></li>' : '');
    if (nearBottom || run.status === 'running') feed.scrollTop = feed.scrollHeight;
  }

  function draw(run) {
    last = run;
    box.hidden = false;
    const s = box.querySelector('[data-status]');
    s.className = `run-status ${run.status}`;
    s.textContent = run.status === 'running' ? `Working · ${Math.round(run.elapsed_s || 0)}s` : run.status === 'done' ? `Done in ${Math.round(run.elapsed_s || 0)}s` : 'Stopped';
    drawFeed(run);
    if (run.allowance) {
      const a = run.allowance;
      box.querySelector('[data-allow]').innerHTML = allowanceCard(a, run.status === 'running');
      box.querySelector('[data-allow-mini]').innerHTML = `${SHIELD} Allowance left: <b>${a.runs_left}</b> builds · <b>${kTok(a.tokens_left)}</b> tokens`;
      onAllowance?.(run.allowance);
    }
    box.querySelector('[data-meter]').innerHTML = meterHtml(run);
    const key = `${run.id}:${run.status}:${run.saved_practice_id || ''}:${run.saved_drill_id || ''}`;
    if (key !== shown) {
      shown = key;
      const result = box.querySelector('[data-result]');
      if (run.status === 'error') {
        result.innerHTML = `<div class="ai-error">${SHIELD}<div><strong>This build stopped.</strong><p>${esc(run.error || 'Something went wrong.')}</p></div></div>`;
      } else if (run.status === 'done' && run.result) {
        renderResult(run, result);
      } else {
        result.innerHTML = '';
      }
    }
  }

  async function follow(runId) {
    clearTimeout(timer);
    let run;
    try { run = await api.get(`/api/planner/runs/${runId}`); } catch (err) { toast(err.message, 'error'); return; }
    if (stopped) return;
    draw(run);
    onRunning?.(run.status === 'running');
    if (run.status === 'running') timer = setTimeout(() => follow(runId), POLL_MS);
    else onFinished?.(run);
  }

  box.querySelector('[data-calls]').addEventListener('change', e => {
    showCalls = e.target.checked;
    if (last) drawFeed(last);
  });
  return {
    follow,
    draw,
    open(runId) { shown = ''; follow(runId); box.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    stop() { stopped = true; clearTimeout(timer); },
  };
}

/** The "Recent AI builds" table for one builder; click a row to open that build. Returns a refresh function. */
export function mountHistory(box, kind, onOpen) {
  async function refresh() {
    const runs = await api.get(`/api/planner/runs?kind=${kind}&limit=10`);
    box.innerHTML = runs.length ? `
      <table class="ai-hist">
        <thead><tr><th>When</th><th>${kind === 'drill' ? 'Drill' : 'Practice'}</th><th>Request</th><th>Calls</th><th>Input (cached)</th><th>Output</th><th>Cost</th><th>Time</th><th>Result</th></tr></thead>
        <tbody>${runs.map(x => {
          const t = x.total || {};
          const saved = x.saved_practice_id || x.saved_drill_id;
          const result = x.status === 'running' ? 'Running…' : x.status === 'error' ? '<span class="hist-err">Stopped</span>' : saved ? '✓ Saved' : 'Proposed';
          const what = kind === 'drill' ? esc(x.title || '—')
            : x.event_date ? esc(`${fmtDate(x.event_date, { month: 'short', day: 'numeric' })} · ${x.team_name || ''}`) : '—';
          return `<tr data-open-run="${x.id}" tabindex="0">
            <td>${esc(localTime(x.created_at))}</td>
            <td>${what}</td>
            <td class="hist-req">${esc(x.request)}</td>
            <td>${t.requests ?? '—'}</td>
            <td>${t.input_tokens != null ? `${num(t.input_tokens)} <span class="muted">(${num(t.cache_read_tokens)})</span>` : '—'}</td>
            <td>${t.output_tokens != null ? num(t.output_tokens) : '—'}</td>
            <td>${t.cost_usd != null ? usd(t.cost_usd) : '—'}</td>
            <td>${x.duration_s != null ? `${Math.round(x.duration_s)}s` : '—'}</td>
            <td>${result}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>` : '<p class="muted small">No AI builds yet. Your first one will show up here with its token count and cost.</p>';
  }
  const open = e => {
    const row = e.target.closest('[data-open-run]');
    if (row && (e.type === 'click' || e.key === 'Enter')) onOpen(row.dataset.openRun);
  };
  box.addEventListener('click', open);
  box.addEventListener('keydown', open);
  return refresh;
}
