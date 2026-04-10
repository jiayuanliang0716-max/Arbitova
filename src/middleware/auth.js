const { dbGet } = require('../db/helpers');
const db = require('../db/schema');

async function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing X-API-Key header' });
  }

  try {
    const sql = db.type === 'pg'
      ? 'SELECT id, name, balance, escrow, stake, reputation_score, wallet_address FROM agents WHERE api_key = $1'
      : 'SELECT id, name, balance, escrow, stake, reputation_score, wallet_address FROM agents WHERE api_key = ?';
    const agent = await dbGet(sql, [apiKey]);

    if (!agent) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.agent = agent;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireApiKey };
