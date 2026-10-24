/**
 * Cloudflare Workers entry point. The Hono app lives in app.ts so tests can
 * import it without triggering Workers-specific module semantics.
 */

import { app } from './app.js';

export default {
  fetch: app.fetch,
};
