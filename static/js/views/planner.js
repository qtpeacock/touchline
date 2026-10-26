// AI practice builder (Practices → Build a practice with AI): a team of AI agents plans a practice for
// the players who are actually coming. The page shows each agent's work as it happens, the tokens,
// cost and daily allowance left, and the proposed plan, which is only saved when the coach clicks Save.
import { api } from '../api.js';
import { esc, fmtDate, fmtRange, icons, isUpcoming, todayISO, toast } from '../ui.js';
import { boardThumb } from '../field.js';
import { presentDrill } from '../present.js';
import { attendanceEditor } from '../attendance.js';
import { SHIELD, allowancePill, animationsFor, mountHistory, mountRunView, reviewHtml } from '../ai-run.js';

const IDEAS = ['Defending as a team', 'Pressing to win the ball back', 'Keeping the ball under pressure', 'Finishing in front of goal', 'Playing out of the back', 'Quick transitions'];
const practiceLabel = ev => `${fmtDate(ev.date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${ev.team_name} · ${fmtRange(ev.start_time, ev.end_time)}`;

/** The same rule the server uses: only "yes" replies count, unless nobody has replied yet. */
function capText(c) {
  if (!c.roster) return 'This team has no players yet.';
  if (c.no_reply === c.roster) return `Nobody has replied yet, so drills may use the full roster of <b>${c.roster}</b>.`;
  return `Drills will use at most <b>${c.yes}</b> player${c.yes === 1 ? '' : 's'}: only players who said yes count.`;
}

