// Turns a drawn whiteboard (players, ball and arrows) into a suggested step-by-step animation.
//
// How it reads the drawing:
// - Runs and dribbles belong to the player standing at the arrow's start. A run that starts where
//   that player's previous run ended is their next run.
// - The ball's story is followed pass by pass: each pass or dribble that starts where the ball is
//   becomes the next step. Those steps set the rhythm of the animation.
// - A run that ends where a pass ends is a run to receive it, so both happen in the same step.
// - A run by the player who just passed happens in the step after the pass ("pass and move").
// - Any other run happens in the first step (pressing, supporting runs, warm-up lines).
import { ASPECT } from './field.js';

const NEAR = 10;   // how close (in on-screen units, ~7% of the board width) counts as "at" a spot
const dist = (a, b) => Math.hypot((a.x - b.x) * ASPECT, a.y - b.y);
const startOf = a => ({ x: a.x1, y: a.y1 });
const endOf = a => ({ x: a.x2, y: a.y2 });
const r2 = n => Math.round(n * 100) / 100;
const curve = a => (a.cx != null && a.cy != null ? { cx: a.cx, cy: a.cy } : {});

/**
 * Returns { phases, usedArrows, skippedArrows } or null if there is nothing to animate.
 * `phases` has the same shape as board.phases: [{ id, moves: [{ id, x, y, type, cx?, cy? }] }].
 */
export function suggestAnimation(board, makeId) {
  const players = board.pieces.filter(p => p.kind === 'player');
  const balls = board.pieces.filter(p => p.kind === 'ball');
  const arrows = board.arrows;
  if (!arrows.length) return null;

  // 1) Which player makes each run or dribble? Players collect "spots" (where they stand, then where
  //    each of their runs ends) so chained runs are matched to the same player.
  const spots = new Map(players.map(p => [p.id, [{ x: p.x, y: p.y }]]));
  const owner = new Map();     // arrow id -> { playerId, seq }
  let pending = arrows.filter(a => a.kind !== 'pass');
  // Match arrows that start right next to a player first; then, for arrows drawn a little away from
  // anyone, accept the closest player who doesn't already have a run within twice that distance.
  for (const radius of [NEAR, NEAR * 2]) {
    while (pending.length) {
      const unmatched = [];
      for (const a of pending) {
        let best = null, bestDist = radius;
        for (const p of players) {
          if (radius > NEAR && spots.get(p.id).length > 1) continue;
          for (const spot of spots.get(p.id)) {
            const d = dist(spot, startOf(a));
            if (d < bestDist) { bestDist = d; best = p; }
          }
        }
        if (best) {
          owner.set(a.id, { playerId: best.id, seq: spots.get(best.id).length });
          spots.get(best.id).push(endOf(a));
        } else unmatched.push(a);
      }
      if (unmatched.length === pending.length) break;
      pending = unmatched;
    }
  }
  const nearestPlayer = point => {
    let best = null, bestDist = NEAR;
    for (const p of players) for (const spot of spots.get(p.id)) {
      const d = dist(spot, point);
      if (d < bestDist) { bestDist = d; best = p.id; }
    }
    return best;
  };

  // 2) Follow each ball from arrow to arrow.
  const ballActions = [];      // { arrow, ballId, step, passer }
  const used = new Set();
  for (const ball of balls) {
    let at = { x: ball.x, y: ball.y };
    for (let step = 0; ; step++) {
      let best = null, bestDist = NEAR;
      for (const a of arrows) {
        if (used.has(a.id) || a.kind === 'move') continue;
        if (a.kind === 'dribble' && !owner.has(a.id)) continue;
        const d = dist(at, startOf(a));
        if (d < bestDist) { bestDist = d; best = a; }
      }
      if (!best) break;
      used.add(best.id);
      ballActions.push({ arrow: best, ballId: ball.id, step, passer: owner.get(best.id)?.playerId ?? nearestPlayer(startOf(best)) });
      at = endOf(best);
    }
  }

  // 3) Lay moves out into steps, never giving one piece two moves in the same step.
  const steps = [];
  const place = (pieceId, step, move) => {
    while ((steps[step] ||= new Map()).has(pieceId)) step++;
    steps[step].set(pieceId, { id: pieceId, ...move });
    return step;
  };
  const lastStepOf = new Map();   // player id -> step of their latest move (keeps chained runs in order)

  for (const act of ballActions) {
    const a = act.arrow;
    if (a.kind === 'pass') {
      place(act.ballId, act.step, { x: r2(a.x2), y: r2(a.y2), type: 'pass', ...curve(a) });
    } else {
      // Dribble: the player and ball travel together, with the ball just ahead of the player's feet.
      const len = dist(startOf(a), endOf(a)) || 1;
      const ux = ((a.x2 - a.x1) * ASPECT) / len, uy = (a.y2 - a.y1) / len;
      const s = place(owner.get(a.id).playerId, act.step, { x: r2(a.x2), y: r2(a.y2), type: 'move', ...curve(a) });
      place(act.ballId, s, { x: r2(Math.min(99, Math.max(1, a.x2 + (ux * 1.6) / ASPECT))), y: r2(Math.min(99, Math.max(1, a.y2 + uy * 1.6))), type: 'move', ...curve(a) });
      lastStepOf.set(owner.get(a.id).playerId, s);
    }
  }

  // Runs, plus any dribble drawn away from the ball (the player still moves).
  const runs = arrows
    .filter(a => owner.has(a.id) && (a.kind === 'move' || (a.kind === 'dribble' && !used.has(a.id))))
    .sort((x, y) => owner.get(x.id).seq - owner.get(y.id).seq);
  for (const run of runs) {
    const { playerId } = owner.get(run.id);
    const receiving = ballActions.find(act => act.passer !== playerId && dist(endOf(act.arrow), endOf(run)) < NEAR);
    const ownPass = ballActions.find(act => act.passer === playerId && act.arrow.kind === 'pass');
    let step = receiving ? receiving.step : ownPass ? ownPass.step + 1 : 0;
    if (lastStepOf.has(playerId)) step = Math.max(step, lastStepOf.get(playerId) + 1);
    lastStepOf.set(playerId, place(playerId, step, { x: r2(run.x2), y: r2(run.y2), type: 'move', ...curve(run) }));
    used.add(run.id);
  }

  const phases = steps.filter(s => s && s.size).map(s => ({ id: makeId(), moves: [...s.values()] }));
  if (!phases.length) return { phases, usedArrows: 0, skippedArrows: arrows.length };
  return { phases, usedArrows: used.size, skippedArrows: arrows.length - used.size };
}
