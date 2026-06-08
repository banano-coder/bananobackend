const { pool } = require('../db/pool');
require('dotenv').config();

async function migrate() {
  console.log('--- Iniciando Migración: Gestión de Cashea y Comisiones ---');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Modificar tabla public.cuenta
    console.log('Modificando tabla public.cuenta...');
    await client.query(`
      ALTER TABLE public.cuenta 
      ADD COLUMN IF NOT EXISTS es_cashea BOOLEAN DEFAULT false;
    `);

    // 2. Modificar tabla public.transaccion_caja
    console.log('Modificando tabla public.transaccion_caja...');
    await client.query(`
      ALTER TABLE public.transaccion_caja 
      ADD COLUMN IF NOT EXISTS liquidado BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS fecha_liquidacion TIMESTAMP WITH TIME ZONE DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS comision_usd NUMERIC(15, 2) DEFAULT 0.00,
      ADD COLUMN IF NOT EXISTS comision_real NUMERIC(15, 2) DEFAULT 0.00;
    `);

    // 3. Modificar tabla public.pedido_item
    console.log('Modificando tabla public.pedido_item...');
    await client.query(`
      ALTER TABLE public.pedido_item 
      ADD COLUMN IF NOT EXISTS comision_cashea NUMERIC(15, 2) DEFAULT 0.00;
    `);

    // 4. Modificar tabla public.pedido
    console.log('Modificando tabla public.pedido...');
    await client.query(`
      ALTER TABLE public.pedido 
      ADD COLUMN IF NOT EXISTS comision_total_cashea NUMERIC(15, 2) DEFAULT 0.00;
    `);

    // 5. Insertar Categoría de Gasto para Comisiones Cashea
    console.log('Insertando categoría de gasto para Comisiones Cashea si no existe...');
    await client.query(`
      INSERT INTO public.categoria_gasto (nombre, descripcion, icono, color)
      VALUES (
        'Comisiones Cashea', 
        'Comisiones automáticas del 4% descontadas por cobros a través de la plataforma Cashea.', 
        'Percent', 
        '#f97316'
      )
      ON CONFLICT (nombre) DO NOTHING;
    `);

    await client.query('COMMIT');
    console.log('MIGRACIÓN DE CASHEA COMPLETADA EXITOSAMENTE.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR EN MIGRACIÓN DE CASHEA:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
