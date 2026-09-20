import { activeProvider } from '../config/env.js';
import { opencageProvider } from './opencage.js';
import { offlineProvider } from './offline.js';

const providers = {
  opencage: opencageProvider,
  offline: offlineProvider,
};

// One place decides which provider is live. Everything else depends on the
// shape { lat, lng, formatted, confidence, provider }, never on OpenCage.
export function getProvider() {
  return providers[activeProvider] ?? offlineProvider;
}

export { activeProvider };
