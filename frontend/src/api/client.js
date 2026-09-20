// One place that knows how to talk to the backend.

const TOKEN_KEY = 'hh.token';
const USER_KEY = 'hh.user';

export const auth = {
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  get user() {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  },
  save(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

// A per-browser-session id attached to every request. The backend reuses an
// incoming x-trace-id rather than generating its own, so a single action in
// this UI can be followed through every service's logs.
const SESSION_TRACE = `web-${Math.random().toString(36).slice(2, 10)}`;

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `request failed with ${status}`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details ?? [];
    this.traceId = body?.error?.traceId;
  }
}

async function request(path, { method = 'GET', body, isFormData = false } = {}) {
  const headers = { 'x-trace-id': `${SESSION_TRACE}-${Date.now()}` };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  // fetch sets the multipart boundary itself; setting Content-Type by hand
  // would omit it and the server would fail to parse the body.
  if (!isFormData && body) headers['content-type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: isFormData ? body : body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  signup: (payload) => request('/api/auth/signup', { method: 'POST', body: payload }),
  login: (payload) => request('/api/auth/login', { method: 'POST', body: payload }),
  me: () => request('/api/auth/me'),

  listDonations: () => request('/api/donations'),
  createDonation: (formData) =>
    request('/api/donations', { method: 'POST', body: formData, isFormData: true }),

  geocode: (address) => request(`/api/geo/geocode?address=${encodeURIComponent(address)}`),
  reverse: (lat, lng) => request(`/api/geo/reverse?lat=${lat}&lng=${lng}`),
  geoStats: () => request('/api/geo/stats'),
};
