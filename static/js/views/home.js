// Account home: a demo tour (demo accounts), the switch between coach, player and parent views, a calendar
// of every upcoming event across the account's roles, the AI chat, and the profile.
import { api } from '../api.js';
import { session, go, logout } from '../router.js';
import {
  esc, fmtRange, fmtTimeShort, icons, initials, isoDate, openModal, ROLES, showFormError, submitting, toast, todayISO,
} from '../ui.js';
import { REPLIES } from '../attendance.js';

export function topbar() {
  return `<header class="topbar">
    <a class="brand" href="#/home"><span class="brandmark">⚽</span> Touchline</a>
    <div class="topbar-right"><span class="muted">${esc(session.user.email)}</span><button class="btn small" type="button" data-logout>Log out</button></div>
  </header>`;
}

const ROLE_ROUTES = { coach: '/coach/calendar', player: '/player', parent: '/parent' };
const ROLE_SUBTITLES = { coach: 'Teams, practices, drills and the AI builders', player: 'Your schedule, replies and drills', parent: "Your child's schedule, replies and travel" };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CHAT_KEY = () => `touchline:chat:${session.user.id}`;
let calRole = 'all';
let calMonth = null;

export function renderHome(host) {
  const user = session.user;
  const profile = user.profile || {};
  const owned = ROLES.filter(r => user.roles.includes(r.key));
  const missing = ROLES.filter(r => !user.roles.includes(r.key));
  if (calRole !== 'all' && !user.roles.includes(calRole)) calRole = 'all';

  host.innerHTML = `${topbar()}
  <main class="home wide">
    <section class="home-hero">
      <div class="avatar">${esc(initials(user.name))}</div>
      <div><p class="eyebrow">Account home</p><h1>${esc(user.name)}</h1><p class="muted">${esc(user.email)}</p></div>
    </section>

    <section class="card card-pad invites-card" data-invites hidden></section>

    ${user.demo ? '<section class="card card-pad demo-tour" data-tour></section>' : ''}

    <section class="card card-pad">
      <div class="card-head"><div><h2>Your roles</h2><p class="muted">Open the coach, player or parent side of Touchline. One account can hold more than one role.</p></div></div>
      <div class="role-toggle" role="group" aria-label="Open a view">
        ${owned.map(r => `
          <button type="button" class="role-tab ${r.key}" data-role="${r.key}">
            <span class="role-icon">${r.icon}</span>
            <span><strong>${r.title}</strong><small>${ROLE_SUBTITLES[r.key]}</small></span>
            <span class="go" aria-hidden="true">→</span>
          </button>`).join('')}
        ${missing.length ? `
          <button type="button" class="role-tab add" data-add-role>
            <span class="role-icon">＋</span>
            <span><strong>Add a role</strong><small>${missing.map(r => r.title).join(' or ')}</small></span>
          </button>` : ''}
      </div>
    </section>

    <div class="home-grid">
      <section class="card card-pad home-cal">
        <div class="card-head">
          <div><h2>Your calendar</h2><p class="muted small">Every practice and game across your roles.</p></div>
          ${owned.length > 1 ? `<span class="seg small" role="group" aria-label="Show events for">${['all', ...owned.map(r => r.key)].map(key => `<button type="button" data-cal-role="${key}" class="${key === calRole ? 'on' : ''}">${key === 'all' ? 'All' : ROLES.find(r => r.key === key).title}</button>`).join('')}</span>` : ''}
        </div>
        <div class="cal-toolbar">
          <div class="cal-nav">
            <button class="icon-btn" type="button" data-step="-1" aria-label="Previous month">‹</button>
            <h3 class="cal-title"></h3>
            <button class="icon-btn" type="button" data-step="1" aria-label="Next month">›</button>
            <button class="btn small" type="button" data-today>Today</button>
          </div>
          <span class="legend role-legend">${owned.map(r => `<i class="${r.key}"></i>${r.title}`).join(' ')}</span>
        </div>
        <div class="cal-grid mini-cal" role="grid"></div>
        <div class="home-next" data-next></div>
      </section>
      <section class="card card-pad home-chat" data-chat></section>
    </div>

    <section class="card card-pad">
      <div class="card-head"><div><h2>Profile</h2><p class="muted">What your teams see about you.</p></div></div>
      <form class="profile-form" id="profileForm" novalidate>
        <div class="grid-2">
          <label class="field"><span>Full name</span><input class="input" name="name" maxlength="80" value="${esc(user.name)}"></label>
          <label class="field"><span>Email</span><input class="input" value="${esc(user.email)}" disabled></label>
        </div>
        <div class="grid-2">
          <label class="field"><span>Phone</span><input class="input" name="phone" type="tel" maxlength="40" value="${esc(profile.phone)}" placeholder="Optional"></label>
          <label class="field"><span>City or town</span><input class="input" name="city" maxlength="80" value="${esc(profile.city)}" placeholder="Optional"></label>
        </div>
        <label class="field"><span>Club, school or organization</span><input class="input" name="organization" maxlength="120" value="${esc(profile.organization)}" placeholder="e.g. New Haven Youth Soccer"></label>
        <label class="field"><span>About you</span><textarea class="input" name="bio" maxlength="600" rows="3" placeholder="Coaching experience, position, anything your team should know…">${esc(profile.bio)}</textarea></label>
        <p class="form-error" role="alert" hidden></p>
        <div class="form-actions"><span class="saved-note" hidden>✓ Saved</span><button class="btn primary" type="submit">Save profile</button></div>
      </form>
    </section>
  </main>`;

  host.querySelector('[data-logout]').addEventListener('click', logout);
  host.querySelectorAll('[data-role]').forEach(b => b.addEventListener('click', () => go(ROLE_ROUTES[b.dataset.role])));
  host.querySelector('[data-add-role]')?.addEventListener('click', () => addRoleModal(missing, () => renderHome(host)));

  const form = host.querySelector('#profileForm');
  const savedNote = form.querySelector('.saved-note');
  form.addEventListener('input', () => { savedNote.hidden = true; });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const v = name => form.elements[name].value.trim();
    if (!v('name')) return showFormError(form, 'Enter your name.');
    submitting(form, async () => {
      session.user = await api.put('/api/me/profile', {
        name: v('name'), phone: v('phone'), city: v('city'), organization: v('organization'), bio: v('bio'),
      });
      host.querySelector('.home-hero h1').textContent = session.user.name;
      host.querySelector('.avatar').textContent = initials(session.user.name);
      savedNote.hidden = false;
    });
  });

  mountCalendar(host);
  mountChat(host.querySelector('[data-chat]'));
  drawInvites(host);
}

