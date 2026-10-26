// Teams: all-teams overview, a page per team (roster with who's coming, drills shared with players,
// away-game travel), and the add/edit team dialog.
import { api } from '../api.js';
import { go } from '../router.js';
import { confirmDialog, esc, eventTitle, fmtDate, fmtRange, icons, initials, isUpcoming, openModal, todayISO, toast } from '../ui.js';
import { boardThumb } from '../field.js';
import { presentDrill } from '../present.js';
import { openEventModal } from './calendar.js';
import { REPLIES, TRAVEL, attendanceBar, attendanceLine, nextReply } from '../attendance.js';

const COLUMN_CHOICES = [4, 8, 12];   // how many upcoming practices and games the roster grid shows
let columnCount = 4;

const TEAM_COLORS = ['#174c3d', '#304dbe', '#e55c4b', '#e8b34c', '#7c3aed', '#0f766e', '#c2410c', '#1f2937'];
const POSITIONS = ['GK', 'CB', 'LB', 'RB', 'DM', 'CM', 'AM', 'LW', 'RW', 'ST'];
const localTime = utc => new Date(`${utc.replace(' ', 'T')}Z`).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export async function renderTeams(host, ctx) {
  if (ctx.id) return renderTeamPage(host, ctx);
  host.innerHTML = `
    <header class="page-head">
      <div><p class="eyebrow">Teams</p><h1>Your teams</h1><p class="muted">Rosters and schedules for every team you coach.</p></div>
      <div class="actions"><button class="btn primary" type="button" data-add-team>${icons.plus} Add team</button></div>
    </header>
    <div class="team-grid"><p class="loading">Loading teams…</p></div>`;

  const [teams, events] = await Promise.all([api.get('/api/teams'), api.get(`/api/events?start=${todayISO()}&limit=200`)]);
  const nextByTeam = new Map();
  for (const ev of events.filter(isUpcoming)) if (ev.team_id && !nextByTeam.has(ev.team_id)) nextByTeam.set(ev.team_id, ev);

  host.querySelector('.team-grid').innerHTML = teams.map(t => {
    const next = nextByTeam.get(t.id);
    const sub = [t.age_group, t.season].filter(Boolean).join(' · ') || 'No age group set';
    return `<a class="card team-card" href="#/coach/teams/${t.id}">
      <div class="team-band" style="background:${esc(t.color)}"><span class="crest" style="color:${esc(t.color)}">${esc(initials(t.name))}</span></div>
      <div class="team-card-body">
        <h3>${esc(t.name)}</h3><p class="muted">${esc(sub)}</p>
        <div class="team-stats">
          <span><strong>${t.player_count}</strong> players</span>
          <span>${next ? `Next: ${esc(fmtDate(next.date, { weekday: 'short', month: 'short', day: 'numeric' }))} · ${next.kind}` : 'Nothing scheduled'}</span>
        </div>
      </div>
    </a>`;
  }).join('') + `<button class="card team-card add" type="button" data-add-team>${icons.plus} Add a team</button>`;

  host.querySelectorAll('[data-add-team]').forEach(b => b.addEventListener('click', () => openTeamModal({
    onSaved: team => { ctx.shell.refreshTeams(); go(`/coach/teams/${team.id}`); },
  })));
}

