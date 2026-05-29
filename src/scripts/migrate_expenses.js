const { pool } = require('../db/pool');
require('dotenv').config();

async function migrate() {
  console.log('--- Iniciando Migración: Módulo de Gastos ---');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Crear tabla public.categoria_gasto
    console.log('Creando tabla public.categoria_gasto...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.categoria_gasto (
        id_categoria_gasto SERIAL PRIMARY KEY,
        nombre VARCHAR(150) NOT NULL UNIQUE,
        descripcion TEXT,
        icono VARCHAR(50) NOT NULL DEFAULT 'Receipt',
        color VARCHAR(20) NOT NULL DEFAULT '#ef4444',
        activo BOOLEAN DEFAULT true,
        eliminado BOOLEAN DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // 2. Insertar categorías por defecto
    console.log('Insertando categorías por defecto...');
    const defaultCategories = [
      ['Servicios Públicos', 'Pagos de luz, agua, internet, telefonía, etc.', 'Lightbulb', '#eab308'],
      ['Alquiler y Locales', 'Pago de arrendamiento de locales y sucursales.', 'Home', '#3b82f6'],
      ['Sueldos y Nómina', 'Pago de salarios, comisiones y honorarios.', 'UserCheck', '#10b981'],
      ['Publicidad y Mercadeo', 'Inversión en anuncios, folletos, redes sociales, etc.', 'Megaphone', '#ec4899'],
      ['Mantenimiento y Reparación', 'Gastos en reparaciones de infraestructura o equipos.', 'Wrench', '#f97316'],
      ['Otros Gastos', 'Egresos generales no clasificados.', 'Coins', '#6b7280']
    ];

    for (const [nombre, descripcion, icono, color] of defaultCategories) {
      await client.query(`
        INSERT INTO public.categoria_gasto (nombre, descripcion, icono, color)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (nombre) DO NOTHING;
      `, [nombre, descripcion, icono, color]);
    }

    // 3. Crear tabla public.gasto
    console.log('Creando tabla public.gasto...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.gasto (
        id_gasto SERIAL PRIMARY KEY,
        id_categoria_gasto INT REFERENCES public.categoria_gasto(id_categoria_gasto) ON DELETE RESTRICT,
        monto_usd NUMERIC(15, 2) NOT NULL,
        tasa_cambio NUMERIC(15, 4) DEFAULT 1.0000,
        monto_real NUMERIC(15, 2) NOT NULL,
        id_cuenta INT REFERENCES public.cuenta(id_cuenta) ON DELETE RESTRICT,
        id_almacen INT REFERENCES public.almacen(id_almacen) ON DELETE SET NULL,
        id_usuario INT REFERENCES public.usuario(id_usuario) ON DELETE SET NULL,
        concepto VARCHAR(255) NOT NULL,
        fecha_gasto DATE NOT NULL DEFAULT CURRENT_DATE,
        eliminado BOOLEAN DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    await client.query('COMMIT');
    console.log('MIGRACIÓN DE GASTOS COMPLETADA EXITOSAMENTE.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR EN MIGRACIÓN DE GASTOS:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
