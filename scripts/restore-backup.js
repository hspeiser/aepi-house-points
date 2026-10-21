// Restore the database from a JSON backup downloaded from the admin Backups tab.
//
//   DATABASE_URL=postgres://... node scripts/restore-backup.js path/to/aepi-backup-....json --yes
//
// This REPLACES all members, categories and requests with the backup's contents.
// Take a fresh backup first if the current data matters at all.

const fs = require('fs');

async function main() {
  const [file, confirm] = process.argv.slice(2);
  if (!file) {
    console.error('Usage: node scripts/restore-backup.js <backup.json> --yes');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('Set DATABASE_URL to the database you want to restore into.');
    process.exit(1);
  }

  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (backup.version !== 1 || !Array.isArray(backup.members) || !Array.isArray(backup.requests)) {
    console.error('That file does not look like an AEPi house points backup.');
    process.exit(1);
  }

  const host = new URL(process.env.DATABASE_URL).host;
  console.log(`Backup from ${backup.created_at}: ${backup.members.length} members, ` +
    `${backup.categories.length} categories, ${backup.requests.length} requests`);
  console.log(`Target database: ${host}`);
  if (confirm !== '--yes') {
    console.log('\nDry run only. Re-run with --yes to replace all data in the target database.');
    return;
  }

  const { pool, initDb } = require('../db');

  // Make sure the tables exist (fresh database case)
  await initDb(pool, { seed: false });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE requests, members, categories RESTART IDENTITY CASCADE');

    for (const m of backup.members) {
      await client.query('INSERT INTO members (id, name, active) VALUES ($1, $2, $3)',
        [m.id, m.name, m.active !== false]);
    }
    for (const c of backup.categories) {
      await client.query('INSERT INTO categories (id, name, default_points) VALUES ($1, $2, $3)',
        [c.id, c.name, c.default_points]);
    }
    for (const r of backup.requests) {
      await client.query(`
        INSERT INTO requests (id, member_id, category_id, custom_category, requested_points, explanation,
                              status, approved_points, admin_note, created_at, resolved_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [r.id, r.member_id, r.category_id, r.custom_category, r.requested_points, r.explanation,
          r.status, r.approved_points, r.admin_note, r.created_at, r.resolved_at]);
    }

    // Point the id counters past the restored rows so new inserts don't collide
    for (const table of ['members', 'categories', 'requests']) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                                        COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
    }

    await client.query('COMMIT');
    console.log('Restore complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Restore failed, nothing was changed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
