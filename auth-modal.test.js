/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

const MAIN_JS = fs.readFileSync(path.resolve(__dirname, 'frontend/cfd/js/main.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.resolve(__dirname, 'frontend/cfd/index.html'), 'utf8');

// Pull the auth helpers straight out of main.js rather than restating them here,
// so these tests fail if the shipped implementation drifts. main.js is an ES
// module that imports Three.js and boots the whole app, so it can't simply be
// required into jsdom.
function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + 1);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Could not extract ${label} from main.js — have the markers moved?`);
  }
  return source.slice(start, end);
}

const authHelpersSource = sliceBetween(
  MAIN_JS,
  'const AUTH_SUBMIT_LABELS = {',
  '// Bind Auth UI event listeners',
  'auth form helpers'
);
const showAuthErrorSource = sliceBetween(
  MAIN_JS,
  'function showAuthError(msg) {',
  '// --- CFD Simulation Runner Client Logic ---',
  'showAuthError'
);

const COGNITO_CONFIG = { clientId: 'test-client-id', region: 'eu-west-2' };

// Rebuild the module scope main.js gives these helpers: the auth element
// consts, the mutable auth state, and `fetch`.
function loadAuthModule(fetchImpl) {
  document.documentElement.innerHTML = INDEX_HTML;

  const factory = new Function('deps', `
    const { authEmail, authPassword, authError, authNotice, btnLoginSubmit,
            authNewPassword, authResetCode, authResetPassword } = deps;
    const fetch = deps.fetch;
    let cognitoConfig = deps.cognitoConfig;
    let authFormMode = 'signin';
    let resetEmail = null;
    let authSession = null;
    let challengeEmail = null;

    ${authHelpersSource}
    ${showAuthErrorSource}

    return {
      AUTH_SUBMIT_LABELS,
      MIN_PASSWORD_LENGTH,
      setAuthFormMode,
      resetAuthForm,
      clearAuthMessages,
      showAuthNotice,
      showAuthError,
      resetErrorMessage,
      cognitoRequest,
      requestPasswordReset,
      getMode: () => authFormMode,
      getResetEmail: () => resetEmail
    };
  `);

  const el = (id) => document.getElementById(id);
  return factory({
    authEmail: el('auth-email'),
    authPassword: el('auth-password'),
    authError: el('auth-error'),
    authNotice: el('auth-notice'),
    btnLoginSubmit: el('btn-login-submit'),
    authNewPassword: el('auth-new-password'),
    authResetCode: el('auth-reset-code'),
    authResetPassword: el('auth-reset-password'),
    fetch: fetchImpl,
    cognitoConfig: COGNITO_CONFIG
  });
}

// A Cognito-shaped error response: HTTP 400 with a __type of "prefix#Name".
function cognitoErrorResponse(type, message) {
  return {
    ok: false,
    status: 400,
    json: async () => ({ __type: `com.amazon.coral.service#${type}`, message })
  };
}

function cognitoOkResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

const isVisible = (el) => el.style.display !== 'none';

// jsdom does no layout, so `offsetParent` and computed styles tell us nothing.
// Visibility here means the inline `display` that setAuthFormMode toggles, on
// the element or any ancestor up to the form — stopping at the form so the
// enclosing modal's own hidden state doesn't count.
function isVisibleInForm(el) {
  let node = el;
  while (node && node.id !== 'auth-form') {
    if (node.style && node.style.display === 'none') return false;
    node = node.parentElement;
  }
  return true;
}

