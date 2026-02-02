const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/banano_db'
});

async function migrate() {
    const client = await pool.connect();
    try {
        console.log('--- Iniciando migración: Soft Delete para Marcas y Categorías ---');

        // 1. Agregar columna eliminado a marca si no existe
        await client.query(`
      ALTER TABLE public.marca 
      ADD COLUMN IF NOT EXISTS eliminado BOOLEAN DEFAULT false;
    `);
        console.log('✅ Columna "eliminado" agregada a la tabla marca.');

        // 2. Agregar columna eliminado a categoria si no existe
        await client.query(`
      ALTER TABLE public.categoria 
      ADD COLUMN IF NOT EXISTS eliminado BOOLEAN DEFAULT false;
    `);
        console.log('✅ Columna "eliminado" agregada a la tabla categoria.');

        // 3. Asegurar que registros existentes no sean NULL
        await client.query(`UPDATE public.marca SET eliminado = false WHERE eliminado IS NULL;`);
        await client.query(`UPDATE public.categoria SET eliminado = false WHERE eliminado IS NULL;`);
        console.log('✅ Registros existentes actualizados.');

        console.log('--- Migración completada con éxito ---');
    } catch (err) {
        console.error('❌ Error en la migración:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
