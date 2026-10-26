// Practices: the next scheduled practice, saved practice plans, and the drag-and-drop practice builder.
import { api } from '../api.js';
import { go } from '../router.js';
import {
  confirmDialog, esc, fmtDate, fmtRange, icons, isUpcoming, relativeDay, todayISO, toast, toIntOrNull,
} from '../ui.js';
import { boardThumb } from '../field.js';
import { openEventModal } from './calendar.js';
import { labelsOf, loadCategories } from '../categories.js';
import { attendanceLine } from '../attendance.js';
import { renderPlanner } from './planner.js';

const totalMinutes = items => items.reduce((n, it) => n + (Number(it.minutes) || 0), 0);

export async function renderPractices(host, ctx) {
  if (ctx.id === 'ai') return renderPlanner(host, ctx);   // the AI practice builder
  if (ctx.id) return renderBuilder(host, ctx);

  host.innerHTML = `
    <header class="page-head">
      <div><p class="eyebrow">Practices</p><h1>Practices</h1><p class="muted">See what's next, reuse saved plans, or build a new session from your drills.</p></div>
      <div class="actions"><a class="btn primary" href="#/coach/practices/ai">${icons.sparkle} Build a practice with AI</a></div>
    </header>
    <div data-next><p class="loading">Loading…</p></div>
    <div class="tabbar">
      <span class="tab on">Saved practices <span class="count" data-count>0</span></span>
      <a class="tab create" href="#/coach/practices/new">${icons.plus} Create new practice</a>
      <span class="grow"></span>
      <input class="input small" type="search" data-search placeholder="Search saved practices…" aria-label="Search saved practices">
    </div>
    <div class="practice-grid" data-saved></div>`;

  const [events, practices, teams] = await Promise.all([
    api.get(`/api/events?start=${todayISO()}&kind=practice&limit=20`),
    api.get('/api/practices'),
    api.get('/api/teams'),
  ]);
  const byId = new Map(practices.map(p => [p.id, p]));

  // ----- next practice -----
  const nextBox = host.querySelector('[data-next]');
  function drawNext(changing = false) {
    const next = events.find(isUpcoming);
    if (!next) {
      nextBox.innerHTML = `<div class="empty" style="margin-bottom:22px"><div class="big">📅</div><h3>No practices on the calendar</h3><p>Schedule your next practice and it will show up here.</p><button class="btn primary" type="button" data-schedule>${icons.plus} Schedule a practice</button></div>`;
      nextBox.querySelector('[data-schedule]').addEventListener('click', () => openEventModal({
        teams, practices, kind: 'practice', onSaved: () => renderPractices(host, ctx),
      }));
      return;
    }
    const plan = !changing && byId.get(next.practice_id);
    nextBox.innerHTML = `
      <section class="card next-practice">
        <div class="np-when">
          <p class="eyebrow">Next practice</p>
          <h2>${esc(fmtDate(next.date))}</h2>
          <p class="np-time">${fmtRange(next.start_time, next.end_time)}</p>
          <p class="np-meta">${next.team_name ? `<span class="team-dot" style="background:${esc(next.team_color)}"></span>${esc(next.team_name)}` : 'No team'}${next.location ? ` · ${esc(next.location)}` : ''}</p>
          ${next.team_id ? `<div class="np-att"><span class="np-att-label">Who's coming</span>${attendanceLine(next)}<a href="#/coach/teams/${next.team_id}">Update replies</a></div>` : ''}
          <span class="np-countdown">${relativeDay(next.date)}</span>
        </div>
        <div class="np-plan">
          ${plan ? `
            <div class="np-plan-head"><strong>${esc(plan.name)}</strong><span class="muted small">${plan.items.length} drills · ${totalMinutes(plan.items)} min</span></div>
            <ol class="np-drills">${plan.items.map(it => `<li><span>${esc(it.name)}</span><small>${it.minutes} min</small></li>`).join('')}</ol>
            <div class="np-actions"><a class="btn small primary" href="#/coach/practices/${plan.id}">Open plan</a><button class="btn small" type="button" data-change>Change plan</button>${next.team_id ? `<a class="btn small soft" href="#/coach/practices/ai?event=${next.id}">${icons.sparkle} Rebuild with AI</a>` : ''}</div>`
          : `
            <div class="np-plan-head"><strong>No practice plan yet</strong></div>
            <p class="muted" style="margin:0">Attach one of your saved plans, or build a new one for this practice.</p>
            <div class="np-actions">
              <select class="input small" data-attach aria-label="Attach a saved plan"><option value="">Attach a saved plan…</option>${practices.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
              ${next.team_id ? `<a class="btn small primary" href="#/coach/practices/ai?event=${next.id}">${icons.sparkle} Build with AI</a>` : ''}
              <a class="btn small" href="#/coach/practices/new?event=${next.id}">${icons.plus} Build a plan</a>
              ${changing ? '<button class="btn small ghost" type="button" data-cancel>Cancel</button>' : ''}
            </div>`}
        </div>
      </section>`;
    nextBox.querySelector('[data-change]')?.addEventListener('click', () => drawNext(true));
    nextBox.querySelector('[data-cancel]')?.addEventListener('click', () => drawNext());
    nextBox.querySelector('[data-attach]')?.addEventListener('change', async e => {
      const id = toIntOrNull(e.target.value);
      if (!id) return;
      Object.assign(next, await api.put(`/api/events/${next.id}/practice`, { practice_id: id }));
      toast('Plan attached to the practice');
      drawNext();
    });
  }
  drawNext();

  // ----- saved plans -----
  const savedBox = host.querySelector('[data-saved]');
  const search = host.querySelector('[data-search]');
  function drawSaved() {
    host.querySelector('[data-count]').textContent = practices.length;
    const q = search.value.trim().toLowerCase();
    const list = practices.filter(p => `${p.name} ${p.focus} ${p.team_name || ''} ${p.items.map(i => i.name).join(' ')}`.toLowerCase().includes(q));
    savedBox.innerHTML = list.length ? list.map(p => `
      <article class="card practice-card">
        <div class="pc-head"><h3>${esc(p.name)}</h3><span class="pill">${esc(p.team_name || 'Any team')}</span></div>
        ${p.focus ? `<p class="muted small" style="margin:0">Focus: ${esc(p.focus)}</p>` : ''}
        <ol class="pc-drills">${p.items.slice(0, 5).map(it => `<li>${esc(it.name)} <small>· ${it.minutes} min</small></li>`).join('')}${p.items.length > 5 ? `<li class="muted">+${p.items.length - 5} more</li>` : ''}</ol>
        <div class="pc-foot">
          <span><strong>${p.items.length}</strong> drills · <strong>${totalMinutes(p.items)}</strong> min</span>
          <div><a class="btn small" href="#/coach/practices/${p.id}">Edit</a><button class="btn small" type="button" data-dup="${p.id}">Duplicate</button><button class="icon-btn danger" type="button" data-del="${p.id}" aria-label="Delete ${esc(p.name)}">×</button></div>
        </div>
      </article>`).join('')
      : practices.length
        ? '<p class="muted">No saved practices match your search.</p>'
        : `<div class="empty" style="grid-column:1/-1"><div class="big">📋</div><h3>No saved practices yet</h3><p>Build a practice from your drill library and save it to reuse later.</p><a class="btn primary" href="#/coach/practices/new">${icons.plus} Create new practice</a></div>`;
  }
  search.addEventListener('input', drawSaved);
  savedBox.addEventListener('click', async e => {
    const dup = e.target.closest('[data-dup]');
    const del = e.target.closest('[data-del]');
    if (dup) {
      const src = byId.get(Number(dup.dataset.dup));
      const copy = await api.post('/api/practices', { name: `${src.name} (copy)`.slice(0, 80), team_id: src.team_id, focus: src.focus, notes: src.notes, items: src.items });
      practices.unshift(copy);
      byId.set(copy.id, copy);
      drawSaved();
      toast('Practice duplicated');
    } else if (del) {
      const p = byId.get(Number(del.dataset.del));
      if (!await confirmDialog(`Delete "${p.name}"? Calendar practices that use it will keep their time but lose the plan.`)) return;
      await api.del(`/api/practices/${p.id}`);
      practices.splice(practices.indexOf(p), 1);
      byId.delete(p.id);
      events.forEach(ev => { if (ev.practice_id === p.id) ev.practice_id = null; });
      drawSaved();
      drawNext();
      toast('Practice deleted');
    }
  });
  drawSaved();
}

// ---------- builder ----------

async function renderBuilder(host, ctx) {
  const isNew = ctx.id === 'new';
  let existing = null;
  const [drills, teams, categories] = await Promise.all([api.get('/api/drills'), api.get('/api/teams'), loadCategories()]);
  if (!isNew) {
    try { existing = await api.get(`/api/practices/${encodeURIComponent(ctx.id)}`); } catch (err) {
      toast(err.message, 'error');
      return go('/coach/practices');
    }
  }
  const eventId = toIntOrNull(ctx.query.get('event'));
  const drillById = new Map(drills.map(d => [d.id, d]));
  const fromDrill = d => ({ drill_id: d.id, name: d.name, categories: labelsOf(d), field: d.board?.field || 'full', minutes: d.minutes });
  const hasLabel = (d, name) => labelsOf(d).some(l => l.toLowerCase() === name.toLowerCase());
  const plan = existing ? structuredClone(existing.items) : [];
  const preset = drillById.get(toIntOrNull(ctx.query.get('drill')));
  if (isNew && preset) plan.push(fromDrill(preset));
  let category = '';
  let dragFrom = null;

  host.innerHTML = `
    <a class="back-link" href="#/coach/practices">← Practices</a>
    <header class="page-head">
      <div><p class="eyebrow">${isNew ? 'Create new practice' : 'Edit practice'}</p><h1>${isNew ? 'Build a practice' : esc(existing.name)}</h1>
      <p class="muted">Drag drills in from your library, put them in order, set the minutes, then name and save it.</p></div>
      <div class="actions"><a class="btn" href="#/coach/practices">Cancel</a><button class="btn primary" type="button" data-save>Save practice</button></div>
    </header>
    <div class="builder">
      <section class="card builder-main">
        <label class="field"><span>Practice name</span><input class="input name-input" data-name maxlength="80" placeholder="e.g. Tuesday: playing out of the back" value="${esc(existing?.name)}"></label>
        <div class="builder-meta">
          <label class="field"><span>Team</span><select class="input" data-team-select><option value="">Any team</option>${teams.map(t => `<option value="${t.id}" ${t.id === existing?.team_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
          <label class="field"><span>What are we working on?</span><input class="input" data-focus maxlength="120" placeholder="e.g. Keeping the ball under pressure" value="${esc(existing?.focus)}"></label>
        </div>
        <div class="plan-summary"><div><span>Drills</span><strong data-count>0</strong></div><div><span>Practice length</span><strong data-total>0 min</strong></div></div>
        <div class="plan-list" data-plan></div>
        <label class="field" style="margin-top:16px"><span>Notes for this practice</span><textarea class="input" data-notes maxlength="1000" rows="3" placeholder="Equipment, groups, reminders…">${esc(existing?.notes)}</textarea></label>
      </section>
      <aside class="card library-panel">
        <h2 class="panel-title">Drill library</h2>
        <p class="muted small" style="margin:0 0 10px">Drag a drill into the plan, or click ＋ to add it to the end.</p>
        <input class="input small" type="search" data-search placeholder="Search drills…" aria-label="Search drills">
        <div class="chips" data-chips></div>
        <div class="lib-list" data-lib></div>
        <a class="btn small soft" style="margin-top:12px" href="#/coach/whiteboard?new=1">${icons.plus} Design a new drill</a>
      </aside>
    </div>`;

  const list = host.querySelector('[data-plan]');
  const lib = host.querySelector('[data-lib]');
  const search = host.querySelector('[data-search]');
  const thumbFor = it => boardThumb(drillById.get(it.drill_id)?.board || { field: it.field }, { mini: true });

  function drawPlan() {
    host.querySelector('[data-count]').textContent = plan.length;
    host.querySelector('[data-total]').textContent = `${totalMinutes(plan)} min`;
    let clock = 0;
    list.innerHTML = plan.length ? plan.map((it, i) => {
      const start = clock;
      clock += Number(it.minutes) || 0;
      return `<div class="plan-item" draggable="true" data-index="${i}">
        <span class="drag-handle" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
        <span class="plan-order">${i + 1}</span>
        <div class="plan-thumb">${thumbFor(it)}</div>
        <div class="plan-info"><strong>${esc(it.name)}</strong><small>${esc(labelsOf(it).join(' · ') || 'Drill')} · minute ${start}–${clock}</small></div>
        <label class="plan-min"><input class="input small" type="number" min="1" max="240" value="${it.minutes}" data-minutes="${i}" aria-label="Minutes for ${esc(it.name)}">min</label>
        <div class="plan-tools">
          <button class="icon-btn" type="button" data-move="${i}" data-dir="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" type="button" data-move="${i}" data-dir="1" aria-label="Move down" ${i === plan.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="icon-btn danger" type="button" data-remove="${i}" aria-label="Remove ${esc(it.name)}">×</button>
        </div>
      </div>`;
    }).join('') : '<div class="plan-empty"><strong>Drag drills here</strong>Pick drills from your library on the right to start building the practice.</div>';
  }

  function drawLibrary() {
    const cats = categories.map(c => c.name).filter(name => drills.some(d => hasLabel(d, name)));
    host.querySelector('[data-chips]').innerHTML = ['', ...cats].map(c => `<button type="button" class="chip${c === category ? ' on' : ''}" data-cat="${esc(c)}">${c ? esc(c) : 'All'}</button>`).join('');
    const q = search.value.trim().toLowerCase();
    const shown = drills.filter(d => (!category || hasLabel(d, category)) && `${d.name} ${labelsOf(d).join(' ')} ${d.notes}`.toLowerCase().includes(q));
    lib.innerHTML = shown.length ? shown.map(d => `
      <div class="lib-item" draggable="true" data-drill="${d.id}">
        <div class="plan-thumb">${boardThumb(d.board, { mini: true })}</div>
        <div class="plan-info"><strong>${esc(d.name)}</strong><small>${esc(labelsOf(d).join(' · ') || 'No category')} · ${d.minutes} min</small></div>
        <button class="icon-btn" type="button" data-add="${d.id}" aria-label="Add ${esc(d.name)} to the practice">＋</button>
      </div>`).join('')
      : `<p class="muted small">${drills.length ? 'No drills match.' : 'Your drill library is empty. Design a drill on the whiteboard first.'}</p>`;
  }

  const clearMarkers = () => list.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
  function dropIndex(y) {
    const items = [...list.querySelectorAll('.plan-item')];
    const i = items.findIndex(el => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; });
    return i === -1 ? items.length : i;
  }
  const accepts = e => e.dataTransfer.types.includes('text/x-drill') || e.dataTransfer.types.includes('text/x-plan');

  lib.addEventListener('dragstart', e => {
    const item = e.target.closest('[data-drill]');
    if (!item) return;
    e.dataTransfer.setData('text/x-drill', item.dataset.drill);
    e.dataTransfer.effectAllowed = 'copy';
  });
  list.addEventListener('dragstart', e => {
    const item = e.target.closest('.plan-item');
    if (!item) return;
    dragFrom = Number(item.dataset.index);
    e.dataTransfer.setData('text/x-plan', item.dataset.index);
    e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => item.classList.add('dragging'));
  });
  list.addEventListener('dragend', () => { dragFrom = null; clearMarkers(); list.classList.remove('drop-target'); drawPlan(); });
  list.addEventListener('dragover', e => {
    if (!accepts(e)) return;
    e.preventDefault();
    list.classList.add('drop-target');
    clearMarkers();
    const items = list.querySelectorAll('.plan-item');
    const at = dropIndex(e.clientY);
    if (items[at]) items[at].classList.add('drop-before');
    else items[items.length - 1]?.classList.add('drop-after');
  });
  list.addEventListener('dragleave', e => {
    if (!list.contains(e.relatedTarget)) { clearMarkers(); list.classList.remove('drop-target'); }
  });
  list.addEventListener('drop', e => {
    if (!accepts(e)) return;
    e.preventDefault();
    const at = dropIndex(e.clientY);
    const drill = drillById.get(Number(e.dataTransfer.getData('text/x-drill')));
    if (drill) {
      plan.splice(at, 0, fromDrill(drill));
    } else if (dragFrom !== null) {
      const [moved] = plan.splice(dragFrom, 1);
      plan.splice(at > dragFrom ? at - 1 : at, 0, moved);
    }
    dragFrom = null;
    list.classList.remove('drop-target');
    drawPlan();
  });

  list.addEventListener('click', e => {
    const mv = e.target.closest('[data-move]');
    const rm = e.target.closest('[data-remove]');
    if (mv) {
      const i = Number(mv.dataset.move), j = i + Number(mv.dataset.dir);
      [plan[i], plan[j]] = [plan[j], plan[i]];
      drawPlan();
    } else if (rm) {
      plan.splice(Number(rm.dataset.remove), 1);
      drawPlan();
    }
  });
  list.addEventListener('change', e => {
    const input = e.target.closest('[data-minutes]');
    if (!input) return;
    plan[Number(input.dataset.minutes)].minutes = Math.max(1, Math.min(240, Math.round(Number(input.value)) || 1));
    drawPlan();
  });
  lib.addEventListener('click', e => {
    const add = e.target.closest('[data-add]');
    if (!add) return;
    plan.push(fromDrill(drillById.get(Number(add.dataset.add))));
    drawPlan();
    toast('Added to the practice');
  });
  host.querySelector('[data-chips]').addEventListener('click', e => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    category = chip.dataset.cat;
    drawLibrary();
  });
  search.addEventListener('input', drawLibrary);

  const saveButton = host.querySelector('[data-save]');
  saveButton.addEventListener('click', async () => {
    const nameInput = host.querySelector('[data-name]');
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return toast('Give the practice a name first', 'error'); }
    if (!plan.length) return toast('Add at least one drill to the practice', 'error');
    const body = {
      name,
      team_id: toIntOrNull(host.querySelector('[data-team-select]').value),
      focus: host.querySelector('[data-focus]').value.trim(),
      notes: host.querySelector('[data-notes]').value.trim(),
      items: plan.map(it => ({ drill_id: it.drill_id, name: it.name, categories: labelsOf(it), field: it.field, minutes: it.minutes })),
    };
    saveButton.disabled = true;
    try {
      const saved = isNew ? await api.post('/api/practices', body) : await api.put(`/api/practices/${existing.id}`, body);
      if (eventId) await api.put(`/api/events/${eventId}/practice`, { practice_id: saved.id });
      toast(eventId ? 'Practice saved and added to your next practice' : 'Practice saved');
      go('/coach/practices');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      saveButton.disabled = false;
    }
  });

  drawPlan();
  drawLibrary();
}
