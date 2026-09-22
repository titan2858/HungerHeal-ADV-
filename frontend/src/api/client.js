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

  // ---------------------------------------------------------------- agent
  // Reported every REPORT_INTERVAL_MS while an agent is on shift. An agent who
  // stops reporting drops out of matching within AGENT_TTL_SECONDS (120s), so
  // this is not optional housekeeping - it is what keeps them visible.
  reportLocation: (lat, lng) =>
    request('/api/location/agents/location', { method: 'POST', body: { lat, lng } }),
  setAvailability: (available) =>
    request('/api/location/agents/availability', { method: 'POST', body: { available } }),
  goOffline: () => request('/api/location/agents/offline', { method: 'POST' }),
  agentState: () => request('/api/location/agents/me'),

  // --------------------------------------------------------------- offers
  offer: (donationId) => request(`/api/engine/offers/${donationId}`),
  acceptOffer: (donationId) =>
    request(`/api/engine/offers/${donationId}/accept`, { method: 'POST' }),
  rejectOffer: (donationId, reason) =>
    request(`/api/engine/offers/${donationId}/reject`, { method: 'POST', body: { reason } }),

  // ------------------------------------------------------------- tracking
  tracking: (donationId) => request(`/api/tracking/${donationId}`),
  listTracking: (params = '') => request(`/api/tracking${params}`),
  markCollected: (donationId) =>
    request(`/api/tracking/${donationId}/collected`, { method: 'POST' }),
  trackingSummary: () => request('/api/tracking/stats/summary'),

  // ------------------------------------------------- monitoring (admin)
  // Read-only by design: there is no assign or reassign call here, because
  // there is no such endpoint. See docs/10-phase10-monitoring.md.
  monitoringStats: () => request('/api/monitoring/stats'),
  monitoringDonations: (params = '') => request(`/api/monitoring/donations${params}`),
  monitoringDonation: (id) => request(`/api/monitoring/donations/${id}`),

  // -------------------------------------------------------- notifications
  notifications: (params = '') => request(`/api/notify${params}`),
  unreadCount: () => request('/api/notify/unread-count'),
  markNotificationRead: (id) => request(`/api/notify/${id}/read`, { method: 'PATCH' }),
  markAllRead: () => request('/api/notify/read-all', { method: 'POST' }),
};
