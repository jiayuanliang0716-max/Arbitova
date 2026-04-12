/**
 * Agent Credential System — pure A2A trust infrastructure
 *
 * Agents declare verifiable credentials (audits, certifications, endorsements).
 * Other agents query credentials before placing high-value orders.
 *
 * Endpoints:
 *   POST   /credentials           — add a credential (self-attested or with proof)
 *   GET    /credentials           — list my credentials (auth required)
 *   GET    /agents/:id/credentials — public credential list for any agent (no auth)
 *   DELETE /credentials/:id       — remove my credential
 *   POST   /credentials/:id/endorse — another agent endorses this credential (adds social proof)
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

const router = Router();

const VALID_TYPES = [
  'audit',           // security/code audit by external party
  'certification',   // passed a formal test/exam
  'endorsement',     // endorsed by a trusted agent or org
  'test_passed',     // autonomous test result (e.g. benchmarking run)
  'identity',        // verified identity / KYC
  'reputation',      // imported from external reputation system
  'compliance',      // regulatory compliance (SOC2, GDPR, etc.)
  'specialization',  // declared area of expertise
  'partnership',     // formal partnership with another agent/org
  'custom'           // free-form credential
];

// POST /credentials — add a credential
router.post('/', requireApiKey, async (req, res, next) => {
  try {
    const { type, title, description, issuer, issuer_url, proof, scope, expires_in_days, is_public = true } = req.body;

    if (!type || !title) return res.status(400).json({ error: 'type and title are required' });
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: 'invalid type', valid_types: VALID_TYPES });
    }

    const id = uuidv4();
    const expires_at = expires_in_days
      ? new Date(Date.now() + expires_in_days * 86400000).toISOString()
      : null;


    await dbRun(
      `INSERT INTO agent_credentials (id, agent_id, type, title, description, issuer, issuer_url, proof, scope, expires_at, self_attested, is_public)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)})`,
      [id, req.agent.id, type, title,
       description || null, issuer || null, issuer_url || null,
       proof || null, scope || null, expires_at,
       proof ? false : true,  // self_attested if no external proof
       is_public ? true : false]
    );

    const cred = await dbGet(`SELECT * FROM agent_credentials WHERE id = ${p(1)}`, [id]);
    res.status(201).json({ credential: formatCred(cred) });
  } catch (e) { next(e); }
});

// GET /credentials — list my credentials (includes private ones)
router.get('/', requireApiKey, async (req, res, next) => {
  try {

    const creds = await dbAll(
      `SELECT * FROM agent_credentials WHERE agent_id = ${p(1)} ORDER BY created_at DESC`,
      [req.agent.id]
    );
    res.json({ credentials: creds.map(formatCred) });
  } catch (e) { next(e); }
});

// DELETE /credentials/:id — remove my credential
router.delete('/:id', requireApiKey, async (req, res, next) => {
  try {

    const cred = await dbGet(
      `SELECT * FROM agent_credentials WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!cred) return res.status(404).json({ error: 'Credential not found' });
    if (cred.agent_id !== req.agent.id) return res.status(403).json({ error: 'Not your credential' });

    await dbRun(`DELETE FROM agent_credentials WHERE id = ${p(1)}`, [req.params.id]);
    res.json({ deleted: req.params.id });
  } catch (e) { next(e); }
});

// POST /credentials/:id/endorse — another agent publicly endorses this credential
router.post('/:id/endorse', requireApiKey, async (req, res, next) => {
  try {

    const cred = await dbGet(
      `SELECT * FROM agent_credentials WHERE id = ${p(1)} AND is_public = ${p(2)}`,
      [req.params.id, true]
    );
    if (!cred) return res.status(404).json({ error: 'Credential not found or not public' });
    if (cred.agent_id === req.agent.id) return res.status(400).json({ error: 'Cannot endorse your own credential' });

    const { comment } = req.body;

    // Store endorsement by appending to a JSON proof field (or create endorsement record)
    // For simplicity: store endorsements as a separate lightweight table approach via proof JSON
    // We'll update a running tally in proof field or just return success and count endorsers
    const endorserId = req.agent.id;
    const endorserAgent = await dbGet(`SELECT name, reputation_score FROM agents WHERE id = ${p(1)}`, [endorserId]);

    // Append endorsement to proof as a structured note
    const existingProof = cred.proof ? JSON.parse(cred.proof) : {};
    const endorsements = existingProof.endorsements || [];
    const alreadyEndorsed = endorsements.some(e => e.endorser_id === endorserId);
    if (alreadyEndorsed) return res.status(409).json({ error: 'Already endorsed' });

    endorsements.push({
      endorser_id: endorserId,
      endorser_name: endorserAgent?.name,
      endorser_reputation: endorserAgent?.reputation_score,
      comment: comment || null,
      endorsed_at: new Date().toISOString()
    });
    existingProof.endorsements = endorsements;

    await dbRun(
      `UPDATE agent_credentials SET self_attested = ${p(1)}, proof = ${p(2)} WHERE id = ${p(3)}`,
      [false, JSON.stringify(existingProof), cred.id]
    );

    res.json({
      credential_id: cred.id,
      endorsement_count: endorsements.length,
      your_endorsement: endorsements[endorsements.length - 1]
    });
  } catch (e) { next(e); }
});

// ─── Public route (no auth) ────────────────────────────────────────────────
// GET /agents/:id/credentials — public credentials for any agent
// (this route is registered in agents.js via the agents router, not here)
// We export a handler function for agents.js to use:
async function getPublicCredentials(req, res, next) {
  try {

    const agent = await dbGet(`SELECT id, name, reputation_score FROM agents WHERE id = ${p(1)}`, [req.params.id]);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const creds = await dbAll(
      `SELECT * FROM agent_credentials WHERE agent_id = ${p(1)} AND is_public = ${p(2)} ORDER BY created_at DESC`,
      [req.params.id, true]
    );

    // Filter out expired credentials
    const now = new Date();
    const active = creds.filter(c => !c.expires_at || new Date(c.expires_at) > now);
    const expired = creds.filter(c => c.expires_at && new Date(c.expires_at) <= now);

    res.json({
      agent_id: agent.id,
      agent_name: agent.name,
      reputation_score: agent.reputation_score,
      credential_count: active.length,
      credentials: active.map(formatCred),
      expired_count: expired.length
    });
  } catch (e) { next(e); }
}

function formatCred(c) {
  if (!c) return null;
  let proof = null;
  if (c.proof) {
    try { proof = JSON.parse(c.proof); } catch (_) { proof = c.proof; }
  }
  return {
    id: c.id,
    agent_id: c.agent_id,
    type: c.type,
    title: c.title,
    description: c.description,
    issuer: c.issuer,
    issuer_url: c.issuer_url,
    scope: c.scope,
    expires_at: c.expires_at,
    self_attested: Boolean(c.self_attested),
    is_public: Boolean(c.is_public),
    endorsement_count: proof?.endorsements?.length || 0,
    endorsements: proof?.endorsements || [],
    created_at: c.created_at
  };
}

module.exports = router;
module.exports.getPublicCredentials = getPublicCredentials;
