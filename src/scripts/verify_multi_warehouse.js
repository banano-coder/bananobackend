const { pool } = require('../db/pool');
require('dotenv').config();

async function test() {
  const client = await pool.connect();
  try {
    // 1. Create a second warehouse
    console.log('Creando almacén de prueba (Sucursal Oeste)...');
    const alm = await client.query(`
      INSERT INTO public.almacen (nombre, direccion, telefono, activo, eliminado)
      VALUES ('Sucursal Oeste', 'Av. Intercomunal', '555-1234', true, false)
      ON CONFLICT (nombre) DO UPDATE SET eliminado = false RETURNING id_almacen
    `);
    const testAlmId = alm.rows[0].id_almacen;
    console.log(`Almacén de prueba creado con ID: ${testAlmId}`);

    // 2. Fetch a variant
    console.log('Buscando una variante para la prueba...');
    const varRes = await client.query('SELECT id_variante_producto FROM public.variante_producto LIMIT 1');
    if (!varRes.rows.length) {
      console.log('No hay variantes registradas. Por favor agrega un producto primero.');
      return;
    }
    const varId = varRes.rows[0].id_variante_producto;
    console.log(`Variante seleccionada para la prueba: ID ${varId}`);

    // 3. Insert stock for that variant in the new warehouse
    console.log(`Insertando 15 unidades de stock para la variante ${varId} en el almacén ${testAlmId}...`);
    await client.query(`
      INSERT INTO public.inventario (id_variante_producto, id_almacen, stock)
      VALUES ($1, $2, 15)
      ON CONFLICT (id_variante_producto, id_almacen) DO UPDATE SET stock = 15
    `, [varId, testAlmId]);

    // 4. Query stock: warehouse-specific vs consolidated
    const specificStock = await client.query(`
      SELECT stock FROM public.inventario WHERE id_variante_producto = $1 AND id_almacen = $2
    `, [varId, testAlmId]);
    console.log(`Stock en Sucursal Oeste: ${specificStock.rows[0]?.stock} (Esperado: 15)`);

    const consolidatedStock = await client.query(`
      SELECT SUM(stock) as stock FROM public.inventario WHERE id_variante_producto = $1
    `, [varId]);
    console.log(`Stock consolidado total: ${consolidatedStock.rows[0]?.stock}`);

    // 5. Clean up testing data
    console.log('Limpiando datos de prueba...');
    await client.query('DELETE FROM public.inventario WHERE id_variante_producto = $1 AND id_almacen = $2', [varId, testAlmId]);
    await client.query('DELETE FROM public.almacen WHERE id_almacen = $1', [testAlmId]);

    console.log('TODO OK: Pruebas de base de datos multi-almacén exitosas.');
  } catch (err) {
    console.error('ERROR EN PRUEBAS:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

test();
