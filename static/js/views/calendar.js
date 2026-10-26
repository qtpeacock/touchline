// Calendar: a month grid of practices and games, plus the add/edit event dialog used across the app.
import { api } from '../api.js';
import {
  confirmDialog, esc, eventTitle, fmtDate, fmtRange, fmtTimeShort, icons, isoDate, isUpcoming, openModal,
  parseDate, todayISO, toast, toIntOrNull,
} from '../ui.js';
import { attendanceEditor, attendanceLine } from '../attendance.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let monthCursor = null;   // first day of the month on screen; kept between visits
let teamFilter = '';

// Short enough for a calendar cell; the full title is in the tooltip. Team color is the dot.
const chipLabel = ev => (ev.title || (ev.kind === 'game' ? `vs ${ev.opponent || 'TBD'}` : ev.team_name || 'Practice'));

export async function renderCalendar(host) {
  if (!monthCursor) {
    const now = new Date();
    monthCursor = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  host.innerHTML = `
    <header class="page-head">
      <div><p class="eyebrow">Calendar</p><h1>Schedule</h1><p class="muted">Practices and games for all of your teams. Click any day to add something.</p></div>
      <div class="actions">
        <button class="btn" type="button" data-new="game">${icons.plus} Add game</button>
        <button class="btn primary" type="button" data-new="practice">${icons.plus} Add practice</button>
      </div>
    </header>
    <div class="cal-layout">
      <section class="card cal-card">
        <div class="cal-toolbar">
          <div class="cal-nav">
            <button class="icon-btn" type="button" data-step="-1" aria-label="Previous month">‹</button>
            <h2 class="cal-title"></h2>
            <button class="icon-btn" type="button" data-step="1" aria-label="Next month">›</button>
            <button class="btn small" type="button" data-today>Today</button>
          </div>
          <div class="cal-filters">
            <select class="input small" data-team-filter aria-label="Filter by team"><option value="">All teams</option></select>
            <span class="legend"><i class="practice"></i>Practice <i class="game"></i>Game</span>
          </div>
        </div>
        <div class="cal-grid" role="grid"></div>
      </section>
      <aside class="card upcoming"><h2>Coming up</h2><div class="up-list"></div></aside>
    </div>`;

  const [teams, practices] = await Promise.all([api.get('/api/teams'), api.get('/api/practices')]);
  const grid = host.querySelector('.cal-grid');
  const filter = host.querySelector('[data-team-filter]');
  filter.insertAdjacentHTML('beforeend', teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join(''));
  if (!teams.some(t => String(t.id) === teamFilter)) teamFilter = '';
  filter.value = teamFilter;
  let loaded = new Map();

  const openEditor = opts => openEventModal({ teams, practices, teamId: teamFilter, onSaved: draw, ...opts });

  async function draw() {
    const year = monthCursor.getFullYear(), month = monthCursor.getMonth();
    host.querySelector('.cal-title').textContent = monthCursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const weeks = Math.ceil((monthCursor.getDay() + new Date(year, month + 1, 0).getDate()) / 7);
    const days = Array.from({ length: weeks * 7 }, (_, i) => new Date(year, month, 1 - monthCursor.getDay() + i));
    const teamQuery = teamFilter ? `&team_id=${teamFilter}` : '';
    const [events, upcoming] = await Promise.all([
      api.get(`/api/events?start=${isoDate(days[0])}&end=${isoDate(days[days.length - 1])}${teamQuery}`),
      api.get(`/api/events?start=${todayISO()}&limit=12${teamQuery}`),
    ]);
    loaded = new Map([...events, ...upcoming].map(ev => [String(ev.id), ev]));
    const byDate = Map.groupBy ? Map.groupBy(events, ev => ev.date) : events.reduce((m, ev) => m.set(ev.date, [...(m.get(ev.date) || []), ev]), new Map());
    const today = todayISO();

    grid.innerHTML = WEEKDAYS.map(d => `<div class="cal-dow" role="columnheader">${d}</div>`).join('') + days.map(d => {
      const iso = isoDate(d);
      return `<div class="cal-day${d.getMonth() !== month ? ' out' : ''}${iso === today ? ' today' : ''}" role="gridcell" data-date="${iso}" tabindex="0" aria-label="${esc(fmtDate(iso))}">
        <div class="cal-day-top"><span class="cal-num">${d.getDate()}</span><span class="add-hint" aria-hidden="true">＋</span></div>
        ${(byDate.get(iso) || []).map(ev => `
          <button type="button" class="ev ${ev.kind}" data-ev="${ev.id}" title="${esc(`${eventTitle(ev)} · ${fmtRange(ev.start_time, ev.end_time)}`)}">
            <i style="background:${esc(ev.team_color || '#8aa197')}"></i><span class="ev-time">${fmtTimeShort(ev.start_time)}</span><span class="ev-name">${esc(chipLabel(ev))}</span>${ev.practice_id ? `<span class="ev-plan" title="Has a practice plan">${icons.practices}</span>` : ''}
          </button>`).join('')}
      </div>`;
    }).join('');

    const next = upcoming.filter(isUpcoming).slice(0, 7);
    host.querySelector('.up-list').innerHTML = next.length ? next.map(ev => {
      const d = parseDate(ev.date);
      const plan = ev.kind !== 'practice' ? ''
        : ev.practice_id ? `<a class="up-plan" href="#/coach/practices/${ev.practice_id}">${icons.practices}<span>${esc(ev.practice_name)}</span></a>`
        : '<span class="up-plan none">No practice plan yet</span>';
      return `<div class="up-item" role="button" tabindex="0" data-ev="${ev.id}">
        <span class="up-date"><small>${WEEKDAYS[d.getDay()]}</small><strong>${d.getDate()}</strong><small>${d.toLocaleDateString(undefined, { month: 'short' })}</small></span>
        <span class="up-body"><span><span class="tag ${ev.kind}">${ev.kind}</span></span><strong>${esc(eventTitle(ev))}</strong><small>${fmtRange(ev.start_time, ev.end_time)}${ev.location ? ' · ' + esc(ev.location) : ''}</small>${attendanceLine(ev)}${plan}</span>
      </div>`;
    }).join('') : '<p class="muted small">Nothing scheduled yet. Add a practice or game to get started.</p>';
  }

  host.addEventListener('click', e => {
    if (e.target.closest('a')) return;   // plan links navigate on their own
    const evButton = e.target.closest('[data-ev]');
    if (evButton) return openEditor({ event: loaded.get(evButton.dataset.ev) });
    const day = e.target.closest('[data-date]');
    if (day) return openEditor({ date: day.dataset.date });
    const step = e.target.closest('[data-step]');
    if (step) {
      monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + Number(step.dataset.step), 1);
      return draw();
    }
    if (e.target.closest('[data-today]')) {
      const now = new Date();
      monthCursor = new Date(now.getFullYear(), now.getMonth(), 1);
      return draw();
    }
    const add = e.target.closest('[data-new]');
    if (add) openEditor({ kind: add.dataset.new });
  });
  host.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.matches('.cal-day')) {
      e.preventDefault();
      openEditor({ date: e.target.dataset.date });
    } else if (e.target.matches('.up-item')) {
      e.preventDefault();
      openEditor({ event: loaded.get(e.target.dataset.ev) });
    }
  });
  filter.addEventListener('change', () => { teamFilter = filter.value; draw(); });

  await draw();
}

