const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// Helpers
function parseDate(s) { return (s || '').trim(); }
function toInt(v, d=10) { const n = parseInt(v,10); return Number.isFinite(n) ? n : d; }

/**
 * 1) KPIs de pedidos (resumen)
 * GET /api/reports/pedidos/kpis?from=YYYY-MM-DD&to=YYYY-MM-DD
 * - total_pedidos
 * - total_concretados
 * - conversion (concretados / total)
 * - monto_total_estimado (suma total_estimado de concretados)
 * - ticket_promedio (monto_total_estimado / concretados)
 */
router.get('/reports/pedidos/kpis',
  requireAuth, requireRole('admin','manager'),
  async (req,res,next)=>{
    try{
      const from = parseDate(req.query.from);
      const to   = parseDate(req.query.to);

      const conds = [];
      const params = [];
      let i=1;
      if (from) { conds.push(`p.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to)   { conds.push(`p.created_at <  ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `
        WITH base AS (
          SELECT p.id_pedido, p.estado, COALESCE(p.total_estimado,0)::numeric AS total
          FROM public.pedido p
          ${where}
        )
        SELECT
          COUNT(*)::int                                         AS total_pedidos,
          SUM(CASE WHEN estado='concretado' THEN 1 ELSE 0 END)::int AS total_concretados,
          COALESCE(SUM(CASE WHEN estado='concretado' THEN total END),0)::float AS monto_total_estimado,
          CASE WHEN SUM(CASE WHEN estado='concretado' THEN 1 ELSE 0 END) = 0
               THEN 0
               ELSE ROUND(
                 COALESCE(SUM(CASE WHEN estado='concretado' THEN total END),0)
                 / NULLIF(SUM(CASE WHEN estado='concretado' THEN 1 ELSE 0 END),0)
               ,2)
          END AS ticket_promedio
        FROM base
        `,
        params
      );

      const k = rows[0] || { total_pedidos:0, total_concretados:0, monto_total_estimado:0, ticket_promedio:0 };
      const conversion = k.total_pedidos ? +(k.total_concretados / k.total_pedidos).toFixed(2) : 0;

      res.json({ ...k, conversion });
    }catch(err){ next(err); }
  }
);

/**
 * 2) Serie temporal de pedidos
 * GET /api/reports/pedidos/serie?from=&to=&granularity=month|day
 * Devuelve: fecha (inicio), total, concretados, monto_concretado
 */
router.get('/reports/pedidos/serie',
  requireAuth, requireRole('admin','manager'),
  async (req,res,next)=>{
    try{
      const from = parseDate(req.query.from);
      const to   = parseDate(req.query.to);
      const g = graw ? String(graw).trim().toLowerCase() : 'month';
      const gran = (g === 'day' || g === 'month' || g === 'year') ? g : 'month';

      const conds = [];
      const params = [];
      let i=1;
      if (from) { conds.push(`p.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to)   { conds.push(`p.created_at <  ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `
        SELECT
          date_trunc('${gran}', p.created_at) AS periodo,
          COUNT(*)::int AS total,
          SUM(CASE WHEN p.estado='concretado' THEN 1 ELSE 0 END)::int AS concretados,
          COALESCE(SUM(CASE WHEN p.estado='concretado' THEN p.total_estimado END),0)::float AS monto_concretado
        FROM public.pedido p
        ${where}
        GROUP BY 1
        ORDER BY 1
        `,
        params
      );

      res.json({ granularity: gran, data: rows.map(r => ({
        periodo: r.periodo.toISOString(),
        total: r.total,
        concretados: r.concretados,
        monto_concretado: r.monto_concretado
      })) });
    }catch(err){ next(err); }
  }
);

/**
 * 3) Top productos por salidas (movimiento_inventario)
 * GET /api/reports/inventario/top-salidas?from=&to=&limit=10
 * Agrupa por producto/variante y ordena por cantidad total salida.
 */
router.get('/reports/inventario/top-salidas',
  requireAuth, requireRole('admin','manager'),
  async (req,res,next)=>{
    try{
      const from = parseDate(req.query.from);
      const to   = parseDate(req.query.to);
      const limit = toInt(req.query.limit, 10);

      const conds = [`m.tipo='salida'`];
      const params = [];
      let i=1;
      if (from) { conds.push(`m.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to)   { conds.push(`m.created_at <  ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
      const where = `WHERE ${conds.join(' AND ')}`;

      const { rows } = await pool.query(
        `
        SELECT
          p.id_producto,
          p.nombre AS producto,
          v.id_variante_producto,
          v.sku,
          SUM(m.cantidad)::int AS total_salidas
        FROM public.movimiento_inventario m
        JOIN public.variante_producto v ON v.id_variante_producto = m.id_variante_producto
        JOIN public.producto p          ON p.id_producto = v.id_producto
        ${where}
        GROUP BY 1,2,3,4
        ORDER BY total_salidas DESC
        LIMIT ${limit}
        `,
        params
      );

      res.json({ data: rows });
    }catch(err){ next(err); }
  }
);

/**
 * 4) Salidas por periodo (serie)
 * GET /api/reports/inventario/salidas-serie?from=&to=&granularity=month|day
 * Cuenta y suma cantidades de salidas.
 */
router.get('/reports/inventario/salidas-serie',
  requireAuth, requireRole('admin','manager'),
  async (req,res,next)=>{
    try{
      const from = parseDate(req.query.from);
      const to   = parseDate(req.query.to);
      const gran = (req.query.granularity || 'month').toLowerCase() === 'day' ? 'day' : 'month';

      const conds = [`m.tipo='salida'`];
      const params = [];
      let i=1;
      if (from) { conds.push(`m.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to)   { conds.push(`m.created_at <  ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
      const where = `WHERE ${conds.join(' AND ')}`;

      const { rows } = await pool.query(
        `
        SELECT
          date_trunc('${gran}', m.created_at) AS periodo,
          COUNT(*)::int AS movimientos,
          COALESCE(SUM(m.cantidad),0)::int AS unidades
        FROM public.movimiento_inventario m
        ${where}
        GROUP BY 1
        ORDER BY 1
        `,
        params
      );

      res.json({ granularity: gran, data: rows.map(r => ({
        periodo: r.periodo.toISOString(),
        movimientos: r.movimientos,
        unidades: r.unidades
      })) });
    }catch(err){ next(err); }
  }
);

/**
 * 5) Alertas de stock bajo
 * GET /api/reports/alertas/stock-bajo?threshold=5
 * - threshold: si no tienes min_stock en BD, usa este parámetro.
 * - Filtra variantes y productos activos con stock <= threshold.
 */
router.get('/reports/alertas/stock-bajo',
  requireAuth, requireRole('admin','manager'),
  async (req,res,next)=>{
    try{
      const threshold = toInt(req.query.threshold, 5);

      const { rows } = await pool.query(
        `
        SELECT
          p.id_producto,
          p.nombre AS producto,
          v.id_variante_producto,
          v.sku,
          COALESCE(i.stock,0)::int AS stock,
          v.activo AS variante_activa,
          p.activo AS producto_activo
        FROM public.variante_producto v
        JOIN public.producto p ON p.id_producto = v.id_producto
        LEFT JOIN public.inventario i ON i.id_variante_producto = v.id_variante_producto
        WHERE COALESCE(i.stock,0) <= $1
          AND v.activo = true
          AND p.activo = true
        ORDER BY i.stock ASC, p.nombre, v.sku
        `,
        [threshold]
      );

      res.json({ threshold, data: rows });
    }catch(err){ next(err); }
  }
);

/**
 * Auditoría (timeline de eventos)
 * GET /api/auditoria?target_tipo=&target_pedido_id=&target_usuario_id=&action=&actor_id=&from=&to=&page=&limit=
 * Roles:
 *   - admin/manager: ven todo
 *   - vendedor: solo eventos de pedidos
 */
router.get('/auditoria',
  requireAuth,
  async (req, res, next) => {
    try {
      const roles = req.user?.roles || [];
      const isAdminMgr = roles.some(r => r === 'admin' || r === 'manager');
      const isVendor = roles.includes('vendedor');
      if (!isAdminMgr && !isVendor) {
        return res.status(403).json({ message: 'No autorizado' });
      }

      const target_tipo = (req.query.target_tipo || '').trim();
      const target_pedido_id = parseInt(req.query.target_pedido_id || '0', 10);
      const target_usuario_id = parseInt(req.query.target_usuario_id || '0', 10);
      const action = (req.query.action || '').trim();
      const actor_id = parseInt(req.query.actor_id || '0', 10);
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);
      const page = Math.max(1, parseInt(req.query.page || '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
      const offset = (page - 1) * limit;

      const conds = [];
      const params = [];
      let i = 1;

      if (target_tipo) { conds.push(`a.target_tipo = $${i++}`); params.push(target_tipo); }
      if (target_pedido_id) { conds.push(`a.target_pedido_id = $${i++}`); params.push(target_pedido_id); }
      if (target_usuario_id) { conds.push(`a.target_usuario_id = $${i++}`); params.push(target_usuario_id); }
      if (action) { conds.push(`a.action = $${i++}`); params.push(action); }
      if (actor_id) { conds.push(`a.actor_id = $${i++}`); params.push(actor_id); }
      if (from) { conds.push(`a.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to) { conds.push(`a.created_at < ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }

      // Restricción: vendedores solo ven auditoría de pedidos
      if (isVendor && !isAdminMgr) {
        conds.push(`a.target_tipo = 'pedido'`);
      }

      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const { rows: tot } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM public.auditoria a ${where}`,
        params
      );
      const total = tot[0]?.total || 0;

      const { rows: data } = await pool.query(
        `
        SELECT a.id_auditoria, a.created_at, a.actor_id,
               a.target_tipo, a.target_pedido_id, a.target_usuario_id,
               a.action, a.payload
          FROM public.auditoria a
          ${where}
         ORDER BY a.created_at DESC
         LIMIT ${limit} OFFSET ${offset}
        `,
        params
      );

      res.json({ data, page, limit, total });
    } catch (err) { next(err); }
  }
);

module.exports = router;
