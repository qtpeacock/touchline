// Shared UI helpers: escaping, toasts, dialogs, icons and date formatting.

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const toIntOrNull = v => (v === '' || v == null ? null : Number(v));
export const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || '?';

const svg = body => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const icons = {
  calendar: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17M8 14h2M14 14h2M8 17h2"/>'),
  teams: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 19.5c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.6c2.3.2 4 1.7 4.5 4.4"/>'),
  practices: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.8h6V4M8.5 10h7M8.5 13.5h7M8.5 17h4"/>'),
  drills: svg('<rect x="3" y="4" width="7.5" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="7" rx="1.5"/><rect x="13" y="13" width="8" height="7" rx="1.5"/>'),
  whiteboard: svg('<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M12 4v13M12 20.5v-3.5M8 20.5h8"/><circle cx="12" cy="10.5" r="2.2"/>'),
  home: svg('<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>'),
  logout: svg('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16l-4-4 4-4M6 12h10"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  search: svg('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>'),
  select: svg('<path d="M5 3.5 18 11l-5.6 1.4L9.6 18z"/>'),
  run: svg('<path d="M4 12h14M13 7l5 5-5 5"/>'),
  pass: svg('<path d="M4 12h2.5M9 12h2.5M14 12h3M13.5 7.5 18 12l-4.5 4.5"/>'),
  dribble: svg('<path d="M3 12c1.5-3 3-3 4.5 0s3 3 4.5 0 3-3 4.5 0"/><path d="M17 8.5 20.5 12 17 15.5"/>'),
  curve: svg('<path d="M4 18C6 8 13 5 19 7"/><path d="M15 4.5 19.2 7l-2.6 4"/>'),
  mirror: svg('<path d="M12 3v18" stroke-dasharray="2 2.5"/><path d="M9 7 4 12l5 5V7zM15 7l5 5-5 5V7z"/>'),
  sparkle: svg('<path d="M12 3.5l1.8 4.7 4.7 1.8-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>'),
  present: svg('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M10 7.5v5l4-2.5z" fill="currentColor"/><path d="M12 16v3M8 20.5h8"/>'),
  undo: svg('<path d="M9 7 4.5 11.5 9 16"/><path d="M5 11.5h9a5 5 0 0 1 0 10h-2"/>'),
  redo: svg('<path d="m15 7 4.5 4.5L15 16"/><path d="M19 11.5h-9a5 5 0 0 0 0 10h2"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  coach: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.8h6V4"/><path d="M8.5 10.5l2 2 4-4M8.5 16h7"/>'),
  player: svg('<path d="M8 3.5 4 6l1.8 4 2.2-.9V20.5h8V9.1l2.2.9L20 6l-4-2.5c-.6 1.6-2.1 2.6-4 2.6s-3.4-1-4-2.6z"/>'),
  parent: svg('<circle cx="8" cy="6.5" r="2.6"/><circle cx="16.5" cy="9" r="2"/><path d="M3.5 20v-3.8A4.3 4.3 0 0 1 8 12a4.3 4.3 0 0 1 4.3 4.2V20M13.2 20v-2.8a3.3 3.3 0 0 1 6.6 0V20"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  pin: svg('<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
  play: svg('<path d="M7 5v14l11-7z" fill="currentColor"/>'),
  stop: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor"/>'),
};

export const ROLES = [
  { key: 'coach', title: 'Coach', text: 'Plan practices, manage teams and design drills.', icon: icons.coach },
  { key: 'player', title: 'Player', text: 'See your schedule and the drills your coach shares.', icon: icons.player },
  { key: 'parent', title: 'Parent', text: "Follow your child's team, schedule and updates.", icon: icons.parent },
];

let toastTimer;
export function toast(message, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export function showFormError(form, message) {
  const el = form.querySelector('.form-error');
  if (!el) return toast(message, 'error');
  el.textContent = message;
  el.hidden = false;
}

// Runs an async form action with the submit button disabled and errors shown inline.
export async function submitting(form, action) {
  const button = form.querySelector('[type=submit]');
  const error = form.querySelector('.form-error');
  if (error) error.hidden = true;
  if (button) button.disabled = true;
  try {
    await action();
  } catch (err) {
    showFormError(form, err.message);
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * Opens a modal form. `onSubmit(form)` may throw to show an inline error, or return false to keep it open.
 * Returns a function that closes the modal.
 */
export function openModal({ title, body, submitLabel = 'Save', footerLeft = '', narrow = false, onSubmit, onMount }) {
  const dialog = document.createElement('dialog');
  dialog.className = `modal${narrow ? ' narrow' : ''}`;
  dialog.innerHTML = `
    <form class="modal-card" novalidate>
      <header class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
      <div class="modal-body">${body}</div>
      <p class="form-error" role="alert" hidden></p>
      <footer class="modal-foot">${footerLeft}<div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${esc(submitLabel)}</button></div></footer>
    </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const close = () => { if (dialog.open) dialog.close(); dialog.remove(); };
  dialog.addEventListener('close', () => { dialog.remove(); window.removeEventListener('hashchange', close); });
  window.addEventListener('hashchange', close);   // following a link inside the dialog closes it
  dialog.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  form.addEventListener('submit', e => {
    e.preventDefault();
    submitting(form, async () => {
      if (await onSubmit?.(form) !== false) close();
    });
  });
  onMount?.(dialog, close);
  dialog.showModal();
  dialog.querySelector('.modal-body input:not([type=radio]):not([type=hidden]), .modal-body select, .modal-body textarea')?.focus();
  return close;
}

export function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Delete', danger = true } = {}) {
  return new Promise(resolve => {
    let answered = false;
    const close = openModal({
      title, narrow: true, submitLabel: confirmLabel,
      body: `<p>${esc(message)}</p>`,
      onSubmit: () => { answered = true; resolve(true); },
      onMount: dialog => {
        if (danger) dialog.querySelector('[type=submit]').classList.add('danger-fill');
        dialog.addEventListener('close', () => { if (!answered) resolve(false); });
      },
    });
    return close;
  });
}

// ---------- dates (all local time, stored as YYYY-MM-DD and HH:MM) ----------
const pad = n => String(n).padStart(2, '0');
export const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDate = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
export const todayISO = () => isoDate(new Date());
export const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function fmtTime(hm) {
  if (!hm) return '';
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}
export function fmtTimeShort(hm) {
  if (!hm) return '';
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + pad(m) : ''}${h >= 12 ? 'p' : 'a'}`;
}
export const fmtRange = (start, end) => (!start ? 'Time TBD' : end ? `${fmtTime(start)} – ${fmtTime(end)}` : fmtTime(start));
export const fmtDate = (iso, opts = { weekday: 'long', month: 'long', day: 'numeric' }) => parseDate(iso).toLocaleDateString(undefined, opts);

export function relativeDay(iso) {
  const days = Math.round((parseDate(iso) - parseDate(todayISO())) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 0) return `${-days} days ago`;
  return `In ${days} days`;
}

export function eventTitle(ev) {
  if (ev.title) return ev.title;
  const team = ev.team_name || 'Team';
  return ev.kind === 'game' ? `${team} vs ${ev.opponent || 'TBD'}` : `${team} practice`;
}

// True if the event has not finished yet.
export function isUpcoming(ev) {
  const today = todayISO();
  if (ev.date !== today) return ev.date > today;
  const t = ev.end_time || ev.start_time;
  return !t || t >= nowHM();
}
