/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

// Extract the auth module contents using fs to avoid dynamic import complexity.
// We can test this by running in a JSDOM environment and using `new Function()`
// to execute the code and export its functions for testing, similar to how
// auth-modal.test.js works, but simpler since this is just auth.js without ES modules
// complex dependencies.

const AUTH_JS = fs.readFileSync(path.resolve(__dirname, 'public/js/auth.js'), 'utf8');

// Strip out `export ` declarations to make it a valid regular script.
const strippedAuthJs = AUTH_JS.replace(/export function /g, 'function ')
                              .replace(/export async function /g, 'async function ');

const setupAuth = new Function('fetchMock', `
  let fetch = fetchMock;
  ${strippedAuthJs}

  return {
    setCognitoConfig,
    getToken,
    setToken,
    clearToken,
    signIn,
    completeNewPassword
  };
`);

describe('admin public/js/auth.js', () => {
  let auth;
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn();
    // clear localStorage
    localStorage.clear();

    auth = setupAuth(fetchMock);
    auth.setCognitoConfig({ clientId: 'test-client', region: 'us-east-1' });
  });

  describe('Token management', () => {
    it('sets and gets a token', () => {
      auth.setToken('test-token');
      expect(auth.getToken()).toBe('test-token');
    });

    it('clears a token', () => {
      auth.setToken('test-token');
      auth.clearToken();
      expect(auth.getToken()).toBeNull();
    });
  });

  describe('signIn', () => {
    it('returns signed-in status with idToken on successful login', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          AuthenticationResult: { IdToken: 'mock-id-token' }
        })
      });

      const result = await auth.signIn('test@example.com', 'password123');

      expect(result).toEqual({ status: 'signed-in', idToken: 'mock-id-token' });
      expect(fetchMock).toHaveBeenCalledWith('https://cognito-idp.us-east-1.amazonaws.com/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth'
        },
        body: JSON.stringify({
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: 'test-client',
          AuthParameters: { USERNAME: 'test@example.com', PASSWORD: 'password123' }
        })
      });
    });

    it('returns new-password-required status with session on challenge', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ChallengeName: 'NEW_PASSWORD_REQUIRED',
          Session: 'mock-session-string'
        })
      });

      const result = await auth.signIn('test@example.com', 'password123');

      expect(result).toEqual({ status: 'new-password-required', session: 'mock-session-string' });
    });

    it('throws error for unsupported challenge', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ChallengeName: 'SMS_MFA'
        })
      });

      await expect(auth.signIn('test@example.com', 'password123'))
        .rejects.toThrow('Unsupported authentication challenge: SMS_MFA');
    });

    it('throws error with code when fetch fails (e.g., wrong password)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          __type: 'NotAuthorizedException',
          message: 'Incorrect username or password.'
        })
      });

      try {
        await auth.signIn('test@example.com', 'wrong');
        fail('Should have thrown');
      } catch (err) {
        expect(err.message).toBe('Incorrect username or password.');
        expect(err.code).toBe('NotAuthorizedException');
      }
    });
  });

  describe('completeNewPassword', () => {
    it('returns signed-in status with idToken on successful password change', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          AuthenticationResult: { IdToken: 'mock-new-id-token' }
        })
      });

      const result = await auth.completeNewPassword('test@example.com', 'newpass123', 'mock-session');

      expect(result).toEqual({ status: 'signed-in', idToken: 'mock-new-id-token' });
      expect(fetchMock).toHaveBeenCalledWith('https://cognito-idp.us-east-1.amazonaws.com/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityProviderService.RespondToAuthChallenge'
        },
        body: JSON.stringify({
          ChallengeName: 'NEW_PASSWORD_REQUIRED',
          ClientId: 'test-client',
          ChallengeResponses: { USERNAME: 'test@example.com', NEW_PASSWORD: 'newpass123' },
          Session: 'mock-session'
        })
      });
    });
  });
});
