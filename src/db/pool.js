const { Pool } = require('pg');
const env = require('../config/env');

// Supabase y otros proveedores requieren TLS; para desactivarlo usa PGSSL=disable
const ssl = env.PGSSL === 'disable' ? false : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  min: env.PGPOOL_MIN,
  max: env.PGPOOL_MAX,
  idleTimeoutMillis: env.PGPOOL_IDLE_MS,
  connectionTimeoutMillis: 20000, // evita colgarse si el host no responde
  ssl
});

pool.on('error', (err) => {
  console.error('Error inesperado en el pool:', err);
});

async function ping() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}

module.exports = { pool, ping };
