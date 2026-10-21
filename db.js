const { Pool } = require('pg');

const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false }
});

// Initialize tables
async function initDb(db = pool, { seed = true } = {}) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      default_points INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 1,
      first_attempt TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS requests (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id),
      category_id INTEGER REFERENCES categories(id),
      custom_category TEXT,
      requested_points INTEGER NOT NULL,
      explanation TEXT,
      status TEXT DEFAULT 'pending',
      approved_points INTEGER,
      admin_note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMP
    );
  `);

  // Migration for existing databases
  await db.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`);

  // Enable RLS with no policies: blocks Supabase's auto-generated REST API (PostgREST)
  // from touching these tables. Our server connects as the table owner, which bypasses RLS.
  await db.query(`
    ALTER TABLE members ENABLE ROW LEVEL SECURITY;
    ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
    ALTER TABLE requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
  `);

  if (!seed) return;

  // Seed categories if empty
  const { rows } = await db.query('SELECT COUNT(*) as count FROM categories');
  if (parseInt(rows[0].count) === 0) {
    const categories = [
      ['Chapter Meeting', 10],
      ['New Member Education', 3],
      ['Event Setup', 2],
      ['Event Cleanup', 2],
      ['Sober Brother (Exchange)', 4],
      ['Sober Brother (Party/Tailgate)', 7],
      ['Supply Run (Driver)', 7],
      ['Supply Run (Passenger)', 3],
      ['DJ Work (per hour, max 15)', 5],
      ['DJ Learning Session', 10],
    ];
    for (const [name, points] of categories) {
      await db.query('INSERT INTO categories (name, default_points) VALUES ($1, $2)', [name, points]);
    }
  }

  // Seed members if empty
  const membersResult = await db.query('SELECT COUNT(*) as count FROM members');
  if (parseInt(membersResult.rows[0].count) === 0) {
    const members = [
      'Dylan Goldman', 'Nevan Hanford', 'Michael Dunn', 'Eddie Maxwell',
      'Ezra Schaffer', 'Ben Goldberg', 'Andrew Petlak', 'Jacob Siegel',
      'Nathan Yafeh', 'Jacob Zeelander', 'Blake Glickman', 'Ben Weiss-Ishai',
      'Nate Frank', 'Shai Grossman', 'Roni Kriger', 'Asher Bailey', 
      'Roy Ruppin', 'Noah Fields', 'David Levin',
      'Gideon Goldberg', 'Ziv Behar', 'Jacob Hedges', 'Roy Almog',
      'Dan Honigstein', 'Solel Marques', 'Dash Rader', 'Noam Hoffman',
      'Alan Krapivner', 'Aiden Mertzel', 'Cole Kellison', 'Jasper Vyda',
      'Liad Shaphir', 'Patrick Van Kerckhove', 'Ben Matinfar', 'Henry Speiser',
      'Spencer Lee', 'Adam Faradjev'
    ];
    for (const name of members) {
      await db.query('INSERT INTO members (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    }
  }

  console.log('Database initialized');
}

module.exports = { pool, initDb };
