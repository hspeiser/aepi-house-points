const express = require('express');
const { pool, initDb } = require('./db');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Get all categories
app.get('/api/categories', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM categories');
  res.json(rows);
});

// Search/get members
app.get('/api/members', async (req, res) => {
  const { search } = req.query;
  let result;
  if (search) {
    result = await pool.query('SELECT * FROM members WHERE name ILIKE $1 ORDER BY name', [`%${search}%`]);
  } else {
    result = await pool.query('SELECT * FROM members ORDER BY name');
  }
  res.json(result.rows);
});

// Create or get member
app.post('/api/members', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const trimmedName = name.trim();
  let result = await pool.query('SELECT * FROM members WHERE LOWER(name) = LOWER($1)', [trimmedName]);

  if (result.rows.length === 0) {
    result = await pool.query('INSERT INTO members (name) VALUES ($1) RETURNING *', [trimmedName]);
  }

  res.json(result.rows[0]);
});

// Submit a point request
app.post('/api/requests', async (req, res) => {
  const { member_id, category_id, custom_category, requested_points, explanation } = req.body;

  if (!member_id || !requested_points) {
    return res.status(400).json({ error: 'Member and points are required' });
  }

  if (!category_id && !custom_category) {
    return res.status(400).json({ error: 'Category is required' });
  }

  const result = await pool.query(`
    INSERT INTO requests (member_id, category_id, custom_category, requested_points, explanation)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [member_id, category_id || null, custom_category || null, requested_points, explanation || null]);

  res.json({ id: result.rows[0].id, message: 'Request submitted!' });
});

// Get all pending requests (admin)
app.get('/api/requests/pending', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT r.*, m.name as member_name, c.name as category_name
    FROM requests r
    JOIN members m ON r.member_id = m.id
    LEFT JOIN categories c ON r.category_id = c.id
    WHERE r.status = 'pending'
    ORDER BY r.created_at DESC
  `);
  res.json(rows);
});

// Get all approved requests (admin)
app.get('/api/requests/approved', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT r.*, m.name as member_name, c.name as category_name
    FROM requests r
    JOIN members m ON r.member_id = m.id
    LEFT JOIN categories c ON r.category_id = c.id
    WHERE r.status = 'approved'
    ORDER BY r.resolved_at DESC
  `);
  res.json(rows);
});

// Get requests by member
app.get('/api/requests/member/:memberId', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT r.*, c.name as category_name
    FROM requests r
    LEFT JOIN categories c ON r.category_id = c.id
    WHERE r.member_id = $1
    ORDER BY r.created_at DESC
  `, [req.params.memberId]);
  res.json(rows);
});

// Get member stats
app.get('/api/members/:memberId/stats', async (req, res) => {
  const memberResult = await pool.query('SELECT * FROM members WHERE id = $1', [req.params.memberId]);
  if (memberResult.rows.length === 0) {
    return res.status(404).json({ error: 'Member not found' });
  }

  const statsResult = await pool.query(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'approved' THEN approved_points ELSE 0 END), 0) as total_points,
      COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved_count,
      COUNT(CASE WHEN status = 'denied' THEN 1 END) as denied_count,
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count
    FROM requests
    WHERE member_id = $1
  `, [req.params.memberId]);

  res.json({ member: memberResult.rows[0], stats: statsResult.rows[0] });
});

// Approve/deny request (admin)
app.put('/api/requests/:id', requireAdmin, async (req, res) => {
  const { status, approved_points, admin_note } = req.body;

  if (!['approved', 'denied'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  await pool.query(`
    UPDATE requests
    SET status = $1, approved_points = $2, admin_note = $3, resolved_at = CURRENT_TIMESTAMP
    WHERE id = $4
  `, [status, status === 'approved' ? approved_points : null, admin_note || null, req.params.id]);

  res.json({ message: 'Request updated' });
});

// Get all requests (with optional status filter)
app.get('/api/requests', async (req, res) => {
  const { status } = req.query;
  let query = `
    SELECT r.*, m.name as member_name, c.name as category_name
    FROM requests r
    JOIN members m ON r.member_id = m.id
    LEFT JOIN categories c ON r.category_id = c.id
  `;
  const params = [];

  if (status && ['pending', 'approved', 'denied'].includes(status)) {
    query += ' WHERE r.status = $1';
    params.push(status);
  }

  query += ' ORDER BY r.created_at DESC LIMIT 100';

  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT m.id, m.name, COALESCE(SUM(r.approved_points), 0) as total_points
    FROM members m
    LEFT JOIN requests r ON m.id = r.member_id AND r.status = 'approved'
    GROUP BY m.id
    ORDER BY total_points DESC
  `);
  res.json(rows);
});

// Admin auth
const crypto = require('crypto');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'touse123';
const adminTokens = new Set();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;

  // Validate input
  if (typeof password !== 'string' || password.length > 100) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  // Timing-safe comparison
  const match = password.length === ADMIN_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD));

  if (match) {
    const token = generateToken();
    adminTokens.add(token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

const PORT = process.env.PORT || 3000;

// For local development
if (process.env.NODE_ENV !== 'production') {
  initDb().then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
}

// Export for Vercel
module.exports = app;
