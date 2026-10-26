// Presentation mode: a drill fills the screen, PowerPoint style, as a diagram or as an animation.
// Keys: → / Enter / click = next step · ← = back · Space = play all · Home = restart
//       W = whiteboard · A = animation · N = notes · Esc = exit
import { esc, icons } from './ui.js';
import { arrowSvg, pieceHtml, pitchSvg, positionsAfter, positionsDuring, surfaceOf, trailSvg } from './field.js';

const SPEEDS = { slow: 1900, normal: 1200, fast: 650 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function presentDrill(drill, { mode = 'board' } = {}) {
  const board = { ...drill.board, phases: (drill.board.phases || []).filter(ph => ph.moves?.length) };
  const total = board.phases.length;
  if (!total) mode = 'board';
  const surface = surfaceOf(board.field);
  let done = 0, current = 0, playing = false, token = 0, live = null, speed = 'normal', showNotes = false;

  const overlay = document.createElement('div');
  overlay.className = 'present';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `Presenting ${drill.name || 'drill'}`);
  overlay.innerHTML = `
    <header class="present-bar">
      <div class="present-title"><strong>${esc(drill.name || 'Untitled drill')}</strong><span>${esc([...(drill.categories || []), drill.minutes ? `${drill.minutes} min` : ''].filter(Boolean).join(' · '))}</span></div>
      <div class="seg present-seg" role="group" aria-label="View">
        <button type="button" data-mode="board">Whiteboard</button>
        <button type="button" data-mode="anim" ${total ? '' : 'disabled title="This drill has no animation yet"'}>Animation</button>
      </div>
      <div class="present-actions">
        <button type="button" class="present-btn" data-notes aria-pressed="false">Notes</button>
        <button type="button" class="present-btn" data-close>✕ Exit</button>
      </div>
    </header>
    <main class="present-stage">
      <div class="board present-board ${board.field === 'blank' ? 'blank' : ''}">
        <div class="layer layer-pitch">${pitchSvg(board.field)}</div>
        <svg class="layer layer-arrows" viewBox="0 0 148 100" preserveAspectRatio="none"></svg>
        <div class="layer layer-pieces"></div>
      </div>
      <aside class="present-notes" hidden><h3>Coaching notes</h3><p>${esc(drill.notes || 'No coaching notes for this drill.')}</p></aside>
    </main>
    <footer class="present-controls"></footer>`;
  document.body.append(overlay);
  document.body.style.overflow = 'hidden';

  const stage = overlay.querySelector('.present-stage');
  const arrowsEl = overlay.querySelector('.layer-arrows');
  const piecesEl = overlay.querySelector('.layer-pieces');
  const controls = overlay.querySelector('.present-controls');

  function render() {
    let positions, svg = '';
    if (mode === 'board') {
      positions = positionsAfter(board, 0);
      svg = (board.arrows || []).map(a => arrowSvg(a, surface)).join('');
    } else {
      positions = live || positionsAfter(board, done);
      if (!live && done < total) {           // preview the paths of the step that comes next
        const from = positionsAfter(board, done);
        svg = board.phases[done].moves.map(mv => (from.get(mv.id) ? trailSvg(mv, from.get(mv.id), surface) : '')).join('');
      }
    }
    arrowsEl.innerHTML = svg;
    piecesEl.innerHTML = board.pieces.map(p => pieceHtml(p, positions.get(p.id) || p, { interactive: false })).join('');
    drawControls();
  }

  function drawControls() {
    overlay.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    if (mode === 'board') {
      controls.innerHTML = `<span class="present-hint">${total ? 'Press <kbd>A</kbd> to animate · ' : ''}<kbd>N</kbd> notes · <kbd>Esc</kbd> exit</span>`;
      return;
    }
    const label = playing ? `Step ${current} of ${total}` : done === 0 ? 'Starting positions' : `Step ${done} of ${total}`;
    controls.innerHTML = `
      <button type="button" class="present-btn" data-restart title="Restart (Home)">⏮</button>
      <button type="button" class="present-btn" data-prev title="Back (←)" ${done === 0 && !playing ? 'disabled' : ''}>◀ Back</button>
      <button type="button" class="present-btn primary" data-play title="Play all (Space)">${playing ? `${icons.stop} Pause` : `${icons.play} ${done >= total ? 'Replay' : 'Play all'}`}</button>
      <button type="button" class="present-btn" data-next title="Next step (→)" ${done >= total || playing ? 'disabled' : ''}>Next ▶</button>
      <span class="step-dots" aria-label="${label}">${Array.from({ length: total }, (_, i) => `<i class="${i < (playing ? current : done) ? 'on' : ''}"></i>`).join('')}</span>
      <span class="present-hint">${label}</span>
      <select class="present-speed" data-speed aria-label="Speed">${Object.keys(SPEEDS).map(s => `<option value="${s}" ${s === speed ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>`;
  }

  async function animateStep(k, myToken) {
    current = k;
    const started = performance.now();
    for (;;) {
      if (myToken !== token) return false;
      const t = Math.min(1, (performance.now() - started) / SPEEDS[speed]);
      live = positionsDuring(board, k, t);
      render();
      if (t >= 1) break;
      await sleep(16);
    }
    live = null;
    done = k;
    return true;
  }
  async function next() {
    if (mode !== 'anim' || playing || done >= total) return;
    playing = true;
    const myToken = ++token;
    await animateStep(done + 1, myToken);
    if (myToken === token) { playing = false; render(); }
  }
  async function playAll() {
    if (mode !== 'anim') return;
    if (playing) return pause();
    if (done >= total) done = 0;
    playing = true;
    const myToken = ++token;
    while (done < total) {
      if (!await animateStep(done + 1, myToken)) return;
      if (done < total) { render(); await sleep(350); }
    }
    if (myToken === token) { playing = false; render(); }
  }
  function pause() {
    token++;
    if (live) done = current;      // finish the interrupted step where it was heading
    live = null;
    playing = false;
    render();
  }
  function back() { pause(); done = Math.max(0, done - 1); render(); }
  function restart() { pause(); done = 0; render(); }
  function setMode(m) {
    if (m === 'anim' && !total) return;
    pause();
    mode = m;
    if (m === 'anim') done = 0;
    render();
  }
  function toggleNotes() {
    showNotes = !showNotes;
    overlay.querySelector('.present-notes').hidden = !showNotes;
    stage.classList.toggle('with-notes', showNotes);
    overlay.querySelector('[data-notes]').setAttribute('aria-pressed', String(showNotes));
  }

  overlay.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) return close();
    const m = e.target.closest('[data-mode]');
    if (m) return setMode(m.dataset.mode);
    if (e.target.closest('[data-notes]')) return toggleNotes();
    if (e.target.closest('[data-play]')) return playAll();
    if (e.target.closest('[data-next]')) return next();
    if (e.target.closest('[data-prev]')) return back();
    if (e.target.closest('[data-restart]')) return restart();
    if (e.target.closest('.present-board') && mode === 'anim') next();   // click the field to advance, like a slide
  });
  overlay.addEventListener('change', e => { if (e.target.matches('[data-speed]')) speed = e.target.value; });

  function onKey(e) {
    if (e.target.closest?.('select')) return;
    const handled = {
      Escape: close, ArrowRight: next, PageDown: next, Enter: next, ArrowLeft: back, PageUp: back,
      ' ': playAll, Home: restart, n: toggleNotes, N: toggleNotes,
      a: () => setMode('anim'), A: () => setMode('anim'), w: () => setMode('board'), W: () => setMode('board'),
    }[e.key];
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    handled();
  }
  window.addEventListener('keydown', onKey, true);

  // Full screen when the browser allows it; otherwise the overlay still covers the window.
  let wentFullscreen = false;
  function onFullscreenChange() {
    if (document.fullscreenElement === overlay) wentFullscreen = true;
    else if (wentFullscreen) close();
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  overlay.requestFullscreen?.().catch(() => {});

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    token++;
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    if (document.fullscreenElement === overlay) document.exitFullscreen().catch(() => {});
    overlay.remove();
    document.body.style.overflow = '';
  }

  render();
  overlay.querySelector('[data-close]').focus();
  return close;
}
