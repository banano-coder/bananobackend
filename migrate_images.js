const { pool } = require('./src/db/pool');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Starting migration...');
    await client.query('BEGIN');

    // Add column if not exists
    await client.query(`
      ALTER TABLE public.imagen_producto 
      ADD COLUMN IF NOT EXISTS id_variante_producto INTEGER REFERENCES public.variante_producto(id_variante_producto) ON DELETE SET NULL;
    `);

    // Add index for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_imagen_producto_variante ON public.imagen_producto(id_variante_producto);
    `);

    await client.query('COMMIT');
    console.log('Migration successful: Added id_variante_producto to imagen_producto');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
  } finally {
    client.release();
    pool.end();
  }
}

migrate();
