// Drawing the soccer field, players, equipment and arrows. Board coordinates are percentages (0–100).
// An arrow or animation move with a control point (cx, cy) is a curve (a quadratic Bézier).
import { esc } from './ui.js';

export const ASPECT = 1.48;              // field width / height
const VIEW_W = 100 * ASPECT;              // arrow layer viewBox is VIEW_W × 100, so arrowheads are not stretched

export const TEAM_COLORS = [
  { name: 'White', color: '#f7f9f5' },
  { name: 'Gold', color: '#e8b34c' },
  { name: 'Blue', color: '#304dbe' },
  { name: 'Red', color: '#e55c4b' },
];
export const ARROW_KINDS = [
  { key: 'move', label: 'Run' },
  { key: 'pass', label: 'Pass' },
  { key: 'dribble', label: 'Dribble' },
];
const ARROW_COLORS = {
  grass: { move: '#ffffff', pass: '#ffd76a', dribble: '#ffffff' },
  blank: { move: '#1f3a30', pass: '#c2410c', dribble: '#1f3a30' },
};

export const surfaceOf = field => (field === 'blank' ? 'blank' : 'grass');
export const isCurved = a => a.cx != null && a.cy != null;
export const ease = t => t * t * (3 - 2 * t);

/** Where every piece stands after the first `k` animation steps (k = 0 is the setup). */
export function positionsAfter(board, k) {
  const at = new Map(board.pieces.map(p => [p.id, { x: p.x, y: p.y }]));
  for (let i = 0; i < k; i++) {
    for (const mv of board.phases[i]?.moves || []) if (at.has(mv.id)) at.set(mv.id, { x: mv.x, y: mv.y });
  }
  return at;
}

/** A point `t` (0–1) of the way along a straight or curved path. */
export function pointOnPath(x1, y1, x2, y2, t, cx, cy) {
  if (cx == null || cy == null) return { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t };
  const u = 1 - t;
  return { x: u * u * x1 + 2 * u * t * cx + t * t * x2, y: u * u * y1 + 2 * u * t * cy + t * t * y2 };
}

/** Positions part-way (t = 0–1) through step k (1-based). Curved moves follow their curve. */
export function positionsDuring(board, k, t) {
  const from = positionsAfter(board, k - 1);
  const at = new Map(from);
  const e = ease(t);
  for (const mv of board.phases[k - 1]?.moves || []) {
    const f = from.get(mv.id);
    if (f) at.set(mv.id, pointOnPath(f.x, f.y, mv.x, mv.y, e, mv.cx, mv.cy));
  }
  return at;
}

/** Control point for a new curve: bowed out to one side by about a third of its length. */
export function defaultControl(x1, y1, x2, y2, side = 1) {
  const dx = (x2 - x1) * ASPECT, dy = y2 - y1;   // measured in on-screen proportions
  const k = 0.32 * side;
  return { cx: (x1 + x2) / 2 - (dy * k) / ASPECT, cy: (y1 + y2) / 2 + dx * k };
}
/** The point halfway along a curve, where its drag handle sits. */
export const curveMidpoint = a => pointOnPath(a.x1, a.y1, a.x2, a.y2, 0.5, a.cx, a.cy);
/** The control point that makes a curve pass through (mx, my) halfway along. */
export const controlThrough = (a, mx, my) => ({ cx: 2 * mx - (a.x1 + a.x2) / 2, cy: 2 * my - (a.y1 + a.y2) / 2 });

let patternSeq = 0;
export function pitchSvg(type) {
  if (type === 'blank') {
    const id = `dots${++patternSeq}`;
    return `<svg viewBox="0 0 900 610" preserveAspectRatio="none" aria-hidden="true"><defs><pattern id="${id}" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="14" cy="14" r=".8" fill="#c9d7cb"/></pattern></defs><rect width="900" height="610" fill="url(#${id})"/></svg>`;
  }
  const stripes = Array.from({ length: 8 }, (_, i) => `<rect x="${i * 112.5}" width="112.5" height="610" fill="${i % 2 ? '#ffffff06' : '#00000007'}"/>`).join('');
  const lines = type === 'half'
    ? '<rect x="28" y="27" width="844" height="556"/><rect x="275" y="27" width="350" height="152"/><rect x="350" y="27" width="200" height="65"/><circle cx="450" cy="121" r="4" fill="#f5fff0"/><path d="M367 179A83 83 0 0 0 533 179"/><path d="M370 583A80 80 0 0 1 530 583"/><path d="M405 27V14h90v13" stroke-width="4"/>'
    : '<rect x="28" y="27" width="844" height="556"/><path d="M450 27V583"/><circle cx="450" cy="305" r="85"/><circle cx="450" cy="305" r="4" fill="#f5fff0"/><rect x="28" y="157" width="125" height="296"/><rect x="747" y="157" width="125" height="296"/><rect x="28" y="222" width="53" height="166"/><rect x="819" y="222" width="53" height="166"/><circle cx="112" cy="305" r="4" fill="#f5fff0"/><circle cx="788" cy="305" r="4" fill="#f5fff0"/><path d="M153 238A78 78 0 0 1 153 372M747 238A78 78 0 0 0 747 372"/><path d="M28 48A21 21 0 0 0 49 27M851 27A21 21 0 0 0 872 48M28 562A21 21 0 0 1 49 583M851 583A21 21 0 0 1 872 562"/><path d="M28 265H16v80h12M872 265h12v80h-12" stroke-width="4"/>';
  return `<svg viewBox="0 0 900 610" preserveAspectRatio="none" aria-hidden="true"><rect width="900" height="610" fill="#43866c"/>${stripes}<g stroke="#f5fff0" stroke-width="3" fill="none" opacity=".82">${lines}</g></svg>`;
}

