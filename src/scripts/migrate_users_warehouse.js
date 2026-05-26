const { pool } = require('../db/pool');
require('dotenv').config();

async function run() {
  const client = await pool.connect();
  try {
    console.log('Iniciando migración: asociar usuarios con almacén/sucursal...');

    // 1. Crear columna id_almacen en la tabla public.usuario si no existe
    await client.query(`
      ALTER TABLE public.usuario 
      ADD COLUMN IF NOT EXISTS id_almacen INT REFERENCES public.almacen(id_almacen) ON DELETE SET NULL;
    `);
    console.log('Columna id_almacen agregada a public.usuario (o ya existía).');

    // 2. Por compatibilidad, asignar el almacén principal (ID 1) a los usuarios existentes
    const { rowCount } = await client.query(`
      UPDATE public.usuario 
      SET id_almacen = 1 
      WHERE id_almacen IS NULL;
    `);
    console.log(`Asignado Almacén Principal (ID 1) a ${rowCount} usuario(s) existente(s).`);

    console.log('MIGRACIÓN COMPLETADA EXITOSAMENTE.');
  } catch (err) {
    console.error('ERROR EN MIGRACIÓN:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