/** Add or edit a practice/game. Used by the calendar, team pages and the practices page. */
export function openEventModal({ event = null, date = todayISO(), kind = 'practice', teamId = '', teams, practices = [], onSaved }) {
  const ev = event || {
    kind, date, team_id: teamId || (teams.length === 1 ? teams[0].id : ''), practice_id: null,
    start_time: kind === 'game' ? '10:00' : '17:30', end_time: kind === 'game' ? '11:30' : '19:00',
    location: '', opponent: '', notes: '', title: '',
  };
  const titleFor = k => (event ? 'Edit event' : k === 'game' ? 'Add a game' : 'Add a practice');
  openModal({
    title: titleFor(ev.kind),
    submitLabel: event ? 'Save changes' : 'Add to calendar',
    footerLeft: event ? '<button type="button" class="btn danger-ghost" data-delete>Delete</button>' : '',
    body: `
      <div class="seg" role="radiogroup" aria-label="Type">
        <label><input type="radio" name="kind" value="practice" ${ev.kind === 'practice' ? 'checked' : ''}>Practice</label>
        <label><input type="radio" name="kind" value="game" ${ev.kind === 'game' ? 'checked' : ''}>Game</label>
      </div>
      <div class="plan-box" data-only="practice">
        <div class="plan-box-head" data-plan-head></div>
        <label class="field"><span>Plan for this practice</span><select class="input" name="practice_id"><option value="">No plan yet</option>${practices.map(p => `<option value="${p.id}" ${p.id === ev.practice_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        ${event?.team_id && event.date >= todayISO() ? `<a class="ai-link" href="#/coach/practices/ai?event=${event.id}">${icons.sparkle} Build a plan with AI for the players who are coming</a>` : ''}
      </div>
      <div class="grid-2">
        <label class="field"><span>Team</span><select class="input" name="team_id"><option value="">No team</option>${teams.map(t => `<option value="${t.id}" ${String(t.id) === String(ev.team_id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Date</span><input class="input" type="date" name="date" value="${esc(ev.date)}"></label>
      </div>
      <div class="grid-2">
        <label class="field"><span>Start time</span><input class="input" type="time" name="start_time" value="${esc(ev.start_time)}"></label>
        <label class="field"><span>End time</span><input class="input" type="time" name="end_time" value="${esc(ev.end_time)}"></label>
      </div>
      <label class="field" data-only="game"><span>Opponent</span><input class="input" name="opponent" maxlength="80" value="${esc(ev.opponent)}" placeholder="e.g. Riverside FC"></label>
      <label class="check" data-only="game"><input type="checkbox" name="away" ${ev.away ? 'checked' : ''}> Away game <span class="muted small">(families can add travel plans)</span></label>
      <label class="field"><span>Location</span><input class="input" name="location" maxlength="120" value="${esc(ev.location)}" placeholder="e.g. Main field"></label>
      ${event ? '' : '<label class="field"><span>Repeat every week until <em class="muted">(optional)</em></span><input class="input" type="date" name="repeat_until"></label>'}
      <label class="field"><span>Notes</span><textarea class="input" name="notes" rows="2" maxlength="500" placeholder="Optional">${esc(ev.notes)}</textarea></label>
      ${event?.team_id ? `
        <div class="att-box">
          <div class="att-box-head"><strong>Who's coming</strong><span class="muted small">Replies save as you click. Only players who say yes count toward drills in the AI builder.</span></div>
          <div data-att><p class="muted small">Loading…</p></div>
        </div>` : ''}`,
    onMount(dialog, close) {
      const form = dialog.querySelector('form');
      const sync = () => {
        const k = form.elements.kind.value;
        dialog.querySelectorAll('[data-only]').forEach(el => { el.hidden = el.dataset.only !== k; });
        dialog.querySelector('.modal-head h2').textContent = titleFor(k);
      };
      form.querySelectorAll('[name=kind]').forEach(r => r.addEventListener('change', sync));
      sync();
      const head = dialog.querySelector('[data-plan-head]');
      const drawPlan = () => {
        const plan = practices.find(p => String(p.id) === form.elements.practice_id.value);
        const minutes = plan ? plan.items.reduce((n, it) => n + (Number(it.minutes) || 0), 0) : 0;
        head.innerHTML = plan
          ? `<span class="plan-box-icon">${icons.practices}</span>
             <div class="plan-box-text"><small>Practice plan</small><strong>${esc(plan.name)}</strong><span>${plan.items.length} drills · ${minutes} min${plan.focus ? ` · ${esc(plan.focus)}` : ''}</span></div>
             <a class="btn small primary" href="#/coach/practices/${plan.id}">Open practice plan</a>`
          : `<span class="plan-box-icon empty">${icons.practices}</span>
             <div class="plan-box-text"><small>Practice plan</small><strong>No plan yet</strong><span>${event ? 'Pick a saved plan below, or build a new one for this practice.' : 'Pick a saved plan below, or build one after adding the practice.'}</span></div>
             ${event ? `<a class="btn small" href="#/coach/practices/new?event=${event.id}">${icons.plus} Build a plan</a>` : ''}`;
      };
      form.elements.practice_id.addEventListener('change', drawPlan);
      drawPlan();
      const attBox = dialog.querySelector('[data-att]');
      if (attBox) {
        let changed = false, first = true;
        attendanceEditor(attBox, event.id, { onChange: () => { if (!first) changed = true; first = false; } })
          .catch(err => { attBox.innerHTML = `<p class="muted small">${esc(err.message)}</p>`; });
        // Replies save as they're clicked, so refresh the page behind the dialog even if it's cancelled.
        dialog.addEventListener('close', () => { if (changed) onSaved?.(); });
      }
      dialog.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!await confirmDialog(`Delete "${eventTitle(event)}" on ${fmtDate(event.date)}?`)) return;
        await api.del(`/api/events/${event.id}`);
        close();
        toast('Removed from the calendar');
        onSaved?.();
      });
    },
    async onSubmit(form) {
      const field = name => form.elements[name]?.value ?? '';
      const type = field('kind');
      if (!field('date')) throw new Error('Pick a date.');
      if (field('start_time') && field('end_time') && field('end_time') < field('start_time')) throw new Error('The end time is before the start time.');
      const body = {
        kind: type, team_id: toIntOrNull(field('team_id')), date: field('date'),
        start_time: field('start_time'), end_time: field('end_time'), location: field('location').trim(),
        opponent: type === 'game' ? field('opponent').trim() : '',
        away: type === 'game' && form.elements.away.checked,
        practice_id: type === 'practice' ? toIntOrNull(field('practice_id')) : null,
        notes: field('notes').trim(), title: ev.title || '',
      };
      if (event) {
        await api.put(`/api/events/${event.id}`, body);
        toast('Event updated');
      } else {
        if (field('repeat_until')) body.repeat_until = field('repeat_until');
        const res = await api.post('/api/events', body);
        toast(res.created > 1 ? `Added ${res.created} weekly ${type}s` : `${type === 'game' ? 'Game' : 'Practice'} added`);
      }
      onSaved?.();
    },
  });
}
