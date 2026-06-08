const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

/**
 * 1) GET /api/cashea/stats
 * Obtener estadísticas consolidadas de cobros de Cashea
 */
router.get('/cashea/stats', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    // 1. Total Procesado Cashea (Bruto) y Comisiones Totales Cobradas (sin pedidos anulados)
    const statsQuery = `
      SELECT 
        COALESCE(SUM(t.monto_usd), 0)::float AS total_bruto, 
        COALESCE(SUM(t.comision_usd), 0)::float AS total_comision,
        COALESCE(SUM(t.monto_real), 0)::float AS total_bruto_real, 
        COALESCE(SUM(t.comision_real), 0)::float AS total_comision_real
      FROM public.transaccion_caja t
      JOIN public.cuenta c ON c.id_cuenta = t.id_cuenta
      JOIN public.pedido p ON p.id_pedido = t.id_pedido
      WHERE c.es_cashea = true 
        AND p.estado != 'anulado' 
        AND t.tipo = 'ingreso'
    `;
    const { rows: statsRows } = await pool.query(statsQuery);
    const stats = statsRows[0];

    // 2. Pendiente por Liquidar (Gross y Net)
    const pendingQuery = `
      SELECT 
        COALESCE(SUM(t.monto_usd), 0)::float AS pending_bruto_usd,
        COALESCE(SUM(t.monto_usd - t.comision_usd), 0)::float AS pending_neto_usd,
        COALESCE(SUM(t.monto_real), 0)::float AS pending_bruto_real,
        COALESCE(SUM(t.monto_real - t.comision_real), 0)::float AS pending_neto_real
      FROM public.transaccion_caja t
      JOIN public.cuenta c ON c.id_cuenta = t.id_cuenta
      JOIN public.pedido p ON p.id_pedido = t.id_pedido
      WHERE c.es_cashea = true 
        AND p.estado != 'anulado' 
        AND t.tipo = 'ingreso' 
        AND t.liquidado = false
    `;
    const { rows: pendingRows } = await pool.query(pendingQuery);
    const pending = pendingRows[0];

    // 3. Ya Liquidado (Gross y Net)
    const liquidatedQuery = `
      SELECT 
        COALESCE(SUM(t.monto_usd), 0)::float AS liquidated_bruto_usd,
        COALESCE(SUM(t.monto_usd - t.comision_usd), 0)::float AS liquidated_neto_usd,
        COALESCE(SUM(t.monto_real), 0)::float AS liquidated_bruto_real,
        COALESCE(SUM(t.monto_real - t.comision_real), 0)::float AS liquidated_neto_real
      FROM public.transaccion_caja t
      JOIN public.cuenta c ON c.id_cuenta = t.id_cuenta
      JOIN public.pedido p ON p.id_pedido = t.id_pedido
      WHERE c.es_cashea = true 
        AND p.estado != 'anulado' 
        AND t.tipo = 'ingreso' 
        AND t.liquidado = true
    `;
    const { rows: liquidatedRows } = await pool.query(liquidatedQuery);
    const liquidated = liquidatedRows[0];

    res.json({
      bruto: stats.total_bruto,
      comision: stats.total_comision,
      bruto_real: stats.total_bruto_real,
      comision_real: stats.total_comision_real,
      
      pendiente_bruto: pending.pending_bruto_usd,
      pendiente_neto: pending.pending_neto_usd,
      pendiente_bruto_real: pending.pending_bruto_real,
      pendiente_neto_real: pending.pending_neto_real,

      liquidado_bruto: liquidated.liquidated_bruto_usd,
      liquidado_neto: liquidated.liquidated_neto_usd,
      liquidado_bruto_real: liquidated.liquidated_bruto_real,
      liquidado_neto_real: liquidated.liquidated_neto_real
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 2) GET /api/cashea/transactions
 * Obtener transacciones asociadas a Cashea, filtradas por liquidado (false/true)
 */
router.get('/cashea/transactions', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const liquidado = req.query.liquidado === 'true';
    const query = `
      SELECT 
        t.id_transaccion, 
        t.monto_usd::float AS monto_usd, 
        t.tasa_cambio::float AS tasa_cambio, 
        t.monto_real::float AS monto_real, 
        t.comision_usd::float AS comision_usd, 
        t.comision_real::float AS comision_real, 
        t.created_at, 
        t.concepto, 
        t.id_pedido, 
        p.cliente_nombre, 
        p.cedula_cliente, 
        c.nombre AS cuenta_origen_nombre, 
        t.liquidado
      FROM public.transaccion_caja t
      JOIN public.cuenta c ON c.id_cuenta = t.id_cuenta
      JOIN public.pedido p ON p.id_pedido = t.id_pedido
      WHERE c.es_cashea = true 
        AND p.estado != 'anulado' 
        AND t.tipo = 'ingreso' 
        AND t.liquidado = $1
      ORDER BY t.created_at DESC
    `;
    const { rows } = await pool.query(query, [liquidado]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * 3) POST /api/cashea/liquidar
 * Realizar la liquidación contable de transacciones seleccionadas
 * Body: { transactionIds: [1, 2, ...], id_cuenta_destino: 5, tasa_cambio: 36.5 }
 */
router.post('/cashea/liquidar', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { transactionIds, id_cuenta_destino, tasa_cambio } = req.body || {};
    const userId = req.user.id || req.user.sub;

    if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
      return res.status(400).json({ message: 'transactionIds es requerido y debe ser un arreglo no vacío' });
    }
    if (!id_cuenta_destino) {
      return res.status(400).json({ message: 'id_cuenta_destino es requerido' });
    }

    const rate = tasa_cambio ? parseFloat(tasa_cambio) : 1.0000;
    if (Number.isNaN(rate) || rate <= 0) {
      return res.status(400).json({ message: 'La tasa de cambio de liquidación debe ser un número mayor a 0' });
    }

    await client.query('BEGIN');

    // 1. Obtener y bloquear las transacciones seleccionadas
    const { rows: txs } = await client.query(
      `SELECT t.id_transaccion, t.id_cuenta, t.monto_usd::float AS monto_usd, t.monto_real::float AS monto_real, 
              t.comision_usd::float AS comision_usd, t.comision_real::float AS comision_real, 
              c.nombre AS cuenta_nombre, c.moneda AS cuenta_moneda, c.saldo::float AS cuenta_saldo
       FROM public.transaccion_caja t
       JOIN public.cuenta c ON c.id_cuenta = t.id_cuenta
       WHERE t.id_transaccion = ANY($1::int[]) AND t.liquidado = false AND t.tipo = 'ingreso'
       FOR UPDATE`,
      [transactionIds]
    );

    if (txs.length !== transactionIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Algunas de las transacciones seleccionadas no son válidas o ya fueron liquidadas' });
    }

    // 2. Obtener y bloquear la cuenta destino
    const { rows: destRows } = await client.query(
      `SELECT id_cuenta, nombre, moneda, saldo::float AS saldo, activo, eliminado 
       FROM public.cuenta 
       WHERE id_cuenta = $1 AND eliminado = false 
       FOR UPDATE`,
      [id_cuenta_destino]
    );

    if (!destRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cuenta destino no encontrada' });
    }
    const destCuenta = destRows[0];
    if (!destCuenta.activo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'La cuenta destino está desactivada' });
    }

    // 3. Agrupar montos totales
    const totalGrossUsd = txs.reduce((sum, t) => sum + t.monto_usd, 0);
    const totalComisionUsd = txs.reduce((sum, t) => sum + t.comision_usd, 0);
    const totalNetUsd = totalGrossUsd - totalComisionUsd;

    // Calcular valores en la moneda de destino
    const destMontoReal = destCuenta.moneda === 'USD' ? totalNetUsd : +(totalNetUsd * rate).toFixed(2);

    // Identificar cuenta Cashea de origen (asumimos todas pertenecen a la misma cuenta configurada)
    const casheaCuentaId = txs[0].id_cuenta;
    const casheaCuentaNombre = txs[0].cuenta_nombre;
    const casheaCuentaMoneda = txs[0].cuenta_moneda;

    // Bloquear cuenta origen para actualizar balance
    const { rows: origRows } = await client.query(
      `SELECT id_cuenta, saldo::float AS saldo FROM public.cuenta WHERE id_cuenta = $1 FOR UPDATE`,
      [casheaCuentaId]
    );
    const origCuenta = origRows[0];

    // 4. Cambiar estado de las transacciones a liquidada
    await client.query(
      `UPDATE public.transaccion_caja 
       SET liquidado = true, fecha_liquidacion = NOW() 
       WHERE id_transaccion = ANY($1::int[])`,
      [transactionIds]
    );

    // 5. Contabilizar comisiones de Cashea como un gasto del negocio
    // Buscar o insertar categoría de comisiones Cashea
    let catId = null;
    const { rows: catRows } = await client.query(
      `SELECT id_categoria_gasto FROM public.categoria_gasto WHERE nombre = 'Comisiones Cashea' AND eliminado = false`
    );
    if (catRows.length > 0) {
      catId = catRows[0].id_categoria_gasto;
    } else {
      const { rows: newCat } = await client.query(
        `INSERT INTO public.categoria_gasto (nombre, descripcion, icono, color) 
         VALUES ('Comisiones Cashea', 'Comisiones cobradas por la plataforma Cashea.', 'Percent', '#f97316') 
         RETURNING id_categoria_gasto`
      );
      catId = newCat[0].id_categoria_gasto;
    }

    const origComisionReal = casheaCuentaMoneda === 'USD' ? totalComisionUsd : txs.reduce((sum, t) => sum + t.comision_real, 0);

    // Insertar registro en public.gasto
    const conceptoGasto = `Comisiones Cashea de Liquidación - Lote #${transactionIds.join('-')}`;
    const { rows: gastoRows } = await client.query(
      `INSERT INTO public.gasto (id_categoria_gasto, monto_usd, tasa_cambio, monto_real, id_cuenta, id_usuario, concepto, fecha_gasto)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE)
       RETURNING id_gasto`,
      [catId, totalComisionUsd, rate, origComisionReal, casheaCuentaId, userId, conceptoGasto]
    );

    // 6. Ajustar saldos contables
    // Restar el monto bruto total de la cuenta Cashea
    const origMontoRealGross = casheaCuentaMoneda === 'USD' ? totalGrossUsd : txs.reduce((sum, t) => sum + t.monto_real, 0);
    const nuevoSaldoCashea = +(origCuenta.saldo - origMontoRealGross).toFixed(2);
    await client.query(
      `UPDATE public.cuenta SET saldo = $2, updated_at = NOW() WHERE id_cuenta = $1`,
      [casheaCuentaId, nuevoSaldoCashea]
    );

    // Sumar el neto transferido a la cuenta destino
    const nuevoSaldoDestino = +(destCuenta.saldo + destMontoReal).toFixed(2);
    await client.query(
      `UPDATE public.cuenta SET saldo = $2, updated_at = NOW() WHERE id_cuenta = $1`,
      [id_cuenta_destino, nuevoSaldoDestino]
    );

    // 7. Generar transacciones de caja de transferencia
    // 7.1 Egreso de la cuenta Cashea (monto neto transferido)
    const origNetReal = casheaCuentaMoneda === 'USD' ? totalNetUsd : txs.reduce((sum, t) => sum + (t.monto_real - t.comision_real), 0);
    await client.query(
      `INSERT INTO public.transaccion_caja (id_cuenta, tipo, monto_usd, tasa_cambio, monto_real, concepto, id_usuario)
       VALUES ($1, 'egreso', $2, $3, $4, $5, $6)`,
      [
        casheaCuentaId, 
        'egreso', 
        totalNetUsd, 
        rate, 
        origNetReal, 
        `Liquidación Cashea transferida a ${destCuenta.nombre}`, 
        userId
      ]
    );

    // 7.2 Egreso de la cuenta Cashea (comisión cobrada)
    await client.query(
      `INSERT INTO public.transaccion_caja (id_cuenta, tipo, monto_usd, tasa_cambio, monto_real, concepto, id_usuario)
       VALUES ($1, 'egreso', $2, $3, $4, $5, $6)`,
      [
        casheaCuentaId, 
        'egreso', 
        totalComisionUsd, 
        rate, 
        origComisionReal, 
        `Gasto Comisión Cashea: Lote #${gastoRows[0].id_gasto}`, 
        userId
      ]
    );

    // 7.3 Ingreso neto en la cuenta de destino
    await client.query(
      `INSERT INTO public.transaccion_caja (id_cuenta, tipo, monto_usd, tasa_cambio, monto_real, concepto, id_usuario)
       VALUES ($1, 'ingreso', $2, $3, $4, $5, $6)`,
      [
        id_cuenta_destino, 
        'ingreso', 
        totalNetUsd, 
        rate, 
        destMontoReal, 
        `Recepción Liquidación Cashea desde ${casheaCuentaNombre}`, 
        userId
      ]
    );

    // 8. Registrar Auditoría General
    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'cuenta', 'CASHEA_LIQUIDAR', $2::jsonb, NOW())`,
      [
        userId,
        JSON.stringify({
          transactionIds,
          casheaCuentaId,
          id_cuenta_destino,
          totalGrossUsd,
          totalComisionUsd,
          totalNetUsd,
          destMontoReal,
          gastoId: gastoRows[0].id_gasto
        })
      ]
    );

    await client.query('COMMIT');
    res.json({
      message: 'Liquidación completada de manera exitosa',
      totalGrossUsd,
      totalComisionUsd,
      totalNetUsd,
      destMontoReal,
      nuevoSaldoCashea,
      nuevoSaldoDestino
    });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
