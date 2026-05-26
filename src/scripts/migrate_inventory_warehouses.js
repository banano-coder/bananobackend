const { pool } = require('../db/pool');
require('dotenv').config();

async function migrate() {
  console.log('--- Iniciando Migración: Almacenes en Inventario ---');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Obtener el ID del almacén por defecto (usualmente 1 o el primero creado)
    console.log('Buscando almacén por defecto...');
    const almRes = await client.query(`
      SELECT id_almacen FROM public.almacen 
      WHERE nombre = 'Almacén Principal' OR eliminado = false 
      ORDER BY id_almacen ASC LIMIT 1
    `);
    
    if (almRes.rows.length === 0) {
      throw new Error('No se encontró ningún almacén en la tabla public.almacen. Asegúrate de correr migrate_almacen.js primero.');
    }
    const defaultAlmacenId = almRes.rows[0].id_almacen;
    console.log(`Almacén por defecto seleccionado: ID ${defaultAlmacenId}`);

    // 2. Modificar la tabla public.inventario
    console.log('Eliminando índices y restricciones únicas existentes sobre id_variante_producto en public.inventario...');
    await client.query(`
      ALTER TABLE public.inventario DROP CONSTRAINT IF EXISTS uq_inventario_id_variante;
      ALTER TABLE public.inventario DROP CONSTRAINT IF EXISTS uq_inv_variante_id;
    `);
    await client.query(`
      DROP INDEX IF EXISTS public.uq_inventario_id_variante;
      DROP INDEX IF EXISTS public.uq_inv_variante_id;
    `);

    console.log('Verificando columna id_almacen en public.inventario...');
    const checkInvCol = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'inventario' AND column_name = 'id_almacen'
    `);

    if (checkInvCol.rows.length === 0) {
      console.log('Agregando columna id_almacen a public.inventario...');
      await client.query(`
        ALTER TABLE public.inventario 
        ADD COLUMN id_almacen INTEGER REFERENCES public.almacen(id_almacen) ON DELETE CASCADE
      `);
      
      console.log(`Asignando id_almacen = ${defaultAlmacenId} a registros existentes en public.inventario...`);
      await client.query(`
        UPDATE public.inventario SET id_almacen = $1 WHERE id_almacen IS NULL
      `, [defaultAlmacenId]);

      console.log('Haciendo id_almacen NOT NULL en public.inventario...');
      await client.query(`
        ALTER TABLE public.inventario ALTER COLUMN id_almacen SET NOT NULL
      `);
    } else {
      console.log('La columna id_almacen ya existe en public.inventario.');
    }

    // 3. Crear restricción única compuesta (id_variante_producto, id_almacen) si no existe
    console.log('Verificando restricción única uq_variante_almacen...');
    const checkUq = await client.query(`
      SELECT constraint_name FROM information_schema.table_constraints 
      WHERE table_name = 'inventario' AND constraint_name = 'uq_variante_almacen'
    `);

    if (checkUq.rows.length === 0) {
      console.log('Creando restricción única uq_variante_almacen...');
      await client.query(`
        ALTER TABLE public.inventario 
        ADD CONSTRAINT uq_variante_almacen UNIQUE (id_variante_producto, id_almacen)
      `);
    } else {
      console.log('La restricción única uq_variante_almacen ya existe.');
    }

    // 4. Modificar la tabla public.movimiento_inventario
    console.log('Verificando columna id_almacen en public.movimiento_inventario...');
    const checkMovCol = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'movimiento_inventario' AND column_name = 'id_almacen'
    `);

    if (checkMovCol.rows.length === 0) {
      console.log('Agregando columna id_almacen a public.movimiento_inventario...');
      await client.query(`
        ALTER TABLE public.movimiento_inventario 
        ADD COLUMN id_almacen INTEGER REFERENCES public.almacen(id_almacen) ON DELETE RESTRICT
      `);

      console.log(`Asignando id_almacen = ${defaultAlmacenId} a movimientos existentes...`);
      await client.query(`
        UPDATE public.movimiento_inventario SET id_almacen = $1 WHERE id_almacen IS NULL
      `, [defaultAlmacenId]);

      console.log('Haciendo id_almacen NOT NULL en public.movimiento_inventario...');
      await client.query(`
        ALTER TABLE public.movimiento_inventario ALTER COLUMN id_almacen SET NOT NULL
      `);
    } else {
      console.log('La columna id_almacen ya existe en public.movimiento_inventario.');
    }

    await client.query('COMMIT');
    console.log('MIGRACIÓN COMPLETADA EXITOSAMENTE.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR EN MIGRACIÓN:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
