const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/banano_db'
});

async function migrate() {
    const client = await pool.connect();
    try {
        console.log('--- Iniciando migración: Soft Delete para Variantes ---');

        // 1. Agregar columna eliminado si no existe
        await client.query(`
          ALTER TABLE public.variante_producto 
          ADD COLUMN IF NOT EXISTS eliminado BOOLEAN DEFAULT false;
        `);
        console.log('✅ Columna "eliminado" agregada a la tabla variante_producto.');

        // 2. Asegurar que registros existentes no sean NULL
        await client.query(`
          UPDATE public.variante_producto 
          SET eliminado = false 
          WHERE eliminado IS NULL;
        `);
        console.log('✅ Registros existentes actualizados a eliminado=false.');

        console.log('--- Migración completada con éxito ---');
    } catch (err) {
        console.error('❌ Error en la migración:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
