// Bootstrap: fetch the public config, sign in, then show the shell.
import { fetchStatus, api, setAuthHandlers } from './api.js';
import { setCognitoConfig, getToken, setToken, clearToken, signIn, completeNewPassword } from './auth.js';
import { closeDrawer, toast } from './ui.js';

import * as simulations from './views/simulations.js';
import * as files from './views/files.js';
import * as users from './views/users.js';

const dom = {
  auth: document.getElementById('auth'),
  authError: document.getElementById('auth-error'),
  authSubtitle: document.getElementById('auth-subtitle'),
  signinForm: document.getElementById('signin-form'),
  signinButton: document.getElementById('signin-button'),
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  newPasswordField: document.getElementById('new-password-field'),
  newPassword: document.getElementById('new-password'),
  denied: document.getElementById('denied'),
  deniedMessage: document.getElementById('denied-message'),
  deniedSignout: document.getElementById('denied-signout'),
  shell: document.getElementById('shell'),
  main: document.getElementById('main'),
  nav: document.getElementById('nav'),
  who: document.getElementById('who'),
  brandEnv: document.getElementById('brand-env'),
  signout: document.getElementById('signout')
};

const views = {
  simulations: { module: simulations, counter: document.getElementById('count-simulations') },
  files: { module: files, counter: document.getElementById('count-files') },
  users: { module: users, counter: document.getElementById('count-users') }
};

let challengeSession = null;
let currentView = null;

/* --- Screens ------------------------------------------------------------ */

function showSignIn(message) {
  dom.auth.hidden = false;
  dom.denied.hidden = true;
  dom.shell.hidden = true;
  closeDrawer();
  if (message) showAuthError(message);
}

function showDenied(message) {
  dom.auth.hidden = true;
  dom.denied.hidden = false;
  dom.shell.hidden = true;
  closeDrawer();
  dom.deniedMessage.textContent = message
    || 'This account is not a member of the administrators group.';
}

function showShell(me) {
  dom.auth.hidden = true;
  dom.denied.hidden = true;
  dom.shell.hidden = false;
  dom.who.textContent = me.email;
  dom.brandEnv.textContent = me.region;
  dom.brandEnv.title = me.bucketName;
}

function showAuthError(message) {
  dom.authError.textContent = message;
  dom.authError.hidden = false;
}

function clearAuthError() {
  dom.authError.hidden = true;
  dom.authError.textContent = '';
}

/* --- Navigation --------------------------------------------------------- */

function selectView(name, { refresh = false } = {}) {
  if (!views[name]) name = 'simulations';
  currentView = name;
  closeDrawer();

  for (const button of dom.nav.querySelectorAll('button')) {
    if (button.dataset.view === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  if (location.hash.slice(1) !== name) {
    history.replaceState(null, '', `#${name}`);
  }

  views[name].module.render({ refresh }).catch((err) => toast(err.message, 'error'));
}

dom.nav.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (button) selectView(button.dataset.view);
});

window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (name && name !== currentView) selectView(name);
});

/* --- Sign in / out ------------------------------------------------------ */

function signOut() {
  clearToken();
  challengeSession = null;
  dom.signinForm.reset();
  dom.newPasswordField.hidden = true;
  for (const view of Object.values(views)) view.counter.textContent = '';
  showSignIn();
}

dom.signout.addEventListener('click', signOut);
dom.deniedSignout.addEventListener('click', signOut);

dom.signinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearAuthError();
  dom.signinButton.disabled = true;
  dom.signinButton.textContent = challengeSession ? 'Setting password…' : 'Signing in…';

  try {
    const email = dom.email.value.trim();
    const result = challengeSession
      ? await completeNewPassword(email, dom.newPassword.value, challengeSession)
      : await signIn(email, dom.password.value);

    if (result.status === 'new-password-required') {
      // First sign-in for an invited account: Cognito wants a permanent
      // password before it will issue tokens.
      challengeSession = result.session;
      dom.password.value = '';
      dom.newPasswordField.hidden = false;
      dom.authSubtitle.textContent = 'Set a permanent password to finish signing in.';
      dom.newPassword.focus();
      return;
    }

    setToken(result.idToken);
    challengeSession = null;
    await enterApp();
  } catch (err) {
    showAuthError(err.message || 'Sign-in failed. Check your email and password.');
  } finally {
    dom.signinButton.disabled = false;
    dom.signinButton.textContent = challengeSession ? 'Set password' : 'Sign in';
  }
});

/* --- Startup ------------------------------------------------------------ */

async function enterApp() {
  // /me is checked before the shell is shown, so someone who authenticates
  // successfully but is not in the admin group gets a clear explanation
  // immediately rather than a shell where every view fails.
  const me = await api('/me');
  showShell(me);
  selectView(location.hash.slice(1) || 'simulations');
}

async function start() {
  setAuthHandlers({
    unauthenticated: () => showSignIn('Your session has expired. Sign in again.'),
    forbidden: (message) => showDenied(message)
  });

  for (const view of Object.values(views)) {
    view.module.init({
      mount: dom.main,
      onCount: (count) => { view.counter.textContent = count; }
    });
  }

  let status;
  try {
    status = await fetchStatus();
  } catch (err) {
    showAuthError(err.message);
    return;
  }
  setCognitoConfig(status.cognito);
  dom.deniedMessage.textContent = `This account is not a member of the "${status.adminGroup}" group.`;

  if (!getToken()) {
    showSignIn();
    return;
  }

  try {
    await enterApp();
  } catch {
    // setAuthHandlers has already routed this to the sign-in or denied screen.
  }
}

start();
