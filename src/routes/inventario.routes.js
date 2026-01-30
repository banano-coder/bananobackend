const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

/**
 * Aplica movimiento transaccional usando TU esquema:
 * - Tabla: public.movimiento_inventario
 * - Columnas: id_usuario, ref_externa, costo_unitario
 * - Auditoría: guarda stock_antes/stock_despues en payload (no en la tabla)
 */
async function aplicarMovimiento({
  client,
  idVariante,
  tipo,
  cantidad,
  motivo,
  refExterna,
  costoUnitario,
  actorId
}) {
  // bloquea inventario de la variante
  const invRow = await client.query(
    `SELECT id_variante_producto, COALESCE(stock,0)::int AS stock
       FROM public.inventario
      WHERE id_variante_producto = $1
      FOR UPDATE`,
    [idVariante]
  );

  let stockActual;
  if (!invRow.rows.length) {
    await client.query(
      `INSERT INTO public.inventario (id_variante_producto, stock)
       VALUES ($1, 0)`,
      [idVariante]
    );
    const again = await client.query(
      `SELECT id_variante_producto, COALESCE(stock,0)::int AS stock
         FROM public.inventario
        WHERE id_variante_producto = $1
        FOR UPDATE`,
      [idVariante]
    );
    stockActual = again.rows[0].stock;
  } else {
    stockActual = invRow.rows[0].stock;
  }

  const cant = parseInt(cantidad, 10);
  if (!Number.isInteger(cant) || cant <= 0) {
    const e = new Error('Cantidad inválida'); e.status = 400; throw e;
  }
  const t = String(tipo || '').trim();

  let stockNuevo = stockActual;
  if (t === 'entrada') stockNuevo = stockActual + cant;
  else if (t === 'salida') {
    if (stockActual < cant) { const e = new Error(`Stock insuficiente (disp: ${stockActual})`); e.status = 409; throw e; }
    stockNuevo = stockActual - cant;
  } else if (t === 'ajuste') {
    // Por simplicidad: ajuste suma; si quieres restar, manda motivo que incluya "negativo"
    if ((motivo || '').toLowerCase().includes('negativo')) {
      if (stockActual < cant) { const e = new Error(`Stock insuficiente para ajuste negativo (disp: ${stockActual})`); e.status = 409; throw e; }
      stockNuevo = stockActual - cant;
    } else {
      stockNuevo = stockActual + cant;
    }
  } else {
    const e = new Error('Tipo inválido'); e.status = 400; throw e;
  }

  // costo_unitario: si no lo mandan, intentamos tomar de variante_producto.costo
  let costo = null;
  if (costoUnitario != null && costoUnitario !== '') {
    const n = Number(costoUnitario);
    costo = Number.isFinite(n) ? n : null;
  } else {
    const { rows: vc } = await client.query(`SELECT costo::numeric FROM public.variante_producto WHERE id_variante_producto=$1`, [idVariante]);
    costo = vc.length ? Number(vc[0].costo) : null;
  }

  // actualiza inventario
  await client.query(
    `UPDATE public.inventario
        SET stock=$2, updated_at=NOW()
      WHERE id_variante_producto=$1`,
    [idVariante, stockNuevo]
  );

  // inserta movimiento en tu tabla
  const { rows: movRows } = await client.query(
    `INSERT INTO public.movimiento_inventario
       (id_variante_producto, tipo, cantidad, motivo, ref_externa, costo_unitario, id_usuario)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id_movimiento_inventario, created_at`,
    [idVariante, t, cant, motivo || null, refExterna || null, costo, actorId || null]
  );
  const mov = movRows[0];

  // auditoría con before/after
  await client.query(
    `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
     VALUES ($1, 'inventario', $2, $3::jsonb, NOW())`,
    [
      actorId || null,
      t === 'entrada' ? 'INV_ENTRADA' : (t === 'salida' ? 'INV_SALIDA' : 'INV_AJUSTE'),
      JSON.stringify({
        id_movimiento_inventario: mov.id_movimiento_inventario,
        id_variante_producto: idVariante,
        tipo: t,
        cantidad: cant,
        motivo: motivo || null,
        ref_externa: refExterna || null,
        costo_unitario: costo,
        stock_antes: stockActual,
        stock_despues: stockNuevo
      })
    ]
  );

  return { idMovimiento: mov.id_movimiento_inventario, stockAntes: stockActual, stockDespues: stockNuevo };
}

/**
 * POST /api/inventario/movimientos
 * Body:
 * {
 *   "id_variante_producto": 3,
 *   "tipo": "entrada|salida|ajuste",
 *   "cantidad": 2,
 *   "motivo": "Venta mostrador",
 *   "ref_externa": "PED-15",
 *   "costo_unitario": 4.50   // opcional; si falta, se toma de variante_producto.costo
 * }
 * Roles:
 *   entrada -> admin, manager
 *   salida  -> admin, manager, vendedor
 *   ajuste  -> admin, manager
 */
