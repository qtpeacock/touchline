// Whiteboard: full field, half field or blank board; players, cones, ball and arrows (straight or curved);
// mirror left/right; animation mode with a suggested animation built from the drawing; presentation mode.
import { api } from '../api.js';
import { session, go, replacePath } from '../router.js';
import { confirmDialog, esc, icons, toast, uid } from '../ui.js';
import {
  ARROW_KINDS, ASPECT, TEAM_COLORS, arrowSvg, controlThrough, curveMidpoint, defaultControl, isCurved,
  pieceHtml, pitchSvg, positionsAfter, positionsDuring, surfaceOf, tokenHtml, trailSvg,
} from '../field.js';
import { suggestAnimation } from '../animate.js';
import { presentDrill } from '../present.js';
import { labelsOf, loadCategories, newCategoryModal } from '../categories.js';

const SPEEDS = { slow: 1800, normal: 1100, fast: 600 };
const MAX_ITEMS = 80, MAX_STEPS = 20, HISTORY = 80;
const TOOLS = [
  { key: 'select', label: 'Select', icon: icons.select, hint: 'Drag pieces to move them. Click an arrow to adjust, bend or delete it.' },
  { key: 'move', label: 'Run', icon: icons.run, hint: 'Run: drag on the board to draw a player run (solid arrow).' },
  { key: 'curve', label: 'Curved run', icon: icons.curve, hint: 'Curved run: drag to draw a bending run. Drag the middle handle afterwards to change the bend.' },
  { key: 'pass', label: 'Pass', icon: icons.pass, hint: 'Pass: drag on the board to draw a pass (dashed arrow).' },
  { key: 'dribble', label: 'Dribble', icon: icons.dribble, hint: 'Dribble: drag on the board to draw a dribble (wavy arrow).' },
];
const FIELDS = [['full', 'Full field'], ['half', 'Half field'], ['blank', 'Whiteboard']];

const draftKey = () => `touchline:board:${session.user.id}`;
const blankBoard = () => ({ field: 'full', pieces: [], arrows: [], phases: [], mirrored: false });
const blankMeta = () => ({ id: null, name: '', categories: [], minutes: 15, notes: '' });
const r2 = n => Math.round(n * 100) / 100;
const clamp = (v, lo = 1.5, hi = 98.5) => Math.max(lo, Math.min(hi, v));
const clampControl = v => r2(Math.max(-45, Math.min(145, v)));

function normalize(board = {}) {
  return {
    field: ['full', 'half', 'blank'].includes(board.field) ? board.field : 'full',
    pieces: Array.isArray(board.pieces) ? board.pieces : [],
    arrows: Array.isArray(board.arrows) ? board.arrows : [],
    phases: Array.isArray(board.phases) ? board.phases.map(p => ({ id: p.id || uid(), moves: Array.isArray(p.moves) ? p.moves : [] })) : [],
    mirrored: !!board.mirrored,
  };
}
function readDraft() {
  try { return JSON.parse(localStorage.getItem(draftKey())); } catch { return null; }
}

