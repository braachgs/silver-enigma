// Resolve Playwright: a local install if present, else the global one used in
// Claude Code cloud sessions.
try {
  module.exports = require('playwright');
} catch (_) {
  module.exports = require('/opt/node22/lib/node_modules/playwright');
}
