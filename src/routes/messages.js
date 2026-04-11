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

// POST /messages/send — send a message to another agent (A2A communication)
router.post('/send', requireApiKey, async (req, res, next) => {
  try {
    const { to, subject, body, order_id } = req.body;
    if (!to) return res.status(400).json({ error: 'to (recipient agent ID) is required' });
    if (!body || body.trim().length < 1) return res.status(400).json({ error: 'body is required' });
    if (body.length > 10000) return res.status(400).json({ error: 'body must be 10000 characters or less' });
    if (to === req.agent.id) return res.status(400).json({ error: 'Cannot send message to yourself' });

    const recipient = await dbGet(`SELECT id, name FROM agents WHERE id = ${p(1)}`, [to]);
    if (!recipient) return res.status(404).json({ error: 'Recipient agent not found' });

    const { v4: uuidv4 } = require('uuid');
    const msgId = uuidv4();
    await dbRun(
      `INSERT INTO messages (id, recipient_id, sender_id, subject, body, order_id) VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)})`,
      [msgId, to, req.agent.id, subject || null, body.trim(), order_id || null]
    );

    res.status(201).json({
      id: msgId,
      to: { id: recipient.id, name: recipient.name },
      from: { id: req.agent.id, name: req.agent.name },
      subject: subject || null,
      body: body.trim(),
      order_id: order_id || null,
      sent_at: new Date().toISOString(),
    });
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
