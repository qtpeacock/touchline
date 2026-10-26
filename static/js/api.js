// Thin JSON wrapper around fetch. Errors carry the server's message so forms can show it.

const FIELD_LABELS = { email: 'Email', password: 'Password', name: 'Name', roles: 'Roles', date: 'Date' };

function messageFrom(data, status) {
  const detail = data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0];
    const field = first.loc?.[first.loc.length - 1];
    const label = FIELD_LABELS[field] || (typeof field === 'string' ? field.replace(/_/g, ' ') : '');
    const msg = String(first.msg || '').replace(/^Value error, /, '');
    return label ? `${label}: ${msg}` : msg;
  }
  return `Something went wrong (${status}). Please try again.`;
}

// The page never reloads as you move around the app, so a tab opened before an update would keep running
// the old code. The server sends the app's version with every answer; when it changes, reload once.
let appVersion = null;
function checkVersion(res) {
  const version = res.headers.get('X-App-Version');
  if (!version) return;
  if (appVersion === null) appVersion = version;
  else if (version !== appVersion) {
    appVersion = version;
    const toast = document.getElementById('toast');
    if (toast) { toast.textContent = 'Touchline was updated. Reloading…'; toast.className = 'toast show'; }
    setTimeout(() => location.reload(), 700);
  }
}

async function request(method, url, body, { quiet = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the Touchline server. Is it still running?');
  }
  checkVersion(res);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !quiet) window.dispatchEvent(new CustomEvent('auth-expired'));
    const err = new Error(messageFrom(data, res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body = {}, opts) => request('POST', url, body, opts),
  put: (url, body = {}, opts) => request('PUT', url, body, opts),
  del: (url, opts) => request('DELETE', url, undefined, opts),
};
