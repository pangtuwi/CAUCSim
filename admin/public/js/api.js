// Fetch wrapper for /api/admin.
//
// 401 and 403 are handled differently on purpose. 401 means the token is stale
// and re-signing in fixes it. 403 means the account authenticated perfectly
// well and simply is not in the admin group — bouncing that person back to the
// sign-in form would loop them forever, so it surfaces its own screen instead.
import { getToken } from './auth.js';

let onUnauthenticated = () => {};
let onForbidden = () => {};

export function setAuthHandlers({ unauthenticated, forbidden }) {
  onUnauthenticated = unauthenticated;
  onForbidden = forbidden;
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body || {};
    this.code = this.body.code;
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { Authorization: `Bearer ${getToken() || ''}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`/api/admin${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  });

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) onUnauthenticated();
    if (response.status === 403) onForbidden(payload.error);
    throw new ApiError(payload.error || `Request failed (${response.status})`, response.status, payload);
  }
  return payload;
}

/**
 * Fetch a raw response body (a file, a log) with the bearer token attached.
 *
 * This exists because the API is protected by a header, not a cookie: a plain
 * navigation or window.open() to an /api/admin URL carries no token and gets a
 * 401. Anything served by the API itself — as opposed to a presigned S3 URL —
 * has to be fetched from script and handed to the browser as a Blob.
 */
export async function apiBlob(path) {
  const response = await fetch(`/api/admin${path}`, {
    headers: { Authorization: `Bearer ${getToken() || ''}` }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) onUnauthenticated();
    if (response.status === 403) onForbidden(payload.error);
    throw new ApiError(payload.error || `Request failed (${response.status})`, response.status, payload);
  }

  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  return { blob: await response.blob(), filename: match ? match[1] : null };
}

/** The unauthenticated bootstrap endpoint. */
export async function fetchStatus() {
  const response = await fetch('/api/admin/status');
  if (!response.ok) throw new Error('The admin server is not responding');
  return response.json();
}