describe('Auth modal markup', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = INDEX_HTML;
  });

  // main.js looks all of these up by id; renaming one side only would break the
  // form at runtime without any other test noticing.
  it.each([
    'auth-email',
    'auth-password',
    'auth-error',
    'auth-notice',
    'btn-login-submit',
    'auth-new-password',
    'auth-reset-code',
    'auth-reset-password',
    'auth-forgot-link',
    'auth-back-link',
    'auth-resend-code-link',
    'auth-forgot-row',
    'auth-back-row',
    'reset-fields',
    'reset-request-hint',
    'reset-destination-text',
    'challenge-fields'
  ])('exposes #%s for main.js to bind to', (id) => {
    expect(document.getElementById(id)).toBeTruthy();
  });

  it('starts on the sign-in face, with the reset and challenge blocks hidden', () => {
    expect(isVisible(document.getElementById('auth-forgot-row'))).toBe(true);
    expect(isVisible(document.getElementById('reset-fields'))).toBe(false);
    expect(isVisible(document.getElementById('reset-request-hint'))).toBe(false);
    expect(isVisible(document.getElementById('challenge-fields'))).toBe(false);
    expect(isVisible(document.getElementById('auth-back-row'))).toBe(false);
    expect(document.getElementById('btn-login-submit').textContent).toBe('Sign In');
  });

  it('marks only the sign-in inputs as required in the initial markup', () => {
    expect(document.getElementById('auth-email').required).toBe(true);
    expect(document.getElementById('auth-password').required).toBe(true);
    expect(document.getElementById('auth-reset-code').required).toBe(false);
    expect(document.getElementById('auth-reset-password').required).toBe(false);
    expect(document.getElementById('auth-new-password').required).toBe(false);
  });

  it('does not offer the reset link as a nested form submit button', () => {
    // A bare <button> inside a form defaults to type="submit", which would fire
    // the sign-in handler instead of switching modes.
    expect(document.getElementById('auth-forgot-link').type).toBe('button');
    expect(document.getElementById('auth-back-link').type).toBe('button');
    expect(document.getElementById('auth-resend-code-link').type).toBe('button');
  });
});

describe('setAuthFormMode', () => {
  let auth;

  beforeEach(() => {
    auth = loadAuthModule();
  });

  const group = (input) => input.closest('.form-group');

  it('shows email and password on the sign-in face', () => {
    auth.setAuthFormMode('signin');

    expect(isVisible(group(document.getElementById('auth-email')))).toBe(true);
    expect(isVisible(group(document.getElementById('auth-password')))).toBe(true);
    expect(isVisible(document.getElementById('auth-forgot-row'))).toBe(true);
    expect(isVisible(document.getElementById('auth-back-row'))).toBe(false);
    expect(isVisible(document.getElementById('reset-fields'))).toBe(false);
    expect(document.getElementById('btn-login-submit').textContent).toBe('Sign In');
  });

  it('asks only for the email address on the reset-request face', () => {
    auth.setAuthFormMode('forgotRequest');

    expect(isVisible(group(document.getElementById('auth-email')))).toBe(true);
    expect(isVisible(group(document.getElementById('auth-password')))).toBe(false);
    expect(isVisible(document.getElementById('reset-request-hint'))).toBe(true);
    expect(isVisible(document.getElementById('reset-fields'))).toBe(false);
    expect(isVisible(document.getElementById('auth-forgot-row'))).toBe(false);
    expect(isVisible(document.getElementById('auth-back-row'))).toBe(true);
    expect(document.getElementById('btn-login-submit').textContent).toBe('Send Reset Code');
  });

  it('asks for the code and a new password on the reset-confirm face', () => {
    auth.setAuthFormMode('forgotConfirm');

    expect(isVisible(group(document.getElementById('auth-email')))).toBe(false);
    expect(isVisible(group(document.getElementById('auth-password')))).toBe(false);
    expect(isVisible(document.getElementById('reset-fields'))).toBe(true);
    expect(isVisible(document.getElementById('reset-request-hint'))).toBe(false);
    expect(isVisible(document.getElementById('auth-back-row'))).toBe(true);
    expect(document.getElementById('btn-login-submit').textContent).toBe('Reset Password');
  });

  it('shows the first-run challenge block on the newPassword face', () => {
    auth.setAuthFormMode('newPassword');

    expect(isVisible(document.getElementById('challenge-fields'))).toBe(true);
    expect(isVisible(group(document.getElementById('auth-email')))).toBe(false);
    expect(isVisible(group(document.getElementById('auth-password')))).toBe(false);
    expect(isVisible(document.getElementById('reset-fields'))).toBe(false);
    expect(isVisible(document.getElementById('auth-forgot-row'))).toBe(false);
    expect(document.getElementById('btn-login-submit').textContent).toBe('Confirm New Password');
  });

  it.each([
    ['signin', { email: true, password: true, newPassword: false, code: false, resetPassword: false }],
    ['newPassword', { email: false, password: false, newPassword: true, code: false, resetPassword: false }],
    ['forgotRequest', { email: true, password: false, newPassword: false, code: false, resetPassword: false }],
    ['forgotConfirm', { email: false, password: false, newPassword: false, code: true, resetPassword: true }]
  ])('sets the required flags for %s', (mode, expected) => {
    auth.setAuthFormMode(mode);

    expect(document.getElementById('auth-email').required).toBe(expected.email);
    expect(document.getElementById('auth-password').required).toBe(expected.password);
    expect(document.getElementById('auth-new-password').required).toBe(expected.newPassword);
    expect(document.getElementById('auth-reset-code').required).toBe(expected.code);
    expect(document.getElementById('auth-reset-password').required).toBe(expected.resetPassword);
  });

  // A `required` input that is display:none blocks submit with a validation
  // bubble the browser cannot anchor anywhere the user can see, which wedges
  // the form. No mode may ever leave one behind.
  it.each(['signin', 'newPassword', 'forgotRequest', 'forgotConfirm'])(
    'leaves no hidden input marked required in %s',
    (mode) => {
      auth.setAuthFormMode(mode);

      const hiddenRequired = Array.from(document.querySelectorAll('#auth-form input'))
        .filter((input) => input.required && !isVisibleInForm(input))
        .map((input) => input.id);

      expect(hiddenRequired).toEqual([]);
    }
  );

  it('re-enables the submit button when switching modes', () => {
    const submit = document.getElementById('btn-login-submit');
    submit.disabled = true;

    auth.setAuthFormMode('forgotConfirm');

    expect(submit.disabled).toBe(false);
  });

  it('round-trips back to a clean sign-in face', () => {
    auth.setAuthFormMode('forgotRequest');
    auth.setAuthFormMode('forgotConfirm');
    auth.setAuthFormMode('signin');

    const group_ = (id) => document.getElementById(id).closest('.form-group');
    expect(isVisible(group_('auth-email'))).toBe(true);
    expect(isVisible(group_('auth-password'))).toBe(true);
    expect(isVisible(document.getElementById('reset-fields'))).toBe(false);
    expect(isVisible(document.getElementById('reset-request-hint'))).toBe(false);
    expect(document.getElementById('auth-reset-code').required).toBe(false);
  });
});