async function renderTeamPage(host, ctx) {
  let team;
  try {
    team = await api.get(`/api/teams/${encodeURIComponent(ctx.id)}`);
  } catch (err) {
    toast(err.message, 'error');
    return go('/coach/teams');
  }
  const sub = () => [team.age_group, team.season, `${team.players.length} players`].filter(Boolean).join(' · ');
  // Filled by loadReplies(): the grid's events, and each player's reply, who gave it, and travel plans.
  let columns = [], replies = {}, answered = {}, travel = {};
  const replyOf = (evId, playerId) => replies[evId]?.[playerId] ?? null;
  const countsFor = evId => {
    const c = { going: 0, maybe: 0, not_going: 0, roster_size: team.players.length };
    for (const p of team.players) {
      const r = replyOf(evId, p.id);
      if (r === 'yes') c.going++; else if (r === 'maybe') c.maybe++; else if (r === 'no') c.not_going++;
    }
    return c;
  };
  const evLabel = ev => `${fmtDate(ev.date, { weekday: 'short', month: 'short', day: 'numeric' })} ${ev.kind}`;
  const rsvpCell = (ev, p) => {
    const r = replyOf(ev.id, p.id);
    const by = r && answered[ev.id]?.[p.id];
    const fromFamily = by && (by.by === 'player' || by.by === 'parent');
    const trip = travel[ev.id]?.[p.id];
    const title = `${p.name} · ${evLabel(ev)}: ${r ? REPLIES[r].label : 'No reply yet'}`
      + (fromFamily ? ` (answered by the ${by.by}, ${localTime(by.at)})` : '')
      + (trip ? ` · Travel: ${TRAVEL[trip.plan]}${trip.plan === 'driving' && trip.seats ? `, ${trip.seats} seats free` : ''}${trip.note ? ` (${trip.note})` : ''}` : '')
      + '. Click to change.';
    return `<td class="col-ev"><button type="button" class="rsvp ${r || 'none'}" data-rsvp="${ev.id}" data-player="${p.id}" title="${esc(title)}" aria-label="${esc(title)}">${r ? REPLIES[r].mark : ''}${fromFamily ? `<i class="by ${by.by}"></i>` : ''}${trip ? '<i class="trip"></i>' : ''}</button></td>`;
  };
  const accountsCell = p => {
    const a = p.accounts || { linked: [], invited: [] };
    const players = a.linked.filter(x => x.relation === 'player').length;
    const parents = a.linked.filter(x => x.relation === 'parent').length;
    const invited = a.invited.length;
    const title = [...a.linked.map(x => `${x.name} (${x.email}): ${x.relation}`), ...a.invited.map(x => `${x.email}: ${x.relation}, invited`)].join('\n')
      || 'No accounts connected yet. Click to invite the player or a parent.';
    return `<button type="button" class="acct-btn${players + parents + invited ? '' : ' empty'}" data-accounts="${p.id}" title="${esc(title)}">${players + parents + invited
      ? `${players ? '<span class="acct-chip player">Player</span>' : ''}${parents ? `<span class="acct-chip parent">${parents} parent${parents > 1 ? 's' : ''}</span>` : ''}${invited ? `<span class="acct-chip invited">${invited} invited</span>` : ''}`
      : `${icons.plus} Connect`}</button>`;
  };
  const headCell = ev => {
    const c = countsFor(ev.id);
    const trips = Object.keys(travel[ev.id] || {}).length;
    return `<th class="col-ev" title="${esc(eventTitle(ev))}">
      <span class="evh-kind ${ev.kind}">${ev.kind === 'game' ? (ev.away ? 'Away game' : 'Game') : 'Practice'}</span>
      <span class="evh-date">${esc(fmtDate(ev.date, { weekday: 'short', month: 'numeric', day: 'numeric' }))}</span>
      ${attendanceBar(c)}<span class="evh-count"><b>${c.going}</b> going</span>
      ${ev.away ? `<span class="evh-trip">${trips} travel plan${trips === 1 ? '' : 's'}</span>` : ''}
    </th>`;
  };

  host.innerHTML = `
    <a class="back-link" href="#/coach/teams">← All teams</a>
    <header class="page-head">
      <div><p class="eyebrow">Team</p><h1><span class="team-title-dot" style="background:${esc(team.color)}"></span><span data-team-name>${esc(team.name)}</span></h1><p class="muted" data-team-sub>${esc(sub())}</p></div>
      <div class="actions">
        <button class="btn" type="button" data-edit-team>Edit team</button>
        <button class="btn primary" type="button" data-schedule>${icons.plus} Add to schedule</button>
      </div>
    </header>
    <div class="team-layout">
      <div class="team-main">
        <section class="card card-pad">
          <div class="card-head">
            <div><h2>Roster and who's coming</h2><p class="muted small">Click any number, name, position or note to edit it. Changes save automatically.</p></div>
            <div class="actions">
              <span class="seg small" role="group" aria-label="How many events to show">${COLUMN_CHOICES.map(n => `<button type="button" data-columns="${n}" class="${n === columnCount ? 'on' : ''}">Next ${n}</button>`).join('')}</span>
              <button class="btn small" type="button" data-add-player>${icons.plus} Add player</button>
            </div>
          </div>
          <p class="rsvp-legend small"><strong>Replies:</strong> click a box to mark
            <span class="rsvp yes mini">${REPLIES.yes.mark}</span> Yes, <span class="rsvp maybe mini">${REPLIES.maybe.mark}</span> Maybe,
            <span class="rsvp no mini">${REPLIES.no.mark}</span> No, or leave it blank.
            <span class="legend-dot player"></span> the player answered · <span class="legend-dot parent"></span> a parent answered · <span class="legend-dot trip"></span> has a travel plan</p>
          <div class="table-scroll">
            <table class="roster">
              <thead></thead>
              <tbody></tbody>
            </table>
          </div>
          <datalist id="positions">${POSITIONS.map(p => `<option value="${p}">`).join('')}</datalist>
        </section>
        <section class="card card-pad">
          <div class="card-head">
            <div><h2>Drills shared with players</h2><p class="muted small">Suggested drills show up on each player's page in Touchline.</p></div>
            <div class="actions">
              <label class="switch-row"><input type="checkbox" class="switch" data-parents-see> <span>Parents can see these</span></label>
              <button class="btn small primary" type="button" data-share>${icons.plus} Share a drill</button>
            </div>
          </div>
          <div class="share-list" data-shares><p class="muted small">Loading…</p></div>
        </section>
      </div>
      <aside class="team-side">
        <section class="card upcoming"><h2>Upcoming for this team</h2><div class="up-list" data-team-events></div></section>
        <section class="card upcoming"><h2>Away game travel</h2><p class="muted small" style="margin:-6px 0 10px">Plans parents add on their page.</p><div data-travel></div></section>
      </aside>
    </div>`;

  const thead = host.querySelector('thead');
  const tbody = host.querySelector('tbody');
  const rowHtml = p => `
    <tr data-player="${p.id}">
      <td><input class="cell num" name="number" maxlength="4" value="${esc(p.number)}" aria-label="Jersey number"></td>
      <td><input class="cell name" name="name" maxlength="60" value="${esc(p.name)}" aria-label="Player name"></td>
      <td><input class="cell" name="position" maxlength="30" list="positions" value="${esc(p.position)}" placeholder="—" aria-label="Position"></td>
      <td class="col-acct">${accountsCell(p)}</td>
      ${columns.map(ev => rsvpCell(ev, p)).join('')}
      <td><input class="cell" name="notes" maxlength="300" value="${esc(p.notes)}" placeholder="Add a note" aria-label="Notes"></td>
      <td class="col-x"><button class="icon-btn danger" type="button" data-remove aria-label="Remove ${esc(p.name)}">×</button></td>
    </tr>`;
  const drawHead = () => {
    thead.innerHTML = `<tr><th class="col-num">#</th><th>Player</th><th class="col-pos">Position</th><th class="col-acct" title="Player and parent accounts connected to this player">Accounts</th>${columns.map(headCell).join('')}<th>Notes</th><th class="col-x"><span class="sr-only">Remove</span></th></tr>`;
  };
  const drawRoster = () => {
    drawHead();
    tbody.innerHTML = team.players.length ? team.players.map(rowHtml).join('') : `<tr><td colspan="${6 + columns.length}" class="muted" style="padding:20px 8px">No players yet. Add your first player.</td></tr>`;
    host.querySelector('[data-team-sub]').textContent = sub();
  };

  async function loadReplies() {
    const data = await api.get(`/api/teams/${team.id}/attendance?limit=${columnCount + 2}`);
    columns = data.events.filter(isUpcoming).slice(0, columnCount);
    ({ replies, answered, travel } = data);
    drawRoster();
    drawTravel();
  }

  // ----- away game travel -----
  function drawTravel() {
    const box = host.querySelector('[data-travel]');
    const away = columns.filter(ev => ev.kind === 'game' && ev.away);
    const name = id => team.players.find(p => p.id === Number(id))?.name || 'A player';
    box.innerHTML = away.length ? away.map(ev => {
      const plans = Object.entries(travel[ev.id] || {});
      return `<div class="trip-game">
        <strong>${esc(fmtDate(ev.date, { weekday: 'short', month: 'short', day: 'numeric' }))} at ${esc(ev.opponent || 'TBD')}</strong>
        <small class="muted">${fmtRange(ev.start_time, ev.end_time)}${ev.location ? ` · ${esc(ev.location)}` : ''}</small>
        ${plans.length ? `<ul>${plans.map(([pid, t]) => `<li><b>${esc(name(pid))}:</b> ${esc(TRAVEL[t.plan])}${t.plan === 'driving' && t.seats ? `, ${t.seats} seat${t.seats === 1 ? '' : 's'} free` : ''}${t.note ? ` · ${esc(t.note)}` : ''}</li>`).join('')}</ul>`
          : '<p class="muted small">No travel plans yet.</p>'}
      </div>`;
    }).join('') : `<p class="muted small">No away games in the next ${columnCount} events.</p>`;
  }

  host.querySelectorAll('[data-columns]').forEach(b => b.addEventListener('click', () => {
    columnCount = Number(b.dataset.columns);
    host.querySelectorAll('[data-columns]').forEach(x => x.classList.toggle('on', x === b));
    loadReplies();
  }));

  tbody.addEventListener('click', e => {
    const button = e.target.closest('[data-accounts]');
    if (!button) return;
    const player = team.players.find(p => String(p.id) === button.dataset.accounts);
    openAccountsModal({
      player,
      onChanged: accounts => {
        player.accounts = accounts;
        tbody.querySelector(`[data-accounts="${player.id}"]`).outerHTML = accountsCell(player);
      },
    });
  });

  tbody.addEventListener('click', async e => {
    const cell = e.target.closest('[data-rsvp]');
    if (!cell) return;
    const evId = cell.dataset.rsvp, playerId = Number(cell.dataset.player);
    const ev = columns.find(c => String(c.id) === evId);
    const player = team.players.find(p => p.id === playerId);
    const before = replyOf(evId, playerId), beforeBy = answered[evId]?.[playerId];
    const status = nextReply(before);
    const set = (value, by) => {
      replies[evId] ||= {};
      answered[evId] ||= {};
      if (value) replies[evId][playerId] = value; else delete replies[evId][playerId];
      if (by) answered[evId][playerId] = by; else delete answered[evId][playerId];
      tbody.querySelector(`[data-rsvp="${evId}"][data-player="${playerId}"]`).closest('td').outerHTML = rsvpCell(ev, player);
      drawHead();
      tbody.querySelector(`[data-rsvp="${evId}"][data-player="${playerId}"]`)?.focus();
    };
    set(status, status && { by: 'coach' });   // update right away; put it back if the save fails
    try {
      await api.put(`/api/events/${evId}/attendance/${playerId}`, { status });
      drawEvents();
    } catch (err) {
      set(before, beforeBy);
      toast(err.message, 'error');
    }
  });

  tbody.addEventListener('change', async e => {
    const row = e.target.closest('tr[data-player]');
    if (!row) return;
    const player = team.players.find(p => String(p.id) === row.dataset.player);
    const values = Object.fromEntries([...row.querySelectorAll('input')].map(i => [i.name, i.value.trim()]));
    if (!values.name) {
      e.target.value = player.name;
      return toast('A player needs a name', 'error');
    }
    try {
      Object.assign(player, await api.put(`/api/players/${player.id}`, values));
      row.classList.add('saved');
      setTimeout(() => row.classList.remove('saved'), 900);
    } catch (err) { toast(err.message, 'error'); }
  });
  tbody.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('.cell')) e.target.blur();
  });
  tbody.addEventListener('click', async e => {
    const button = e.target.closest('[data-remove]');
    if (!button) return;
    const row = button.closest('tr');
    const player = team.players.find(p => String(p.id) === row.dataset.player);
    if (!await confirmDialog(`Remove ${player.name} from ${team.name}?`, { confirmLabel: 'Remove' })) return;
    await api.del(`/api/players/${player.id}`);
    team.players = team.players.filter(p => p !== player);
    drawRoster();
    ctx.shell.refreshTeams();
  });
  host.querySelector('[data-add-player]').addEventListener('click', async () => {
    const used = new Set(team.players.map(p => p.number));
    let number = 1;
    while (used.has(String(number))) number++;
    const player = await api.post(`/api/teams/${team.id}/players`, { name: `Player ${team.players.length + 1}`, number: String(number) });
    team.players.push(player);
    drawRoster();
    const nameInput = tbody.querySelector(`tr[data-player="${player.id}"] [name=name]`);
    nameInput.focus();
    nameInput.select();
  });

  host.querySelector('[data-edit-team]').addEventListener('click', () => openTeamModal({
    team,
    onSaved: saved => {
      Object.assign(team, saved);
      host.querySelector('[data-team-name]').textContent = team.name;
      host.querySelector('.team-title-dot').style.background = team.color;
      drawRoster();
      ctx.shell.refreshTeams();
    },
    onDeleted: () => { ctx.shell.refreshTeams(); go('/coach/teams'); },
  }));

  // ----- drills shared with players -----
  const sharesBox = host.querySelector('[data-shares]');
  const parentsSee = host.querySelector('[data-parents-see]');
  let shares = [];
  async function drawShares() {
    const data = await api.get(`/api/teams/${team.id}/shared-drills`);
    parentsSee.checked = data.parents_see_drills;
    shares = data.shares;
    sharesBox.innerHTML = shares.length ? shares.map(s => `
      <article class="share-item">
        <button type="button" class="share-thumb" data-view-share="${s.id}" title="Show this drill full screen">${boardThumb(s.board, { mini: true })}</button>
        <div class="share-body">
          <strong>${esc(s.name)}</strong>
          <span class="share-to">${s.to.length ? `To ${esc(s.to.map(p => p.name).join(', '))}` : 'To all players'} · ${esc(localTime(s.created_at))}</span>
          ${s.note ? `<p>“${esc(s.note)}”</p>` : ''}
        </div>
        <button class="icon-btn danger" type="button" data-unshare="${s.id}" aria-label="Stop sharing ${esc(s.name)}" title="Stop sharing">×</button>
      </article>`).join('')
      : '<p class="muted small">Nothing shared yet. Share a drill from your library so players can practice it at home.</p>';
  }
  sharesBox.addEventListener('click', async e => {
    const view = e.target.closest('[data-view-share]');
    const del = e.target.closest('[data-unshare]');
    if (view) {
      const s = shares.find(x => String(x.id) === view.dataset.viewShare);
      const animated = (s.board.phases || []).some(p => p.moves?.length);
      return presentDrill({ name: s.name, categories: s.categories, minutes: s.minutes, notes: s.notes, board: s.board }, { mode: animated ? 'anim' : 'board' });
    }
    if (del) {
      const s = shares.find(x => String(x.id) === del.dataset.unshare);
      if (!await confirmDialog(`Stop sharing "${s.name}"? It disappears from players' pages; the drill stays in your library.`, { confirmLabel: 'Stop sharing' })) return;
      await api.del(`/api/shared-drills/${s.id}`);
      toast('No longer shared');
      drawShares();
    }
  });
  parentsSee.addEventListener('change', async () => {
    try {
      await api.put(`/api/teams/${team.id}/parents-see-drills`, { parents_see_drills: parentsSee.checked });
      toast(parentsSee.checked ? 'Parents can now see shared drills' : 'Shared drills are now for players only');
    } catch (err) {
      parentsSee.checked = !parentsSee.checked;
      toast(err.message, 'error');
    }
  });
  host.querySelector('[data-share]').addEventListener('click', async () => {
    const drills = await api.get('/api/drills');
    if (!drills.length) return toast('Your drill library is empty. Design a drill first.', 'error');
    openShareModal({ team, drills, onShared: drawShares });
  });

  // ----- upcoming list -----
  const eventsBox = host.querySelector('[data-team-events]');
  async function drawEvents() {
    const events = (await api.get(`/api/events?start=${todayISO()}&team_id=${team.id}&limit=12`)).filter(isUpcoming).slice(0, 6);
    eventsBox.innerHTML = events.length ? events.map(ev => `
      <div class="up-item">
        <span class="up-body"><span><span class="tag ${ev.kind}">${ev.kind === 'game' && ev.away ? 'away game' : ev.kind}</span></span><strong>${esc(eventTitle(ev))}</strong>
        <small>${esc(fmtDate(ev.date, { weekday: 'short', month: 'short', day: 'numeric' }))} · ${fmtRange(ev.start_time, ev.end_time)}</small>${attendanceLine(ev)}</span>
      </div>`).join('') : '<p class="muted small">Nothing on the calendar yet.</p>';
  }
  host.querySelector('[data-schedule]').addEventListener('click', async () => {
    const [teams, practices] = await Promise.all([api.get('/api/teams'), api.get('/api/practices')]);
    openEventModal({ teams, practices, teamId: team.id, onSaved: () => { drawEvents(); loadReplies(); } });
  });
  await Promise.all([loadReplies(), drawEvents(), drawShares()]);
}

