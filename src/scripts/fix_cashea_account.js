const { pool } = require('../db/pool');

async function fix() {
  try {
    const { rowCount } = await pool.query(
      `UPDATE public.cuenta 
       SET nombre = nombre || ' (Eliminada ' || id_cuenta || ')' 
       WHERE eliminado = true AND nombre NOT LIKE '%(Eliminada%'`
    );
    console.log(`Fixed ${rowCount} accounts.`);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

fix();
