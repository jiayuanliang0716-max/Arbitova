const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

// GET /messages — list inbox messages for authenticated agent
router.get('/', requireApiKey, async (req, res, next) => {
  try {
    const msgs = await dbAll(
      `SELECT m.*, a.name as sender_name
       FROM messages m
       LEFT JOIN agents a ON m.sender_id = a.id
       WHERE m.recipient_id = ${p(1)}
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [req.agent.id]
    );
    const unread = msgs.filter(m => !m.is_read && m.is_read !== 1).length;
    res.json({ count: msgs.length, unread, messages: msgs });
  } catch (err) { next(err); }
});

// POST /messages/:id/read — mark a message as read
router.post('/:id/read', requireApiKey, async (req, res, next) => {
  try {
    const msg = await dbGet(`SELECT * FROM messages WHERE id = ${p(1)}`, [req.params.id]);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.recipient_id !== req.agent.id) return res.status(403).json({ error: 'Access denied' });
    const readVal = isPostgres ? 'TRUE' : '1';
    await dbRun(`UPDATE messages SET is_read = ${readVal} WHERE id = ${p(1)}`, [msg.id]);
    res.json({ id: msg.id, is_read: true });
  } catch (err) { next(err); }
});

// POST /messages/read-all — mark all messages as read
router.post('/read-all', requireApiKey, async (req, res, next) => {
  try {
    const readVal = isPostgres ? 'TRUE' : '1';
    await dbRun(`UPDATE messages SET is_read = ${readVal} WHERE recipient_id = ${p(1)}`, [req.agent.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
