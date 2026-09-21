/**
 * @jest-environment jsdom
 */

import { api, apiBlob, fetchStatus, setAuthHandlers, } from './admin/public/js/api.js';
import * as auth from './admin/public/js/auth.js';

jest.mock('./admin/public/js/auth.js', () => ({
  getToken: jest.fn()
}));

function mockResponse(ok, status, data, headers = {}) {
  return {
    ok,
    status,
    headers: {
      get: (key) => headers[key.toLowerCase()] || null
    },
    json: async () => {
      if (typeof data === 'string') throw new SyntaxError();
      return data;
    },
    blob: async () => data
  };
}

describe('api.js', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    auth.getToken.mockReturnValue(null);
  });

  describe('api', () => {
    it('adds Authorization and Content-Type headers', async () => {
      fetchMock.mockResolvedValue(mockResponse(true, 200, {}));
      auth.getToken.mockReturnValue('test-token');

      await api('/test', { method: 'POST', body: { a: 1 } });

      expect(fetchMock).toHaveBeenCalledWith('/api/admin/test', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: '{"a":1}',
        signal: undefined
      });
    });

    it('handles 204 No Content', async () => {
      fetchMock.mockResolvedValue(mockResponse(true, 204, {}));

      const res = await api('/test');
      expect(res).toBeNull();
    });

    it('returns parsed JSON for 200 OK', async () => {
      fetchMock.mockResolvedValue(mockResponse(true, 200, { foo: 'bar' }));

      const res = await api('/test');
      expect(res).toEqual({ foo: 'bar' });
    });

    it('throws ApiError with payload code and message', async () => {
      fetchMock.mockResolvedValue(mockResponse(false, 400, { error: 'Bad data', code: 'bad_request' }));

      await expect(api('/test')).rejects.toMatchObject({
        message: 'Bad data',
        status: 400,
        code: 'bad_request'
      });
    });

    it('calls unauthenticated handler on 401', async () => {
      fetchMock.mockResolvedValue(mockResponse(false, 401, {}));

      const unauthenticated = jest.fn();
      setAuthHandlers({ unauthenticated, forbidden: jest.fn() });

      await expect(api('/test')).rejects.toThrow();
      expect(unauthenticated).toHaveBeenCalled();
    });

    it('calls forbidden handler on 403 with error message', async () => {
      fetchMock.mockResolvedValue(mockResponse(false, 403, { error: 'Not admin' }));

      const forbidden = jest.fn();
      setAuthHandlers({ unauthenticated: jest.fn(), forbidden });

      await expect(api('/test')).rejects.toThrow();
      expect(forbidden).toHaveBeenCalledWith('Not admin');
    });
  });

  describe('apiBlob', () => {
    it('adds Authorization header', async () => {
      fetchMock.mockResolvedValue(mockResponse(true, 200, new Blob(), { 'content-disposition': 'attachment; filename="test.txt"' }));
      auth.getToken.mockReturnValue('test-token');

      await apiBlob('/test.txt');

      expect(fetchMock).toHaveBeenCalledWith('/api/admin/test.txt', {
        headers: {
          'Authorization': 'Bearer test-token'
        }
      });
    });

    it('extracts filename from content-disposition', async () => {
      fetchMock.mockResolvedValue(mockResponse(true, 200, new Blob(), { 'content-disposition': 'attachment; filename="test.txt"' }));

      const res = await apiBlob('/test.txt');
      expect(res.filename).toBe('test.txt');
      expect(res.blob).toBeDefined();
    });

    it('handles 401 and 403 just like api()', async () => {
      fetchMock.mockResolvedValue(mockResponse(false, 401, {}));

      const unauthenticated = jest.fn();
      setAuthHandlers({ unauthenticated, forbidden: jest.fn() });

      await expect(apiBlob('/test')).rejects.toThrow();
      expect(unauthenticated).toHaveBeenCalled();
    });
  });

  describe('fetchStatus', () => {
    it('returns parsed JSON for 200 OK', async () => {
      fetchMock.mockResolvedValue(mockResponse(true, 200, { ok: true }));

      const res = await fetchStatus();
      expect(res).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledWith('/api/admin/status');
    });

    it('throws Error for non-200', async () => {
      fetchMock.mockResolvedValue(mockResponse(false, 500, {}));

      await expect(fetchStatus()).rejects.toThrow('The admin server is not responding');
    });
  });
});
