// Log in and create-account pages.
import { api } from '../api.js';
import { session, go } from '../router.js';
import { esc, ROLES, showFormError, submitting } from '../ui.js';
import { boardThumb } from '../field.js';

const LAST_EMAIL = 'touchline:last-email';
const DEMOS = [
  { email: 'coach@example.com', password: 'coach1234', title: 'Demo account', text: 'Coach of Team 1 and Team 2, and also Player 1 and their parent, so you can switch views' },
  { email: 'player@example.com', password: 'player1234', title: 'Player 1', text: 'Player only: Team 1 goalkeeper' },
  { email: 'parent@example.com', password: 'parent1234', title: 'Parent of Player 1', text: 'Parent only: Player 1 on Team 1' },
];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Decorative board on the left of the auth pages: a 4-3-3 with a passing move.
const SHOWCASE = {
  field: 'full',
  pieces: [
    ['gk', 7, 50, '#e8b34c', '1'], ['lb', 22, 18, '#f7f9f5', '3'], ['cb1', 20, 38, '#f7f9f5', '4'], ['cb2', 20, 62, '#f7f9f5', '5'],
    ['rb', 22, 82, '#f7f9f5', '2'], ['cm1', 40, 32, '#f7f9f5', '8'], ['dm', 34, 50, '#f7f9f5', '6'], ['cm2', 40, 68, '#f7f9f5', '10'],
    ['lw', 62, 20, '#f7f9f5', '11'], ['st', 66, 50, '#f7f9f5', '9'], ['rw', 62, 80, '#f7f9f5', '7'],
    ['d1', 74, 40, '#e55c4b', ''], ['d2', 75, 60, '#e55c4b', ''],
  ].map(([id, x, y, color, label]) => ({ id, kind: 'player', x, y, color, label }))
    .concat([{ id: 'b', kind: 'ball', x: 43, y: 36, color: '#f7f9f5', label: '' }]),
  arrows: [
    { id: 'a1', kind: 'pass', x1: 43, y1: 35, x2: 60, y2: 22 },
    { id: 'a2', kind: 'move', x1: 63, y1: 23, x2: 82, y2: 34 },
    { id: 'a3', kind: 'dribble', x1: 68, y1: 52, x2: 84, y2: 50 },
  ],
};

function layout(inner) {
  return `<div class="auth">
    <section class="auth-art">
      <div class="auth-brand"><span class="brandmark">⚽</span> Touchline</div>
      <div class="auth-board" aria-hidden="true">${boardThumb(SHOWCASE)}</div>
      <div class="auth-copy">
        <h2>Every practice, planned.</h2>
        <p>Schedules, rosters, practice plans and a drill whiteboard in one place, for coaches, players and parents.</p>
      </div>
    </section>
    <section class="auth-panel"><div class="auth-card">${inner}</div></section>
  </div>`;
}

export function renderLogin(host) {
  const lastEmail = localStorage.getItem(LAST_EMAIL) || '';
  host.innerHTML = layout(`
    <h1>Log in</h1>
    <p class="muted">Welcome back. Pick up where you left off.</p>
    <form class="stack" id="loginForm" novalidate>
      <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" maxlength="254" value="${esc(lastEmail)}"></label>
      <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="current-password" maxlength="200"></label>
      <p class="form-error" role="alert" hidden></p>
      <button class="btn primary block" type="submit">Log in</button>
    </form>
    <p class="auth-switch">New to Touchline? <a href="#/signup">Create an account</a></p>
    <div class="demo-logins">
      <p class="demo-logins-title">Demo logins</p>
      ${DEMOS.map((d, i) => `
        <div class="demo-box">
          <div><strong>${esc(d.title)}</strong><br><span class="muted small">${esc(d.text)}</span><br><span class="muted small">${esc(d.email)} · ${esc(d.password)}</span></div>
          <button class="btn small${i === 0 ? ' primary' : ''}" type="button" data-demo="${i}">Log in</button>
        </div>`).join('')}
    </div>`);

  const form = host.querySelector('#loginForm');
  const { email, password } = form.elements;
  (lastEmail ? password : email).focus();
  host.querySelectorAll('[data-demo]').forEach(b => b.addEventListener('click', () => {
    const demo = DEMOS[Number(b.dataset.demo)];
    email.value = demo.email;
    password.value = demo.password;
    form.requestSubmit();
  }));
  form.addEventListener('submit', e => {
    e.preventDefault();
    if (!email.value.trim() || !password.value) return showFormError(form, 'Enter your email and password.');
    submitting(form, async () => {
      session.user = await api.post('/api/auth/login', { email: email.value.trim(), password: password.value }, { quiet: true });
      localStorage.setItem(LAST_EMAIL, session.user.email);
      go('/home');
    });
  });
}

export function renderSignup(host) {
  host.innerHTML = layout(`
    <h1>Create your account</h1>
    <p class="muted">One account for every role you have on the team.</p>
    <form class="stack" id="signupForm" novalidate>
      <label class="field"><span>Full name</span><input class="input" name="name" autocomplete="name" maxlength="80"></label>
      <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" maxlength="254"></label>
      <div class="grid-2">
        <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="new-password" maxlength="200"></label>
        <label class="field"><span>Confirm password</span><input class="input" name="confirm" type="password" autocomplete="new-password" maxlength="200"></label>
      </div>
      <p class="hint">Use at least 8 characters.</p>
      <fieldset class="role-pick">
        <legend>Are you a coach, player or parent? <span class="muted">Choose all that apply.</span></legend>
        ${ROLES.map(r => `
          <label class="role-option">
            <input type="checkbox" name="roles" value="${r.key}">
            <span class="role-icon">${r.icon}</span>
            <span><strong>${r.title}</strong><small>${r.text}</small></span>
            <span class="check" aria-hidden="true">✓</span>
          </label>`).join('')}
      </fieldset>
      <p class="form-error" role="alert" hidden></p>
      <button class="btn primary block" type="submit">Create account</button>
    </form>
    <p class="auth-switch">Already have an account? <a href="#/login">Log in</a></p>`);

  const form = host.querySelector('#signupForm');
  const { name, email, password, confirm } = form.elements;
  name.focus();
  form.addEventListener('submit', e => {
    e.preventDefault();
    const roles = [...form.querySelectorAll('[name=roles]:checked')].map(i => i.value);
    const problem =
      !name.value.trim() ? 'Enter your name.' :
      !EMAIL_RE.test(email.value.trim()) ? 'Enter a valid email address.' :
      password.value.length < 8 ? 'Your password needs at least 8 characters.' :
      password.value !== confirm.value ? "The two passwords don't match." :
      !roles.length ? 'Choose at least one role: coach, player or parent.' : '';
    if (problem) return showFormError(form, problem);
    submitting(form, async () => {
      session.user = await api.post('/api/auth/signup', {
        name: name.value.trim(), email: email.value.trim(), password: password.value, roles,
      }, { quiet: true });
      localStorage.setItem(LAST_EMAIL, session.user.email);
      go('/home');
    });
  });
}
