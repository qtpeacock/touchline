// Player and parent pages: the team's upcoming practices and games with a Yes / Maybe / No reply on each,
// travel plans for away games (parents), and the drills the coach shared. Kept simple for now.
import { api } from '../api.js';
import { go, logout, session } from '../router.js';
import { esc, eventTitle, fmtDate, fmtRange, parseDate, todayISO, toast } from '../ui.js';
import { boardThumb } from '../field.js';
import { presentDrill } from '../present.js';
import { REPLIES, TRAVEL } from '../attendance.js';
import { topbar } from './home.js';

const WHO = { coach: 'the coach', player: 'the player', parent: 'a parent' };
const localTime = utc => new Date(`${utc.replace(' ', 'T')}Z`).toLocaleString(undefined, { month: 'short', day: 'numeric' });

/** "This week", "Next week" or "Week of Nov 9", for grouping the schedule like a calendar. */
function weekLabel(iso) {
  const day = parseDate(iso), today = parseDate(todayISO());
  const sunday = d => { const s = new Date(d); s.setDate(s.getDate() - s.getDay()); return s; };   // weeks start on Sunday, like the calendar
  const weeks = Math.round((sunday(day) - sunday(today)) / (7 * 86400000));
  return weeks === 0 ? 'This week' : weeks === 1 ? 'Next week' : `Week of ${sunday(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

export async function renderFamily(host, relation) {
  if (!session.user.roles.includes(relation)) {
    toast(`Add the ${relation} role to your account first`);
    return go('/home');
  }
  host.innerHTML = `${topbar()}<main class="home family"><a class="back-link" href="#/home">← Account home</a><div data-kids><p class="loading">Loading…</p></div></main>`;
  host.querySelector('[data-logout]').addEventListener('click', logout);
  const { kids } = await api.get(`/api/family/${relation}`);
  const box = host.querySelector('[data-kids]');
  if (!kids.length) {
    box.innerHTML = `<section class="card preview-card"><h1>Not connected to a team yet</h1><p class="muted">Ask your coach to invite <strong>${esc(session.user.email)}</strong> as ${relation === 'parent' ? 'a parent of your child' : 'you, the player'} from their team roster. The invitation shows up on your account home: accept it and the schedule and drills appear here.</p><a class="btn primary" href="#/home">Back to account home</a></section>`;
    return;
  }
  box.innerHTML = kids.map((kid, k) => kidHtml(kid, k, relation)).join('');

  box.addEventListener('click', async e => {
    const reply = e.target.closest('[data-reply]');
    const view = e.target.closest('[data-view-drill]');
    const save = e.target.closest('[data-save-travel]');
    if (reply) {
      const kid = kids[Number(reply.dataset.kid)];
      const ev = kid.events.find(x => String(x.id) === reply.dataset.event);
      const status = ev.reply?.status === reply.dataset.reply ? null : reply.dataset.reply;   // click a lit button to clear
      try {
        await api.put(`/api/family/${relation}/events/${ev.id}/reply`, { player_id: kid.player.id, status });
        ev.reply = status ? { status, by: relation } : null;
        reply.closest('.fam-ev').outerHTML = eventHtml(ev, Number(reply.dataset.kid), relation);
        toast(status ? `Marked ${REPLIES[status].label}. ${kid.player.name}'s coach can see it now.` : 'Reply cleared');
      } catch (err) { toast(err.message, 'error'); }
    } else if (view) {
      const s = kids[Number(view.dataset.kid)].drills.find(x => String(x.id) === view.dataset.viewDrill);
      const animated = (s.board.phases || []).some(p => p.moves?.length);
      presentDrill({ name: s.name, categories: s.categories, minutes: s.minutes, notes: s.notes, board: s.board }, { mode: animated ? 'anim' : 'board' });
    } else if (save) {
      const row = save.closest('.fam-travel');
      const kid = kids[Number(save.dataset.kid)];
      const ev = kid.events.find(x => String(x.id) === save.dataset.saveTravel);
      const plan = row.querySelector('[data-plan]').value || null;
      const body = { player_id: kid.player.id, plan, seats: Number(row.querySelector('[data-seats]').value) || 0, note: row.querySelector('[data-note]').value.trim() };
      try {
        await api.put(`/api/family/parent/events/${ev.id}/travel`, body);
        ev.travel = plan ? body : null;
        toast(plan ? 'Travel plan saved. The coach can see it.' : 'Travel plan cleared');
        row.querySelector('[data-saved]').hidden = false;
      } catch (err) { toast(err.message, 'error'); }
    }
  });
  box.addEventListener('change', e => {
    const plan = e.target.closest('[data-plan]');
    if (plan) plan.closest('.fam-travel').querySelector('[data-seats-wrap]').hidden = plan.value !== 'driving';
  });
  box.addEventListener('input', e => {
    const row = e.target.closest('.fam-travel');
    if (row) row.querySelector('[data-saved]').hidden = true;
  });
}