router.post('/inventario/movimientos', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id_variante_producto, tipo, cantidad, motivo, ref_externa, costo_unitario } = req.body || {};

    // autorización por tipo
    const roles = req.user?.roles || [];
    const canEntrada = roles.some(r => r === 'admin' || r === 'manager');
    const canSalida = roles.some(r => r === 'admin' || r === 'manager' || r === 'vendedor');
    const canAjuste = roles.some(r => r === 'admin' || r === 'manager');

    if (tipo === 'entrada' && !canEntrada) return res.status(403).json({ message: 'No autorizado (entrada)' });
    if (tipo === 'salida' && !canSalida) return res.status(403).json({ message: 'No autorizado (salida)' });
    if (tipo === 'ajuste' && !canAjuste) return res.status(403).json({ message: 'No autorizado (ajuste)' });

    const idVar = parseInt(id_variante_producto, 10);
    if (!Number.isInteger(idVar) || idVar <= 0) return res.status(400).json({ message: 'id_variante_producto inválido' });

    await client.query('BEGIN');

    // valida variante y producto activos
    const { rows: vr } = await client.query(
      `SELECT vp.id_variante_producto, vp.activo, p.activo AS prod_activo
         FROM public.variante_producto vp
         JOIN public.producto p ON p.id_producto = vp.id_producto
        WHERE vp.id_variante_producto = $1`,
      [idVar]
    );
    if (!vr.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Variante no existe' }); }
    if (vr[0].activo === false || vr[0].prod_activo === false) {
      await client.query('ROLLBACK'); return res.status(400).json({ message: 'Variante o producto inactivo' });
    }

    const result = await aplicarMovimiento({
      client,
      idVariante: idVar,
      tipo,
      cantidad,
      motivo,
      refExterna: ref_externa,
      costoUnitario: costo_unitario,
      actorId: req.user.id || req.user.sub
    });

    await client.query('COMMIT');
    res.status(201).json({
      message: 'Movimiento registrado',
      id_movimiento_inventario: result.idMovimiento,
      stock_antes: result.stockAntes,
      stock_despues: result.stockDespues
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    if (err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  } finally { client.release(); }
});

/**
 * GET /api/inventario/movimientos?tipo=&id_variante=&from=&to=&page=&limit=
 * Roles: admin, manager
 * (si quieres que vendedor vea solo 'salida', avísame y filtro)
 */
router.get('/inventario/movimientos', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const tipo = (req.query.tipo || '').trim();
    const idVar = parseInt(req.query.id_variante || '0', 10);
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conds = [];
    const params = [];
    let i = 1;

    if (tipo) { conds.push(`m.tipo = $${i++}`); params.push(tipo); }
    if (idVar) { conds.push(`m.id_variante_producto = $${i++}`); params.push(idVar); }
    if (from) { conds.push(`m.created_at >= $${i++}::timestamptz`); params.push(from); }
    if (to) { conds.push(`m.created_at < ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows: t } = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM public.movimiento_inventario m
        ${where}`,
      params
    );
    const total = t[0].total;

    const { rows: data } = await pool.query(
      `SELECT m.id_movimiento_inventario, m.id_variante_producto, m.tipo, m.cantidad,
              m.motivo, m.ref_externa, m.costo_unitario,
              m.id_usuario, u.nombre AS usuario_nombre,
              v.sku, p.nombre AS producto_nombre,
              m.created_at
         FROM public.movimiento_inventario m
         LEFT JOIN public.usuario u ON u.id_usuario = m.id_usuario
         JOIN public.variante_producto v ON v.id_variante_producto = m.id_variante_producto
         JOIN public.producto p          ON p.id_producto = v.id_producto
        ${where}
        ORDER BY m.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    res.json({ data, page, limit, total });
  } catch (err) { next(err); }
});

/** GET /api/inventario/stock/:id */
router.get('/inventario/stock/:id', requireAuth, requireRole('admin', 'manager', 'vendedor'), async (req, res, next) => {
  try {
    const idVar = parseInt(req.params.id, 10);
    if (!Number.isInteger(idVar) || idVar <= 0) return res.status(400).json({ message: 'id inválido' });
    const { rows } = await pool.query(
      `SELECT COALESCE(stock,0)::int AS stock
         FROM public.inventario
        WHERE id_variante_producto = $1`,
      [idVar]
    );
    res.json({ id_variante_producto: idVar, stock: rows.length ? rows[0].stock : 0 });
  } catch (err) { next(err); }
});

module.exports = router;
