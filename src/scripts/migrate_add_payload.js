const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function migrate() {
    const client = await pool.connect();
    try {
        console.log('--- Iniciando migración: Agregar columna payload a Solicitudes ---');

        await client.query(`
          ALTER TABLE public.solicitud_autorizacion 
          ADD COLUMN IF NOT EXISTS payload JSONB;
        `);
        console.log('✅ Columna payload agregada/verificada en public.solicitud_autorizacion.');

        console.log('--- Migración completada con éxito ---');
    } catch (err) {
        console.error('❌ Error en la migración:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
