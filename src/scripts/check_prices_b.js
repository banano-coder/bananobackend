const { pool } = require('../db/pool');
require('dotenv').config();

async function run() {
    try {
        console.log('Querying products with default variant price mismatch...');
        const { rows } = await pool.query(`
            WITH ProductDefaults AS (
                SELECT 
                    p.id_producto,
                    p.nombre AS product_name,
                    -- Same subquery as used in catalog.routes.js and products.routes.js
                    (SELECT id_variante_producto 
                     FROM public.variante_producto 
                     WHERE id_producto = p.id_producto AND activo = true 
                     ORDER BY id_variante_producto ASC LIMIT 1) AS default_variant_id,
                    MIN(vp.precio_lista)::float AS min_price
                FROM public.producto p
                JOIN public.variante_producto vp ON vp.id_producto = p.id_producto
                WHERE vp.activo = true AND vp.eliminado = false AND p.eliminado = false
                GROUP BY p.id_producto, p.nombre
            )
            SELECT 
                pd.id_producto,
                pd.product_name,
                pd.default_variant_id,
                pd.min_price AS displayed_min_price,
                vp.precio_lista::float AS default_variant_price,
                vp.sku AS default_variant_sku
            FROM ProductDefaults pd
            JOIN public.variante_producto vp ON vp.id_variante_producto = pd.default_variant_id
            WHERE pd.min_price <> vp.precio_lista::float
        `);
        console.log('Mismatched Products:', JSON.stringify(rows, null, 2));
    } catch (e) {
        console.error('Error:', e);
    } finally {
        await pool.end();
    }
}

run();
