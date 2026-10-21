const express = require('express');
const { pool, initDb } = require('./db');
const { put, list, del, get } = require('@vercel/blob');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Run initDb (table creation + migrations) once per serverless instance, before any query
let dbReady = null;
app.use((req, res, next) => {
  if (!dbReady) dbReady = initDb();
  dbReady.then(() => next()).catch(err => {
    dbReady = null;
    console.error('DB init failed:', err);
    res.status(500).json({ error: 'Database unavailable' });
  });
});

// Keep-alive ping — hit daily by Vercel cron so the free-tier database never pauses for inactivity
app.get('/api/ping', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

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
    result = await pool.query('SELECT * FROM members WHERE active = TRUE AND name ILIKE $1 ORDER BY name', [`%${search}%`]);
  } else {
    result = await pool.query('SELECT * FROM members WHERE active = TRUE ORDER BY name');
  }
  res.json(result.rows);
});

// "Did you mean…?" matching for names that aren't an exact hit
const NICKNAMES = {
  jake: 'jacob', jay: 'jacob', mike: 'michael', mikey: 'michael', ben: 'benjamin', benji: 'benjamin',
  danny: 'daniel', dan: 'daniel', dave: 'david', davey: 'david', ed: 'edward', eddie: 'edward',
  andy: 'andrew', drew: 'andrew', nate: 'nathan', zach: 'zachary', zack: 'zachary', sam: 'samuel',
  josh: 'joshua', matt: 'matthew', alex: 'alexander', nick: 'nicholas', will: 'william', bill: 'william',
  bob: 'robert', rob: 'robert', bobby: 'robert', tom: 'thomas', tommy: 'thomas', jon: 'jonathan',
  johnny: 'john', chris: 'christopher', tony: 'anthony', joe: 'joseph', joey: 'joseph', max: 'maxwell',
  gabe: 'gabriel', abe: 'abraham', izzy: 'isaac', ike: 'isaac', eli: 'elijah', ari: 'ariel',
  pat: 'patrick', jim: 'james', jimmy: 'james', steve: 'steven', ricky: 'richard', rick: 'richard'
};

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Similarity of two single name parts, 0..1 (nicknames and prefixes count as strong matches)
function tokenScore(typed, actual) {
  if (typed === actual) return 1;
  const canonTyped = NICKNAMES[typed] || typed;
  const canonActual = NICKNAMES[actual] || actual;
  if (canonTyped === canonActual) return 0.95;
  if (typed.length >= 3 && actual.startsWith(typed)) return 0.85;
  const dist = levenshtein(typed, actual);
  return Math.max(0, 1 - dist / Math.max(typed.length, actual.length));
}

function suggestMembers(input, members) {
  const typedParts = input.toLowerCase().replace(/[^a-z\s'-]/g, '').split(/\s+/).filter(Boolean);
  if (typedParts.length === 0) return [];

  const scored = members.map(m => {
    const parts = m.name.toLowerCase().split(/\s+/);
    // Each typed word matches its best word in the member's name
    const total = typedParts.reduce((sum, t) => sum + Math.max(...parts.map(p => tokenScore(t, p))), 0);
    return { id: m.id, name: m.name, score: total / typedParts.length };
  });

  return scored
    .filter(s => s.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ id, name }) => ({ id, name }));
}

