const { pool } = require('../db/pool');
require('dotenv').config();

async function migrate() {
  console.log('--- Iniciando Migración: Módulo de Dinero, Cuentas y Divisas ---');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Crear tabla public.cuenta
    console.log('Creando tabla public.cuenta...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.cuenta (
        id_cuenta SERIAL PRIMARY KEY,
        nombre VARCHAR(150) NOT NULL UNIQUE,
        moneda VARCHAR(10) NOT NULL DEFAULT 'USD',
        saldo NUMERIC(15, 2) DEFAULT 0.00,
        id_almacen INT REFERENCES public.almacen(id_almacen) ON DELETE SET NULL,
        activo BOOLEAN DEFAULT true,
        eliminado BOOLEAN DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // 2. Insertar cuenta por defecto (Caja Efectivo USD)
    console.log('Insertando cuenta por defecto (Caja Efectivo USD)...');
    await client.query(`
      INSERT INTO public.cuenta (nombre, moneda, saldo, activo, eliminado)
      VALUES ('Caja Efectivo USD', 'USD', 0.00, true, false)
      ON CONFLICT (nombre) DO NOTHING;
    `);

    // 3. Crear tabla public.transaccion_caja
    console.log('Creando tabla public.transaccion_caja...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.transaccion_caja (
        id_transaccion SERIAL PRIMARY KEY,
        id_cuenta INT REFERENCES public.cuenta(id_cuenta) ON DELETE CASCADE,
        tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('ingreso', 'egreso')),
        monto_usd NUMERIC(15, 2) NOT NULL,
        tasa_cambio NUMERIC(15, 4) DEFAULT 1.0000,
        monto_real NUMERIC(15, 2) NOT NULL,
        concepto VARCHAR(255) NOT NULL,
        id_pedido INT REFERENCES public.pedido(id_pedido) ON DELETE SET NULL,
        id_usuario INT REFERENCES public.usuario(id_usuario) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // 4. Modificar tabla public.pedido para agregar columnas de divisas y sucursal
    console.log('Modificando tabla public.pedido...');
    await client.query(`
      ALTER TABLE public.pedido ADD COLUMN IF NOT EXISTS id_almacen INT REFERENCES public.almacen(id_almacen) ON DELETE SET NULL;
      ALTER TABLE public.pedido ADD COLUMN IF NOT EXISTS id_usuario INT REFERENCES public.usuario(id_usuario) ON DELETE SET NULL;
      ALTER TABLE public.pedido ADD COLUMN IF NOT EXISTS id_cuenta INT REFERENCES public.cuenta(id_cuenta) ON DELETE SET NULL;
      ALTER TABLE public.pedido ADD COLUMN IF NOT EXISTS moneda_pago VARCHAR(10) DEFAULT 'USD';
      ALTER TABLE public.pedido ADD COLUMN IF NOT EXISTS tasa_cambio NUMERIC(15, 4) DEFAULT 1.0000;
      ALTER TABLE public.pedido ADD COLUMN IF NOT EXISTS monto_pago_real NUMERIC(15, 2);
    `);

    await client.query('COMMIT');
    console.log('MIGRACIÓN COMPLETADA EXITOSAMENTE.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR EN MIGRACIÓN:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