/** Connect a roster player to accounts: invite the player or a parent by email, cancel invites, remove links. */
function openAccountsModal({ player, onChanged }) {
  let accounts = player.accounts || { linked: [], invited: [] };
  const label = { player: 'Player', parent: 'Parent' };
  openModal({
    title: `Accounts for ${player.name}`,
    submitLabel: 'Send invite',
    body: `
      <p class="muted small">Connected accounts see ${esc(player.name)}'s schedule and the drills you share, and can answer Yes, Maybe or No. Parents can also add travel plans for away games. Invite someone by email: they accept on their Touchline account home, and someone new accepts right after signing up with that email.</p>
      <div data-list></div>
      <div class="invite-row">
        <label class="field"><span>Email</span><input class="input" name="email" type="email" maxlength="254" placeholder="name@example.com" autocomplete="off"></label>
        <label class="field"><span>Connect as</span><select class="input" name="relation"><option value="parent">A parent</option><option value="player">${esc(player.name)} (the player)</option></select></label>
      </div>`,
    onMount(dialog) {
      const list = dialog.querySelector('[data-list]');
      const draw = () => {
        list.innerHTML = `
          <h3 class="acct-h">Connected</h3>
          ${accounts.linked.length ? `<ul class="acct-list">${accounts.linked.map(a => `
            <li><span class="acct-chip ${a.relation}">${label[a.relation]}</span><span class="acct-who"><strong>${esc(a.name)}</strong><small>${esc(a.email)}</small></span>
              <button type="button" class="btn small danger-ghost" data-disconnect="${a.user_id}" data-relation="${a.relation}">Remove</button></li>`).join('')}</ul>`
            : '<p class="muted small">No accounts connected yet.</p>'}
          ${accounts.invited.length ? `<h3 class="acct-h">Invited, waiting to accept</h3><ul class="acct-list">${accounts.invited.map(i => `
            <li><span class="acct-chip invited">${label[i.relation]}</span><span class="acct-who"><strong>${esc(i.email)}</strong><small>Invited ${esc(new Date(`${i.created_at.replace(' ', 'T')}Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</small></span>
              <button type="button" class="btn small" data-cancel-invite="${i.id}">Cancel</button></li>`).join('')}</ul>` : ''}`;
      };
      const refresh = async () => {
        accounts = await api.get(`/api/players/${player.id}/accounts`);
        draw();
        onChanged(accounts);
      };
      list.addEventListener('click', async e => {
        const disconnect = e.target.closest('[data-disconnect]');
        const cancel = e.target.closest('[data-cancel-invite]');
        try {
          if (disconnect) {
            const a = accounts.linked.find(x => String(x.user_id) === disconnect.dataset.disconnect && x.relation === disconnect.dataset.relation);
            if (!await confirmDialog(`Disconnect ${a.name} from ${player.name}? Their account stays; they just stop seeing ${player.name}'s team.`, { confirmLabel: 'Remove' })) return;
            await api.del(`/api/players/${player.id}/accounts/${a.user_id}?relation=${a.relation}`);
            toast('Account disconnected');
            await refresh();
          } else if (cancel) {
            await api.del(`/api/invites/${cancel.dataset.cancelInvite}`);
            toast('Invitation cancelled');
            await refresh();
          }
        } catch (err) { toast(err.message, 'error'); }
      });
      list.addEventListener('redraw', draw);   // after an invite is sent
      draw();
    },
    async onSubmit(form) {
      const email = form.elements.email.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
      accounts = await api.post(`/api/players/${player.id}/invites`, { email, relation: form.elements.relation.value });
      onChanged(accounts);
      form.elements.email.value = '';
      form.querySelector('[data-list]').dispatchEvent(new CustomEvent('redraw'));
      toast(`Invitation sent to ${email}. They'll see it on their account home.`);
      return false;   // keep the dialog open to invite more
    },
  });
}

