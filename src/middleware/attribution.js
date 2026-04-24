'use strict';
/**
 * src/middleware/attribution.js
 *
 * Optional middleware: if the request carries X-Attribution-Key and it matches
 * a verified, non-revoked row in attribution_keys, attach the project info to
 * req.attribution. Always passes the request through — never blocks.
 *
 * Use this wherever you want to credit a caller in downstream events (e.g.
 * tagging on-chain escrow events with the project that created them).
 *
 * Usage:
 *   const { attribution } = require('./middleware/attribution');
 *   app.use(attribution());  // every request gets req.attribution if valid
 */

const accum = require('../user_accumulation/db');

function attribution() {
  return async function attributionMw(req, res, next) {
    const plaintext = req.headers['x-attribution-key'];
    if (!plaintext) return next();
    try {
      const row = await accum.attribution.verify(String(plaintext));
      if (row && row.verified_at) {
        req.attribution = {
          id:           row.id,
          project_name: row.project_name,
          project_url:  row.project_url,
          project_logo: row.project_logo,
        };
      }
    } catch (err) {
      // swallow — attribution is best-effort
    }
    next();
  };
}

module.exports = { attribution };
