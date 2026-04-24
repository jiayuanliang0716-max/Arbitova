'use strict';
/**
 * src/routes/partners.js
 *
 * Public attribution sign-up. A project fills out /partners, we create a
 * pending attribution_key and email the plaintext key back (out-of-band).
 * Verification happens manually (admin reviews, calls /admin/users/attribution/:id/verify).
 *
 *   GET  /partners             serves public/partners.html
 *   POST /api/partners/signup  { project_name, project_url, project_logo, contact_email, contact_wallet }
 *
 * Rate-limit is inherited from the global limiter in server.js.
 */

const express = require('express');
const path = require('path');
const accum = require('../user_accumulation/db');
const { recordEvent } = require('../middleware/userEvents');

const router = express.Router();

router.get('/partners', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'partners.html'));
});

// Public: list verified attribution partners (name, url, logo only — no PII).
// /verdicts reads this to render the "building on Arbitova" strip.
router.get('/api/partners/verified', async (req, res) => {
  try {
    const rows = await accum.attribution.list({ onlyVerified: true, limit: 100 });
    const partners = rows.map((r) => ({
      project_name: r.project_name,
      project_url:  r.project_url,
      project_logo: r.project_logo || null,
      verified_at:  r.verified_at,
    }));
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ partners, count: partners.length });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'internal_error' });
  }
});

router.post('/api/partners/signup', express.json(), async (req, res) => {
  try {
    const { project_name, project_url, project_logo, contact_email, contact_wallet } = req.body || {};
    if (!project_name || !project_url || !contact_email) {
      return res.status(400).json({ error: 'project_name, project_url, contact_email are required', code: 'bad_request' });
    }
    if (!/^https?:\/\/.+/i.test(project_url)) {
      return res.status(400).json({ error: 'project_url must be an http(s) URL', code: 'bad_request' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact_email)) {
      return res.status(400).json({ error: 'contact_email must be a valid email', code: 'bad_request' });
    }
    if (contact_wallet && !/^0x[a-fA-F0-9]{40}$/.test(contact_wallet)) {
      return res.status(400).json({ error: 'contact_wallet must be a 0x address', code: 'bad_request' });
    }

    const { id, key } = await accum.attribution.issue({
      project_name, project_url, project_logo, contact_email, contact_wallet,
    });

    // Heat: signing up is a meaningful signal even before manual verify.
    await recordEvent({
      event_type: 'attribution_signup',
      wallet: contact_wallet || null,
      email: contact_email,
      metadata: { project_name, project_url, attribution_id: id },
    }).catch(() => {});

    // Return plaintext key only here. Admin must still flip verified_at before
    // /verdicts will show the project's logo.
    res.json({
      id,
      key,
      pending_verification: true,
      notice: 'Save this key now — it will not be shown again. We\'ll email you once verification is complete (typically within 24h).',
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'internal_error' });
  }
});

module.exports = router;
