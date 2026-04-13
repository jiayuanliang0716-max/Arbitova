/**
 * posts.js — Public blog / changelog posts
 *
 * Public:
 *   GET  /api/v1/posts           — list published posts
 *   GET  /api/v1/posts/:slug     — single post by slug
 *
 * Admin (X-Admin-Key required):
 *   POST   /api/v1/posts         — create post
 *   PATCH  /api/v1/posts/:id     — update post
 *   DELETE /api/v1/posts/:id     — delete post
 */

const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const router = express.Router();

function requireAdminKey(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  const provided = req.headers['x-admin-key'];
  if (!adminKey || provided !== adminKey) {
    return res.status(401).json({ error: 'Invalid admin key' });
  }
  next();
}

function genId() {
  return 'post_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function toSlug(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

// GET /api/v1/posts
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = parseInt(req.query.offset) || 0;
    const category = req.query.category || null;

    let sql = `SELECT id, title, slug, excerpt, cover_image, category, author_name, pinned, created_at, updated_at
               FROM posts WHERE published = TRUE`;
    const params = [];
    if (category) {
      params.push(category);
      sql += ` AND category = $${params.length}`;
    }
    sql += ` ORDER BY pinned DESC, created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const posts = await dbAll(sql, params);
    res.json({ posts, count: posts.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/v1/posts/:slug
router.get('/:slug', async (req, res) => {
  try {
    const post = await dbGet(
      `SELECT * FROM posts WHERE slug = $1 AND published = TRUE`,
      [req.params.slug]
    );
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json(post);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/v1/posts (admin)
router.post('/', requireAdminKey, async (req, res) => {
  try {
    const { title, content, excerpt, cover_image, category, author_name, published, pinned, slug } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title and content required' });

    const id = genId();
    const finalSlug = slug || toSlug(title) + '-' + Date.now().toString(36);
    await dbRun(
      `INSERT INTO posts (id, title, slug, content, excerpt, cover_image, category, author_name, published, pinned)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, title, finalSlug, content, excerpt || '', cover_image || null, category || 'update',
       author_name || 'Arbitova Team', published !== false, pinned === true]
    );
    const post = await dbGet('SELECT * FROM posts WHERE id = $1', [id]);
    res.status(201).json(post);
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('duplicate')) {
      return res.status(409).json({ error: 'Slug already exists' });
    }
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/v1/posts/:id (admin)
router.patch('/:id', requireAdminKey, async (req, res) => {
  try {
    const { title, content, excerpt, cover_image, category, author_name, published, pinned } = req.body;
    const post = await dbGet('SELECT * FROM posts WHERE id = $1', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    await dbRun(
      `UPDATE posts SET
         title = $1, content = $2, excerpt = $3, cover_image = $4, category = $5,
         author_name = $6, published = $7, pinned = $8, updated_at = NOW()
       WHERE id = $9`,
      [title ?? post.title, content ?? post.content, excerpt ?? post.excerpt,
       cover_image !== undefined ? cover_image : post.cover_image,
       category ?? post.category, author_name ?? post.author_name,
       published !== undefined ? published : post.published,
       pinned !== undefined ? pinned : post.pinned,
       req.params.id]
    );
    const updated = await dbGet('SELECT * FROM posts WHERE id = $1', [req.params.id]);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/v1/posts/:id (admin)
router.delete('/:id', requireAdminKey, async (req, res) => {
  try {
    const post = await dbGet('SELECT id FROM posts WHERE id = $1', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    await dbRun('DELETE FROM posts WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
