/**
 * PostgreSQL connection pool for the same-server mirror database.
 *
 * MongoDB stays the application's source of truth; this pool only keeps a
 * second, identical database available on the same Node server (started with
 * the API in src/server.js) and is used by the migration scripts
 * (npm run migrate:pg / npm run seed:pg).
 *
 * Configuration: PG_URI in backend/.env (see postgres/README.md).
 */
const { Pool } = require('pg');
require('../config'); // loads .env so process.env.PG_URI is available

const maskUri = (uri) => String(uri).replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@');

const pool = new Pool({
  connectionString:
    process.env.PG_URI || 'postgresql://postgres@127.0.0.1:5432/online_food_kitchen',
});

/**
 * Verifies the PostgreSQL mirror is reachable. Never throws — a missing
 * mirror must not stop the API (MongoDB is the source of truth).
 * @returns {Promise<boolean>} true when connected
 */
const connectPostgres = async () => {
  const uri = maskUri(pool.options.connectionString || '');
  try {
    await pool.query('SELECT 1');
    console.log(`PostgreSQL connected: ${uri}`);
    return true;
  } catch (error) {
    console.warn(
      `PostgreSQL mirror unavailable (${error.message}). ` +
        'The API keeps running on MongoDB; start PostgreSQL or run migrate:pg to enable the mirror.'
    );
    return false;
  }
};

const closePostgres = async () => {
  try {
    await pool.end();
  } catch (error) {
    // Pool already closed on shutdown — nothing to do.
  }
};

module.exports = { pool, connectPostgres, closePostgres, maskUri };
