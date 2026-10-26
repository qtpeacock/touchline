// Hash routing and the signed-in user, shared by every view.
import { api } from './api.js';

export const session = { user: null };

let routeHandler = () => {};
export function setRouteHandler(fn) { routeHandler = fn; }

export function go(path) {
  const target = '#' + path;
  if (location.hash === target) routeHandler();
  else location.hash = target;
}

// Change the address bar without re-rendering (e.g. after a new drill gets its id).
export function replacePath(path) {
  history.replaceState(null, '', '#' + path);
}

export async function logout() {
  try { await api.post('/api/auth/logout', {}, { quiet: true }); } catch { /* already signed out */ }
  session.user = null;
  go('/login');
}
