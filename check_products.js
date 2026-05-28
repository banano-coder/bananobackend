const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const query = `
      SELECT
        p.id_producto,
        p.nombre,
        p.id_categoria,
        p.activo,
        p.eliminado,
        (SELECT COUNT(*)::int FROM public.variante_producto vp WHERE vp.id_producto = p.id_producto AND vp.activo = true) AS active_variants_count
      FROM public.producto p
      WHERE p.id_producto IN (246, 247, 248, 249, 250)
    `;
    const { rows } = await pool.query(query);
    console.log('--- PLUG PRODUCTS DETAILS ---');
    console.log(rows);

    console.log('--- ALL PRODUCTS RETURNED BY CATALOG QUERY ---');
    const catalogQuery = `
      SELECT
        p.id_producto,
        p.nombre,
        p.id_categoria,
        MIN(vp.precio_lista) AS min_price,
        COUNT(vp.precio_lista) FILTER (WHERE vp.activo = true) AS variantes_activas
      FROM public.producto p
      LEFT JOIN public.variante_producto vp
        ON vp.id_producto = p.id_producto
       AND vp.activo = true
      WHERE p.activo = true AND p.eliminado = false
      GROUP BY p.id_producto
    `;
    const { rows: catalogRows } = await pool.query(catalogQuery);
    console.log(`Total catalog products: ${catalogRows.length}`);
    const plugCatalog = catalogRows.filter(r => ['5', '18', 5, 18].includes(r.id_categoria));
    console.log('Plug products in catalog output:', plugCatalog);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
