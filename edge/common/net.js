/* Fetching for the Edge widgets. iCUE lets a widget reach the hosts its
 * manifest declares, but may still apply the browser's cross-origin (CORS)
 * rules, which football-data.org and Google's iCal feeds may not satisfy.
 * So each request goes direct first and, if the browser refuses it, through
 * the optional Day Board Helper on this PC (edge/helper: a PowerShell relay
 * on http://localhost:8577 for those two services only). Whichever works is
 * remembered; direct is retried every hour.
 */
(function (root) {
  const HELPER = 'http://localhost:8577';
  let viaHelper = false;
  let lastDirect = 0;

  class NetError extends Error {
    constructor(label, message) { super(message || label); this.label = label; }
  }

  /** GET [url] with [headers]; resolves to a Response (any HTTP status), or throws NetError when nothing gets through. */
  async function get(url, headers = {}) {
    const now = Date.now();
    if (!viaHelper || now - lastDirect > 3600e3) {
      lastDirect = now;
      try {
        const r = await fetch(url, { headers, cache: 'no-store' });
        viaHelper = false;
        return r;
      } catch (_) { /* offline, not permitted, or refused by CORS: try the helper */ }
    }
    try {
      const r = await fetch(`${HELPER}/relay?url=${encodeURIComponent(url)}`, { headers, cache: 'no-store' });
      viaHelper = true;
      return r;
    } catch (_) {
      throw new NetError('OFFLINE OR BLOCKED', `Couldn't reach ${new URL(url).host} directly or through the Day Board Helper.`);
    }
  }

  const api = { get, NetError, HELPER, usingHelper: () => viaHelper };
  root.EdgeNet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
