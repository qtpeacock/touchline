// Attendance: who is coming to each practice and game. Used by the roster grid, the event dialog,
// the practices page and the AI practice builder. A missing reply is "no reply".
import { api } from './api.js';
import { esc, toast } from './ui.js';

export const REPLIES = {
  yes: { label: 'Yes', mark: '✓' },
  maybe: { label: 'Maybe', mark: '?' },
  no: { label: 'No', mark: '✕' },
};
export const TRAVEL = { driving: 'Driving', need_ride: 'Needs a ride', carpool: 'Carpooling', other: 'Other plan' };
const CYCLE = [null, 'yes', 'maybe', 'no'];
/** Clicking a roster cell steps through: no reply → yes → maybe → no → no reply. */
export const nextReply = status => CYCLE[(CYCLE.indexOf(status ?? null) + 1) % CYCLE.length];

/** Counts from an attendance response ({ yes, maybe, no, no_reply, roster }) or an event row (going, maybe, not_going, roster_size). */
export function countsOf(x) {
  if ('roster' in x) return { yes: x.yes, maybe: x.maybe, no: x.no, none: x.no_reply, roster: x.roster };
  const roster = x.roster_size || 0;
  return { yes: x.going || 0, maybe: x.maybe || 0, no: x.not_going || 0, none: Math.max(roster - (x.going || 0) - (x.maybe || 0) - (x.not_going || 0), 0), roster };
}

/** "8 going · 2 maybe · 1 can't · 3 no reply" as small colored chips. Empty when the event has no team. */
export function attendanceLine(x) {
  const c = countsOf(x);
  if (!c.roster) return '';
  return `<span class="att-line"><span class="att-chip yes"><b>${c.yes}</b> going</span>${c.maybe ? `<span class="att-chip maybe"><b>${c.maybe}</b> maybe</span>` : ''}${c.no ? `<span class="att-chip no"><b>${c.no}</b> can't</span>` : ''}${c.none ? `<span class="att-chip none"><b>${c.none}</b> no reply</span>` : ''}</span>`;
}

/** A stacked bar of the replies: yes, maybe, no, no reply. */
export function attendanceBar(x) {
  const c = countsOf(x);
  if (!c.roster) return '';
  const part = (cls, n) => (n ? `<i class="${cls}" style="flex:${n}"></i>` : '');
  return `<span class="att-bar" role="img" aria-label="${c.yes} going, ${c.maybe} maybe, ${c.no} can't, ${c.none} no reply">${part('yes', c.yes)}${part('maybe', c.maybe)}${part('no', c.no)}${part('none', c.none)}</span>`;
}

/** The team's players with Yes / Maybe / No buttons for one event. Click a lit button again to clear it. */
export async function attendanceEditor(host, eventId, { onChange } = {}) {
  let data = await api.get(`/api/events/${eventId}/attendance`);
  const draw = () => {
    host.innerHTML = !data.players.length ? '<p class="muted small">This team has no players yet.</p>' : `
      <div class="att-summary">${attendanceBar(data.counts)}${attendanceLine(data.counts)}</div>
      <ul class="att-list">${data.players.map(p => `
        <li>
          <span class="att-num">${esc(p.number)}</span><span class="att-name">${esc(p.name)}${p.status && (p.source === 'player' || p.source === 'parent') ? ` <span class="by-tag ${p.source}">by ${p.source}</span>` : ''}</span><span class="att-pos">${esc(p.position)}</span>
          <span class="att-seg" role="group" aria-label="${esc(p.name)}">${Object.entries(REPLIES).map(([key, r]) => `<button type="button" class="${p.status === key ? `on ${key}` : ''}" data-player="${p.id}" data-reply="${key}" aria-pressed="${p.status === key}">${r.label}</button>`).join('')}</span>
        </li>`).join('')}
      </ul>`;
  };
  host.addEventListener('click', async e => {
    const button = e.target.closest('[data-reply]');
    if (!button) return;
    const player = data.players.find(p => String(p.id) === button.dataset.player);
    const status = player.status === button.dataset.reply ? null : button.dataset.reply;
    try {
      data = await api.put(`/api/events/${eventId}/attendance/${player.id}`, { status });
      draw();
      onChange?.(data);
    } catch (err) { toast(err.message, 'error'); }
  });
  draw();
  onChange?.(data);
  return data;
}
