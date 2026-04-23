/**
 * admin.js — CMS admin endpoints (site-config + announcements).
 *
 * Path A analytics/payout handlers removed 2026-04-24; source in the
 * v2-path-a-legacy tag. All remaining endpoints require X-Admin-Key
 * matching process.env.ADMIN_KEY.
 */

const express = require('express');
const { dbAll, dbRun } = require('../db/helpers');

const router = express.Router();

function requireAdminKey(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  const provided = req.headers['x-admin-key'];

  if (!provided) {
    return res.status(401).json({ error: 'Missing X-Admin-Key header' });
  }
  if (!adminKey || provided !== adminKey) {
    return res.status(401).json({ error: 'Invalid admin key' });
  }
  next();
}

router.use(requireAdminKey);

// ── Site Config (CMS) ──────────────────────────────────────────────────────

router.get('/site-config', async (req, res) => {
  try {
    const rows = await dbAll('SELECT key, value FROM site_config ORDER BY key');
    const config = {};
    for (const r of rows) {
      config[r.key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
    }
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/site-config', async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Body must be a JSON object' });
    for (const [key, value] of Object.entries(updates)) {
      const jsonVal = JSON.stringify(value);
      await dbRun(
        `INSERT INTO site_config (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, jsonVal]
      );
    }
    res.json({ ok: true, updated: Object.keys(updates) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Announcements ──────────────────────────────────────────────────────────

router.get('/announcements', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM announcements ORDER BY created_at DESC');
    res.json({ announcements: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/announcements', async (req, res) => {
  try {
    const { text, url, active = true } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    const id = require('crypto').randomUUID();
    await dbRun(
      `INSERT INTO announcements (id, text, url, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [id, text, url || null, active]
    );

    if (active && process.env.DISCORD_WEBHOOK_URL) {
      const discordBody = {
        content: `**Arbitova Update:** ${text}${url ? '\n' + url : ''}`
      };
      fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordBody)
      }).catch(e => console.error('Discord webhook error:', e.message));
    }

    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/announcements/:id', async (req, res) => {
  try {
    const { active } = req.body;
    await dbRun(
      'UPDATE announcements SET active = $1, updated_at = NOW() WHERE id = $2',
      [active, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/announcements/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM announcements WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
