const { pool } = require('../db/pool');
require('dotenv').config();

async function verify() {
  const client = await pool.connect();
  try {
    console.log('Iniciando verificación de asociación usuario-almacén...');

    // 1. Consultar usuarios con sucursal
    const { rows: users } = await client.query(`
      SELECT u.id_usuario, u.nombre, u.email, u.id_almacen, alm.nombre AS almacen_nombre
      FROM public.usuario u
      LEFT JOIN public.almacen alm ON alm.id_almacen = u.id_almacen
      WHERE u.eliminado = false
      LIMIT 3
    `);
    console.log('Usuarios encontrados en la base de datos:');
    users.forEach(u => {
      console.log(`- ID: ${u.id_usuario}, Nombre: ${u.nombre}, Almacén Asignado: ${u.almacen_nombre || 'Ninguno (Central)'} (ID: ${u.id_almacen || 'NULL'})`);
    });

    if (users.length === 0) {
      console.log('No hay usuarios en la base de datos.');
      return;
    }

    const testUser = users[0];

    // 2. Probar cambio de almacén a un almacén de prueba temporal
    console.log(`\nProbando asignación de almacén para el usuario ID ${testUser.id_usuario}...`);
    
    // Crear almacén temporal
    const almRes = await client.query(`
      INSERT INTO public.almacen (nombre, direccion, telefono, activo, eliminado)
      VALUES ('Sucursal Test Temporal', 'Calle Test', '12345', true, false)
      ON CONFLICT (nombre) DO UPDATE SET eliminado = false RETURNING id_almacen
    `);
    const tempAlmId = almRes.rows[0].id_almacen;
    console.log(`Almacén temporal creado con ID: ${tempAlmId}`);

    // Asignar al usuario
    await client.query(`
      UPDATE public.usuario SET id_almacen = $1 WHERE id_usuario = $2
    `, [tempAlmId, testUser.id_usuario]);

    // Verificar asignación con join
    const verifyUser = await client.query(`
      SELECT u.id_usuario, u.nombre, u.id_almacen, alm.nombre AS almacen_nombre
      FROM public.usuario u
      LEFT JOIN public.almacen alm ON alm.id_almacen = u.id_almacen
      WHERE u.id_usuario = $1
    `, [testUser.id_usuario]);

    const updatedUser = verifyUser.rows[0];
    console.log(`Verificación de asignación:`);
    console.log(`- Almacén asignado: ${updatedUser.almacen_nombre} (ID: ${updatedUser.id_almacen})`);
    if (updatedUser.id_almacen === tempAlmId && updatedUser.almacen_nombre === 'Sucursal Test Temporal') {
      console.log('-> ÉXITO: Relación e integración de Join de base de datos verificada con éxito.');
    } else {
      console.error('-> ERROR: La asignación no coincide.');
    }

    // 3. Restaurar usuario original y limpiar almacén temporal
    console.log('\nRestaurando valores originales...');
    await client.query(`UPDATE public.usuario SET id_almacen = $1 WHERE id_usuario = $2`, [testUser.id_almacen, testUser.id_usuario]);
    await client.query(`DELETE FROM public.almacen WHERE id_almacen = $1`, [tempAlmId]);

    console.log('Restauración completada.');
    console.log('TODO OK: Pruebas de integración de base de datos exitosas.');

  } catch (err) {
    console.error('ERROR EN VERIFICACIÓN:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

verify();
