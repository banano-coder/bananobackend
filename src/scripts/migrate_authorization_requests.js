const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/banano_db'
});

async function migrate() {
    const client = await pool.connect();
    try {
        console.log('--- Iniciando migración: Tabla de Solicitudes de Autorización ---');

        await client.query(`
          CREATE TABLE IF NOT EXISTS public.solicitud_autorizacion (
              id_solicitud SERIAL PRIMARY KEY,
              id_usuario_solicitante INT NOT NULL REFERENCES public.usuario(id_usuario) ON DELETE CASCADE,
              tipo_accion VARCHAR(50) NOT NULL,
              target_id INT NOT NULL,
              target_nombre VARCHAR(255) NOT NULL,
              motivo TEXT NOT NULL,
              estado VARCHAR(20) DEFAULT 'pendiente',
              id_usuario_autorizador INT REFERENCES public.usuario(id_usuario) ON DELETE SET NULL,
              comentario_autorizador TEXT,
              fecha_creacion TIMESTAMPTZ DEFAULT NOW(),
              fecha_resolucion TIMESTAMPTZ
          );
        `);
        console.log('✅ Tabla public.solicitud_autorizacion creada/verificada.');

        console.log('--- Migración completada con éxito ---');
    } catch (err) {
        console.error('❌ Error en la migración:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
