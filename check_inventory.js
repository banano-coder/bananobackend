const { pool } = require('./src/db/pool');
require('dotenv').config();

async function check() {
    try {
        console.log('--- Verificando Tabla public.inventario ---');
        const columns = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'inventario'
            ORDER BY ordinal_position;
        `);
        console.log('Columnas:', columns.rows);

        const data = await pool.query('SELECT * FROM public.inventario LIMIT 10;');
        console.log('Datos actuales (primeros 10):');
        console.table(data.rows);

        // Check for specific columns that might be "empty"
        const nullChecks = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(id_inventario) as has_id,
                COUNT(id_variante_producto) as has_variante,
                COUNT(cantidad) as has_cantidad,
                COUNT(tipo_movimiento) as has_tipo,
                COUNT(motivo) as has_motivo,
                COUNT(fecha_movimiento) as has_fecha
            FROM public.inventario;
        `);
        console.log('Validación de valores nulos:');
        console.table(nullChecks.rows);

    } catch (err) {
        console.error('ERROR:', err);
    } finally {
        await pool.end();
    }
}

check();
