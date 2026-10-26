// App entry point: restores the session, then routes between the auth pages, account home and coach tools.
import { api } from './api.js';
import { session, setRouteHandler, go } from './router.js';
import { toast } from './ui.js';
import { renderLogin, renderSignup } from './views/auth.js';
import { renderHome } from './views/home.js';
import { renderFamily } from './views/family.js';
import { ensureCoachShell } from './views/shell.js';
import { renderCalendar } from './views/calendar.js';
import { renderTeams } from './views/teams.js';
import { renderPractices } from './views/practices.js';
import { renderDrills } from './views/drills.js';
import { renderWhiteboard } from './views/whiteboard.js';

const app = document.getElementById('app');
const COACH_VIEWS = {
  calendar: renderCalendar,
  teams: renderTeams,
  practices: renderPractices,
  drills: renderDrills,
  whiteboard: renderWhiteboard,
};
let cleanup = null;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(query) };
}

// A full-page view outside the coach sidebar.
function plainPage() {
  delete app.dataset.shell;
  const host = document.createElement('div');
  app.replaceChildren(host);
  return host;
}

async function renderCoach([section = 'calendar', id, sub], query) {
  if (!session.user.roles.includes('coach')) {
    toast('Add the Coach role to your account first');
    return go('/home');
  }
  const view = COACH_VIEWS[section];
  if (!view) return go('/coach/calendar');
  const shell = ensureCoachShell(app);
  shell.setActive(section, id);
  // Each visit renders into a fresh host, so a slow, superseded render can't overwrite a newer page.
  const host = document.createElement('div');
  host.className = 'page-inner';
  shell.page.replaceChildren(host);
  const result = await view(host, { id, sub, query, shell });
  if (typeof result === 'function') {
    if (host.isConnected) cleanup = result;
    else result();
  }
}

async function route() {
  const { parts, query } = parseHash();
  const [top, ...rest] = parts;
  const isPublic = top === 'login' || top === 'signup';
  if (!session.user && !isPublic) return go('/login');
  if (session.user && (isPublic || !top)) return go('/home');

  if (cleanup) {
    try { cleanup(); } catch (err) { console.error(err); }
    cleanup = null;
  }
  window.scrollTo(0, 0);
  try {
    switch (top) {
      case 'login': return renderLogin(plainPage());
      case 'signup': return renderSignup(plainPage());
      case 'home': return renderHome(plainPage());
      case 'player':
      case 'parent': return await renderFamily(plainPage(), top);
      case 'coach': return await renderCoach(rest, query);
      default: return go('/home');
    }
  } catch (err) {
    console.error(err);
    toast(err.message || 'Something went wrong', 'error');
  }
}

window.addEventListener('auth-expired', () => {
  if (!session.user) return;
  session.user = null;
  toast('Your session ended. Please log in again.');
  go('/login');
});
setRouteHandler(route);
window.addEventListener('hashchange', route);

try {
  session.user = (await api.get('/api/session')).user;
} catch (err) {
  session.user = null;
  toast(err.message, 'error');
}
route();