describe('resetAuthForm', () => {
  let auth;

  beforeEach(() => {
    auth = loadAuthModule();
  });

  it('clears the secret fields and returns to sign-in', () => {
    auth.setAuthFormMode('forgotConfirm');
    document.getElementById('auth-password').value = 'old-password';
    document.getElementById('auth-reset-code').value = '123456';
    document.getElementById('auth-reset-password').value = 'a-new-password';
    document.getElementById('auth-new-password').value = 'a-new-password';

    auth.resetAuthForm();

    expect(auth.getMode()).toBe('signin');
    expect(document.getElementById('auth-password').value).toBe('');
    expect(document.getElementById('auth-reset-code').value).toBe('');
    expect(document.getElementById('auth-reset-password').value).toBe('');
    expect(document.getElementById('auth-new-password').value).toBe('');
  });

  it('keeps the email address so a user who just reset need not retype it', () => {
    document.getElementById('auth-email').value = 'pupil@example.com';

    auth.resetAuthForm();

    expect(document.getElementById('auth-email').value).toBe('pupil@example.com');
  });

  it('hides both the error and the notice', () => {
    auth.showAuthError('something went wrong');
    auth.showAuthNotice('something happened');

    auth.resetAuthForm();

    expect(isVisible(document.getElementById('auth-error'))).toBe(false);
    expect(isVisible(document.getElementById('auth-notice'))).toBe(false);
  });

  it('drops the in-flight reset email', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      cognitoOkResponse({ CodeDeliveryDetails: { Destination: 'p***@e***' } })
    );
    const scoped = loadAuthModule(fetchMock);
    await scoped.requestPasswordReset('pupil@example.com');
    expect(scoped.getResetEmail()).toBe('pupil@example.com');

    scoped.resetAuthForm();

    expect(scoped.getResetEmail()).toBeNull();
  });
});