/** Share a library drill with the whole team or chosen players, with an optional note. */
function openShareModal({ team, drills, onShared }) {
  openModal({
    title: `Share a drill with ${team.name}`,
    submitLabel: 'Share drill',
    body: `
      <label class="field"><span>Drill</span><select class="input" name="drill_id">${drills.map(d => `<option value="${d.id}">${esc(d.name)} · ${d.minutes} min</option>`).join('')}</select></label>
      <div class="share-preview" data-preview></div>
      <div class="field"><span>Who gets it</span>
        <div class="seg" role="radiogroup" aria-label="Who gets it">
          <label><input type="radio" name="to" value="all" checked>All players</label>
          <label><input type="radio" name="to" value="some">Choose players</label>
        </div>
      </div>
      <div class="share-players" data-players hidden>${team.players.map(p => `<label class="check"><input type="checkbox" name="player" value="${p.id}"> #${esc(p.number)} ${esc(p.name)}${p.position ? ` <span class="muted small">${esc(p.position)}</span>` : ''}</label>`).join('')}</div>
      <label class="field"><span>Note for players <em class="muted">(optional)</em></span><textarea class="input" name="note" rows="2" maxlength="300" placeholder="e.g. 10 minutes against a wall before Thursday."></textarea></label>`,
    onMount(dialog) {
      const form = dialog.querySelector('form');
      const preview = () => {
        const d = drills.find(x => String(x.id) === form.elements.drill_id.value);
        dialog.querySelector('[data-preview]').innerHTML = boardThumb(d.board);
      };
      form.elements.drill_id.addEventListener('change', preview);
      preview();
      form.querySelectorAll('[name=to]').forEach(r => r.addEventListener('change', () => {
        dialog.querySelector('[data-players]').hidden = form.elements.to.value !== 'some';
      }));
    },
    async onSubmit(form) {
      const some = form.elements.to.value === 'some';
      const players = [...form.querySelectorAll('[name=player]:checked')].map(i => Number(i.value));
      if (some && !players.length) throw new Error('Pick at least one player, or share with all players.');
      await api.post(`/api/teams/${team.id}/shared-drills`, {
        drill_id: Number(form.elements.drill_id.value), player_ids: some ? players : [], note: form.elements.note.value.trim(),
      });
      toast(some ? `Shared with ${players.length} player${players.length === 1 ? '' : 's'}` : `Shared with all of ${team.name}`);
      onShared?.();
    },
  });
}

export function openTeamModal({ team = null, onSaved, onDeleted }) {
  const color = team?.color || TEAM_COLORS[0];
  openModal({
    title: team ? 'Edit team' : 'Add a team',
    submitLabel: team ? 'Save team' : 'Create team',
    footerLeft: team ? '<button type="button" class="btn danger-ghost" data-delete>Delete team</button>' : '',
    body: `
      <label class="field"><span>Team name</span><input class="input" name="name" maxlength="60" value="${esc(team?.name)}" placeholder="e.g. U12 Lions"></label>
      <div class="grid-2">
        <label class="field"><span>Age group or level</span><input class="input" name="age_group" maxlength="40" value="${esc(team?.age_group)}" placeholder="e.g. U12 Girls"></label>
        <label class="field"><span>Season</span><input class="input" name="season" maxlength="40" value="${esc(team?.season)}" placeholder="e.g. Fall 2026"></label>
      </div>
      <div class="field"><span>Team color</span><div class="swatches">${TEAM_COLORS.map(c => `<button type="button" class="swatch${c === color ? ' on' : ''}" style="--c:${c}" data-color="${c}" aria-label="Color ${c}"></button>`).join('')}</div></div>`,
    onMount(dialog, close) {
      let picked = color;
      dialog.dataset.color = picked;
      dialog.querySelectorAll('[data-color]').forEach(b => b.addEventListener('click', () => {
        picked = b.dataset.color;
        dialog.dataset.color = picked;
        dialog.querySelectorAll('[data-color]').forEach(x => x.classList.toggle('on', x === b));
      }));
      dialog.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!await confirmDialog(`Delete ${team.name}? Its roster and calendar events will be removed too.`, { confirmLabel: 'Delete team' })) return;
        await api.del(`/api/teams/${team.id}`);
        close();
        toast('Team deleted');
        onDeleted?.();
      });
    },
    async onSubmit(form) {
      const v = name => form.elements[name].value.trim();
      if (!v('name')) throw new Error('Give the team a name.');
      const body = { name: v('name'), age_group: v('age_group'), season: v('season'), color: form.closest('dialog').dataset.color };
      const saved = team ? await api.put(`/api/teams/${team.id}`, body) : await api.post('/api/teams', body);
      toast(team ? 'Team updated' : `${saved.name} created`);
      onSaved?.(saved);
    },
  });
}
