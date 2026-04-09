const { dbGet } = require('../db/helpers');

async function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing X-API-Key header' });
  }

  try {
    const agent = await dbGet('SELECT * FROM agents WHERE api_key = $1', [apiKey])
      || await dbGet('SELECT * FROM agents WHERE api_key = ?', [apiKey]);

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