describe('showAuthError', () => {
  let auth;

  beforeEach(() => {
    auth = loadAuthModule();
  });

  it('displays the message and re-enables the button', () => {
    document.getElementById('btn-login-submit').disabled = true;

    auth.showAuthError('Incorrect username or password.');

    const error = document.getElementById('auth-error');
    expect(error.textContent).toBe('Incorrect username or password.');
    expect(isVisible(error)).toBe(true);
    expect(document.getElementById('btn-login-submit').disabled).toBe(false);
  });

  // The button label is mid-flight ("Resetting...") when an error lands, so it
  // has to be restored to the label for the mode actually on screen.
  it.each([
    ['signin', 'Sign In'],
    ['newPassword', 'Confirm New Password'],
    ['forgotRequest', 'Send Reset Code'],
    ['forgotConfirm', 'Reset Password']
  ])('restores the %s submit label', (mode, label) => {
    auth.setAuthFormMode(mode);
    document.getElementById('btn-login-submit').textContent = 'Resetting...';

    auth.showAuthError('nope');

    expect(document.getElementById('btn-login-submit').textContent).toBe(label);
  });
});

describe('showAuthNotice and clearAuthMessages', () => {
  let auth;

  beforeEach(() => {
    auth = loadAuthModule();
  });

  it('shows the notice text', () => {
    auth.showAuthNotice('Reset codes expire after 24 hours.');

    const notice = document.getElementById('auth-notice');
    expect(notice.textContent).toBe('Reset codes expire after 24 hours.');
    expect(isVisible(notice)).toBe(true);
  });

  it('hides both banners', () => {
    auth.showAuthNotice('hello');
    auth.showAuthError('goodbye');

    auth.clearAuthMessages();

    expect(isVisible(document.getElementById('auth-notice'))).toBe(false);
    expect(isVisible(document.getElementById('auth-error'))).toBe(false);
  });
});

describe('cognitoRequest', () => {
  it('posts AWS JSON 1.1 with the operation in X-Amz-Target', async () => {
    const fetchMock = jest.fn().mockResolvedValue(cognitoOkResponse({ ok: true }));
    const auth = loadAuthModule(fetchMock);

    await auth.cognitoRequest('ForgotPassword', { ClientId: 'abc', Username: 'x' }, 'fallback');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cognito-idp.eu-west-2.amazonaws.com/');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/x-amz-json-1.1');
    expect(options.headers['X-Amz-Target'])
      .toBe('AWSCognitoIdentityProviderService.ForgotPassword');
    expect(JSON.parse(options.body)).toEqual({ ClientId: 'abc', Username: 'x' });
  });

  it('never sends a SecretHash — this app client is public and has no secret', async () => {
    const fetchMock = jest.fn().mockResolvedValue(cognitoOkResponse({}));
    const auth = loadAuthModule(fetchMock);

    await auth.cognitoRequest('ForgotPassword', { ClientId: 'abc', Username: 'x' }, 'fallback');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('SecretHash');
  });

  it('returns the parsed body on success', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      cognitoOkResponse({ CodeDeliveryDetails: { Destination: 'a***@e***' } })
    );
    const auth = loadAuthModule(fetchMock);

    const data = await auth.cognitoRequest('ForgotPassword', {}, 'fallback');

    expect(data.CodeDeliveryDetails.Destination).toBe('a***@e***');
  });

  // Cognito returns HTTP 400 with the error name after a "#" in __type; the
  // reset error messages key off that, so the parse has to be exact.
  it('parses __type into a bare error code', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      cognitoErrorResponse('CodeMismatchException', 'Invalid verification code provided, please try again.')
    );
    const auth = loadAuthModule(fetchMock);

    await expect(auth.cognitoRequest('ConfirmForgotPassword', {}, 'fallback'))
      .rejects.toMatchObject({
        code: 'CodeMismatchException',
        message: 'Invalid verification code provided, please try again.'
      });
  });

  it('falls back to the supplied message when the body carries none', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ __type: 'x#InternalErrorException' })
    });
    const auth = loadAuthModule(fetchMock);

    await expect(auth.cognitoRequest('InitiateAuth', {}, 'Cognito authentication failed'))
      .rejects.toThrow('Cognito authentication failed');
  });

  it('survives a non-JSON error body', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); }
    });
    const auth = loadAuthModule(fetchMock);

    await expect(auth.cognitoRequest('ForgotPassword', {}, 'Could not start the password reset.'))
      .rejects.toThrow('Could not start the password reset.');
  });
});

