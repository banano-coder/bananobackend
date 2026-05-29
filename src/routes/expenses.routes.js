const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// Helper to convert to Int safely
function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// ══════════════════════════════════════════════════════════════════════════
// 1. CATEGORÍAS DE GASTOS
// ══════════════════════════════════════════════════════════════════════════

// LISTAR categorías de gastos
router.get('/expenses/categories', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_categoria_gasto, nombre, descripcion, icono, color, activo
       FROM public.categoria_gasto
       WHERE eliminado = false
       ORDER BY nombre ASC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// CREAR categoría de gasto
router.post('/expenses/categories', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const { nombre, descripcion, icono, color } = req.body || {};

    if (!nombre) {
      return res.status(400).json({ message: 'El nombre de la categoría es requerido' });
    }

    const { rows } = await pool.query(
      `INSERT INTO public.categoria_gasto (nombre, descripcion, icono, color)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        String(nombre).trim(),
        descripcion ? String(descripcion).trim() : null,
        icono ? String(icono).trim() : 'Receipt',
        color ? String(color).trim() : '#ef4444'
      ]
    );

    // AUDITORÍA
    await pool.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'money', 'EXPENSE_CATEGORY_CREATE', $2::jsonb, NOW())`,
      [req.user.id || req.user.sub, JSON.stringify(rows[0])]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Ya existe una categoría de gasto con este nombre' });
    }
    next(err);
  }
});

// ACTUALIZAR categoría de gasto
router.patch('/expenses/categories/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { nombre, descripcion, icono, color, activo } = req.body || {};

    if (Number.isNaN(id)) {
      return res.status(400).json({ message: 'ID de categoría inválido' });
    }

    // Construcción de campos dinámicos
    const fields = [];
    const params = [];
    let idx = 1;

    if (nombre !== undefined) {
      fields.push(`nombre = $${idx++}`);
      params.push(String(nombre).trim());
    }
    if (descripcion !== undefined) {
      fields.push(`descripcion = $${idx++}`);
      params.push(descripcion ? String(descripcion).trim() : null);
    }
    if (icono !== undefined) {
      fields.push(`icono = $${idx++}`);
      params.push(String(icono).trim());
    }
    if (color !== undefined) {
      fields.push(`color = $${idx++}`);
      params.push(String(color).trim());
    }
    if (activo !== undefined) {
      fields.push(`activo = $${idx++}`);
      params.push(!!activo);
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: 'No se enviaron campos para actualizar' });
    }

    params.push(id);
    const { rows, rowCount } = await pool.query(
      `UPDATE public.categoria_gasto
       SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id_categoria_gasto = $${idx} AND eliminado = false
       RETURNING *`,
      params
    );

    if (!rowCount) {
      return res.status(404).json({ message: 'Categoría de gasto no encontrada' });
    }

    // AUDITORÍA
    await pool.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'money', 'EXPENSE_CATEGORY_UPDATE', $2::jsonb, NOW())`,
      [req.user.id || req.user.sub, JSON.stringify(rows[0])]
    );

    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Ya existe otra categoría de gasto con este nombre' });
    }
    next(err);
  }
});

// ELIMINAR (Soft Delete) categoría de gasto
router.delete('/expenses/categories/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: 'ID de categoría inválido' });
    }

    const { rowCount } = await pool.query(
      `UPDATE public.categoria_gasto
       SET eliminado = true, updated_at = NOW()
       WHERE id_categoria_gasto = $1 AND eliminado = false`,
      [id]
    );

    if (!rowCount) {
      return res.status(404).json({ message: 'Categoría de gasto no encontrada o ya eliminada' });
    }

    // AUDITORÍA
    await pool.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'money', 'EXPENSE_CATEGORY_DELETE', $2::jsonb, NOW())`,
      [req.user.id || req.user.sub, JSON.stringify({ id_categoria_gasto: id })]
    );

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});


