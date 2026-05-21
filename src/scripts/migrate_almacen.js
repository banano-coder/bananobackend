const { pool } = require('../db/pool');
require('dotenv').config();

async function migrate() {
  console.log('--- Iniciando Migración: Creación de la Tabla public.almacen ---');
  const client = await pool.connect();
  try {
    // 1. Crear tabla public.almacen
    console.log('Creando tabla public.almacen si no existe...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.almacen (
        id_almacen SERIAL PRIMARY KEY,
        nombre VARCHAR(150) NOT NULL UNIQUE,
        direccion TEXT,
        telefono VARCHAR(50),
        activo BOOLEAN DEFAULT true,
        eliminado BOOLEAN DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    console.log('Tabla public.almacen verificada/creada.');

    // 2. Insertar almacén por defecto
    console.log('Insertando almacén por defecto (Almacén Principal)...');
    await client.query(`
      INSERT INTO public.almacen (nombre, direccion, telefono, activo, eliminado)
      VALUES ('Almacén Principal', 'Dirección General', '', true, false)
      ON CONFLICT (nombre) DO NOTHING;
    `);
    console.log('Almacén por defecto verificado.');

    console.log('MIGRACIÓN COMPLETADA EXITOSAMENTE.');
  } catch (err) {
    console.error('ERROR EN MIGRACIÓN:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