const f2 = n => Math.round(n * 100) / 100;

// The arrow's path as a function of t, in viewBox units.
function pathFn(a) {
  const x1 = a.x1 * ASPECT, x2 = a.x2 * ASPECT;
  if (!isCurved(a)) return t => ({ x: x1 + (x2 - x1) * t, y: a.y1 + (a.y2 - a.y1) * t });
  const cx = a.cx * ASPECT;
  return t => { const u = 1 - t; return { x: u * u * x1 + 2 * u * t * cx + t * t * x2, y: u * u * a.y1 + 2 * u * t * a.cy + t * t * a.y2 }; };
}

// A wave that follows the arrow's (possibly curved) path, with a straight tail so the arrowhead lines up.
function wavyPath(fn) {
  const N = 60;
  const pts = Array.from({ length: N + 1 }, (_, i) => fn(i / N));
  const cum = [0];
  for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const len = cum[N];
  if (len < 5) return `M${f2(pts[0].x)} ${f2(pts[0].y)}L${f2(pts[N].x)} ${f2(pts[N].y)}`;
  const waveLen = len - 3.5;
  const steps = Math.max(12, Math.round(waveLen / 0.6));
  let d = `M${f2(pts[0].x)} ${f2(pts[0].y)}`;
  let i = 1;
  for (let s = 1; s <= steps; s++) {
    const dist = (s / steps) * waveLen;
    while (i < N && cum[i] < dist) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const k = (dist - cum[i - 1]) / seg;
    const tx = pts[i].x - pts[i - 1].x, ty = pts[i].y - pts[i - 1].y, tl = Math.hypot(tx, ty) || 1;
    const off = Math.sin((dist / 3.4) * Math.PI * 2) * 1.15;
    d += `L${f2(pts[i - 1].x + tx * k - (ty / tl) * off)} ${f2(pts[i - 1].y + ty * k + (tx / tl) * off)}`;
  }
  return d + `L${f2(pts[N].x)} ${f2(pts[N].y)}`;
}

function arrowPath(a) {
  if (a.kind === 'dribble') return wavyPath(pathFn(a));
  const start = `M${f2(a.x1 * ASPECT)} ${f2(a.y1)}`;
  return isCurved(a)
    ? `${start}Q${f2(a.cx * ASPECT)} ${f2(a.cy)} ${f2(a.x2 * ASPECT)} ${f2(a.y2)}`
    : `${start}L${f2(a.x2 * ASPECT)} ${f2(a.y2)}`;
}

export function arrowSvg(a, surface, { selected = false, hit = false, trail = false } = {}) {
  const kind = ARROW_COLORS[surface][a.kind] ? a.kind : 'move';
  const d = arrowPath({ ...a, kind });
  const dash = kind === 'pass' ? ' stroke-dasharray="1.6 1.2"' : '';
  return `<g class="arrow${trail ? ' trail' : ''}">`
    + (selected ? `<path d="${d}" class="arrow-glow"/>` : '')
    + `<path d="${d}" fill="none" stroke="${ARROW_COLORS[surface][kind]}" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round"${dash} marker-end="url(#head-${surface}-${kind})"/>`
    + (hit ? `<path d="${d}" class="hit" data-arrow="${esc(a.id)}"/>` : '')
    + '</g>';
}

/** The path a piece travels in an animation step, drawn like an arrow. */
export function trailSvg(mv, from, surface) {
  return arrowSvg({ id: mv.id, kind: mv.type === 'pass' ? 'pass' : 'move', x1: from.x, y1: from.y, x2: mv.x, y2: mv.y, cx: mv.cx, cy: mv.cy }, surface, { trail: true });
}

export function arrowLayer(arrows, surface, opts) {
  return `<svg viewBox="0 0 ${VIEW_W} 100" preserveAspectRatio="none" aria-hidden="true">${arrows.map(a => arrowSvg(a, surface, opts)).join('')}</svg>`;
}

const BALL = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.6" fill="#fff" stroke="#1d2b25" stroke-width="1.5"/><path d="M12 7.3l3.5 2.6-1.3 4.1H9.8L8.5 9.9z" fill="#1d2b25"/><path d="M12 7.3V2.4M15.5 9.9l4.6-1.5M14.2 14l2.9 3.9M9.8 14l-2.9 3.9M8.5 9.9 3.9 8.4" stroke="#1d2b25" stroke-width="1.2" fill="none"/></svg>';

function textOn(hex) {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 165 ? '#1d3329' : '#ffffff';
}

export function tokenHtml(p) {
  if (p.kind === 'player') return `<span class="tok-player" style="--c:${esc(p.color)};--t:${textOn(p.color)}">${esc(p.label)}</span>`;
  if (p.kind === 'ball') return `<span class="tok-ball">${BALL}</span>`;
  return '<span class="tok-cone"></span>';
}

export function pieceHtml(p, at = p, { selected = false, ghost = false, interactive = true } = {}) {
  const cls = `pc pc-${p.kind}${selected ? ' sel' : ''}${ghost ? ' ghost' : ''}`;
  const data = interactive && !ghost ? ` data-piece="${esc(p.id)}"` : '';
  return `<div class="${cls}"${data} style="left:${f2(at.x)}%;top:${f2(at.y)}%">${tokenHtml(p)}</div>`;
}

/** A static, non-interactive picture of a board (library cards, practice plans, previews). */
export function boardThumb(board, { mini = false } = {}) {
  const b = board || {};
  const field = b.field || 'full';
  const surface = surfaceOf(field);
  return `<div class="board-thumb ${surface}${mini ? ' mini' : ''}">${pitchSvg(field)}${arrowLayer(b.arrows || [], surface)}${(b.pieces || []).map(p => pieceHtml(p, p, { interactive: false })).join('')}</div>`;
}
