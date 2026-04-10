const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB base64 limit

// POST /files — upload a file (base64)
// Body: { filename, mimetype, content (base64) }
router.post('/', requireApiKey, async (req, res, next) => {
  try {
    const { filename, mimetype, content } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    if (!content)  return res.status(400).json({ error: 'content (base64) is required' });

    const sizeBytes = Buffer.byteLength(content, 'base64');
    if (sizeBytes > MAX_SIZE_BYTES) {
      return res.status(400).json({ error: `File too large (max 5MB, got ${(sizeBytes/1024/1024).toFixed(1)}MB)` });
    }

    const fileId = uuidv4();
    await dbRun(
      `INSERT INTO files (id, uploader_id, filename, mimetype, size, content)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)})`,
      [fileId, req.agent.id, filename, mimetype || 'application/octet-stream', sizeBytes, content]
    );

    res.status(201).json({
      id: fileId,
      filename,
      mimetype: mimetype || 'application/octet-stream',
      size_bytes: sizeBytes,
      message: 'File uploaded. Use this file_id when creating a service.'
    });
  } catch (err) { next(err); }
});

// GET /files — list my uploaded files
router.get('/', requireApiKey, async (req, res, next) => {
  try {
    const files = await dbAll(
      `SELECT id, filename, mimetype, size, created_at FROM files WHERE uploader_id = ${p(1)} ORDER BY created_at DESC`,
      [req.agent.id]
    );
    res.json({ count: files.length, files });
  } catch (err) { next(err); }
});

// GET /files/:id/download — download a file
// Accessible by: uploader OR any agent with a completed/delivered order for a service linked to this file
router.get('/:id/download', requireApiKey, async (req, res, next) => {
  try {
    const file = await dbGet(`SELECT * FROM files WHERE id = ${p(1)}`, [req.params.id]);
    if (!file) return res.status(404).json({ error: 'File not found' });

    // Check access: uploader always has access
    if (file.uploader_id !== req.agent.id) {
      // Check if requester has an order for a service linked to this file
      const order = await dbGet(
        `SELECT o.id FROM orders o
         JOIN services s ON o.service_id = s.id
         WHERE s.file_id = ${p(1)} AND o.buyer_id = ${p(2)}
           AND o.status IN ('delivered', 'completed')
         LIMIT 1`,
        [file.id, req.agent.id]
      );
      if (!order) return res.status(403).json({ error: 'Access denied. Purchase the service to download.' });
    }

    const buffer = Buffer.from(file.content, 'base64');
    res.setHeader('Content-Type', file.mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) { next(err); }
});

// DELETE /files/:id — delete a file (uploader only, cannot delete if linked to active service)
router.delete('/:id', requireApiKey, async (req, res, next) => {
  try {
    const file = await dbGet(`SELECT * FROM files WHERE id = ${p(1)}`, [req.params.id]);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.uploader_id !== req.agent.id) return res.status(403).json({ error: 'Access denied' });

    const linked = await dbGet(
      `SELECT id FROM services WHERE file_id = ${p(1)} AND is_active = ${isPostgres ? 'TRUE' : '1'} LIMIT 1`,
      [file.id]
    );
    if (linked) return res.status(400).json({ error: 'Cannot delete: file is linked to an active service' });

    await dbRun(`DELETE FROM files WHERE id = ${p(1)}`, [file.id]);
    res.json({ ok: true, message: 'File deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