export async function renderPlanner(host, ctx) {
  host.innerHTML = `
    <a class="back-link" href="#/coach/practices">← Practices</a>
    <header class="page-head">
      <div><p class="eyebrow">AI practice builder</p><h1>Build a practice with AI</h1>
      <p class="muted">Say what to work on. A team of AI agents checks who's coming, picks drills from your library, designs new ones that fit, and reviews the plan. Nothing is saved until you approve it.</p></div>
      <div class="actions"><span class="ai-allowance" data-allowance></span></div>
    </header>
    <div data-body><p class="loading">Loading…</p></div>`;

  const [status, events] = await Promise.all([
    api.get('/api/planner/status'),
    api.get(`/api/events?start=${todayISO()}&kind=practice&limit=40`),
  ]);
  const practices = events.filter(ev => ev.team_id && isUpcoming(ev));
  const wanted = Number(ctx.query.get('event'));
  let selected = practices.find(ev => ev.id === wanted) || practices[0];

  const pill = host.querySelector('[data-allowance]');
  const drawPill = a => { pill.innerHTML = allowancePill(a); };
  drawPill(status.allowance);

  const body = host.querySelector('[data-body]');
  body.innerHTML = `
    ${status.ready ? '' : `<div class="ai-notice">${SHIELD}<div><strong>The AI builder isn't set up on this computer.</strong> Add <code>PORTKEY_API_KEY</code> to a <code>.env</code> file in the project folder or the folder above it, then restart the app. Everything else works without it.</div></div>`}
    <div class="ai-layout">
      <section class="card card-pad ai-form">
        ${practices.length ? `
          <label class="field"><span>Practice</span>
            <select class="input" data-event>${practices.map(ev => `<option value="${ev.id}" ${ev === selected ? 'selected' : ''}>${esc(practiceLabel(ev))}${ev.practice_id ? ' · has a plan' : ''}</option>`).join('')}</select>
          </label>
          <label class="field"><span>What should this practice work on?</span>
            <textarea class="input" data-request rows="3" maxlength="500" placeholder="e.g. We keep getting beaten 1v1 on the wings. Work on defending and finish with a game."></textarea>
          </label>
          <div class="chips" data-ideas>${IDEAS.map(i => `<button type="button" class="chip" data-idea="${esc(i)}">${esc(i)}</button>`).join('')}</div>
          <div class="ai-go">
            <button class="btn primary big" type="button" data-go ${status.ready ? '' : 'disabled'}>${icons.sparkle} Build my practice</button>
            <span class="muted small">Takes about a minute and costs well under a cent.</span>
          </div>`
        : `<div class="empty"><div class="big">📅</div><h3>No upcoming practices</h3><p>Add a practice with a team on the calendar, then come back to build its plan.</p><a class="btn primary" href="#/coach/calendar">Open the calendar</a></div>`}
      </section>
      <aside class="card card-pad ai-att">
        <h2>Who's coming</h2>
        <p class="ai-cap" data-cap></p>
        <div data-att></div>
      </aside>
    </div>
    <section class="ai-run" data-run hidden></section>
    <section class="card card-pad ai-history">
      <div class="card-head"><div><h2>Recent AI practice builds</h2><p class="muted small">Real token counts for every build, from the app's own log. Click one to open it.</p></div></div>
      <div class="table-scroll" data-history><p class="muted small">Loading…</p></div>
    </section>`;

  const goButton = body.querySelector('[data-go]');
  const request = body.querySelector('[data-request]');
  const view = mountRunView(body.querySelector('[data-run]'), {
    renderResult,
    onAllowance: drawPill,
    onRunning: running => {
      if (!goButton) return;
      goButton.disabled = running || !status.ready;
      goButton.innerHTML = running ? '<span class="spinner"></span> Building…' : `${icons.sparkle} Build my practice`;
    },
    onFinished: () => refreshHistory(),
  });
  const refreshHistory = mountHistory(body.querySelector('[data-history]'), 'practice', id => view.open(id));

  // ----- who's coming -----
  async function drawAttendance() {
    const box = document.createElement('div');   // a fresh box, so old click handlers go with the old one
    body.querySelector('[data-att]').replaceChildren(box);
    const capLine = body.querySelector('[data-cap]');
    if (!selected) { capLine.textContent = 'Pick a practice to see who is coming.'; return; }
    await attendanceEditor(box, selected.id, { onChange: data => { capLine.innerHTML = capText(data.counts); } });
  }
  body.querySelector('[data-event]')?.addEventListener('change', e => {
    selected = practices.find(ev => String(ev.id) === e.target.value);
    drawAttendance();
  });
  body.querySelector('[data-ideas]')?.addEventListener('click', e => {
    const chip = e.target.closest('[data-idea]');
    if (!chip) return;
    request.value = request.value.trim() ? `${request.value.trim()} ${chip.dataset.idea.toLowerCase()}.` : `${chip.dataset.idea}.`;
    request.focus();
  });

  goButton?.addEventListener('click', async () => {
    const text = request.value.trim();
    if (text.length < 3) { request.focus(); return toast('Tell the AI what this practice should work on', 'error'); }
    goButton.disabled = true;
    try {
      const { run_id } = await api.post('/api/planner/runs', { event_id: selected.id, request: text });
      view.open(run_id);
    } catch (err) {
      goButton.disabled = false;
      toast(err.message, 'error');
    }
  });

  // ----- the proposal -----
  function renderResult(run, box) {
    const r = run.result;
    const animations = animationsFor(r.items);
    const phasesOf = it => (it.source === 'new' ? animations[it.new_drill_number] : it.board.phases) || [];
    const newCount = r.items.filter(it => it.source === 'new').length;
    box.innerHTML = `
      <section class="card ai-result">
        <header class="ai-result-head">
          <div>
            <p class="eyebrow">Proposed practice · ${esc(r.event.when)} · ${esc(r.event.team_name)}</p>
            <h2>${esc(r.title)}</h2>
            <p class="muted">Focus: ${esc(r.focus)}</p>
          </div>
          <div class="ai-badges">
            <span class="ai-badge">${icons.clock} ${r.total_minutes}${r.practice_length ? ` of ${r.practice_length}` : ''} min</span>
            <span class="ai-badge cap">${icons.teams} Max ${r.cap} players per drill</span>
            <span class="ai-badge ${r.review.verdict}">${r.review.verdict === 'approve' ? '✓ Reviewer approved' : 'Reviewer has suggestions'}</span>
          </div>
        </header>
        <ol class="ai-items">${r.items.map((it, i) => `
          <li class="ai-item">
            <span class="plan-order">${i + 1}</span>
            <button type="button" class="ai-thumb" data-present="${i}" title="Show this drill full screen">
              ${boardThumb(it.board)}<span class="badge">${phasesOf(it).length ? `▶ Play ${phasesOf(it).length} step${phasesOf(it).length === 1 ? '' : 's'}` : `${icons.present} View`}</span>
            </button>
            <div class="ai-item-body">
              ${it.kind ? `<span class="ai-kind ${it.kind}">${esc(it.kind)}</span>` : ''}
              <div class="ai-item-top"><strong>${esc(it.name)}</strong><span class="pill ${it.source === 'new' ? 'new' : ''}">${it.source === 'new' ? '✦ New drill' : 'From your library'}</span></div>
              <small class="muted">${it.minutes} min · ${it.players_needed} of ${r.cap} players${it.categories?.length ? ` · ${esc(it.categories.join(', '))}` : ''}</small>
              <p>${esc(it.purpose)}</p>
              <details>
                <summary>${it.source === 'new' ? 'How it works' : 'Drill notes'}</summary>
                <p>${esc(it.about)}</p>
                ${it.setup ? `<p><b>Setup:</b> ${esc(it.setup)}</p>` : ''}
                ${it.coaching_points?.length ? `<p><b>Coaching points:</b></p><ul>${it.coaching_points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
                ${it.progression ? `<p><b>Progression:</b> ${esc(it.progression)}</p>` : ''}
              </details>
            </div>
          </li>`).join('')}
        </ol>
        <div class="ai-notes">
          <div><h3>Coach notes</h3><p>${esc(r.coach_notes)}</p></div>
          <div><h3>If the maybes come</h3><p>${esc(r.if_maybes_come || 'No changes needed.')}</p></div>
          <div><h3>Who's coming</h3><p>${esc(r.attendance.summary)}</p><p class="muted small">${esc(r.cap_reason)}</p></div>
        </div>
        ${reviewHtml(r.review, { who: 'Plan Reviewer', revised: r.revised })}
        <footer class="ai-save">
          ${run.saved_practice_id ? `
            <p class="saved-note">✓ Saved to your practices${newCount ? ' and drill library' : ''}.</p>
            <div class="actions"><a class="btn primary" href="#/coach/practices/${run.saved_practice_id}">Open the practice plan</a></div>` : `
            <label class="field ai-name"><span>Save as</span><input class="input" data-plan-name maxlength="80" value="${esc(r.title)}"></label>
            <label class="check"><input type="checkbox" data-attach checked> Attach it to the ${esc(r.event.when)} practice</label>
            <div class="actions">
              <button class="btn" type="button" data-again>Build again</button>
              <button class="btn primary" type="button" data-save>Save plan${newCount ? ` + ${newCount} new drill${newCount === 1 ? '' : 's'}` : ''}</button>
            </div>`}
        </footer>
      </section>`;

    box.querySelectorAll('[data-present]').forEach(b => b.addEventListener('click', () => {
      const it = r.items[Number(b.dataset.present)];
      const phases = phasesOf(it);
      presentDrill({ name: it.name, categories: it.categories, minutes: it.minutes, notes: it.about, board: { ...it.board, phases } },
        { mode: phases.length ? 'anim' : 'board' });
    }));
    box.querySelector('[data-again]')?.addEventListener('click', () => {
      body.querySelector('.ai-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      request?.focus();
    });
    const save = box.querySelector('[data-save]');
    save?.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const res = await api.post(`/api/planner/runs/${run.id}/save`, {
          name: box.querySelector('[data-plan-name]').value.trim() || r.title,
          attach: box.querySelector('[data-attach]').checked,
          animations,
        });
        toast(res.attached ? 'Practice saved and attached to the calendar' : 'Practice saved');
        view.draw({ ...run, saved_practice_id: res.practice_id });
        refreshHistory();
      } catch (err) {
        save.disabled = false;
        toast(err.message, 'error');
      }
    });
  }

  await Promise.all([drawAttendance(), refreshHistory()]);
  const resume = status.running_kind === 'practice' ? status.running_run_id : ctx.query.get('run');
  if (resume) view.open(resume);

  return () => view.stop();
}
