// Small shared formatters, so the same donation never renders two ways.

// The backend's status codes are for machines. These are for people.
export const STATUS_LABEL = {
  PENDING_ASSIGNMENT: 'Finding an agent',
  OFFERED: 'Agents notified',
  ACCEPTED: 'On the way',
  COLLECTED: 'Collected',
  UNASSIGNED: 'Needs attention',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

// Badge colours by meaning, not by hue-of-the-week: amber is in progress,
// green is done, red needs a human to look.
// Tone names are the ones <Badge> understands, so a status can be rendered
// straight through without a second lookup table.
export const STATUS_TONE = {
  PENDING_ASSIGNMENT: 'warning',
  OFFERED: 'warning',
  ACCEPTED: 'info',
  COLLECTED: 'success',
  UNASSIGNED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
};

export const prettyCategory = (c) =>
  c ? c.replace(/_/g, ' ').toLowerCase() : 'food';

export const prettyUnit = (u) => (u ? u.toLowerCase() : '');

export function timeAgo(date) {
  if (!date) return '';
  const seconds = Math.round((Date.now() - new Date(date)) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(date).toLocaleDateString();
}

export const clockTime = (date) =>
  new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
