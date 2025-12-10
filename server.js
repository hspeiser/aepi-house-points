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

// CSV Export
app.get('/api/export/csv', async (req, res) => {
  // Get all data
  const members = await pool.query(`
    SELECT m.*, COALESCE(SUM(r.approved_points), 0) as total_points
    FROM members m
    LEFT JOIN requests r ON m.id = r.member_id AND r.status = 'approved'
    GROUP BY m.id
    ORDER BY total_points DESC
  `);

  const requests = await pool.query(`
    SELECT r.*, m.name as member_name, c.name as category_name
    FROM requests r
    JOIN members m ON r.member_id = m.id
    LEFT JOIN categories c ON r.category_id = c.id
    ORDER BY r.created_at DESC
  `);

  const categories = await pool.query('SELECT * FROM categories ORDER BY id');

  // Build CSV
  let csv = 'AEPI HOUSE POINTS EXPORT\n';
  csv += 'Generated: ' + new Date().toISOString() + '\n\n';

  // Members summary
  csv += '=== MEMBERS LEADERBOARD ===\n';
  csv += 'Rank,Name,Total Points\n';
  members.rows.forEach((m, i) => {
    csv += `${i + 1},"${m.name}",${m.total_points}\n`;
  });

  csv += '\n=== CATEGORIES ===\n';
  csv += 'ID,Name,Default Points\n';
  categories.rows.forEach(c => {
    csv += `${c.id},"${c.name}",${c.default_points}\n`;
  });

  csv += '\n=== ALL REQUESTS ===\n';
  csv += 'ID,Member,Category,Custom Category,Requested Points,Approved Points,Status,Explanation,Created At,Resolved At\n';
  requests.rows.forEach(r => {
    const explanation = (r.explanation || '').replace(/"/g, '""');
    const customCat = (r.custom_category || '').replace(/"/g, '""');
    csv += `${r.id},"${r.member_name}","${r.category_name || ''}","${customCat}",${r.requested_points},${r.approved_points || ''},${r.status},"${explanation}",${r.created_at || ''},${r.resolved_at || ''}\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=aepi-house-points-backup-' + new Date().toISOString().split('T')[0] + '.csv');
  res.send(csv);
});

// Admin auth
const crypto = require('crypto');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'touse123';
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.createHash('sha256').update(ADMIN_PASSWORD + 'aepi_secret').digest('hex');

// Rate limiting for login attempts
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_TIME = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(ip) {
  const now = Date.now();
  const attempts = loginAttempts.get(ip);

  if (!attempts) return true;
  if (now - attempts.firstAttempt > LOCKOUT_TIME) {
    loginAttempts.delete(ip);
    return true;
  }
  return attempts.count < MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const attempts = loginAttempts.get(ip);

  if (!attempts || now - attempts.firstAttempt > LOCKOUT_TIME) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    attempts.count++;
  }
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

function generateToken() {
  const timestamp = Date.now().toString();
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(timestamp).digest('hex');
  return `${timestamp}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [timestamp, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(timestamp).digest('hex');

  // Check signature matches
  if (signature !== expectedSig) return false;

  // Check token is not older than 24 hours
  const age = Date.now() - parseInt(timestamp);
  if (age > 24 * 60 * 60 * 1000) return false;

  return true;
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';

  // Check rate limit
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const { password } = req.body;

  // Validate input
  if (typeof password !== 'string' || password.length > 100) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Wrong password' });
  }

  // Timing-safe comparison
  const match = password.length === ADMIN_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD));

  if (match) {
    clearAttempts(ip);
    const token = generateToken();
    res.json({ success: true, token });
  } else {
    recordFailedAttempt(ip);
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
