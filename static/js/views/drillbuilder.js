// AI drill builder (Drills → Design a drill with AI): the Drill Designer draws one new drill for the
// coach's group, the Drill Reviewer checks it, and the coach decides whether to save it to the library.
import { api } from '../api.js';
import { esc, fmtDate, fmtRange, icons, isUpcoming, todayISO, toast } from '../ui.js';
import { boardThumb } from '../field.js';
import { presentDrill } from '../present.js';
import { countsOf } from '../attendance.js';
import { SHIELD, allowancePill, animationsFor, mountHistory, mountRunView, reviewHtml } from '../ai-run.js';

const IDEAS = ['1v1 defending to a gate', 'A rondo to keep the ball under pressure', 'Finishing with a goalkeeper', 'A pressing game with a trigger', 'A passing pattern warm-up', 'Counter-attacking after winning the ball'];
const eventLabel = ev => `${fmtDate(ev.date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${ev.team_name} ${ev.kind} · ${fmtRange(ev.start_time, ev.end_time)}`;

/** Players a practice can use, by the same rule as the server: yes replies, or the roster if nobody replied. */
function playersFor(ev) {
  const c = countsOf(ev);
  return c.none === c.roster ? c.roster : c.yes;
}

export async function renderDrillBuilder(host, ctx) {
  host.innerHTML = `
    <a class="back-link" href="#/coach/drills">← Drills</a>
    <header class="page-head">
      <div><p class="eyebrow">AI drill builder</p><h1>Design a drill with AI</h1>
      <p class="muted">Describe the drill you need. The Drill Designer draws it on the whiteboard for the players you have, the Drill Reviewer checks it, and you decide whether to save it to your library.</p></div>
      <div class="actions"><span class="ai-allowance" data-allowance></span></div>
    </header>
    <div data-body><p class="loading">Loading…</p></div>`;

  const [status, events] = await Promise.all([
    api.get('/api/planner/status'),
    api.get(`/api/events?start=${todayISO()}&limit=40`),
  ]);
  const upcoming = events.filter(ev => ev.team_id && isUpcoming(ev));
  const pill = host.querySelector('[data-allowance]');
  const drawPill = a => { pill.innerHTML = allowancePill(a); };
  drawPill(status.allowance);

  const body = host.querySelector('[data-body]');
  body.innerHTML = `
    ${status.ready ? '' : `<div class="ai-notice">${SHIELD}<div><strong>The AI builder isn't set up on this computer.</strong> Add <code>PORTKEY_API_KEY</code> to a <code>.env</code> file in the project folder or the folder above it, then restart the app.</div></div>`}
    <div class="ai-layout">
      <section class="card card-pad ai-form">
        <label class="field"><span>What drill do you need?</span>
          <textarea class="input" data-request rows="3" maxlength="500" placeholder="e.g. A 1v1 defending drill where the defender has to show the attacker onto their weaker foot."></textarea>
        </label>
        <div class="chips" data-ideas>${IDEAS.map(i => `<button type="button" class="chip" data-idea="${esc(i)}">${esc(i)}</button>`).join('')}</div>
        <div class="ai-drill-opts">
          <label class="field span-2"><span>Size it for a practice or game <em class="muted">(optional)</em></span>
            <select class="input" data-event>
              <option value="">None: I'll set the number of players</option>
              ${upcoming.map(ev => `<option value="${ev.id}">${esc(eventLabel(ev))} · ${countsOf(ev).yes} going</option>`).join('')}
            </select>
          </label>
          <label class="field"><span>Players</span><input class="input" type="number" data-players min="1" max="22" value="8"></label>
          <label class="field"><span>Minutes</span><input class="input" type="number" data-minutes min="5" max="45" value="15"></label>
          <label class="field span-2"><span>Board</span>
            <select class="input" data-board>
              <option value="">Let the AI choose</option>
              <option value="blank">Coned grid (whiteboard)</option>
              <option value="half">Half field</option>
              <option value="full">Full field</option>
            </select>
          </label>
        </div>
        <p class="ai-cap" data-cap></p>
        <div class="ai-go">
          <button class="btn primary big" type="button" data-go ${status.ready ? '' : 'disabled'}>${icons.sparkle} Design my drill</button>
          <span class="muted small">Takes about 20–40 seconds and costs a fraction of a cent.</span>
        </div>
      </section>
      <aside class="card card-pad ai-steps">
        <h2>How it works</h2>
        <ol>
          <li><span class="feed-av dd">DD</span><div><strong>Drill Designer</strong><p>Writes the drill and draws it on the whiteboard, with exactly the players you have.</p></div></li>
          <li><span class="feed-av gr">${SHIELD}</span><div><strong>App check</strong><p>A drawing with more players than you have is sent back before you ever see it.</p></div></li>
          <li><span class="feed-av pr">DR</span><div><strong>Drill Reviewer</strong><p>Checks it like an assistant coach and can ask for one redraw.</p></div></li>
          <li><span class="feed-av coach">You</span><div><strong>You decide</strong><p>Play the animation, then save it to your library or try again.</p></div></li>
        </ol>
      </aside>
    </div>
    <section class="ai-run" data-run hidden></section>
    <section class="card card-pad ai-history">
      <div class="card-head"><div><h2>Recent AI drill builds</h2><p class="muted small">Real token counts for every build, from the app's own log. Click one to open it.</p></div></div>
      <div class="table-scroll" data-history><p class="muted small">Loading…</p></div>
    </section>`;

  const goButton = body.querySelector('[data-go]');
  const request = body.querySelector('[data-request]');
  const eventSelect = body.querySelector('[data-event]');
  const playersInput = body.querySelector('[data-players]');
  const view = mountRunView(body.querySelector('[data-run]'), {
    renderResult,
    onAllowance: drawPill,
    onRunning: running => {
      goButton.disabled = running || !status.ready;
      goButton.innerHTML = running ? '<span class="spinner"></span> Designing…' : `${icons.sparkle} Design my drill`;
    },
    onFinished: () => refreshHistory(),
  });
  const refreshHistory = mountHistory(body.querySelector('[data-history]'), 'drill', id => view.open(id));

  // ----- how many players -----
  const chosenEvent = () => upcoming.find(ev => String(ev.id) === eventSelect.value);
  function drawCap() {
    const ev = chosenEvent();
    const max = ev ? playersFor(ev) : 22;
    playersInput.max = String(Math.max(max, 1));
    const n = Math.max(1, Math.min(Number(playersInput.value) || 1, Math.max(max, 1)));
    body.querySelector('[data-cap]').innerHTML = ev
      ? (max ? `Sized for ${esc(fmtDate(ev.date, { weekday: 'short', month: 'short', day: 'numeric' }))}: <b>${max}</b> said yes, so the drill will use at most <b>${n}</b> player${n === 1 ? '' : 's'}.`
        : 'Nobody has said yes to that one yet, so there is nobody to design for.')
      : `The drill will use <b>${n}</b> player${n === 1 ? '' : 's'}.`;
  }
  eventSelect.addEventListener('change', () => {
    const ev = chosenEvent();
    if (ev) playersInput.value = String(playersFor(ev));
    drawCap();
  });
  playersInput.addEventListener('input', drawCap);
  drawCap();

  body.querySelector('[data-ideas]').addEventListener('click', e => {
    const chip = e.target.closest('[data-idea]');
    if (!chip) return;
    request.value = `${chip.dataset.idea}.`;
    request.focus();
  });

  goButton.addEventListener('click', async () => {
    const text = request.value.trim();
    if (text.length < 3) { request.focus(); return toast('Describe the drill you need', 'error'); }
    const players = Math.round(Number(playersInput.value));
    if (!(players >= 1 && players <= 22)) { playersInput.focus(); return toast('Players must be between 1 and 22', 'error'); }
    const minutes = Math.max(5, Math.min(45, Math.round(Number(body.querySelector('[data-minutes]').value)) || 15));
    goButton.disabled = true;
    try {
      const { run_id } = await api.post('/api/planner/drill-runs', {
        request: text, players, minutes, board: body.querySelector('[data-board]').value || null,
        event_id: chosenEvent()?.id ?? null,
      });
      view.open(run_id);
    } catch (err) {
      goButton.disabled = false;
      toast(err.message, 'error');
    }
  });

  // ----- the proposed drill -----
  function renderResult(run, box) {
    const r = run.result;
    const it = r.drill;
    const animations = animationsFor([it]);
    const phases = animations[it.new_drill_number] || [];
    box.innerHTML = `
      <section class="card ai-result">
        <header class="ai-result-head">
          <div>
            <p class="eyebrow">Proposed drill${r.event ? ` · sized for ${esc(r.event.when)} · ${esc(r.event.team_name)}` : ''}</p>
            <h2>${esc(it.name)}</h2>
            <p class="muted">${esc(it.categories.join(' · ') || 'No category')}</p>
          </div>
          <div class="ai-badges">
            <span class="ai-badge">${icons.clock} ${it.minutes} min</span>
            <span class="ai-badge cap">${icons.teams} ${it.players_needed} of ${r.cap} players</span>
            <span class="ai-badge ${r.review.verdict}">${r.review.verdict === 'approve' ? '✓ Reviewer approved' : 'Reviewer has suggestions'}</span>
          </div>
        </header>
        <div class="ai-drill-body">
          <button type="button" class="ai-thumb big" data-present title="Show this drill full screen">
            ${boardThumb(it.board)}<span class="badge">${phases.length ? `▶ Play ${phases.length} step${phases.length === 1 ? '' : 's'}` : `${icons.present} View`}</span>
          </button>
          <div class="ai-drill-text">
            <h3>How it works</h3><p>${esc(it.about)}</p>
            <h3>Setup</h3><p>${esc(it.setup)}</p>
            <h3>Coaching points</h3><ul>${it.coaching_points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
            ${it.progression ? `<h3>Progression</h3><p>${esc(it.progression)}</p>` : ''}
          </div>
        </div>
        ${reviewHtml(r.review, { who: 'Drill Reviewer', revised: r.revised })}
        <footer class="ai-save">
          ${run.saved_drill_id ? `
            <p class="saved-note">✓ Saved to your drill library${phases.length ? ', with its animation' : ''}.</p>
            <div class="actions">
              <a class="btn" href="#/coach/practices/new?drill=${run.saved_drill_id}">${icons.plus} Add to a practice</a>
              <a class="btn primary" href="#/coach/whiteboard/${run.saved_drill_id}">Open on the whiteboard</a>
            </div>` : `
            <label class="field ai-name"><span>Save as</span><input class="input" data-drill-name maxlength="70" value="${esc(it.name)}"></label>
            <div class="actions">
              <button class="btn" type="button" data-again>Design another</button>
              <button class="btn primary" type="button" data-save>Save to my drill library</button>
            </div>`}
        </footer>
      </section>`;

    box.querySelector('[data-present]').addEventListener('click', () => presentDrill(
      { name: it.name, categories: it.categories, minutes: it.minutes, notes: it.about, board: { ...it.board, phases } },
      { mode: phases.length ? 'anim' : 'board' },
    ));
    box.querySelector('[data-again]')?.addEventListener('click', () => {
      body.querySelector('.ai-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      request.focus();
    });
    const save = box.querySelector('[data-save]');
    save?.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const res = await api.post(`/api/planner/runs/${run.id}/save`, {
          name: box.querySelector('[data-drill-name]').value.trim() || it.name, animations,
        });
        toast('Drill saved to your library');
        view.draw({ ...run, saved_drill_id: res.drill_id });
        refreshHistory();
      } catch (err) {
        save.disabled = false;
        toast(err.message, 'error');
      }
    });
  }

  await refreshHistory();
  const resume = status.running_kind === 'drill' ? status.running_run_id : ctx.query.get('run');
  if (resume) view.open(resume);

  return () => view.stop();
}
