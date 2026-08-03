const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// LISTAR cuentas activas
router.get('/cuentas', requireAuth, async (req, res, next) => {
  try {
    const id_almacen = req.query.id_almacen ? parseInt(req.query.id_almacen, 10) : null;
    let queryText = `
      SELECT c.id_cuenta, c.nombre, c.moneda, c.saldo::float AS saldo,
             c.id_almacen, alm.nombre AS almacen_nombre, c.activo,
             c.es_cashea, c.es_efectivo, c.created_at
      FROM public.cuenta c
      LEFT JOIN public.almacen alm ON alm.id_almacen = c.id_almacen
      WHERE c.eliminado = false
    `;
    const params = [];
    if (id_almacen) {
      queryText += ` AND c.id_almacen = $1`;
      params.push(id_almacen);
    }
    queryText += ` ORDER BY c.nombre ASC`;

    let rows;
    try {
      const result = await pool.query(queryText, params);
      rows = result.rows;
    } catch (colErr) {
      if (colErr.code !== '42703') throw colErr;
      const fallbackQueryText = queryText.replace('c.es_efectivo', 'false AS es_efectivo');
      const fallbackResult = await pool.query(fallbackQueryText, params);
      rows = fallbackResult.rows;
    }

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// CREAR cuenta
router.post('/cuentas', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const { nombre, moneda, saldo_inicial, id_almacen, es_cashea, es_efectivo } = req.body || {};

    if (!nombre || !moneda) {
      return res.status(400).json({ message: 'nombre y moneda son requeridos' });
    }

    const validCurrencies = new Set(['USD', 'COP', 'VES']);
    if (!validCurrencies.has(moneda)) {
      return res.status(400).json({ message: 'Moneda inválida (solo USD, COP, VES)' });
    }

    let rows;
    try {
      const result = await pool.query(
        `INSERT INTO public.cuenta (nombre, moneda, saldo, id_almacen, es_cashea, es_efectivo)
         VALUES ($1, $2, COALESCE($3, 0.00), $4, $5, $6)
         RETURNING id_cuenta, nombre, moneda, saldo::float AS saldo, id_almacen, activo, es_cashea, es_efectivo`,
        [
          String(nombre).trim(),
          moneda,
          saldo_inicial ? parseFloat(saldo_inicial) : 0.00,
          id_almacen ? parseInt(id_almacen, 10) : null,
          !!es_cashea,
          !!es_efectivo
        ]
      );
      rows = result.rows;
    } catch (colErr) {
      if (colErr.code !== '42703') throw colErr;
      const result = await pool.query(
        `INSERT INTO public.cuenta (nombre, moneda, saldo, id_almacen, es_cashea)
         VALUES ($1, $2, COALESCE($3, 0.00), $4, $5)
         RETURNING id_cuenta, nombre, moneda, saldo::float AS saldo, id_almacen, activo, es_cashea`,
        [
          String(nombre).trim(),
          moneda,
          saldo_inicial ? parseFloat(saldo_inicial) : 0.00,
          id_almacen ? parseInt(id_almacen, 10) : null,
          !!es_cashea
        ]
      );
      rows = result.rows;
      rows[0].es_efectivo = false;
    }

    await pool.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'cuenta', 'CUENTA_CREAR', $2::jsonb, NOW())`,
      [req.user.id || req.user.sub, JSON.stringify(rows[0])]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Ya existe una cuenta con ese nombre' });
    }
    next(err);
  }
});

// ACTUALIZAR cuenta
router.patch('/cuentas/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { nombre, activo, es_cashea, es_efectivo } = req.body || {};

    if (!id) return res.status(400).json({ message: 'ID inválido' });

    let rows;
    try {
      const result = await pool.query(
        `UPDATE public.cuenta
         SET nombre      = COALESCE($2, nombre),
             activo      = COALESCE($3, activo),
             es_cashea   = COALESCE($4, es_cashea),
             es_efectivo = COALESCE($5, es_efectivo),
             updated_at  = NOW()
         WHERE id_cuenta = $1 AND eliminado = false
         RETURNING id_cuenta, nombre, moneda, saldo::float AS saldo, id_almacen, activo, es_cashea, es_efectivo`,
        [
          id,
          nombre ? String(nombre).trim() : null,
          activo !== undefined ? !!activo : null,
          es_cashea !== undefined ? !!es_cashea : null,
          es_efectivo !== undefined ? !!es_efectivo : null
        ]
      );
      rows = result.rows;
    } catch (colErr) {
      if (colErr.code !== '42703') throw colErr;
      const result = await pool.query(
        `UPDATE public.cuenta
         SET nombre      = COALESCE($2, nombre),
             activo      = COALESCE($3, activo),
             es_cashea   = COALESCE($4, es_cashea),
             updated_at  = NOW()
         WHERE id_cuenta = $1 AND eliminado = false
         RETURNING id_cuenta, nombre, moneda, saldo::float AS saldo, id_almacen, activo, es_cashea`,
        [
          id,
          nombre ? String(nombre).trim() : null,
          activo !== undefined ? !!activo : null,
          es_cashea !== undefined ? !!es_cashea : null
        ]
      );
      rows = result.rows;
      if (rows.length) rows[0].es_efectivo = false;
    }

    if (!rows.length) {
      return res.status(404).json({ message: 'Cuenta no encontrada' });
    }

    await pool.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'cuenta', 'CUENTA_ACTUALIZAR', $2::jsonb, NOW())`,
      [req.user.id || req.user.sub, JSON.stringify({ id_cuenta: id, changes: req.body })]
    );

    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Ya existe una cuenta con ese nombre' });
    }
    next(err);
  }
});

// ELIMINAR cuenta (lógico)
router.delete('/cuentas/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'ID inválido' });

    const { rowCount } = await pool.query(
      `UPDATE public.cuenta
       SET eliminado = true, activo = false, updated_at = NOW(),
           nombre = nombre || ' (Eliminada ' || id_cuenta || ')'
       WHERE id_cuenta = $1 AND eliminado = false`,
      [id]
    );

    if (!rowCount) {
      return res.status(404).json({ message: 'Cuenta no encontrada o ya eliminada' });
    }

    await pool.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'cuenta', 'CUENTA_ELIMINAR', $2::jsonb, NOW())`,
      [req.user.id || req.user.sub, JSON.stringify({ id_cuenta: id })]
    );

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
