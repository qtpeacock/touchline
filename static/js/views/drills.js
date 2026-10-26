// Drill library: every saved drill as a card with its whiteboard diagram, filtered by the coach's categories.
import { api } from '../api.js';
import { confirmDialog, esc, icons, toast } from '../ui.js';
import { boardThumb } from '../field.js';
import { presentDrill } from '../present.js';
import { labelPills, labelsOf, loadCategories, manageCategoriesModal, newCategoryModal } from '../categories.js';
import { renderDrillBuilder } from './drillbuilder.js';

const NONE = '__none__';   // filter value for drills with no category
let category = '';

export async function renderDrills(host, ctx) {
  if (ctx?.id === 'ai') return renderDrillBuilder(host, ctx);   // the AI drill builder
  host.innerHTML = `
    <header class="page-head">
      <div><p class="eyebrow">Drills</p><h1>Drill library</h1><p class="muted">Your playbook of reusable drills. Open one on the whiteboard to edit it, or add it to a practice.</p></div>
      <div class="actions"><a class="btn" href="#/coach/whiteboard?new=1">${icons.plus} New drill</a><a class="btn primary" href="#/coach/drills/ai">${icons.sparkle} Design a drill with AI</a></div>
    </header>
    <section class="card cat-bar">
      <div class="cat-bar-head">
        <h2>Categories</h2>
        <div class="actions"><button class="btn small" type="button" data-manage>Manage</button><button class="btn small soft" type="button" data-new-cat>${icons.plus} New category</button></div>
      </div>
      <div class="chips" data-chips></div>
    </section>
    <div class="toolbar-row">
      <input class="input" type="search" data-search placeholder="Search drills, categories or notes…" aria-label="Search drills">
      <span class="muted small" data-count></span>
    </div>
    <div class="drill-grid" data-grid><p class="loading">Loading drills…</p></div>`;

  let [drills, categories] = await Promise.all([api.get('/api/drills'), loadCategories()]);
  const grid = host.querySelector('[data-grid]');
  const search = host.querySelector('[data-search]');
  const refresh = async () => {
    [drills, categories] = await Promise.all([api.get('/api/drills'), loadCategories()]);
    draw();
  };

  const matches = (d, cat) => (cat === NONE ? !labelsOf(d).length : labelsOf(d).some(l => l.toLowerCase() === cat.toLowerCase()));

  function draw() {
    if (category && category !== NONE && !categories.some(c => c.name === category)) category = '';
    const uncategorized = drills.filter(d => !labelsOf(d).length).length;
    const chip = (value, label, count) => `<button type="button" class="chip${value === category ? ' on' : ''}" data-cat="${esc(value)}">${esc(label)}<span class="n">${count}</span></button>`;
    host.querySelector('[data-chips]').innerHTML = chip('', 'All drills', drills.length)
      + categories.map(c => chip(c.name, c.name, drills.filter(d => matches(d, c.name)).length)).join('')
      + (uncategorized ? chip(NONE, 'No category', uncategorized) : '');

    const q = search.value.trim().toLowerCase();
    const shown = drills.filter(d => (!category || matches(d, category)) && `${d.name} ${labelsOf(d).join(' ')} ${d.notes}`.toLowerCase().includes(q));
    host.querySelector('[data-count]').textContent = `Showing ${shown.length} of ${drills.length} drill${drills.length === 1 ? '' : 's'}`;
    grid.innerHTML = shown.length ? shown.map(d => {
      const steps = (d.board?.phases || []).filter(p => p.moves?.length).length;
      return `<article class="card drill-card">
        <div class="drill-media">
          <a class="drill-thumb" href="#/coach/whiteboard/${d.id}" aria-label="Open ${esc(d.name)} on the whiteboard">
            ${boardThumb(d.board)}${steps ? `<span class="badge">▶ Animated · ${steps} step${steps === 1 ? '' : 's'}</span>` : ''}
          </a>
          <button class="thumb-present" type="button" data-present="${d.id}" title="Show this drill full screen">${icons.present} Present</button>
        </div>
        <div class="drill-body">
          <div class="pill-row">${labelPills(labelsOf(d))}<span class="pill minutes">${d.minutes} min</span></div>
          <h3>${esc(d.name)}</h3>
          <p class="muted clamp">${esc(d.notes || 'No coaching notes yet.')}</p>
          <div class="drill-actions">
            <a class="btn small" href="#/coach/whiteboard/${d.id}">Open drill</a>
            <a class="btn small soft" href="#/coach/practices/new?drill=${d.id}">${icons.plus} Practice</a>
            <button class="icon-btn danger" type="button" data-del="${d.id}" aria-label="Delete ${esc(d.name)}">×</button>
          </div>
        </div>
      </article>`;
    }).join('') : `<div class="empty" style="grid-column:1/-1">
        <div class="big">⚽</div>
        <h3>${!drills.length ? 'Your playbook starts here' : category && !q ? `No ${category === NONE ? 'uncategorized' : `"${esc(category)}"`} drills yet` : 'No drills match'}</h3>
        <p>${!drills.length ? 'Design a drill on the whiteboard and save it to see it here.' : category && !q ? 'Design one on the whiteboard and tick this category under Drill details.' : 'Try a different search or category.'}</p>
        <a class="btn primary" href="#/coach/whiteboard?new=1">${icons.plus} Design a drill</a>
      </div>`;
  }

  search.addEventListener('input', draw);
  host.querySelector('[data-chips]').addEventListener('click', e => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    category = chip.dataset.cat === category ? '' : chip.dataset.cat;
    draw();
  });
  host.querySelector('[data-new-cat]').addEventListener('click', () => newCategoryModal(created => {
    categories.push(created);
    draw();
  }));
  host.querySelector('[data-manage]').addEventListener('click', () => manageCategoriesModal(categories, refresh));
  grid.addEventListener('click', async e => {
    const present = e.target.closest('[data-present]');
    if (present) {
      const drill = drills.find(d => String(d.id) === present.dataset.present);
      const animated = (drill.board?.phases || []).some(p => p.moves?.length);
      return presentDrill(drill, { mode: animated ? 'anim' : 'board' });
    }
    const del = e.target.closest('[data-del]');
    if (!del) return;
    const drill = drills.find(d => String(d.id) === del.dataset.del);
    if (!await confirmDialog(`Delete "${drill.name}" from your library? Saved practices keep their copy of it.`)) return;
    await api.del(`/api/drills/${drill.id}`);
    drills.splice(drills.indexOf(drill), 1);
    draw();
    toast('Drill deleted');
  });
  draw();
}