export async function renderWhiteboard(host, ctx) {
  // ----- decide which board to open -----
  let meta = blankMeta(), board = blankBoard(), dirty = false;
  const draft = readDraft();
  const fromDraft = () => { meta = { ...blankMeta(), ...draft.meta, categories: labelsOf(draft.meta || {}) }; board = normalize(draft.board); dirty = !!draft.dirty; };
  let categories = [];
  const categoriesLoaded = loadCategories().then(list => { categories = list; }).catch(() => {});

  if (ctx.id) {
    if (draft?.dirty && String(draft.meta?.id) === String(ctx.id)) {
      fromDraft();
    } else {
      if (draft?.dirty && !await confirmDialog('You have unsaved changes on the whiteboard. Discard them and open this drill?', { title: 'Unsaved changes', confirmLabel: 'Discard changes' })) {
        return go('/coach/whiteboard');
      }
      let drill;
      try { drill = await api.get(`/api/drills/${encodeURIComponent(ctx.id)}`); } catch (err) {
        toast(err.message, 'error');
        return go('/coach/drills');
      }
      meta = { id: drill.id, name: drill.name, categories: labelsOf(drill), minutes: drill.minutes, notes: drill.notes };
      board = normalize(drill.board);
    }
  } else if (ctx.query.get('new') === '1') {
    const keep = draft?.dirty && !await confirmDialog('Start a new board? Your unsaved changes will be lost.', { title: 'Unsaved changes', confirmLabel: 'Start new board' });
    if (keep) fromDraft();
    else localStorage.removeItem(draftKey());
    replacePath(meta.id ? `/coach/whiteboard/${meta.id}` : '/coach/whiteboard');
  } else if (draft) {
    fromDraft();
    if (meta.id) replacePath(`/coach/whiteboard/${meta.id}`);
  }

  // ----- editor state -----
  let tool = 'select';
  let sel = null;                  // { type: 'piece' | 'arrow', id }
  let anim = false, step = 0;      // step 0 = setup; step k = board.phases[k - 1]
  let speed = 'normal', playToken = 0, playing = false, live = null;
  let drag = null, labelBefore = null, lastField = null;
  const undoStack = [], redoStack = [];

  host.innerHTML = `
    <header class="page-head">
      <div><p class="eyebrow">Whiteboard</p><h1 data-title></h1><p class="muted">Drag players, cones and the ball onto the board, then draw runs, passes and dribbles.</p></div>
      <div class="actions">
        <span class="dirty-note" data-dirty></span>
        <button class="btn" type="button" data-present title="Show this drill full screen">${icons.present} Present</button>
        <button class="btn" type="button" data-new>New board</button>
        <button class="btn primary" type="button" data-save>Save to drills</button>
      </div>
    </header>
    <div class="wb-layout">
      <section class="card wb-main">
        <div class="wb-toolbar">
          <div class="group">
            <div class="seg" data-fields>${FIELDS.map(([k, label]) => `<button type="button" data-field="${k}">${label}</button>`).join('')}</div>
            <button class="btn small mirror-btn" type="button" data-mirror aria-pressed="false" title="Flip the drill left ↔ right">${icons.mirror} Mirror</button>
          </div>
          <div class="group">
            <div class="seg" data-tools>${TOOLS.map(t => `<button type="button" data-tool="${t.key}" title="${t.label}">${t.icon}${t.label}</button>`).join('')}</div>
            <button class="icon-btn" type="button" data-undo title="Undo (Ctrl+Z)" aria-label="Undo">${icons.undo}</button>
            <button class="icon-btn" type="button" data-redo title="Redo (Ctrl+Y)" aria-label="Redo">${icons.redo}</button>
          </div>
        </div>
        <div class="wb-stage">
          <div class="board" data-board>
            <div class="layer layer-pitch"></div>
            <svg class="layer layer-arrows" viewBox="0 0 ${100 * ASPECT} 100" preserveAspectRatio="none"></svg>
            <div class="layer layer-pieces"></div>
          </div>
        </div>
        <p class="wb-hint" data-hint></p>
        <div class="anim-bar">
          <div class="anim-row">
            <div class="group">
              <label class="toggle"><input type="checkbox" data-anim><span class="toggle-track"></span><span>Animation mode<em class="beta">BETA</em></span></label>
              <button class="btn small soft" type="button" data-suggest title="Turn the arrows on this board into animation steps">${icons.sparkle} Suggest animation</button>
            </div>
            <div class="play-controls" data-play-controls hidden>
              <select class="input small" data-speed aria-label="Playback speed"><option value="slow">Slow</option><option value="normal" selected>Normal</option><option value="fast">Fast</option></select>
              <button class="btn small primary" type="button" data-play></button>
            </div>
          </div>
          <div class="steps" data-steps hidden></div>
        </div>
        <div class="anim-row" style="margin-top:12px">
          <span class="muted small" data-count></span>
          <button class="btn small ghost" type="button" data-clear>Clear board</button>
        </div>
      </section>
      <aside class="wb-side">
        <section class="card">
          <h2 class="panel-title">Add to the board</h2>
          <p class="muted small" style="margin:0">Drag onto the board, or click to drop in the middle.</p>
          <div class="palette-group"><h3>Players</h3><div class="palette">
            ${TEAM_COLORS.map(c => `<button type="button" class="pal-item" draggable="true" data-add="player" data-color="${c.color}"><span class="pal-token">${tokenHtml({ kind: 'player', color: c.color, label: '#' })}</span>${c.name}</button>`).join('')}
          </div></div>
          <div class="palette-group"><h3>Equipment</h3><div class="palette">
            <button type="button" class="pal-item" draggable="true" data-add="ball"><span class="pal-token">${tokenHtml({ kind: 'ball' })}</span>Ball</button>
            <button type="button" class="pal-item" draggable="true" data-add="cone"><span class="pal-token">${tokenHtml({ kind: 'cone' })}</span>Cone</button>
          </div></div>
        </section>
        <section class="card inspector" data-inspector></section>
        <section class="card">
          <h2 class="panel-title">Drill details</h2>
          <div class="stack" style="margin-top:10px">
            <label class="field"><span>Drill name</span><input class="input" data-meta="name" maxlength="70" placeholder="e.g. 4v2 Rondo"></label>
            <div class="field"><span>Categories <em class="muted">· pick any that fit</em></span><div class="chips cat-picker" data-cat-picker></div></div>
            <label class="field minutes-field"><span>Minutes</span><input class="input" type="number" min="1" max="180" data-meta="minutes"></label>
            <label class="field"><span>Coaching notes</span><textarea class="input" data-meta="notes" maxlength="2000" rows="5" placeholder="Setup, rules, coaching points…"></textarea></label>
            <button class="btn small" type="button" data-save-copy hidden>Save as a new drill</button>
          </div>
        </section>
      </aside>
    </div>`;

  const $ = s => host.querySelector(s);
  const fieldEl = $('[data-board]');
  const pitchLayer = $('.layer-pitch'), arrowLayer = $('.layer-arrows'), pieceLayer = $('.layer-pieces');
  const inspector = $('[data-inspector]');
  for (const input of host.querySelectorAll('[data-meta]')) input.value = meta[input.dataset.meta] ?? '';

  // ----- persistence + history -----
  function persist() {
    try { localStorage.setItem(draftKey(), JSON.stringify({ meta, board, dirty })); } catch { /* storage full: ignore */ }
  }
  function markDirty() {
    dirty = true;
    persist();
    drawStatus();
  }
  const snapshot = () => JSON.stringify(board);
  function commit(before) {
    if (before === snapshot()) return;
    undoStack.push(before);
    if (undoStack.length > HISTORY) undoStack.shift();
    redoStack.length = 0;
    markDirty();
  }
  function edit(change) {
    const before = snapshot();
    change();
    commit(before);
    draw();
  }
  function restore(json) {
    board = normalize(JSON.parse(json));
    if (sel && !(sel.type === 'piece' ? board.pieces : board.arrows).some(x => x.id === sel.id)) sel = null;
    step = Math.min(step, board.phases.length);
    markDirty();
    draw();
  }
  function undo() { if (undoStack.length) { stopPlayback(); redoStack.push(snapshot()); restore(undoStack.pop()); } }
  function redo() { if (redoStack.length) { stopPlayback(); undoStack.push(snapshot()); restore(redoStack.pop()); } }

  // ----- lookups -----
  const pieceById = id => board.pieces.find(p => p.id === id);
  const arrowById = id => board.arrows.find(a => a.id === id);
  const isSel = (type, id) => sel?.type === type && sel.id === id;
  const positions = () => live || positionsAfter(board, anim ? step : 0);
  const currentPhase = () => (anim && step > 0 ? board.phases[step - 1] : null);
  const drawingTool = () => tool !== 'select' && !anim;

  // ----- drawing -----
  function drawPitch() {
    if (lastField === board.field) return;
    lastField = board.field;
    pitchLayer.innerHTML = pitchSvg(board.field);
    fieldEl.classList.toggle('blank', board.field === 'blank');
  }
  function drawArrows() {
    const surface = surfaceOf(board.field);
    let svg = '';
    if (!anim) svg += board.arrows.map(a => arrowSvg(a, surface, { selected: isSel('arrow', a.id), hit: tool === 'select' })).join('');
    if (drag?.type === 'new-arrow') svg += arrowSvg(drag.arrow, surface);
    const phase = currentPhase();
    if (phase && !live) {
      const from = positionsAfter(board, step - 1);
      svg += phase.moves.map(mv => (from.get(mv.id) ? trailSvg(mv, from.get(mv.id), surface) : '')).join('');
    }
    arrowLayer.innerHTML = svg;
  }
  function drawPieces() {
    const at = positions();
    let html = '';
    const phase = currentPhase();
    if (phase && !live) {
      const from = positionsAfter(board, step - 1);
      html += phase.moves.map(mv => pieceById(mv.id) && pieceHtml(pieceById(mv.id), from.get(mv.id), { ghost: true })).filter(Boolean).join('');
    }
    html += board.pieces.map(p => pieceHtml(p, at.get(p.id) || p, { selected: isSel('piece', p.id) })).join('');
    const a = !anim && sel?.type === 'arrow' && arrowById(sel.id);
    if (a) {
      html += `<span class="handle" data-handle="start" style="left:${a.x1}%;top:${a.y1}%"></span><span class="handle" data-handle="end" style="left:${a.x2}%;top:${a.y2}%"></span>`;
      if (isCurved(a)) {
        const mid = curveMidpoint(a);
        html += `<span class="handle bend" data-handle="mid" title="Drag to change the bend" style="left:${r2(mid.x)}%;top:${r2(mid.y)}%"></span>`;
      }
    }
    pieceLayer.innerHTML = html;
  }
  function drawToolbar() {
    host.querySelectorAll('[data-field]').forEach(b => b.classList.toggle('on', b.dataset.field === board.field));
    host.querySelectorAll('[data-tool]').forEach(b => {
      b.classList.toggle('on', b.dataset.tool === tool);
      b.disabled = anim && b.dataset.tool !== 'select';
    });
    const mirror = $('[data-mirror]');
    mirror.classList.toggle('on', board.mirrored);
    mirror.setAttribute('aria-pressed', String(board.mirrored));
    $('[data-undo]').disabled = !undoStack.length;
    $('[data-redo]').disabled = !redoStack.length;
    fieldEl.classList.toggle('tool-draw', drawingTool());
    const counts = { player: 0, ball: 0, cone: 0 };
    board.pieces.forEach(p => { counts[p.kind]++; });
    $('[data-count]').textContent = `${counts.player} players · ${counts.cone} cones · ${counts.ball} ball${counts.ball === 1 ? '' : 's'} · ${board.arrows.length} arrows`;
  }
  function drawAnimBar() {
    $('[data-anim]').checked = anim;
    $('[data-steps]').hidden = !anim;
    $('[data-play-controls]').hidden = !anim;
    $('[data-suggest]').disabled = playing || !board.arrows.length;
    $('[data-play]').innerHTML = playing ? `${icons.stop} Stop` : `${icons.play} Play`;
    if (!anim) return;
    $('[data-steps]').innerHTML = `<button type="button" class="step${step === 0 ? ' on' : ''}" data-step="0">Setup</button>`
      + board.phases.map((ph, i) => `<button type="button" class="step${step === i + 1 ? ' on' : ''}" data-step="${i + 1}">Step ${i + 1}<small>${ph.moves.length}</small></button>`).join('')
      + (board.phases.length < MAX_STEPS ? '<button type="button" class="step add" data-add-step>＋ Add step</button>' : '')
      + (step > 0 && !playing ? `<button type="button" class="step remove" data-remove-step>Delete step ${step}</button>` : '');
  }
  function drawHint() {
    let hint;
    if (playing) hint = 'Playing the animation…';
    else if (!anim) hint = TOOLS.find(t => t.key === tool).hint;
    else if (step === 0) hint = 'Setup: arrange where everyone starts. Then choose a step and drag players or the ball to where they go.';
    else hint = `Step ${step}: drag players or the ball to where they move in this step. Faded markers show where they started.`;
    $('[data-hint]').textContent = hint;
  }
  function drawStatus() {
    $('[data-title]').textContent = meta.name.trim() || (meta.id ? 'Untitled drill' : 'New drill');
    const note = $('[data-dirty]');
    note.textContent = dirty ? 'Unsaved changes' : meta.id ? '✓ Saved' : '';
    note.classList.toggle('ok', !dirty);
    $('[data-save]').textContent = meta.id ? 'Save changes' : 'Save to drills';
    $('[data-save-copy]').hidden = !meta.id;
  }
  function drawInspector() {
    if (labelBefore !== null) { commit(labelBefore); labelBefore = null; }
    const p = sel?.type === 'piece' && pieceById(sel.id);
    const a = sel?.type === 'arrow' && arrowById(sel.id);
    if (!p && !a) {
      inspector.innerHTML = `<h2 class="panel-title">Selection</h2><p class="muted small" style="margin:0">Click a player, cone, ball or arrow to edit it.</p>
        <ul class="shortcuts"><li><kbd>Delete</kbd> remove the selection</li><li><kbd>Ctrl</kbd> + <kbd>D</kbd> duplicate</li><li><kbd>Ctrl</kbd> + <kbd>Z</kbd> undo · <kbd>Ctrl</kbd> + <kbd>Y</kbd> redo</li><li><kbd>Esc</kbd> back to Select</li></ul>`;
      return;
    }
    if (a) {
      const curved = isCurved(a);
      inspector.innerHTML = `<h2 class="panel-title">Arrow</h2>
        <div class="field"><span>Type</span><div class="seg small">${ARROW_KINDS.map(k => `<button type="button" class="${a.kind === k.key ? 'on' : ''}" data-arrow-kind="${k.key}">${k.label}</button>`).join('')}</div></div>
        <div class="field"><span>Shape</span><div class="seg small"><button type="button" class="${curved ? '' : 'on'}" data-shape="straight">Straight</button><button type="button" class="${curved ? 'on' : ''}" data-shape="curved">Curved</button></div></div>
        <p class="muted small" style="margin:10px 0 0">Drag the yellow handles to move either end${curved ? ', or the middle one to change the bend' : ''}. Drag the arrow itself to move it.</p>
        <div class="inspector-actions">${curved ? '<button class="btn small" type="button" data-flip-bend>Flip bend</button>' : ''}<button class="btn small" type="button" data-reverse>Reverse</button><button class="btn small danger-ghost" type="button" data-delete>${icons.trash} Delete</button></div>`;
      return;
    }
    const moved = currentPhase()?.moves.some(m => m.id === p.id);
    inspector.innerHTML = `<h2 class="panel-title">${p.kind === 'player' ? 'Player' : p.kind === 'ball' ? 'Ball' : 'Cone'}</h2>
      ${p.kind === 'player' ? `
        <label class="field"><span>Number or name</span><input class="input" data-label maxlength="16" value="${esc(p.label)}" placeholder="e.g. 7, GK, Alex"></label>
        <div class="field"><span>Team color</span><div class="swatches">${TEAM_COLORS.map(c => `<button type="button" class="swatch${c.color === p.color ? ' on' : ''}" style="--c:${c.color}" data-recolor="${c.color}" title="${c.name}" aria-label="${c.name}"></button>`).join('')}</div></div>` : ''}
      ${moved ? `<button class="btn small" type="button" data-clear-move style="margin-top:12px">Undo this step's movement</button>` : ''}
      <div class="inspector-actions"><button class="btn small" type="button" data-duplicate>Duplicate</button><button class="btn small danger-ghost" type="button" data-delete>${icons.trash} Delete</button></div>`;
  }
  function draw() {
    drawPitch();
    drawArrows();
    drawPieces();
    drawToolbar();
    drawAnimBar();
    drawHint();
    drawInspector();
    drawStatus();
  }

  // ----- board edits -----
  function nextNumber(color) {
    const used = new Set(board.pieces.filter(p => p.kind === 'player' && p.color === color).map(p => p.label));
    let n = 1;
    while (used.has(String(n))) n++;
    return String(n);
  }
  function addPiece(kind, color, at) {
    if (!['player', 'ball', 'cone'].includes(kind)) return;
    if (board.pieces.length >= MAX_ITEMS) return toast(`A board can hold up to ${MAX_ITEMS} pieces`, 'error');
    stopPlayback();
    const piece = {
      id: uid(), kind, x: r2(clamp(at.x)), y: r2(clamp(at.y)),
      color: kind === 'player' ? color : kind === 'cone' ? '#f88939' : '#f7f9f5',
      label: kind === 'player' ? nextNumber(color) : '',
    };
    sel = { type: 'piece', id: piece.id };
    edit(() => board.pieces.push(piece));
  }
  function deleteSelection() {
    if (!sel) return;
    const { type, id } = sel;
    sel = null;
    edit(() => {
      if (type === 'piece') {
        board.pieces = board.pieces.filter(p => p.id !== id);
        board.phases.forEach(ph => { ph.moves = ph.moves.filter(m => m.id !== id); });
      } else {
        board.arrows = board.arrows.filter(a => a.id !== id);
      }
    });
  }
  function duplicateSelection() {
    const p = sel?.type === 'piece' && pieceById(sel.id);
    if (!p) return;
    addPiece(p.kind, p.color, { x: p.x + 4, y: p.y + 4 });
  }
  // Move one end of a straight or curved path; a curve keeps its bend by moving its control point half as far.
  function shiftEnd(obj, xKey, yKey, x, y) {
    if (obj.cx != null && obj.cy != null) {
      obj.cx = clampControl(obj.cx + (x - obj[xKey]) / 2);
      obj.cy = clampControl(obj.cy + (y - obj[yKey]) / 2);
    }
    obj[xKey] = r2(x);
    obj[yKey] = r2(y);
  }
  function setPiecePosition(p, x, y) {
    const phase = currentPhase();
    if (!phase) { p.x = r2(x); p.y = r2(y); return; }
    const move = phase.moves.find(m => m.id === p.id);
    if (move) shiftEnd(move, 'x', 'y', x, y);
    else phase.moves.push({ id: p.id, x: r2(x), y: r2(y), type: p.kind === 'ball' ? 'pass' : 'move' });
  }
  function mirror() {
    stopPlayback();
    const flip = x => r2(100 - x);
    edit(() => {
      board.pieces.forEach(p => { p.x = flip(p.x); });
      board.arrows.forEach(a => { a.x1 = flip(a.x1); a.x2 = flip(a.x2); if (a.cx != null) a.cx = flip(a.cx); });
      board.phases.forEach(ph => ph.moves.forEach(m => { m.x = flip(m.x); if (m.cx != null) m.cx = flip(m.cx); }));
      board.mirrored = !board.mirrored;
    });
    toast(board.mirrored ? 'Drill mirrored left ↔ right' : 'Drill flipped back to the original side');
  }
  async function suggest() {
    stopPlayback();
    const result = suggestAnimation(board, uid);
    if (!result) return toast('Draw some runs, passes or dribbles first', 'error');
    if (!result.phases.length) return toast("Couldn't match the arrows to players or a ball. Start each arrow next to the player (or ball) that moves.", 'error');
    if (board.phases.some(ph => ph.moves.length) && !await confirmDialog('Replace the current animation steps with a suggested animation from your arrows?', { title: 'Replace animation?', confirmLabel: 'Replace', danger: false })) return;
    edit(() => { board.phases = result.phases; });
    anim = true;
    tool = 'select';
    sel = null;
    step = 1;
    draw();
    const skipped = result.skippedArrows ? ` ${result.skippedArrows} arrow${result.skippedArrows === 1 ? " wasn't" : "s weren't"} next to a player or the ball, so ${result.skippedArrows === 1 ? 'it was' : 'they were'} left out.` : '';
    toast(`Suggested ${result.phases.length} step${result.phases.length === 1 ? '' : 's'}. Press Play to watch, or drag pieces to adjust.${skipped}`);
  }

  // ----- pointer interaction on the board (pointer is captured by the board, so layers can redraw freely) -----
  function pointOf(e) {
    const r = fieldEl.getBoundingClientRect();
    return { x: clamp(((e.clientX - r.left) / r.width) * 100, 0.5, 99.5), y: clamp(((e.clientY - r.top) / r.height) * 100, 0.5, 99.5) };
  }
  function newArrow(start, end) {
    const kind = tool === 'curve' ? 'move' : tool;
    const a = { id: drag?.arrow?.id || uid(), kind, x1: r2(start.x), y1: r2(start.y), x2: r2(end.x), y2: r2(end.y) };
    if (tool === 'curve') {
      const c = defaultControl(a.x1, a.y1, a.x2, a.y2);
      a.cx = clampControl(c.cx);
      a.cy = clampControl(c.cy);
    }
    return a;
  }
  fieldEl.addEventListener('pointerdown', e => {
    if (playing || e.button > 0) return;
    const pt = pointOf(e);
    const pieceEl = e.target.closest('[data-piece]');
    const piece = pieceEl && pieceById(pieceEl.dataset.piece);
    const handle = e.target.closest('[data-handle]');
    const arrowEl = e.target.closest('[data-arrow]');

    if (drawingTool()) {
      const start = piece ? positions().get(piece.id) : pt;
      drag = { type: 'new-arrow', start, arrow: newArrow(start, start) };
    } else if (handle && sel?.type === 'arrow') {
      drag = { type: 'handle', end: handle.dataset.handle, id: sel.id, before: snapshot() };
    } else if (piece) {
      if (currentPhase() && piece.kind === 'cone') {
        sel = { type: 'piece', id: piece.id };
        draw();
        return toast('Cones stay in place during the animation');
      }
      const at = positions().get(piece.id);
      sel = { type: 'piece', id: piece.id };
      drag = { type: 'piece', id: piece.id, before: snapshot(), dx: at.x - pt.x, dy: at.y - pt.y };
    } else if (arrowEl) {
      sel = { type: 'arrow', id: arrowEl.dataset.arrow };
      drag = { type: 'arrow', id: sel.id, before: snapshot(), last: pt };
    } else {
      sel = null;
      draw();
      return;
    }
    drag.pointer = e.pointerId;
    fieldEl.setPointerCapture(e.pointerId);
    e.preventDefault();
    draw();
  });
  fieldEl.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const pt = pointOf(e);
    if (drag.type === 'new-arrow') {
      drag.arrow = newArrow(drag.start, pt);
      return drawArrows();
    }
    if (drag.type === 'piece') {
      setPiecePosition(pieceById(drag.id), clamp(pt.x + drag.dx), clamp(pt.y + drag.dy));
    } else if (drag.type === 'handle') {
      const a = arrowById(drag.id);
      if (drag.end === 'start') shiftEnd(a, 'x1', 'y1', pt.x, pt.y);
      else if (drag.end === 'end') shiftEnd(a, 'x2', 'y2', pt.x, pt.y);
      else {
        const c = controlThrough(a, pt.x, pt.y);
        a.cx = clampControl(c.cx);
        a.cy = clampControl(c.cy);
      }
    } else if (drag.type === 'arrow') {
      const a = arrowById(drag.id);
      const dx = Math.max(0.5 - Math.min(a.x1, a.x2), Math.min(99.5 - Math.max(a.x1, a.x2), pt.x - drag.last.x));
      const dy = Math.max(0.5 - Math.min(a.y1, a.y2), Math.min(99.5 - Math.max(a.y1, a.y2), pt.y - drag.last.y));
      Object.assign(a, { x1: r2(a.x1 + dx), y1: r2(a.y1 + dy), x2: r2(a.x2 + dx), y2: r2(a.y2 + dy) });
      if (isCurved(a)) Object.assign(a, { cx: clampControl(a.cx + dx), cy: clampControl(a.cy + dy) });
      drag.last = pt;
    }
    drawArrows();
    drawPieces();
  });
  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointer) return;
    const finished = drag;
    drag = null;
    if (finished.type === 'new-arrow') {
      const a = finished.arrow;
      if (Math.hypot((a.x2 - a.x1) * ASPECT, a.y2 - a.y1) < 3) return draw();
      if (board.arrows.length >= MAX_ITEMS) return toast(`A board can hold up to ${MAX_ITEMS} arrows`, 'error');
      edit(() => board.arrows.push(a));
      return;
    }
    commit(finished.before);
    draw();
  }
  fieldEl.addEventListener('pointerup', endDrag);
  fieldEl.addEventListener('pointercancel', endDrag);

  // Drag from the palette onto the board.
  host.querySelector('.wb-side').addEventListener('dragstart', e => {
    const item = e.target.closest('[data-add]');
    if (!item) return;
    e.dataTransfer.setData('text/x-piece', JSON.stringify({ kind: item.dataset.add, color: item.dataset.color || '' }));
    e.dataTransfer.effectAllowed = 'copy';
  });
  fieldEl.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/x-piece')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  fieldEl.addEventListener('drop', e => {
    const raw = e.dataTransfer.getData('text/x-piece');
    if (!raw) return;
    e.preventDefault();
    const { kind, color } = JSON.parse(raw);
    addPiece(kind, color, pointOf(e));
  });

  // ----- sidebar controls -----
  host.querySelector('.wb-side').addEventListener('click', e => {
    const add = e.target.closest('[data-add]');
    if (add) return addPiece(add.dataset.add, add.dataset.color, { x: 50 + (Math.random() - 0.5) * 16, y: 50 + (Math.random() - 0.5) * 16 });
    if (e.target.closest('[data-delete]')) return deleteSelection();
    if (e.target.closest('[data-duplicate]')) return duplicateSelection();
    const recolor = e.target.closest('[data-recolor]');
    if (recolor) return edit(() => { pieceById(sel.id).color = recolor.dataset.recolor; });
    const kind = e.target.closest('[data-arrow-kind]');
    if (kind) return edit(() => { arrowById(sel.id).kind = kind.dataset.arrowKind; });
    const shape = e.target.closest('[data-shape]');
    if (shape) {
      return edit(() => {
        const a = arrowById(sel.id);
        if (shape.dataset.shape === 'straight') { delete a.cx; delete a.cy; return; }
        if (isCurved(a)) return;
        const c = defaultControl(a.x1, a.y1, a.x2, a.y2);
        a.cx = clampControl(c.cx);
        a.cy = clampControl(c.cy);
      });
    }
    if (e.target.closest('[data-flip-bend]')) {
      return edit(() => {
        const a = arrowById(sel.id);
        a.cx = clampControl(a.x1 + a.x2 - a.cx);   // reflect the control point through the chord's midpoint
        a.cy = clampControl(a.y1 + a.y2 - a.cy);
      });
    }
    if (e.target.closest('[data-reverse]')) {
      return edit(() => { const a = arrowById(sel.id); [a.x1, a.y1, a.x2, a.y2] = [a.x2, a.y2, a.x1, a.y1]; });
    }
    if (e.target.closest('[data-clear-move]')) {
      return edit(() => { const ph = currentPhase(); ph.moves = ph.moves.filter(m => m.id !== sel.id); });
    }
    if (e.target.closest('[data-save-copy]')) saveDrill(true);
  });
  inspector.addEventListener('focusin', e => { if (e.target.matches('[data-label]')) labelBefore = snapshot(); });
  inspector.addEventListener('input', e => {
    if (!e.target.matches('[data-label]')) return;
    const p = sel && pieceById(sel.id);
    if (!p) return;
    p.label = e.target.value.slice(0, 16);
    drawPieces();
  });
  inspector.addEventListener('change', e => {
    if (e.target.matches('[data-label]') && labelBefore !== null) { commit(labelBefore); labelBefore = null; drawToolbar(); }
  });
  inspector.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-label]')) e.target.blur(); });

  host.querySelectorAll('[data-meta]').forEach(input => input.addEventListener('input', () => {
    meta[input.dataset.meta] = input.value;
    markDirty();
  }));

  // ----- categories -----
  const picker = $('[data-cat-picker]');
  function drawCategories() {
    const chosen = new Set(meta.categories.map(c => c.toLowerCase()));
    const names = [...categories.map(c => c.name), ...meta.categories.filter(l => !categories.some(c => c.name.toLowerCase() === l.toLowerCase()))];
    picker.innerHTML = names.map(n => {
      const on = chosen.has(n.toLowerCase());
      return `<button type="button" class="chip${on ? ' on' : ''}" data-pick="${esc(n)}" aria-pressed="${on}">${on ? '✓ ' : ''}${esc(n)}</button>`;
    }).join('') + '<button type="button" class="chip add" data-new-cat>＋ New</button>';
  }
  picker.addEventListener('click', e => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const name = pick.dataset.pick;
      const had = meta.categories.some(c => c.toLowerCase() === name.toLowerCase());
      meta.categories = had ? meta.categories.filter(c => c.toLowerCase() !== name.toLowerCase()) : [...meta.categories, name];
      markDirty();
      return drawCategories();
    }
    if (e.target.closest('[data-new-cat]')) {
      newCategoryModal(created => {
        categories.push(created);
        meta.categories = [...meta.categories, created.name];
        markDirty();
        drawCategories();
      });
    }
  });
  categoriesLoaded.then(drawCategories);

  $('[data-fields]').addEventListener('click', e => {
    const b = e.target.closest('[data-field]');
    if (b && b.dataset.field !== board.field) edit(() => { board.field = b.dataset.field; });
  });
  $('[data-mirror]').addEventListener('click', mirror);
  $('[data-tools]').addEventListener('click', e => {
    const b = e.target.closest('[data-tool]');
    if (!b || b.disabled) return;
    tool = b.dataset.tool;
    if (tool !== 'select') sel = null;
    draw();
  });
  $('[data-undo]').addEventListener('click', undo);
  $('[data-redo]').addEventListener('click', redo);
  $('[data-clear]').addEventListener('click', async () => {
    if (!board.pieces.length && !board.arrows.length) return;
    if (!await confirmDialog('Remove every player, cone, ball, arrow and animation step from this board?', { title: 'Clear the board?', confirmLabel: 'Clear board' })) return;
    stopPlayback();
    sel = null;
    step = 0;
    edit(() => { board.pieces = []; board.arrows = []; board.phases = []; board.mirrored = false; });
  });
  $('[data-new]').addEventListener('click', () => go('/coach/whiteboard?new=1'));
  $('[data-save]').addEventListener('click', () => saveDrill(false));
  $('[data-present]').addEventListener('click', () => {
    stopPlayback();
    draw();
    presentDrill({ ...meta, board: structuredClone(board) }, { mode: anim ? 'anim' : 'board' });
  });

  // ----- animation -----
  $('[data-anim]').addEventListener('change', e => {
    stopPlayback();
    anim = e.target.checked;
    tool = 'select';
    sel = null;
    if (anim && !board.phases.length) edit(() => board.phases.push({ id: uid(), moves: [] }));
    step = anim ? Math.min(1, board.phases.length) : 0;
    draw();
  });
  $('[data-suggest]').addEventListener('click', suggest);
  $('[data-steps]').addEventListener('click', e => {
    if (playing) return;
    const pick = e.target.closest('[data-step]');
    if (pick) { step = Number(pick.dataset.step); sel = null; return draw(); }
    if (e.target.closest('[data-add-step]')) {
      edit(() => board.phases.push({ id: uid(), moves: [] }));
      step = board.phases.length;
      return draw();
    }
    if (e.target.closest('[data-remove-step]') && step > 0) {
      const index = step - 1;
      step = Math.max(0, step - 1);
      edit(() => board.phases.splice(index, 1));
    }
  });
  $('[data-speed]').addEventListener('change', e => { speed = e.target.value; });
  $('[data-play]').addEventListener('click', play);

  function stopPlayback() {
    if (!playing && !live) return;
    playToken++;
    playing = false;
    live = null;
  }
  async function play() {
    if (playing) { stopPlayback(); return draw(); }
    if (!board.phases.some(ph => ph.moves.length)) return toast('Pick a step and drag a player or the ball first', 'error');
    const token = ++playToken;
    playing = true;
    sel = null;
    step = 0;
    draw();
    for (let k = 1; k <= board.phases.length; k++) {
      step = k;
      drawAnimBar();
      const started = performance.now();
      for (;;) {
        if (token !== playToken) return;
        const t = Math.min(1, (performance.now() - started) / SPEEDS[speed]);
        live = positionsDuring(board, k, t);
        drawArrows();
        drawPieces();
        if (t >= 1) break;
        await new Promise(resolve => setTimeout(resolve, 16));   // ~60 fps; keeps going even if paint frames are throttled
      }
    }
    if (token === playToken) {
      playing = false;
      live = null;
      draw();
    }
  }

  // ----- saving -----
  async function saveDrill(asNew) {
    const name = meta.name.trim();
    if (!name) {
      $('[data-meta=name]').focus();
      return toast('Give the drill a name first', 'error');
    }
    const minutes = Math.max(1, Math.min(180, Math.round(Number(meta.minutes)) || 15));
    const body = { name, categories: meta.categories, minutes, notes: meta.notes, board };
    const creating = asNew || !meta.id;
    try {
      const saved = creating ? await api.post('/api/drills', { ...body, name: asNew ? `${name} (copy)`.slice(0, 70) : name }) : await api.put(`/api/drills/${meta.id}`, body);
      meta = { id: saved.id, name: saved.name, categories: labelsOf(saved), minutes: saved.minutes, notes: saved.notes };
      drawCategories();
      host.querySelectorAll('[data-meta]').forEach(input => { input.value = meta[input.dataset.meta]; });
      dirty = false;
      persist();
      replacePath(`/coach/whiteboard/${saved.id}`);
      drawStatus();
      toast(asNew ? 'Saved as a new drill' : creating ? 'Drill saved to your library' : 'Drill updated');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ----- keyboard -----
  function onKey(e) {
    if (!host.isConnected || e.target.closest?.('input, textarea, select') || document.querySelector('dialog[open], .present')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && key === 'y') { e.preventDefault(); redo(); }
    else if (mod && key === 'd') { e.preventDefault(); duplicateSelection(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); deleteSelection(); }
    else if (e.key === 'Escape') { tool = 'select'; sel = null; draw(); }
  }
  document.addEventListener('keydown', onKey);

  persist();   // the sidebar's Whiteboard link reopens whatever board was open last
  draw();
  return () => {
    stopPlayback();
    document.removeEventListener('keydown', onKey);
  };
}