describe('resetErrorMessage', () => {
  let auth;

  beforeEach(() => {
    auth = loadAuthModule();
  });

  it('explains that a never-signed-in account cannot self-reset', () => {
    const msg = auth.resetErrorMessage({ code: 'NotAuthorizedException' }, 'request');

    expect(msg).toMatch(/temporary password from your invitation email/i);
  });

  // InvalidParameterException means "no verified email" when asking for a code,
  // but something else entirely once a code is in play.
  it('reads InvalidParameterException as a missing verified email at the request stage', () => {
    const msg = auth.resetErrorMessage(
      { code: 'InvalidParameterException', message: 'raw cognito text' },
      'request'
    );

    expect(msg).toMatch(/no verified email address/i);
  });

  it('passes InvalidParameterException through at the confirm stage', () => {
    const msg = auth.resetErrorMessage(
      { code: 'InvalidParameterException', message: 'raw cognito text' },
      'confirm'
    );

    expect(msg).toBe('raw cognito text');
  });

  it.each([
    ['CodeMismatchException', /code is not correct/i],
    ['ExpiredCodeException', /expired/i],
    ['PasswordHistoryPolicyViolationException', /not used before/i],
    ['CodeDeliveryFailureException', /could not be delivered/i],
    ['LimitExceededException', /too many attempts/i],
    ['TooManyRequestsException', /too many attempts/i],
    ['TooManyFailedAttemptsException', /too many attempts/i]
  ])('maps %s onto actionable text', (code, pattern) => {
    expect(auth.resetErrorMessage({ code }, 'confirm')).toMatch(pattern);
  });

  // InvalidPasswordException carries the pool's actual policy wording, which is
  // more useful than anything we could write here.
  it('passes an unmapped Cognito message through untouched', () => {
    const msg = auth.resetErrorMessage(
      { code: 'InvalidPasswordException', message: 'Password did not conform with policy: must have numeric characters' },
      'confirm'
    );

    expect(msg).toBe('Password did not conform with policy: must have numeric characters');
  });

  it('falls back to generic text when there is no message at all', () => {
    expect(auth.resetErrorMessage({ code: 'SomethingNew' }, 'confirm')).toBe('Password reset failed.');
  });
});

describe('requestPasswordReset', () => {
  it('sends ForgotPassword with the app client id and the email as username', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      cognitoOkResponse({ CodeDeliveryDetails: { Destination: 'p***@e***' } })
    );
    const auth = loadAuthModule(fetchMock);

    await auth.requestPasswordReset('pupil@example.com');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ ClientId: 'test-client-id', Username: 'pupil@example.com' });
    expect(fetchMock.mock.calls[0][1].headers['X-Amz-Target'])
      .toBe('AWSCognitoIdentityProviderService.ForgotPassword');
  });

  it('returns the masked destination Cognito reports', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      cognitoOkResponse({ CodeDeliveryDetails: { Destination: 'p***@e***' } })
    );
    const auth = loadAuthModule(fetchMock);

    await expect(auth.requestPasswordReset('pupil@example.com')).resolves.toBe('p***@e***');
    expect(auth.getResetEmail()).toBe('pupil@example.com');
  });

  it('returns null when Cognito reports no delivery details', async () => {
    const fetchMock = jest.fn().mockResolvedValue(cognitoOkResponse({}));
    const auth = loadAuthModule(fetchMock);

    await expect(auth.requestPasswordReset('pupil@example.com')).resolves.toBeNull();
  });

  // Account enumeration guard: an address with no account must reach the same
  // "code sent" screen as a real one. Cognito's own "prevent user existence
  // errors" option does this server-side, but it is a per-app-client setting
  // that can be switched off, so the UI must not depend on it.
  it('treats UserNotFoundException as success and reveals nothing', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      cognitoErrorResponse('UserNotFoundException', 'User does not exist.')
    );
    const auth = loadAuthModule(fetchMock);

    await expect(auth.requestPasswordReset('nobody@example.com')).resolves.toBeNull();
    expect(auth.getResetEmail()).toBe('nobody@example.com');
  });

  it.each([
    'NotAuthorizedException',
    'InvalidParameterException',
    'LimitExceededException',
    'CodeDeliveryFailureException'
  ])('propagates %s so the form can explain it', async (code) => {
    const fetchMock = jest.fn().mockResolvedValue(cognitoErrorResponse(code, 'nope'));
    const auth = loadAuthModule(fetchMock);

    await expect(auth.requestPasswordReset('pupil@example.com'))
      .rejects.toMatchObject({ code });
  });
});
