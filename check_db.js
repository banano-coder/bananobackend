const { pool } = require('./src/db/pool');
require('dotenv').config();

async function check() {
    try {
        console.log('--- Verificando Tabla public.configuracion ---');
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'configuracion'
            );
        `);
        console.log('¿Existe la tabla?:', tableCheck.rows[0].exists);

        if (tableCheck.rows[0].exists) {
            const columns = await pool.query(`
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_name = 'configuracion';
            `);
            console.log('Columnas:', columns.rows);

            const data = await pool.query('SELECT * FROM public.configuracion;');
            console.log('Datos actuales:', data.rows);
        } else {
            console.log('CREANDO TABLA...');
            await pool.query(`
                CREATE TABLE public.configuracion (
                    clave TEXT PRIMARY KEY,
                    valor JSONB NOT NULL,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                );
            `);
            console.log('Tabla creada exitosamente.');
        }
    } catch (err) {
        console.error('ERROR:', err);
    } finally {
        await pool.end();
    }
}

check();
