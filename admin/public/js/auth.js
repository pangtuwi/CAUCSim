// Cognito sign-in for the admin app.
//
// The flow is the same one frontend/cfd/js/main.js uses — USER_PASSWORD_AUTH
// straight from the browser against the public app client, plus the
// NEW_PASSWORD_REQUIRED challenge — and cognitoRequest is lifted from there
// deliberately: duplicating fifteen lines beats coupling the two apps together.
//
// The token is stored under its own key. Different ports are different origins
// today so there is no collision, but if the admin app is ever mounted on the
// same host under /admin, a shared key would have the two apps overwriting each
// other's sessions.
const TOKEN_KEY = 'caucsim_admin_id_token';

let cognitoConfig = null;

export function setCognitoConfig(config) {
  cognitoConfig = config;
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing with storage blocked: the session just won't survive a
    // reload, which is survivable for an admin tool.
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* see setToken */ }
}

// Cognito's user pool endpoint speaks AWS JSON 1.1: the operation goes in
// X-Amz-Target, and failures come back as HTTP 400 with a `__type` like
// "com.amazon...#NotAuthorizedException". These operations are unauthenticated,
// so no request signing is involved.
async function cognitoRequest(operation, body, fallbackMessage) {
  const response = await fetch(`https://cognito-idp.${cognitoConfig.region}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.message || fallbackMessage);
    err.code = String(data.__type || '').split('#').pop();
    throw err;
  }
  return data;
}

/**
 * Attempt a sign-in.
 * @returns {Promise<{ status: 'signed-in', idToken: string }
 *                  | { status: 'new-password-required', session: string }>}
 */
export async function signIn(email, password) {
  const data = await cognitoRequest('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: cognitoConfig.clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password }
  }, 'Cognito authentication failed');

  if (data.AuthenticationResult) {
    return { status: 'signed-in', idToken: data.AuthenticationResult.IdToken };
  }
  if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    return { status: 'new-password-required', session: data.Session };
  }
  throw new Error(`Unsupported authentication challenge: ${data.ChallengeName || 'unknown'}`);
}

/** Complete the first-sign-in challenge for an invited account. */
export async function completeNewPassword(email, newPassword, session) {
  const data = await cognitoRequest('RespondToAuthChallenge', {
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    ClientId: cognitoConfig.clientId,
    ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
    Session: session
  }, 'Password change failed');

  return { status: 'signed-in', idToken: data.AuthenticationResult.IdToken };
}