// Look up member by name (creation is admin-only via /api/admin/members)
app.post('/api/members', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const trimmedName = name.trim();
  const result = await pool.query('SELECT * FROM members WHERE LOWER(name) = LOWER($1)', [trimmedName]);

  if (result.rows.length === 0) {
    const active = await pool.query('SELECT id, name FROM members WHERE active = TRUE');
    return res.status(404).json({
      error: 'Name not found. Ask an admin to add you.',
      suggestions: suggestMembers(trimmedName, active.rows)
    });
  }
  if (!result.rows[0].active) {
    return res.status(403).json({ error: 'This member was removed. Ask an admin to re-add you.' });
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

  const points = Number(requested_points);
  if (!Number.isInteger(points) || points < 1 || points > 100) {
    return res.status(400).json({ error: 'Points must be a whole number between 1 and 100' });
  }

  const memberCheck = await pool.query('SELECT id FROM members WHERE id = $1 AND active = TRUE', [member_id]);
  if (memberCheck.rows.length === 0) {
    return res.status(400).json({ error: 'Member not found' });
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
    ORDER BY r.resolved_at DESC, r.id DESC
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

// Bulk attendance (admin)
app.post('/api/attendance/bulk', requireAdmin, async (req, res) => {
  const { event_type, event_date, member_ids } = req.body;

  if (!event_type || !event_date || !member_ids || !Array.isArray(member_ids) || member_ids.length === 0) {
    return res.status(400).json({ error: 'Event type, date, and member IDs are required' });
  }

  // Determine category and points based on event type
  let categoryName, points;
  if (event_type === 'chapter') {
    categoryName = 'Chapter Meeting';
    points = 10;
  } else if (event_type === 'nme') {
    categoryName = 'New Member Education';
    points = 3;
  } else {
    return res.status(400).json({ error: 'Invalid event type' });
  }

  // Get category ID
  const categoryResult = await pool.query('SELECT id FROM categories WHERE name = $1', [categoryName]);
  if (categoryResult.rows.length === 0) {
    return res.status(400).json({ error: 'Category not found' });
  }
  const categoryId = categoryResult.rows[0].id;

  // Format the date for the explanation
  const formattedDate = new Date(event_date).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
  const explanation = `${categoryName} attendance - ${formattedDate}`;

  // Insert a pre-approved request for each member
  let insertedCount = 0;
  for (const memberId of member_ids) {
    try {
      await pool.query(`
        INSERT INTO requests (member_id, category_id, requested_points, approved_points, explanation, status, resolved_at)
        VALUES ($1, $2, $3, $4, $5, 'approved', CURRENT_TIMESTAMP)
      `, [memberId, categoryId, points, points, explanation]);
      insertedCount++;
    } catch (err) {
      // Skip invalid member IDs
      console.error(`Failed to insert attendance for member ${memberId}:`, err.message);
    }
  }

  res.json({ message: 'Attendance recorded', count: insertedCount });
});

// Award position points (admin)
app.post('/api/admin/position-points', requireAdmin, async (req, res) => {
  const { member_id, position, points, note } = req.body;

  if (!member_id || !position || points === undefined || points === null) {
    return res.status(400).json({ error: 'Member, position, and points are required' });
  }

  const pointsNum = parseInt(points);
  if (isNaN(pointsNum) || pointsNum < 0 || pointsNum > 100) {
    return res.status(400).json({ error: 'Points must be between 0 and 100' });
  }

  if (position === 'Comms' && pointsNum > 20) {
    return res.status(400).json({ error: 'Comms points cannot exceed 20' });
  }

  // Verify member exists
  const memberCheck = await pool.query('SELECT id FROM members WHERE id = $1 AND active = TRUE', [member_id]);
  if (memberCheck.rows.length === 0) {
    return res.status(404).json({ error: 'Member not found' });
  }

  const explanation = note && note.trim() ? `${position} - ${note.trim()}` : position;

  await pool.query(`
    INSERT INTO requests (member_id, custom_category, requested_points, approved_points, explanation, status, resolved_at)
    VALUES ($1, $2, $3, $4, $5, 'approved', CURRENT_TIMESTAMP)
  `, [member_id, 'Position Points', pointsNum, pointsNum, explanation]);

  res.json({ message: 'Position points awarded', points: pointsNum });
});

// Add member (admin)
app.post('/api/admin/members', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const trimmedName = name.trim();

  // Check if member already exists
  const existing = await pool.query('SELECT * FROM members WHERE LOWER(name) = LOWER($1)', [trimmedName]);
  if (existing.rows.length > 0) {
    if (existing.rows[0].active) {
      return res.status(400).json({ error: 'Member already exists' });
    }
    // Previously removed — reactivate with all their old points intact
    const reactivated = await pool.query('UPDATE members SET active = TRUE WHERE id = $1 RETURNING *', [existing.rows[0].id]);
    return res.json(reactivated.rows[0]);
  }

  const result = await pool.query('INSERT INTO members (name) VALUES ($1) RETURNING *', [trimmedName]);
  res.json(result.rows[0]);
});

// Remove member (admin) — soft delete: hides the member but keeps all their data
app.delete('/api/admin/members/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  const member = await pool.query('SELECT * FROM members WHERE id = $1 AND active = TRUE', [id]);
  if (member.rows.length === 0) {
    return res.status(404).json({ error: 'Member not found' });
  }

  await pool.query('UPDATE members SET active = FALSE WHERE id = $1', [id]);

  res.json({ message: 'Member removed', name: member.rows[0].name });
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT m.id, m.name, COALESCE(SUM(r.approved_points), 0) as total_points
    FROM members m
    LEFT JOIN requests r ON m.id = r.member_id AND r.status = 'approved'
    WHERE m.active = TRUE
    GROUP BY m.id
    ORDER BY total_points DESC
  `);
  res.json(rows);
});

// Analytics (admin)
app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
  try {
    // Headline numbers
    const totals = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM members WHERE active = TRUE) AS member_count,
        (SELECT COUNT(*) FROM requests) AS total_requests,
        (SELECT COUNT(*) FROM requests WHERE status = 'pending') AS pending_count,
        (SELECT COUNT(*) FROM requests WHERE status = 'approved') AS approved_count,
        (SELECT COUNT(*) FROM requests WHERE status = 'denied') AS denied_count,
        (SELECT COALESCE(SUM(approved_points),0) FROM requests WHERE status = 'approved') AS total_points_awarded,
        (SELECT COALESCE(AVG(approved_points),0) FROM requests WHERE status = 'approved') AS avg_points_per_approval,
        (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))),0)
           FROM requests WHERE resolved_at IS NOT NULL AND created_at IS NOT NULL) AS avg_decision_seconds
    `);

    // Points awarded per day (last 60 days)
    const perDay = await pool.query(`
      SELECT to_char(date_trunc('day', resolved_at), 'YYYY-MM-DD') AS day,
             SUM(approved_points)::int AS points,
             COUNT(*)::int AS approvals
      FROM requests
      WHERE status = 'approved' AND resolved_at >= NOW() - INTERVAL '60 days'
      GROUP BY 1
      ORDER BY 1
    `);

    // Requests submitted per day (last 60 days)
    const submittedPerDay = await pool.query(`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS submissions
      FROM requests
      WHERE created_at >= NOW() - INTERVAL '60 days'
      GROUP BY 1
      ORDER BY 1
    `);

    // Top members by points
    const topMembers = await pool.query(`
      SELECT m.name,
             COALESCE(SUM(r.approved_points),0)::int AS points,
             COUNT(r.id) FILTER (WHERE r.status = 'approved')::int AS approvals
      FROM members m
      LEFT JOIN requests r ON r.member_id = m.id AND r.status = 'approved'
      WHERE m.active = TRUE
      GROUP BY m.id, m.name
      ORDER BY points DESC
      LIMIT 15
    `);

    // Members with zero points
    const zeroPointMembers = await pool.query(`
      SELECT m.name
      FROM members m
      LEFT JOIN requests r ON r.member_id = m.id AND r.status = 'approved'
      WHERE m.active = TRUE
      GROUP BY m.id, m.name
      HAVING COALESCE(SUM(r.approved_points),0) = 0
      ORDER BY m.name
    `);

    // Category breakdown of approved points
    const byCategory = await pool.query(`
      SELECT COALESCE(c.name, r.custom_category, 'Other') AS category,
             SUM(r.approved_points)::int AS points,
             COUNT(*)::int AS count
      FROM requests r
      LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.status = 'approved'
      GROUP BY 1
      ORDER BY points DESC
    `);

    // Status distribution
    const statusBreakdown = await pool.query(`
      SELECT status, COUNT(*)::int AS count
      FROM requests
      GROUP BY status
    `);

    // Hour-of-day distribution of submissions
    const hourly = await pool.query(`
      SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS count
      FROM requests
      GROUP BY hour
      ORDER BY hour
    `);

    // Day-of-week distribution of submissions (0=Sun .. 6=Sat)
    const weekday = await pool.query(`
      SELECT EXTRACT(DOW FROM created_at)::int AS dow, COUNT(*)::int AS count
      FROM requests
      GROUP BY dow
      ORDER BY dow
    `);

    // Approval rate by member (members with at least 1 resolved request)
    const approvalRate = await pool.query(`
      SELECT m.name,
             COUNT(*) FILTER (WHERE r.status = 'approved')::int AS approved,
             COUNT(*) FILTER (WHERE r.status = 'denied')::int AS denied,
             COUNT(*) FILTER (WHERE r.status IN ('approved','denied'))::int AS resolved
      FROM members m
      JOIN requests r ON r.member_id = m.id
      WHERE m.active = TRUE AND r.status IN ('approved','denied')
      GROUP BY m.id, m.name
      HAVING COUNT(*) FILTER (WHERE r.status IN ('approved','denied')) >= 3
      ORDER BY (COUNT(*) FILTER (WHERE r.status = 'approved'))::float
               / NULLIF(COUNT(*) FILTER (WHERE r.status IN ('approved','denied')), 0) DESC
      LIMIT 15
    `);

    // Top categories by request volume
    const topCategoryVolume = await pool.query(`
      SELECT COALESCE(c.name, r.custom_category, 'Other') AS category,
             COUNT(*)::int AS count
      FROM requests r
      LEFT JOIN categories c ON c.id = r.category_id
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 10
    `);

    // Cumulative points over time (last 60 days)
    const cumulative = await pool.query(`
      WITH days AS (
        SELECT generate_series(
          (CURRENT_DATE - INTERVAL '59 days')::date,
          CURRENT_DATE::date,
          '1 day'
        )::date AS day
      ),
      daily AS (
        SELECT d.day,
               COALESCE(SUM(r.approved_points), 0)::int AS pts
        FROM days d
        LEFT JOIN requests r
          ON date_trunc('day', r.resolved_at)::date = d.day
         AND r.status = 'approved'
        GROUP BY d.day
      )
      SELECT to_char(day, 'YYYY-MM-DD') AS day,
             SUM(pts) OVER (ORDER BY day)::int AS cumulative
      FROM daily
      ORDER BY day
    `);

    res.json({
      totals: totals.rows[0],
      pointsPerDay: perDay.rows,
      submittedPerDay: submittedPerDay.rows,
      topMembers: topMembers.rows,
      zeroPointMembers: zeroPointMembers.rows,
      byCategory: byCategory.rows,
      statusBreakdown: statusBreakdown.rows,
      hourly: hourly.rows,
      weekday: weekday.rows,
      approvalRate: approvalRate.rows,
      topCategoryVolume: topCategoryVolume.rows,
      cumulative: cumulative.rows
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Failed to load analytics', detail: err.message });
  }
});

// CSV Export (admin)
app.get('/api/export/csv', requireAdmin, async (req, res) => {
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
  csv += 'Rank,Name,Total Points,Status\n';
  members.rows.forEach((m, i) => {
    csv += `${i + 1},"${m.name}",${m.total_points},${m.active ? 'Active' : 'Removed'}\n`;
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

// Backups — full JSON snapshots of the database in a private Vercel Blob store
const BACKUP_PREFIX = 'backups/';
const BACKUP_RETENTION_DAYS = 365;

async function runBackup(trigger) {
  const [members, categories, requests] = await Promise.all([
    pool.query('SELECT * FROM members ORDER BY id'),
    pool.query('SELECT * FROM categories ORDER BY id'),
    // Timestamps as text: the columns have no time zone, so this round-trips exactly on restore
    pool.query(`
      SELECT id, member_id, category_id, custom_category, requested_points, explanation, status,
             approved_points, admin_note, created_at::text AS created_at, resolved_at::text AS resolved_at
      FROM requests ORDER BY id
    `)
  ]);

  const snapshot = {
    version: 1,
    created_at: new Date().toISOString(),
    trigger,
    counts: {
      members: members.rows.length,
      categories: categories.rows.length,
      requests: requests.rows.length
    },
    members: members.rows,
    categories: categories.rows,
    requests: requests.rows
  };

  const pathname = `${BACKUP_PREFIX}aepi-backup-${snapshot.created_at.replace(/[:.]/g, '-')}.json`;
  const blob = await put(pathname, JSON.stringify(snapshot), {
    access: 'private',
    contentType: 'application/json'
  });

  // Prune backups past the retention window
  const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const { blobs } = await list({ prefix: BACKUP_PREFIX, limit: 1000 });
  const expired = blobs.filter(b => new Date(b.uploadedAt).getTime() < cutoff).map(b => b.url);
  if (expired.length > 0) await del(expired);

  return { pathname: blob.pathname, counts: snapshot.counts, pruned: expired.length };
}

// Daily backup — called by Vercel Cron, which sends "Authorization: Bearer $CRON_SECRET"
app.get('/api/cron/backup', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${secret}`;
  if (!secret || auth.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    res.json(await runBackup('cron'));
  } catch (err) {
    console.error('Backup failed:', err);
    res.status(500).json({ error: 'Backup failed', detail: err.message });
  }
});

// List backups (admin)
app.get('/api/admin/backups', requireAdmin, async (req, res) => {
  const { blobs } = await list({ prefix: BACKUP_PREFIX, limit: 1000 });
  blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(blobs.map(b => ({ pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt })));
});

// Run a backup now (admin)
app.post('/api/admin/backups', requireAdmin, async (req, res) => {
  try {
    res.json(await runBackup('manual'));
  } catch (err) {
    console.error('Backup failed:', err);
    res.status(500).json({ error: 'Backup failed', detail: err.message });
  }
});

// Download one backup (admin)
app.get('/api/admin/backups/download', requireAdmin, async (req, res) => {
  const { pathname } = req.query;
  if (typeof pathname !== 'string' || !pathname.startsWith(BACKUP_PREFIX) || pathname.includes('..')) {
    return res.status(400).json({ error: 'Invalid backup' });
  }
  const result = await get(pathname, { access: 'private', useCache: false });
  if (!result || result.statusCode !== 200) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  const body = Buffer.from(await new Response(result.stream).arrayBuffer());
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${pathname.slice(BACKUP_PREFIX.length)}"`);
  res.send(body);
});

// Admin auth
const crypto = require('crypto');
// In production the env vars are required — no hardcoded fallback
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' ? null : 'touse123');
const TOKEN_SECRET = process.env.TOKEN_SECRET ||
  (ADMIN_PASSWORD ? crypto.createHash('sha256').update(ADMIN_PASSWORD + 'aepi_secret').digest('hex') : null);

// Rate limiting for login attempts — stored in Postgres so it survives serverless cold starts
const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function clientIp(req) {
  // Vercel sets x-forwarded-for itself; the first entry is the real client IP
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : req.ip) || 'unknown';
}

async function checkRateLimit(ip) {
  await pool.query(`DELETE FROM login_attempts WHERE first_attempt < NOW() - INTERVAL '${LOCKOUT_MINUTES} minutes'`);
  const { rows } = await pool.query('SELECT count FROM login_attempts WHERE ip = $1', [ip]);
  return rows.length === 0 || rows[0].count < MAX_ATTEMPTS;
}

async function recordFailedAttempt(ip) {
  await pool.query(`
    INSERT INTO login_attempts (ip) VALUES ($1)
    ON CONFLICT (ip) DO UPDATE SET count = login_attempts.count + 1
  `, [ip]);
}

async function clearAttempts(ip) {
  await pool.query('DELETE FROM login_attempts WHERE ip = $1', [ip]);
}

function generateToken() {
  const timestamp = Date.now().toString();
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(timestamp).digest('hex');
  return `${timestamp}.${signature}`;
}

function verifyToken(token) {
  if (!TOKEN_SECRET) return false;
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

app.post('/api/admin/login', async (req, res) => {
  if (!ADMIN_PASSWORD || !TOKEN_SECRET) {
    return res.status(500).json({ error: 'Admin login not configured. Set ADMIN_PASSWORD and TOKEN_SECRET env vars.' });
  }

  const ip = clientIp(req);

  // Check rate limit
  if (!(await checkRateLimit(ip))) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const { password } = req.body;

  // Validate input
  if (typeof password !== 'string' || password.length > 100) {
    await recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Wrong password' });
  }

  // Timing-safe comparison
  const match = password.length === ADMIN_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD));

  if (match) {
    await clearAttempts(ip);
    const token = generateToken();
    res.json({ success: true, token });
  } else {
    await recordFailedAttempt(ip);
    res.status(401).json({ error: 'Wrong password' });
  }
});

const PORT = process.env.PORT || 3000;

// For local development (on Vercel, initDb runs via the middleware above)
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// Export for Vercel
module.exports = app;