function kidHtml(kid, k, relation) {
  const p = kid.player;
  const weeks = new Map();
  for (const ev of kid.events) {
    const label = weekLabel(ev.date);
    if (!weeks.has(label)) weeks.set(label, []);
    weeks.get(label).push(ev);
  }
  return `
    <section class="card fam-hero" style="--team:${esc(p.team_color)}">
      <span class="fam-crest">${esc(p.number || '?')}</span>
      <div>
        <p class="eyebrow">${relation === 'parent' ? 'Parent view' : 'Player view'}</p>
        <h1>${relation === 'parent' ? `${esc(p.name)}'s schedule` : esc(p.name)}</h1>
        <p class="muted">${esc([p.position, p.team_name, p.age_group].filter(Boolean).join(' · '))} · Coach: ${esc(p.coach_name)}</p>
      </div>
    </section>
    <div class="fam-layout">
      <section class="card card-pad">
        <div class="card-head"><div><h2>Upcoming practices and games</h2>
          <p class="muted small">${relation === 'parent' ? `Answer for ${esc(p.name)}, and add how you're getting to away games.` : "Let your coach know if you're coming."} The coach sees each answer right away.</p></div></div>
        ${kid.events.length ? [...weeks].map(([label, events]) => `
          <h3 class="fam-week">${esc(label)}</h3>
          <ol class="fam-events">${events.map(ev => eventHtml(ev, k, relation)).join('')}</ol>`).join('')
          : '<p class="muted small">Nothing on the schedule in the next six weeks.</p>'}
      </section>
      <aside class="card card-pad fam-drills">
        <h2>Suggested drills</h2>
        <p class="muted small">${relation === 'parent' ? `Drills ${esc(p.coach_name)} shared with ${esc(p.name)}.` : 'From your coach, to practice at home.'}</p>
        ${kid.drills_hidden ? `<p class="fam-empty">The coach shares drills with players only on this team.</p>`
          : kid.drills.length ? kid.drills.map(s => `
            <article class="fam-drill">
              <button type="button" class="fam-drill-thumb" data-view-drill="${s.id}" data-kid="${k}" title="Show this drill full screen">${boardThumb(s.board)}<span class="badge">▶ View</span></button>
              <strong>${esc(s.name)}</strong>
              <small class="muted">${s.minutes} min · ${s.to.length ? `just for ${esc(p.name)}` : 'for the whole team'} · shared ${esc(localTime(s.created_at))}</small>
              ${s.note ? `<p>“${esc(s.note)}”</p>` : ''}
            </article>`).join('')
          : '<p class="fam-empty">Nothing yet. Drills your coach shares will show up here.</p>'}
      </aside>
    </div>`;
}

function eventHtml(ev, k, relation) {
  const d = parseDate(ev.date);
  const r = ev.reply?.status;
  const title = ev.kind === 'game' ? `${ev.away ? 'at' : 'vs'} ${ev.opponent || 'TBD'}` : eventTitle(ev);
  const t = ev.travel;
  return `<li class="fam-ev">
    <span class="up-date"><small>${d.toLocaleDateString(undefined, { weekday: 'short' })}</small><strong>${d.getDate()}</strong><small>${d.toLocaleDateString(undefined, { month: 'short' })}</small></span>
    <div class="fam-ev-body">
      <span><span class="tag ${ev.kind}">${ev.kind === 'game' && ev.away ? 'away game' : ev.kind}</span></span>
      <strong>${esc(title)}</strong>
      <small>${fmtRange(ev.start_time, ev.end_time)}${ev.location ? ` · ${esc(ev.location)}` : ''}</small>
      ${r && ev.reply.by && ev.reply.by !== relation ? `<small class="muted">Marked by ${WHO[ev.reply.by] || ev.reply.by}</small>` : ''}
    </div>
    <span class="att-seg" role="group" aria-label="Coming to ${esc(title)}?">${Object.entries(REPLIES).map(([key, rep]) =>
      `<button type="button" class="${r === key ? `on ${key}` : ''}" data-reply="${key}" data-event="${ev.id}" data-kid="${k}" aria-pressed="${r === key}">${rep.label}</button>`).join('')}</span>
    ${relation === 'parent' && ev.kind === 'game' && ev.away ? `
      <div class="fam-travel">
        <span class="fam-travel-label">Travel</span>
        <select class="input small" data-plan aria-label="Travel plan"><option value="">No plan yet</option>${Object.entries(TRAVEL).map(([key, label]) => `<option value="${key}" ${t?.plan === key ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <label class="fam-seats" data-seats-wrap ${t?.plan === 'driving' ? '' : 'hidden'}><input class="input small" type="number" min="0" max="8" data-seats value="${t?.seats ?? 0}" aria-label="Seats free"> seats free</label>
        <input class="input small" data-note maxlength="200" placeholder="Note, e.g. leaving 9:15 from the school lot" value="${esc(t?.note)}" aria-label="Travel note">
        <button class="btn small" type="button" data-save-travel="${ev.id}" data-kid="${k}">Save</button>
        <span class="saved-note" data-saved hidden>✓ Saved</span>
      </div>` : ''}
  </li>`;
}
