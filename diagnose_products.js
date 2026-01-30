const { pool } = require('./src/db/pool');
require('dotenv').config();

async function diagnose() {
    try {
        console.log('--- Diagnóstico de Productos ---');
        const products = await pool.query('SELECT id_producto, nombre, activo FROM producto ORDER BY id_producto ASC LIMIT 10;');
        console.log('Top 10 productos en DB:');
        console.table(products.rows);

        const count = await pool.query('SELECT COUNT(*) FROM producto;');
        console.log('Total productos:', count.rows[0].count);

        // Verificar si hay producto con id=1 (o el que intentó borrar)
        const idToCheck = 1; // El del log del usuario
        const p1 = await pool.query('SELECT * FROM producto WHERE id_producto = $1;', [idToCheck]);
        if (p1.rows.length > 0) {
            console.log(`ALERTA: El producto con ID ${idToCheck} todavía EXISTE en la tabla producto.`);
            console.log(p1.rows[0]);
        } else {
            console.log(`CONFIRMADO: El producto con ID ${idToCheck} NO existe en la tabla producto.`);
        }
    } catch (err) {
        console.error('Error en diagnóstico:', err);
    } finally {
        await pool.end();
    }
}

diagnose();
