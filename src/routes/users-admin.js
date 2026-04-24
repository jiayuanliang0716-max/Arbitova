'use strict';
/**
 * src/routes/users-admin.js
 *
 * Admin surface for the user accumulation system. Gated by X-Admin-Key.
 * Mount at /admin/users.
 *
 *   GET  /admin/users                      list entities (?state=hot&minHeat=50&limit=100)
 *   GET  /admin/users/events               tail user_events (?entityId=wallet:0x...)
 *   POST /admin/log_outreach               { channel, target, target_kind, subject, body_excerpt, entity_id }
 *   GET  /admin/outreach                   list outreach log
 *   POST /admin/attribution                issue new attribution key (manual, for testing)
 *   GET  /admin/attribution                list all attribution keys
 *   POST /admin/attribution/:id/verify     mark an attribution key as verified
 *   POST /admin/attribution/:id/revoke     revoke an attribution key
 *   GET  /admin/github-snapshots           list daily snapshots (?repo=...)
 *   POST /admin/users/chain-indexer/run    manually trigger one indexer pass
 */

const express = require('express');
const accum = require('../user_accumulation/db');
const chainIndexer = require('../user_accumulation/chainIndexer');

const router = express.Router();

function requireAdminKey(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  const provided = req.headers['x-admin-key'];
  if (!provided) return res.status(401).json({ error: 'Missing X-Admin-Key header', code: 'unauthorized' });
  if (!adminKey || provided !== adminKey) return res.status(401).json({ error: 'Invalid admin key', code: 'unauthorized' });
  next();
}

router.use(requireAdminKey);

router.get('/', async (req, res) => {
  try {
    const { state, minHeat, limit } = req.query;
    const rows = await accum.listEntities({
      state: state || null,
      minHeat: Number(minHeat) || 0,
      limit: Math.min(500, Number(limit) || 200),
    });
    res.json({ entities: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'internal_error' });
  }
});

router.get('/events', async (req, res) => {
  try {
    const { entityId, limit } = req.query;
    const rows = await accum.listEvents({
      entityId: entityId || null,
      limit: Math.min(1000, Number(limit) || 200),
    });
    res.json({ events: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'internal_error' });
  }
});

router.post('/log_outreach', express.json(), async (req, res) => {
  try {
    const { channel, target, target_kind, subject, body_excerpt, response, entity_id, metadata } = req.body || {};
    if (!channel || !target || !target_kind) {
      return res.status(400).json({ error: 'channel, target, target_kind are required', code: 'bad_request' });
    }
    await accum.recordOutreach({ channel, target, target_kind, subject, body_excerpt, response, entity_id, metadata });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'internal_error' });
  }
});

router.get('/outreach', async (req, res) => {
  try {
    const rows = await accum.listOutreach({
      channel: req.query.channel || null,
      limit: Math.min(500, Number(req.query.limit) || 200),
    });
    res.json({ outreach: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'internal_error' });
  }
});

router.post('/attribution', express.json(), async (req, res) => {
  try {
    const { project_name, project_url, project_logo, contact_email, contact_wallet } = req.body || {};
    if (!project_name || !project_url || !contact_email) {
      return res.status(400).json({ error: 'project_name, project_url, contact_email required', code: 'bad_request' });
    }
    const { id, key } = await accum.attribution.issue({ project_name, project_url, project_logo, contact_email, contact_wallet });
    res.json({ id, key, notice: 'Store this key — it will not be shown again.' });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'internal_error' });
  }
});

router.get('/attribution', async (req, res) => {
  try {
    const rows = await accum.attribution.list({
      onlyVerified: req.query.verified === '1',
      limit: Math.min(500, Number(req.query.limit) || 200),
    });
    res.json({ keys: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'internal_error' });
  }
});

router.post('/attribution/:id/verify', async (req, res) => {
  try {
    await accum.attribution.markVerified(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'internal_error' });
  }
});

router.post('/attribution/:id/revoke', async (req, res) => {
  try {
    await accum.attribution.revoke(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'internal_error' });
  }
});

router.get('/github-snapshots', async (req, res) => {
  try {
    const rows = await accum.listGithubSnapshots({
      repo: req.query.repo || null,
      limit: Math.min(365, Number(req.query.limit) || 60),
    });
    res.json({ snapshots: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'internal_error' });
  }
});

// Manually trigger one pass of the chain indexer and return the result.
// Useful for catch-up runs without waiting for the interval.
router.post('/chain-indexer/run', async (req, res) => {
  try {
    const result = await chainIndexer.runOnce();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'internal_error' });
  }
});

module.exports = router;
