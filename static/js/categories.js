// Drill categories: each coach has their own list (defaults plus any they create), and a drill can carry several.
import { api } from './api.js';
import { confirmDialog, esc, openModal, toast } from './ui.js';

export const loadCategories = () => api.get('/api/categories');

/** A drill's (or practice-plan item's) labels, including the single category older saves used. */
export const labelsOf = d => (Array.isArray(d?.categories) && d.categories.length ? d.categories : d?.category && d.category !== 'Other' ? [d.category] : []);

export const labelPills = (labels, max = 3) => labels.length
  ? labels.slice(0, max).map(l => `<span class="pill">${esc(l)}</span>`).join('') + (labels.length > max ? `<span class="pill muted-pill">+${labels.length - max}</span>` : '')
  : '<span class="pill muted-pill">No category</span>';

export function newCategoryModal(onCreated) {
  openModal({
    title: 'New category',
    submitLabel: 'Create category',
    narrow: true,
    body: '<label class="field"><span>Category name</span><input class="input" name="name" maxlength="30" placeholder="e.g. Transition, Rondos, Goalkeeping"></label>',
    async onSubmit(form) {
      const name = form.elements.name.value.trim();
      if (!name) throw new Error('Give the category a name.');
      const created = await api.post('/api/categories', { name });
      toast(`Category "${created.name}" created`);
      onCreated?.(created);
    },
  });
}

/** Rename, delete and add categories. Changes save as you make them; `onChanged` runs when the dialog closes. */
export function manageCategoriesModal(categories, onChanged) {
  let changed = false;
  const list = [...categories];
  const rows = () => list.map(c => `
    <div class="cat-row" data-id="${c.id}">
      <input class="input small" value="${esc(c.name)}" maxlength="30" aria-label="Category name">
      <button type="button" class="icon-btn danger" data-remove aria-label="Delete ${esc(c.name)}">×</button>
    </div>`).join('') || '<p class="muted small">No categories yet.</p>';
  openModal({
    title: 'Drill categories',
    submitLabel: 'Done',
    body: `<p class="muted small">Rename a category by editing its name. Deleting one removes it from your drills; the drills stay.</p>
      <div class="cat-rows">${rows()}</div>
      <div class="cat-add"><input class="input small" data-new maxlength="30" placeholder="New category name"><button type="button" class="btn small" data-add>Add</button></div>`,
    onMount(dialog) {
      const box = dialog.querySelector('.cat-rows');
      const redraw = () => { box.innerHTML = rows(); };
      dialog.addEventListener('close', () => { if (changed) onChanged?.(); });
      box.addEventListener('change', async e => {
        const row = e.target.closest('[data-id]');
        const cat = list.find(c => String(c.id) === row?.dataset.id);
        const name = e.target.value.trim();
        if (!cat || name === cat.name) return;
        if (!name) { e.target.value = cat.name; return toast('A category needs a name', 'error'); }
        try {
          Object.assign(cat, await api.put(`/api/categories/${cat.id}`, { name }));
          changed = true;
          toast('Category renamed');
        } catch (err) { e.target.value = cat.name; toast(err.message, 'error'); }
      });
      box.addEventListener('click', async e => {
        const row = e.target.closest('[data-remove]')?.closest('[data-id]');
        if (!row) return;
        const cat = list.find(c => String(c.id) === row.dataset.id);
        if (!await confirmDialog(`Delete the "${cat.name}" category? Drills keep everything else.`)) return;
        await api.del(`/api/categories/${cat.id}`);
        list.splice(list.indexOf(cat), 1);
        changed = true;
        redraw();
      });
      const input = dialog.querySelector('[data-new]');
      const add = async () => {
        const name = input.value.trim();
        if (!name) return;
        try {
          list.push(await api.post('/api/categories', { name }));
          changed = true;
          input.value = '';
          redraw();
        } catch (err) { toast(err.message, 'error'); }
      };
      dialog.querySelector('[data-add]').addEventListener('click', add);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    },
  });
}
