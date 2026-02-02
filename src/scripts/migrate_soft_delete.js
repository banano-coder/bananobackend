const { pool } = require('../db/pool');
require('dotenv').config();

async function migrate() {
    console.log('--- Iniciando Migración: Soft Delete para Usuarios ---');
    const client = await pool.connect();
    try {
        // 1. Agregar columna 'eliminado' si no existe
        console.log('Agregando columna "eliminado" a tabla public.usuario...');
        await client.query(`
            ALTER TABLE public.usuario 
            ADD COLUMN IF NOT EXISTS eliminado BOOLEAN DEFAULT false;
        `);
        console.log('Columna agregada (o ya existía).');

        // 2. Opcional: Asegurar que NULLs existentes sean false (aunque el DEFAULT se encarga de nuevos)
        await client.query(`
            UPDATE public.usuario SET eliminado = false WHERE eliminado IS NULL;
        `);

        console.log('MIGRACIÓN COMPLETADA EXITOSAMENTE.');
    } catch (err) {
        console.error('ERROR EN MIGRACIÓN:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