// ---------- invitations from coaches ----------

async function drawInvites(host) {
  const box = host.querySelector('[data-invites]');
  let invites = [];
  try { invites = await api.get('/api/me/invites'); } catch { return; }
  box.hidden = !invites.length;
  if (!invites.length) return;
  box.innerHTML = `
    <div class="card-head"><div><h2>Invitations</h2><p class="muted small">A coach wants to connect you to a player on their team. Accept to see the schedule and answer for practices and games.</p></div></div>
    <ul class="invite-list">${invites.map(i => `
      <li>
        <span class="role-icon">${i.relation === 'parent' ? icons.parent : icons.player}</span>
        <span class="invite-text"><strong>${esc(i.coach_name)}</strong> invited you as ${i.relation === 'parent' ? `a parent of <strong>${esc(i.player_name)}</strong>` : `<strong>${esc(i.player_name)}</strong> (the player)`} on <strong>${esc(i.team_name)}</strong>.</span>
        <span class="actions"><button class="btn small" type="button" data-decline="${i.id}">Decline</button><button class="btn small primary" type="button" data-accept="${i.id}">Accept</button></span>
      </li>`).join('')}</ul>`;
  box.addEventListener('click', async e => {
    const accept = e.target.closest('[data-accept]');
    const decline = e.target.closest('[data-decline]');
    const invite = invites.find(i => String(i.id) === (accept || decline)?.dataset[accept ? 'accept' : 'decline']);
    if (!invite) return;
    try {
      if (accept) {
        session.user = await api.post(`/api/me/invites/${invite.id}/accept`);
        toast(`You're connected to ${invite.player_name} on ${invite.team_name}`);
      } else {
        await api.post(`/api/me/invites/${invite.id}/decline`);
        toast('Invitation declined');
      }
      renderHome(host);   // roles and the calendar may have changed (this also replaces the box and its listener)
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- the calendar ----------

// Five weeks at a time, starting with this week, so the calendar is about what's coming up.
const WEEKS = 5;
const thisSunday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay()); return d; };

function mountCalendar(host) {
  if (!calMonth) calMonth = thisSunday();   // the first day on screen
  const grid = host.querySelector('.cal-grid');
  let events = [], links = {};

  const shown = () => events.filter(ev => calRole === 'all' || ev.roles.includes(calRole));
  const label = ev => ev.title || (ev.kind === 'game' ? `${ev.away ? 'at' : 'vs'} ${ev.opponent || 'TBD'}` : ev.team_name || 'Practice');
  const routeFor = ev => ROLE_ROUTES[calRole !== 'all' ? calRole : ev.roles.includes('coach') ? 'coach' : ev.roles[0]];
  const myReply = ev => {
    const r = ev.replies?.[calRole] || (calRole === 'all' ? Object.values(ev.replies || {})[0] : null);
    return r?.status ? ` · ${r.player}: ${REPLIES[r.status].label}` : '';
  };

  function draw() {
    const days = Array.from({ length: WEEKS * 7 }, (_, i) => new Date(calMonth.getFullYear(), calMonth.getMonth(), calMonth.getDate() + i));
    const short = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    host.querySelector('.cal-title').textContent = `${short(days[0])} – ${short(days[days.length - 1])}`;
    const today = todayISO();
    const byDate = new Map();
    for (const ev of shown()) byDate.set(ev.date, [...(byDate.get(ev.date) || []), ev]);
    grid.innerHTML = WEEKDAYS.map(d => `<div class="cal-dow" role="columnheader">${d}</div>`).join('') + days.map(d => {
      const iso = isoDate(d);
      return `<div class="cal-day${iso === today ? ' today' : ''}${iso < today ? ' past' : ''}" role="gridcell">
        <div class="cal-day-top"><span class="cal-num">${d.getDate() === 1 ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.getDate()}</span></div>
        ${(byDate.get(iso) || []).map(ev => `
          <a class="ev ${ev.kind}" href="#${routeFor(ev)}" title="${esc(`${label(ev)} · ${ev.team_name} · ${fmtRange(ev.start_time, ev.end_time)}${myReply(ev)}`)}">
            <span class="role-dots">${ev.roles.map(r => `<i class="${r}"></i>`).join('')}</span><span class="ev-time">${fmtTimeShort(ev.start_time)}</span><span class="ev-name">${esc(label(ev))}</span>
          </a>`).join('')}
      </div>`;
    }).join('');
    const next = shown().filter(ev => ev.date >= today).slice(0, 3);
    host.querySelector('[data-next]').innerHTML = next.length ? `<p class="eyebrow">Next up</p>${next.map(ev => `
      <a class="home-next-item" href="#${routeFor(ev)}">
        <span class="role-dots">${ev.roles.map(r => `<i class="${r}"></i>`).join('')}</span>
        <strong>${esc(new Date(`${ev.date}T00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))}</strong>
        <span>${esc(ev.team_name)} ${ev.kind === 'game' ? esc(label(ev)) : 'practice'} · ${fmtRange(ev.start_time, ev.end_time)}${esc(myReply(ev))}</span>
      </a>`).join('')}` : '<p class="muted small">Nothing coming up.</p>';
  }

  async function load() {
    const first = calMonth;
    const last = new Date(first); last.setDate(first.getDate() + WEEKS * 7 - 1);
    try {
      ({ events, links } = await api.get(`/api/me/schedule?start=${isoDate(first)}&end=${isoDate(last)}`));
    } catch (err) { toast(err.message, 'error'); }
    draw();
    drawTour(host, links);
  }

  host.querySelectorAll('[data-cal-role]').forEach(b => b.addEventListener('click', () => {
    calRole = b.dataset.calRole;
    host.querySelectorAll('[data-cal-role]').forEach(x => x.classList.toggle('on', x === b));
    draw();
  }));
  host.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth(), calMonth.getDate() + Number(b.dataset.step) * WEEKS * 7);
    load();
  }));
  host.querySelector('[data-today]').addEventListener('click', () => {
    calMonth = thisSunday();
    load();
  });
  load();
}

// ---------- demo tour ----------

const TOUR_KEY = 'touchline:tour-hidden';

function drawTour(host, links) {
  const box = host.querySelector('[data-tour]');
  if (!box) return;
  const roles = session.user.roles;
  const kid = links.player?.[0] || links.parent?.[0];
  const team = kid ? `#/coach/teams/${kid.team_id}` : '#/coach/teams';
  const steps = [
    roles.includes('player') && ['Reply as Player 1', 'Open the Player view and mark Maybe for Thursday\'s practice.', '#/player'],
    roles.includes('parent') && ['Plan travel as the parent', "Open the Parent view and add a travel plan for Saturday's away game.", '#/parent'],
    roles.includes('coach') && ['See it as the coach', "Team 1's roster shows Player 1's reply with a dot for who answered, and the travel plan under Away game travel.", team],
    roles.includes('coach') && ['Share a drill', 'On the same team page, share a drill with just Player 1, and switch parent visibility on or off.', team],
    roles.includes('coach') && ['Build a practice with AI', 'Ask for a defending practice: the agents plan for the 8 players who said yes.', '#/coach/practices/ai'],
    roles.includes('coach') && ['Design a drill with AI', 'Ask for a 5v5 sized for a practice with 6 yes replies, and watch the app cap it.', '#/coach/drills/ai'],
    ['Ask the AI chat', roles.includes('coach') ? '"Who\'s coming to Tuesday\'s practice?"' : '"When is my next game?"', '#chat'],
  ].filter(Boolean);
  const hidden = localStorage.getItem(TOUR_KEY) === '1';
  box.innerHTML = `
    <div class="card-head">
      <div><h2>${icons.sparkle} Demo tour</h2><p class="muted small">A quick path through the app. Every step opens in this account, so you never have to log out.</p></div>
      <button class="btn small ghost" type="button" data-tour-toggle>${hidden ? 'Show' : 'Hide'}</button>
    </div>
    ${hidden ? '' : `<ol class="tour-steps">${steps.map(([title, text, href], i) => `
      <li><a href="${href}" ${href === '#chat' ? 'data-tour-chat' : ''}><span class="tour-n">${i + 1}</span><span><strong>${esc(title)}</strong><small>${esc(text)}</small></span></a></li>`).join('')}</ol>`}`;
  box.querySelector('[data-tour-toggle]').addEventListener('click', () => {
    localStorage.setItem(TOUR_KEY, hidden ? '0' : '1');
    drawTour(host, links);
  });
  box.querySelector('[data-tour-chat]')?.addEventListener('click', e => {
    e.preventDefault();
    host.querySelector('[data-chat]').scrollIntoView({ behavior: 'smooth', block: 'center' });
    host.querySelector('[data-chat] textarea').focus();
  });
}

// ---------- AI chat ----------

const IDEAS = {
  coach: ["Who's coming to Tuesday's practice?", 'Which away games need rides?', 'Which of my drills work on defending?'],
  player: ['When is my next game?', 'Which drills did my coach share with me?'],
  parent: ["Do we need to drive to Saturday's game?", "What's on the schedule this week?"],
};

function formatAnswer(text) {
  return esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
}

function mountChat(box) {
  const user = session.user;
  let messages = [];
  try { messages = JSON.parse(sessionStorage.getItem(CHAT_KEY()) || '[]'); } catch { messages = []; }
  const ideas = [...new Set(user.roles.flatMap(r => IDEAS[r] || []))].slice(0, 4);
  box.innerHTML = `
    <div class="card-head">
      <div><h2>${icons.sparkle} Ask Touchline</h2><p class="muted small">Questions about your schedule, replies, travel and drills. It looks things up but can't change anything.</p></div>
      <button class="btn small ghost" type="button" data-clear title="Start a new conversation">Clear</button>
    </div>
    <div class="chat-log" data-log aria-live="polite"></div>
    <div class="chips" data-ideas>${ideas.map(i => `<button type="button" class="chip" data-idea="${esc(i)}">${esc(i)}</button>`).join('')}</div>
    <form class="chat-form" data-form>
      <textarea class="input" rows="2" maxlength="500" placeholder="Ask a question…" aria-label="Your question"></textarea>
      <button class="btn primary" type="submit">Send</button>
    </form>
    <p class="muted small chat-meta" data-meta></p>`;
  const log = box.querySelector('[data-log]');
  const input = box.querySelector('textarea');
  const meta = box.querySelector('[data-meta]');

  const save = () => sessionStorage.setItem(CHAT_KEY(), JSON.stringify(messages.slice(-20)));
  function draw(waiting = false) {
    log.innerHTML = (messages.length ? '' : `<div class="bubble assistant"><p>Hi ${esc(user.name.split(' ')[0])}! Ask me about your schedule, who's coming, travel to away games, or drills.</p></div>`)
      + messages.map(m => `<div class="bubble ${m.role}${m.error ? ' error' : ''}"><p>${m.role === 'assistant' ? formatAnswer(m.text) : esc(m.text)}</p>${
        m.steps?.length ? `<small class="bubble-steps">${m.steps.map(s => esc(s)).join(' · ')}</small>` : ''}${
        m.usage ? `<small class="bubble-meta">${m.usage.requests} model call${m.usage.requests === 1 ? '' : 's'} · ${Number(m.usage.total_tokens).toLocaleString()} tokens · $${Number(m.usage.cost_usd).toFixed(4)}</small>` : ''}</div>`).join('')
      + (waiting ? '<div class="bubble assistant waiting"><span class="spinner"></span> Looking that up…</div>' : '');
    log.scrollTop = log.scrollHeight;
  }
  const drawMeta = a => { meta.innerHTML = a ? `Daily allowance left: <b>${a.chats_left}</b> of ${a.chat_limit} questions · <b>${Math.round(a.tokens_left / 1000)}k</b> tokens (shared with the AI builders)` : ''; };

  async function ask(text) {
    if (!text.trim()) return;
    messages.push({ role: 'user', text: text.trim() });
    input.value = '';
    draw(true);
    const button = box.querySelector('[type=submit]');
    button.disabled = true;
    try {
      const res = await api.post('/api/chat', { messages: messages.slice(-12).map(m => ({ role: m.role, text: m.text })) });
      messages.push({ role: 'assistant', text: res.answer, steps: res.steps, usage: res.usage, error: !res.ok });
      drawMeta(res.allowance);
    } catch (err) {
      messages.push({ role: 'assistant', text: err.message, error: true });
    } finally {
      button.disabled = false;
      save();
      draw();
    }
  }

  box.querySelector('[data-form]').addEventListener('submit', e => { e.preventDefault(); ask(input.value); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); } });
  box.querySelector('[data-ideas]').addEventListener('click', e => { const chip = e.target.closest('[data-idea]'); if (chip) ask(chip.dataset.idea); });
  box.querySelector('[data-clear]').addEventListener('click', () => { messages = []; save(); draw(); });
  draw();
  api.get('/api/planner/status').then(s => drawMeta(s.allowance)).catch(() => drawMeta(null));
}

function addRoleModal(missing, onDone) {
  openModal({
    title: 'Add a role',
    submitLabel: 'Add role',
    narrow: true,
    body: `<p class="muted">Choose the roles to add to your account.</p>
      <div class="role-pick">${missing.map(r => `
        <label class="role-option">
          <input type="checkbox" name="roles" value="${r.key}" ${missing.length === 1 ? 'checked' : ''}>
          <span class="role-icon">${r.icon}</span>
          <span><strong>${r.title}</strong><small>${r.text}</small></span>
          <span class="check" aria-hidden="true">✓</span>
        </label>`).join('')}</div>`,
    async onSubmit(form) {
      const picked = [...form.querySelectorAll('[name=roles]:checked')].map(i => i.value);
      if (!picked.length) throw new Error('Choose at least one role.');
      for (const role of picked) session.user = await api.post('/api/me/roles', { role });
      toast(`${picked.length === 1 ? 'Role' : 'Roles'} added`);
      onDone();
    },
  });
}
