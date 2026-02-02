const { pool } = require('./src/db/pool');
require('dotenv').config();

async function check() {
    try {
        console.log('--- Diagnóstico de Stock ---');

        const query = `
            SELECT
                p.id_producto,
                p.nombre AS producto,
                p.activo AS producto_activo,
                v.id_variante_producto,
                v.sku,
                v.activo AS variante_activa,
                COALESCE(i.stock, 0)::int AS stock
            FROM public.variante_producto v
            JOIN public.producto p ON p.id_producto = v.id_producto
            LEFT JOIN public.inventario i ON i.id_variante_producto = v.id_variante_producto
            ORDER BY p.id_producto, v.id_variante_producto;
        `;

        const res = await pool.query(query);
        console.log(`Total de variantes: ${res.rows.length}`);

        const stockCero = res.rows.filter(r => r.stock === 0);
        console.log(`Variantes con stock 0: ${stockCero.length}`);

        const stockCeroActivos = stockCero.filter(r => r.producto_activo && r.variante_activa);
        console.log(`Variantes con stock 0 (Producto y Variante Activos): ${stockCeroActivos.length}`);

        console.log('\n--- TODOS LOS PRODUCTOS CON STOCK 0 (ACTIVOS) ---');
        console.table(stockCeroActivos);

        console.log('\n--- TODOS LOS PRODUCTOS CON STOCK <= 3 (ACTIVOS) ---');
        const stockBajoActivos = res.rows.filter(r => r.stock <= 3 && r.producto_activo && r.variante_activa);
        console.table(stockBajoActivos);

    } catch (err) {
        console.error('ERROR:', err);
    } finally {
        await pool.end();
    }
}

check();
