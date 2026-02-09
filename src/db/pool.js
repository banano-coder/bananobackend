const { Pool } = require('pg');
const env = require('../config/env');

const ssl =
  env.PGSSL === 'require'
    ? { rejectUnauthorized: false } // útil en Railway/Render/Heroku-like
    : false;

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  min: env.PGPOOL_MIN,
  max: env.PGPOOL_MAX,
  idleTimeoutMillis: env.PGPOOL_IDLE_MS,
  ssl
});

// Comprobación inicial de conexión
pool.on('error', (err) => {
  console.error('❌ Error inesperado en el pool:', err);
});

async function ping() {
  // SELECT 1 es suficiente para Postgres 17
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}

module.exports = { pool, ping };