// OBTENER resumen semanal de gastos del mes actual o específico
router.get('/expenses/weekly-summary', requireAuth, async (req, res, next) => {
  try {
    const now = new Date();
    const year = req.query.year ? parseInt(req.query.year, 10) : now.getFullYear();
    const month = req.query.month ? parseInt(req.query.month, 10) : now.getMonth() + 1;

    if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
      return res.status(400).json({ message: 'Año o mes inválidos' });
    }

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;

    const { rows } = await pool.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN EXTRACT(DAY FROM fecha_gasto) BETWEEN 1 AND 7 THEN monto_usd ELSE 0 END), 0)::float AS week1_total,
         COUNT(CASE WHEN EXTRACT(DAY FROM fecha_gasto) BETWEEN 1 AND 7 THEN 1 END)::int AS week1_count,
         
         COALESCE(SUM(CASE WHEN EXTRACT(DAY FROM fecha_gasto) BETWEEN 8 AND 14 THEN monto_usd ELSE 0 END), 0)::float AS week2_total,
         COUNT(CASE WHEN EXTRACT(DAY FROM fecha_gasto) BETWEEN 8 AND 14 THEN 1 END)::int AS week2_count,
         
         COALESCE(SUM(CASE WHEN EXTRACT(DAY FROM fecha_gasto) BETWEEN 15 AND 21 THEN monto_usd ELSE 0 END), 0)::float AS week3_total,
         COUNT(CASE WHEN EXTRACT(DAY FROM fecha_gasto) BETWEEN 15 AND 21 THEN 1 END)::int AS week3_count,
         
         COALESCE(SUM(CASE WHEN EXTRACT(DAY FROM fecha_gasto) >= 22 THEN monto_usd ELSE 0 END), 0)::float AS week4_total,
         COUNT(CASE WHEN EXTRACT(DAY FROM fecha_gasto) >= 22 THEN 1 END)::int AS week4_count
       FROM public.gasto
       WHERE eliminado = false
         AND fecha_gasto >= $1::date
         AND fecha_gasto < ($1::date + INTERVAL '1 month')`,
      [startDate]
    );

    res.json({
      year,
      month,
      summary: rows[0]
    });
  } catch (err) {
    next(err);
  }
});

// LISTAR gastos con filtros y paginación
router.get('/expenses', requireAuth, async (req, res, next) => {
  try {
    const id_categoria_gasto = req.query.id_categoria_gasto ? parseInt(req.query.id_categoria_gasto, 10) : null;
    const id_almacen = req.query.id_almacen ? parseInt(req.query.id_almacen, 10) : null;
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const search = (req.query.search || '').trim();
    const page = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
    const offset = (page - 1) * limit;

    const conds = ['g.eliminado = false'];
    const params = [];
    let idx = 1;

    if (id_categoria_gasto) {
      conds.push(`g.id_categoria_gasto = $${idx++}`);
      params.push(id_categoria_gasto);
    }
    if (id_almacen) {
      conds.push(`g.id_almacen = $${idx++}`);
      params.push(id_almacen);
    }
    if (from) {
      conds.push(`g.fecha_gasto >= $${idx++}::date`);
      params.push(from);
    }
    if (to) {
      conds.push(`g.fecha_gasto <= $${idx++}::date`);
      params.push(to);
    }
    if (search) {
      conds.push(`(g.concepto ILIKE $${idx++})`);
      params.push(`%${search}%`);
    }

    const whereClause = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    // Total de registros
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM public.gasto g
       ${whereClause}`,
      params
    );
    const total = countRows[0]?.total || 0;

    // Obtener datos paginados y ordenados
    const { rows: data } = await pool.query(
      `SELECT g.id_gasto, g.monto_usd::float AS monto_usd, g.tasa_cambio::float AS tasa_cambio, g.monto_real::float AS monto_real,
              g.concepto, g.fecha_gasto::text AS fecha_gasto, g.id_cuenta, c.nombre AS cuenta_nombre, c.moneda AS cuenta_moneda,
              g.id_categoria_gasto, cat.nombre AS categoria_nombre, cat.icono AS categoria_icono, cat.color AS categoria_color,
              g.id_almacen, alm.nombre AS almacen_nombre,
              g.id_usuario, u.nombre AS usuario_nombre, g.created_at
       FROM public.gasto g
       JOIN public.categoria_gasto cat ON cat.id_categoria_gasto = g.id_categoria_gasto
       JOIN public.cuenta c ON c.id_cuenta = g.id_cuenta
       LEFT JOIN public.almacen alm ON alm.id_almacen = g.id_almacen
       LEFT JOIN public.usuario u ON u.id_usuario = g.id_usuario
       ${whereClause}
       ORDER BY g.fecha_gasto DESC, g.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    res.json({ data, page, limit, total });
  } catch (err) {
    next(err);
  }
});

// REGISTRAR un nuevo gasto
router.post('/expenses', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id_categoria_gasto, monto_usd, tasa_cambio, id_cuenta, id_almacen, concepto, fecha_gasto } = req.body || {};

    if (!id_categoria_gasto || !monto_usd || !id_cuenta || !concepto) {
      return res.status(400).json({ message: 'id_categoria_gasto, monto_usd, id_cuenta y concepto son requeridos' });
    }

    const valUsd = parseFloat(monto_usd);
    if (Number.isNaN(valUsd) || valUsd <= 0) {
      return res.status(400).json({ message: 'El monto en USD debe ser un número mayor a 0' });
    }

    const rate = tasa_cambio ? parseFloat(tasa_cambio) : 1.0000;
    if (Number.isNaN(rate) || rate <= 0) {
      return res.status(400).json({ message: 'La tasa de cambio debe ser un número mayor a 0' });
    }

    const montoReal = +(valUsd * rate).toFixed(2);

    await client.query('BEGIN');

    // 1. Validar que la categoría de gasto existe y esté activa
    const { rows: catRows } = await client.query(
      `SELECT id_categoria_gasto, nombre FROM public.categoria_gasto
       WHERE id_categoria_gasto = $1 AND eliminado = false AND activo = true`,
      [id_categoria_gasto]
    );
    if (!catRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Categoría de gasto no encontrada o inactiva' });
    }
    const categoria = catRows[0];

    // 2. Obtener y bloquear la cuenta seleccionada para evitar condiciones de carrera
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
      return res.status(400).json({ message: 'La cuenta bancaria está desactivada' });
    }

    // 3. Validar saldo suficiente
    if (cuenta.saldo < montoReal) {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        message: `Saldo insuficiente en la cuenta (disponible: ${cuenta.saldo.toFixed(2)} ${cuenta.moneda}, requerido: ${montoReal.toFixed(2)} ${cuenta.moneda})` 
      });
    }

    const nuevoSaldo = +(cuenta.saldo - montoReal).toFixed(2);
    const userId = req.user.id || req.user.sub;

    // 4. Registrar el Gasto
    const { rows: gRows } = await client.query(
      `INSERT INTO public.gasto (id_categoria_gasto, monto_usd, tasa_cambio, monto_real, id_cuenta, id_almacen, id_usuario, concepto, fecha_gasto)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, CURRENT_DATE))
       RETURNING id_gasto, fecha_gasto::text AS fecha_gasto, created_at`,
      [
        id_categoria_gasto,
        valUsd,
        rate,
        montoReal,
        id_cuenta,
        id_almacen ? parseInt(id_almacen, 10) : null,
        userId,
        String(concepto).trim(),
        fecha_gasto ? String(fecha_gasto).trim() : null
      ]
    );
    const gasto = gRows[0];

    // 5. Restar de la cuenta bancaria
    await client.query(
      `UPDATE public.cuenta 
       SET saldo = $2, updated_at = NOW() 
       WHERE id_cuenta = $1`,
      [id_cuenta, nuevoSaldo]
    );

    // 6. Registrar en transacciones de caja (egreso)
    const { rows: tRows } = await client.query(
      `INSERT INTO public.transaccion_caja (id_cuenta, tipo, monto_usd, tasa_cambio, monto_real, concepto, id_usuario)
       VALUES ($1, 'egreso', $2, $3, $4, $5, $6)
       RETURNING id_transaccion`,
      [
        id_cuenta,
        valUsd,
        rate,
        montoReal,
        `Gasto: [${categoria.nombre}] - ${String(concepto).trim()}`,
        userId
      ]
    );

    // 7. Auditoría
    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'money', 'EXPENSE_CREATE', $2::jsonb, NOW())`,
      [
        userId,
        JSON.stringify({
          id_gasto: gasto.id_gasto,
          id_cuenta,
          cuenta_nombre: cuenta.nombre,
          categoria_nombre: categoria.nombre,
          monto_usd: valUsd,
          tasa_cambio: rate,
          monto_real: montoReal,
          concepto: concepto,
          id_transaccion: tRows[0].id_transaccion
        })
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({
      id_gasto: gasto.id_gasto,
      monto_usd: valUsd,
      tasa_cambio: rate,
      monto_real: montoReal,
      fecha_gasto: gasto.fecha_gasto,
      saldo_restante: nuevoSaldo,
      created_at: gasto.created_at
    });

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ANULAR un gasto
router.delete('/expenses/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: 'ID de gasto inválido' });
    }

    await client.query('BEGIN');

    // 1. Obtener y bloquear el gasto
    const { rows: gRows } = await client.query(
      `SELECT g.id_gasto, g.id_cuenta, g.monto_usd::float AS monto_usd, g.tasa_cambio::float AS tasa_cambio, 
              g.monto_real::float AS monto_real, g.concepto, g.eliminado, cat.nombre AS categoria_nombre
       FROM public.gasto g
       JOIN public.categoria_gasto cat ON cat.id_categoria_gasto = g.id_categoria_gasto
       WHERE g.id_gasto = $1
       FOR UPDATE`,
      [id]
    );

    if (!gRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Gasto no encontrado' });
    }

    const gasto = gRows[0];
    if (gasto.eliminado) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'El gasto ya se encuentra anulado' });
    }

    // 2. Obtener y bloquear la cuenta para el reingreso de dinero
    const { rows: cRows } = await client.query(
      `SELECT id_cuenta, nombre, moneda, saldo::float AS saldo, activo, eliminado 
       FROM public.cuenta 
       WHERE id_cuenta = $1 AND eliminado = false 
       FOR UPDATE`,
      [gasto.id_cuenta]
    );

    if (!cRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cuenta bancaria asociada no encontrada' });
    }

    const cuenta = cRows[0];
    const nuevoSaldo = +(cuenta.saldo + gasto.monto_real).toFixed(2);
    const userId = req.user.id || req.user.sub;

    // 3. Modificar saldo
    await client.query(
      `UPDATE public.cuenta 
       SET saldo = $2, updated_at = NOW() 
       WHERE id_cuenta = $1`,
      [gasto.id_cuenta, nuevoSaldo]
    );

    // 4. Registrar en transacciones de caja (ingreso/reversión)
    const { rows: tRows } = await client.query(
      `INSERT INTO public.transaccion_caja (id_cuenta, tipo, monto_usd, tasa_cambio, monto_real, concepto, id_usuario)
       VALUES ($1, 'ingreso', $2, $3, $4, $5, $6)
       RETURNING id_transaccion`,
      [
        gasto.id_cuenta,
        gasto.monto_usd,
        gasto.tasa_cambio,
        gasto.monto_real,
        `Reversión Gasto: [${gasto.categoria_nombre}] - ${gasto.concepto}`,
        userId
      ]
    );

    // 5. Marcar gasto como eliminado
    await client.query(
      `UPDATE public.gasto 
       SET eliminado = true, updated_at = NOW() 
       WHERE id_gasto = $1`,
      [id]
    );

    // 6. Auditoría
    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'money', 'EXPENSE_DELETE', $2::jsonb, NOW())`,
      [
        userId,
        JSON.stringify({
          id_gasto: id,
          id_cuenta: gasto.id_cuenta,
          cuenta_nombre: cuenta.nombre,
          categoria_nombre: gasto.categoria_nombre,
          monto_usd: gasto.monto_usd,
          tasa_cambio: gasto.tasa_cambio,
          monto_real: gasto.monto_real,
          concepto: gasto.concepto,
          id_transaccion_reversion: tRows[0].id_transaccion
        })
      ]
    );

    await client.query('COMMIT');
    res.status(200).json({
      message: 'Gasto anulado correctamente',
      id_gasto: id,
      saldo_devuelto: gasto.monto_real,
      nuevo_saldo: nuevoSaldo
    });

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
