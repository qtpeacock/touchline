// The coach layout: "Welcome Coach!" sidebar with Calendar, Teams (with team dropdown), Practices, Drills, Whiteboard.
import { api } from '../api.js';
import { session, go, logout } from '../router.js';
import { esc, icons } from '../ui.js';
import { openTeamModal } from './teams.js';

export function ensureCoachShell(app) {
  if (app.dataset.shell === 'coach' && app.coachShell?.page.isConnected) return app.coachShell;
  app.dataset.shell = 'coach';
  app.innerHTML = `
    <div class="coach-app">
      <aside class="sidebar">
        <div class="welcome">
          <span class="brandmark">⚽</span>
          <div><div class="welcome-title">Welcome Coach!</div><div class="welcome-sub">${esc(session.user.name)}</div></div>
        </div>
        <nav aria-label="Coach tools">
          <a class="nav-item" data-nav="calendar" href="#/coach/calendar" title="Calendar">${icons.calendar}<span>Calendar</span></a>
          <div class="nav-group" data-group="teams">
            <button class="nav-item" data-nav="teams" type="button" aria-expanded="false" title="Teams">${icons.teams}<span>Teams</span><span class="caret">▾</span></button>
            <div class="subnav" hidden>
              <div class="subnav-list"></div>
              <button class="subnav-item add" type="button" data-add-team title="Add team">＋ <span class="sub-label">Add team</span></button>
            </div>
          </div>
          <a class="nav-item" data-nav="practices" href="#/coach/practices" title="Practices">${icons.practices}<span>Practices</span></a>          <a class="nav-item" data-nav="drills" href="#/coach/drills" title="Drills">${icons.drills}<span>Drills</span></a>
          <a class="nav-item" data-nav="whiteboard" href="#/coach/whiteboard" title="Whiteboard">${icons.whiteboard}<span>Whiteboard</span></a>
        </nav>
        <div class="side-foot">
          <a class="nav-item minor" href="#/home" title="Account home">${icons.home}<span>Account home</span></a>
          <button class="nav-item minor" type="button" data-logout title="Log out">${icons.logout}<span>Log out</span></button>
        </div>
      </aside>
      <main class="page" id="page"></main>
    </div>`;

  const group = app.querySelector('[data-group=teams]');
  const teamsButton = group.querySelector('[data-nav=teams]');
  const subnav = group.querySelector('.subnav');
  const subList = group.querySelector('.subnav-list');
  let active = { section: '', id: null };

  function setExpanded(open) {
    subnav.hidden = !open;
    group.classList.toggle('open', open);
    teamsButton.setAttribute('aria-expanded', String(open));
  }

  function markActive() {
    app.querySelectorAll('[data-nav]').forEach(el => el.classList.toggle('active', el.dataset.nav === active.section));
    subList.querySelectorAll('[data-team]').forEach(el => el.classList.toggle('active', active.section === 'teams' && el.dataset.team === String(active.id)));
  }

  async function refreshTeams() {
    try {
      const teams = await api.get('/api/teams');
      subList.innerHTML = teams.length
        ? teams.map(t => `<a class="subnav-item" data-team="${t.id}" href="#/coach/teams/${t.id}" title="${esc(t.name)}"><span class="team-dot" style="background:${esc(t.color)}"></span><span class="sub-label">${esc(t.name)}</span></a>`).join('')
        : '<p class="subnav-empty sub-label">No teams yet</p>';
      markActive();
    } catch { /* sidebar list is a convenience; the teams page shows errors */ }
  }

  // Teams opens the all-teams page and drops down the team list; clicking it again on that page folds it away.
  teamsButton.addEventListener('click', () => {
    const onTeamsPage = active.section === 'teams' && !active.id;
    if (onTeamsPage && !subnav.hidden) setExpanded(false);
    else setExpanded(true);
    if (!onTeamsPage) go('/coach/teams');
  });
  group.querySelector('[data-add-team]').addEventListener('click', () => openTeamModal({
    onSaved: team => { refreshTeams(); go(`/coach/teams/${team.id}`); },
  }));
  app.querySelector('[data-logout]').addEventListener('click', logout);

  const shell = {
    page: app.querySelector('#page'),
    refreshTeams,
    setActive(section, id) {
      active = { section, id: id ?? null };
      if (section === 'teams') setExpanded(true);
      markActive();
    },
  };
  app.coachShell = shell;
  refreshTeams();
  return shell;
}
