const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize tables
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      default_points INTEGER NOT NULL
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

  // Seed categories if empty
  const { rows } = await pool.query('SELECT COUNT(*) as count FROM categories');
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
      await pool.query('INSERT INTO categories (name, default_points) VALUES ($1, $2)', [name, points]);
    }
  }

  // Seed members if empty
  const membersResult = await pool.query('SELECT COUNT(*) as count FROM members');
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
      await pool.query('INSERT INTO members (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    }
  }

  console.log('Database initialized');
}

module.exports = { pool, initDb };
