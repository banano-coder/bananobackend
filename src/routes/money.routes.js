const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// Helpers
function toInt(v, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; }

// LISTAR movimientos de caja
router.get('/money/movimientos', requireAuth, async (req, res, next) => {
  try {
    const id_almacen = req.query.id_almacen ? parseInt(req.query.id_almacen, 10) : null;
    const id_cuenta = req.query.id_cuenta ? parseInt(req.query.id_cuenta, 10) : null;
    const tipo = (req.query.tipo || '').trim();
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const search = (req.query.search || '').trim();
    const page = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
    const offset = (page - 1) * limit;

    const conds = [];
    const params = [];
    let i = 1;

    if (id_cuenta) { conds.push(`t.id_cuenta = $${i++}`); params.push(id_cuenta); }
    if (id_almacen) { conds.push(`c.id_almacen = $${i++}`); params.push(id_almacen); }
    if (tipo) { conds.push(`t.tipo = $${i++}`); params.push(tipo); }
    if (from) { conds.push(`t.created_at >= $${i++}::timestamptz`); params.push(from); }
    if (to) { conds.push(`t.created_at < ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
    if (search) {
      conds.push(`(t.concepto ILIKE $${i})`);
      params.push(`%${search}%`); i++;
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total 
       FROM public.transaccion_caja t 
       JOIN public.cuenta c ON c.id_cuenta = t.id_cuenta
       ${where}`, 
      params
    );
    const total = countRows[0]?.total || 0;

    const { rows: data } = await pool.query(
      `SELECT t.id_transaccion, t.id_cuenta, c.nombre AS cuenta_nombre, c.moneda AS cuenta_moneda,
              t.tipo, t.monto_usd::float AS monto_usd, t.tasa_cambio::float AS tasa_cambio, 
              t.monto_real::float AS monto_real, t.concepto, t.id_pedido, 
              t.id_usuario, u.nombre AS usuario_nombre, t.created_at
       FROM public.transaccion_caja t
       JOIN public.cuenta c ON c.id_cuenta = t.id_cuenta
       LEFT JOIN public.usuario u ON u.id_usuario = t.id_usuario
       ${where}
       ORDER BY t.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    res.json({ data, page, limit, total });
  } catch (err) {
    next(err);
  }
});

// CREAR movimiento de caja manual (Ingreso / Egreso)
router.post('/money/movimientos', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id_cuenta, tipo, monto_usd, tasa_cambio, concepto } = req.body || {};

    if (!id_cuenta || !tipo || !monto_usd || !concepto) {
      return res.status(400).json({ message: 'id_cuenta, tipo, monto_usd y concepto son requeridos' });
    }

    const t = String(tipo).trim().toLowerCase();
    if (t !== 'ingreso' && t !== 'egreso') {
      return res.status(400).json({ message: 'Tipo inválido (ingreso o egreso)' });
    }

    const valUsd = parseFloat(monto_usd);
    if (valUsd <= 0) {
      return res.status(400).json({ message: 'El monto en USD debe ser mayor a 0' });
    }

    const rate = tasa_cambio ? parseFloat(tasa_cambio) : 1.0000;
    if (rate <= 0) {
      return res.status(400).json({ message: 'La tasa de cambio debe ser mayor a 0' });
    }

    await client.query('BEGIN');

    // 1. Obtener la cuenta y bloquearla para evitar condiciones de carrera
    const { rows: cRows } = await client.query(
      `SELECT id_cuenta, nombre, moneda, saldo::float AS saldo, activo, eliminado 
       FROM public.cuenta 
       WHERE id_cuenta = $1 AND eliminado = false 
       FOR UPDATE`,
      [id_cuenta]
    );

    if (!cRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cuenta no encontrada' });
    }

    const cuenta = cRows[0];
    if (!cuenta.activo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'La cuenta está desactivada' });
    }

    const montoReal = +(valUsd * rate).toFixed(2);

    let nuevoSaldo = cuenta.saldo;
    if (t === 'ingreso') {
      nuevoSaldo += montoReal;
    } else {
      if (cuenta.saldo < montoReal) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: `Saldo insuficiente en la cuenta (disponible: ${cuenta.saldo} ${cuenta.moneda})` });
      }
      nuevoSaldo -= montoReal;
    }

    // 2. Insertar la transacción
    const { rows: tRows } = await client.query(
      `INSERT INTO public.transaccion_caja (id_cuenta, tipo, monto_usd, tasa_cambio, monto_real, concepto, id_usuario)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id_transaccion, created_at`,
      [id_cuenta, t, valUsd, rate, montoReal, String(concepto).trim(), req.user.id || req.user.sub]
    );

    // 3. Actualizar el saldo de la cuenta
    await client.query(
      `UPDATE public.cuenta 
       SET saldo = $2, updated_at = NOW() 
       WHERE id_cuenta = $1`,
      [id_cuenta, nuevoSaldo]
    );

    // AUDITORIA
    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'money', $2, $3::jsonb, NOW())`,
      [
        req.user.id || req.user.sub,
        t === 'ingreso' ? 'MONEY_INGRESO' : 'MONEY_EGRESO',
        JSON.stringify({
          id_transaccion: tRows[0].id_transaccion,
          id_cuenta,
          nombre_cuenta: cuenta.nombre,
          monto_usd: valUsd,
          tasa_cambio: rate,
          monto_real: montoReal,
          saldo_antes: cuenta.saldo,
          saldo_despues: nuevoSaldo
        })
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({
      id_transaccion: tRows[0].id_transaccion,
      monto_usd: valUsd,
      tasa_cambio: rate,
      monto_real: montoReal,
      saldo_despues: nuevoSaldo,
      created_at: tRows[0].created_at
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// RESUMEN de saldos por moneda
router.get('/money/resumen', requireAuth, async (req, res, next) => {
  try {
    const id_almacen = req.query.id_almacen ? parseInt(req.query.id_almacen, 10) : null;
    
    let balancesQuery = `
      SELECT moneda, SUM(saldo)::float AS total 
      FROM public.cuenta 
      WHERE eliminado = false AND activo = true
    `;
    const balanceParams = [];
    if (id_almacen) {
      balancesQuery += ` AND id_almacen = $1`;
      balanceParams.push(id_almacen);
    }
    balancesQuery += ` GROUP BY moneda`;

    const { rows: balances } = await pool.query(balancesQuery, balanceParams);

    let countsQuery = `
      SELECT t.tipo, COUNT(*)::int AS cantidad, COALESCE(SUM(t.monto_usd)::float, 0) AS total_usd
      FROM public.transaccion_caja t
      JOIN public.cuenta c ON c.id_cuenta = t.id_cuenta
    `;
    const countsParams = [];
    if (id_almacen) {
      countsQuery += ` WHERE c.id_almacen = $1`;
      countsParams.push(id_almacen);
    }
    countsQuery += ` GROUP BY t.tipo`;

    const { rows: counts } = await pool.query(countsQuery, countsParams);

    res.json({
      saldos: balances,
      metricas: counts
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
