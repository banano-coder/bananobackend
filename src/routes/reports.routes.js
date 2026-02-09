const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// Helpers
function parseDate(s) { return (s || '').trim(); }
function toInt(v, d = 10) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

// Etiquetas legibles para acciones de auditoría
const ACTION_LABELS = {
  CREATE_USER: 'Creó usuario',
  CREATE_USER_SIGNUP: 'Signup de usuario',
  REPLACE_ROLES: 'Actualizó roles',
  RESET_PASSWORD: 'Reseteó contraseña',
  ENABLE: 'Activó usuario',
  DISABLE: 'Desactivó usuario',
  PRODUCT_CREATE: 'Creó producto',
  PRODUCT_CREATE_WITH_VARIANT: 'Creó producto (con variante)',
  PRODUCT_UPDATE: 'Actualizó producto',
  PRODUCT_DISABLE: 'Desactivó producto',
  CAT_CREATE: 'Creó categoría',
  CAT_UPDATE: 'Actualizó categoría',
  CAT_DISABLE: 'Desactivó categoría',
  BRAND_CREATE: 'Creó marca',
  BRAND_UPDATE: 'Actualizó marca',
  BRAND_DISABLE: 'Desactivó marca',
  VARIANT_CREATE: 'Creó variante',
  VARIANT_UPDATE: 'Actualizó variante',
  VARIANT_PRICE_CHANGE: 'Cambio de precio/costo',
  VARIANT_DISABLE: 'Desactivó variante',
  INV_ENTRADA: 'Entrada de inventario',
  INV_SALIDA: 'Salida de inventario',
  INV_AJUSTE: 'Ajuste de inventario',
  PEDIDO_CREAR: 'Creó pedido',
  PEDIDO_CAMBIAR_ESTADO: 'Cambió estado de pedido',
  USUARIO_UPDATE_PERFIL: 'Actualizó perfil',
  USUARIO_UPDATE_PASSWORD: 'Cambió contraseña',
  SOFT_DELETE_USER: 'Eliminó usuario',
  PRODUCT_SOFT_DELETE: 'Eliminó producto',
  BRAND_SOFT_DELETE: 'Eliminó marca',
  CAT_SOFT_DELETE: 'Eliminó categoría'
};

// Resumen legible del payload según acción
function formatDetail(action, payload) {
  if (!payload) return '';
  let data = payload;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return payload; }
  }

  switch (action) {
    case 'REPLACE_ROLES':
      return data.roles ? `Roles: ${data.roles.join(', ')}` : '';
    case 'ENABLE':
    case 'DISABLE':
      return data.activo !== undefined ? `Activo: ${data.activo}` : '';
    case 'RESET_PASSWORD':
      return data.by ? `Reseteada por: ${data.by}` : '';
    case 'CREATE_USER_SIGNUP':
    case 'CREATE_USER':
      return data.email ? `Email: ${data.email} | Rol: ${data.rol || data.roles}` : '';
    case 'VARIANT_UPDATE':
      return data.changes ? `Cambios: ${JSON.stringify(data.changes)}` : '';
    case 'VARIANT_PRICE_CHANGE':
      return data.prev || data.next
        ? `Precio ${JSON.stringify(data.prev || {})} → ${JSON.stringify(data.next || {})}`
        : '';
    case 'VARIANT_DISABLE':
    case 'VARIANT_CREATE':
      return data.sku ? `SKU: ${data.sku}` : '';
    case 'INV_ENTRADA':
    case 'INV_SALIDA':
    case 'INV_AJUSTE':
      return data.cantidad
        ? `Cant: ${data.cantidad} | Stock ${data.stock_antes} → ${data.stock_despues}`
        : '';
    case 'PEDIDO_CREAR':
      return data.total !== undefined ? `Total: ${data.total} | Items: ${data.items?.length || 0}` : '';
    case 'PEDIDO_CAMBIAR_ESTADO':
      return data.estado ? `Estado: ${data.estado}` : '';
    case 'USUARIO_UPDATE_PERFIL':
      return `Nombre: ${data.nombre} | Email: ${data.email}`;
    case 'USUARIO_UPDATE_PASSWORD':
      return 'Contraseña actualizada por el usuario';
    case 'SOFT_DELETE_USER':
      return data.deleted_user_nombre
        ? `Usuario: ${data.deleted_user_nombre} (ID: ${data.deleted_user_id})`
        : (data.deleted_user_id ? `ID Usuario eliminado: ${data.deleted_user_id}` : 'Usuario eliminado');
    case 'PRODUCT_SOFT_DELETE':
      return data.deleted_product_nombre
        ? `Producto: ${data.deleted_product_nombre} (ID: ${data.id_producto})`
        : (data.id_producto ? `ID Producto eliminado: ${data.id_producto}` : 'Producto eliminado');
    case 'BRAND_SOFT_DELETE':
      return data.nombre ? `Marca: ${data.nombre} (ID: ${data.id_marca})` : `Marca ID: ${data.id_marca}`;
    case 'CAT_SOFT_DELETE':
      return data.nombre ? `Categoría: ${data.nombre} (ID: ${data.id_categoria})` : `Categoría ID: ${data.id_categoria}`;
    case 'PRODUCT_CREATE_WITH_VARIANT':
      return data.id_producto ? `ID Producto: ${data.id_producto} | ID Variante: ${data.variant_id}` : '';
    case 'PRODUCT_CREATE':
      return data.id_producto ? `ID Producto: ${data.id_producto}` : '';
    case 'CAT_CREATE':
      return data.id_categoria ? `ID Categoría: ${data.id_categoria} | Nombre: ${data.nombre}` : '';
    case 'BRAND_CREATE':
      return data.id_marca ? `ID Marca: ${data.id_marca} | Nombre: ${data.nombre}` : '';
    default:
      return typeof data === 'object' ? JSON.stringify(data) : String(data);
  }
}

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
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);

      const conds = [];
      const params = [];
      let i = 1;
      if (from) { conds.push(`p.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to) { conds.push(`p.created_at <  ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
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

      const k = rows[0] || { total_pedidos: 0, total_concretados: 0, monto_total_estimado: 0, ticket_promedio: 0 };
      const conversion = k.total_pedidos ? +(k.total_concretados / k.total_pedidos).toFixed(2) : 0;

      res.json({ ...k, conversion });
    } catch (err) { next(err); }
  }
);

/**
 * 2) Serie temporal de pedidos
 * GET /api/reports/pedidos/serie?from=&to=&granularity=month|day
 * Devuelve: fecha (inicio), total, concretados, monto_concretado
 */
router.get('/reports/pedidos/serie',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);
      const g = graw ? String(graw).trim().toLowerCase() : 'month';
      const gran = (g === 'day' || g === 'month' || g === 'year') ? g : 'month';

      const conds = [];
      const params = [];
      let i = 1;
      if (from) { conds.push(`p.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to) { conds.push(`p.created_at <  ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
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

      res.json({
        granularity: gran, data: rows.map(r => ({
          periodo: r.periodo.toISOString(),
          total: r.total,
          concretados: r.concretados,
          monto_concretado: r.monto_concretado
        }))
      });
    } catch (err) { next(err); }
  }
);

/**
 * 3) Top productos por salidas (movimiento_inventario)
 * GET /api/reports/inventario/top-salidas?from=&to=&limit=10
 * Agrupa por producto/variante y ordena por cantidad total salida.
 */
router.get('/reports/inventario/top-salidas',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);
      const limit = toInt(req.query.limit, 10);

      const conds = [`m.tipo='salida'`];
      const params = [];
      let i = 1;
      if (from) { conds.push(`m.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to) { conds.push(`m.created_at <  ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
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
    } catch (err) { next(err); }
  }
);

/**
 * 4) Salidas por periodo (serie)
 * GET /api/reports/inventario/salidas-serie?from=&to=&granularity=month|day
 * Cuenta y suma cantidades de salidas.
 */
router.get('/reports/inventario/salidas-serie',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);
      const gran = (req.query.granularity || 'month').toLowerCase() === 'day' ? 'day' : 'month';

      const conds = [`m.tipo='salida'`];
      const params = [];
      let i = 1;
      if (from) { conds.push(`m.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to) { conds.push(`m.created_at <  ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
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

      res.json({
        granularity: gran, data: rows.map(r => ({
          periodo: r.periodo.toISOString(),
          movimientos: r.movimientos,
          unidades: r.unidades
        }))
      });
    } catch (err) { next(err); }
  }
);

/**
 * 5) Alertas de stock bajo
 * GET /api/reports/alertas/stock-bajo?threshold=5
 * - threshold: si no tienes min_stock en BD, usa este parámetro.
 * - Filtra variantes y productos activos con stock <= threshold.
 */
router.get('/reports/alertas/stock-bajo',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const threshold = toInt(req.query.threshold, 5);

      const { rows } = await pool.query(
        `
        SELECT
          p.id_producto,
          p.nombre AS producto,
          v.id_variante_producto,
          v.sku,
          COALESCE(i.stock,0)::int AS stock,
          COALESCE(v.activo, true) AS variante_activa,
          p.activo AS producto_activo
        FROM public.producto p
        LEFT JOIN public.variante_producto v ON v.id_producto = p.id_producto
        LEFT JOIN public.inventario i        ON i.id_variante_producto = v.id_variante_producto
        WHERE p.activo = true
          AND (v.id_variante_producto IS NULL OR v.activo = true)
          AND COALESCE(i.stock,0) <= $1
        ORDER BY i.stock ASC, p.nombre, v.sku
        `,
        [threshold]
      );

      res.json({ threshold, data: rows });
    } catch (err) { next(err); }
  }
);

/**
 * 6) Stock Actual (operativo)
 * GET /api/reports/inventario/stock-actual
 * Filtra solo productos y variantes activas.
 */
router.get('/reports/inventario/stock-actual',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `
        SELECT
          p.id_producto,
          p.nombre AS producto,
          v.id_variante_producto,
          v.sku,
          COALESCE(i.stock,0)::int AS stock
        FROM public.producto p
        LEFT JOIN public.variante_producto v ON v.id_producto = p.id_producto
        LEFT JOIN public.inventario i        ON i.id_variante_producto = v.id_variante_producto
        WHERE p.activo = true
          AND (v.id_variante_producto IS NULL OR v.activo = true)
        ORDER BY p.nombre, v.sku
        `
      );
      res.json({ data: rows });
    } catch (err) { next(err); }
  }
);

/**
 * 7) KPIs de Despachos (Salidas de inventario)
 * GET /api/reports/movimientos/kpis?from=&to=
 */
router.get('/reports/movimientos/kpis',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);

      const conds = [`m.tipo = 'salida'`];
      const params = [];
      let i = 1;

      if (from) { conds.push(`m.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to) { conds.push(`m.created_at < ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `
        SELECT
          COUNT(*)::int AS total_movimientos,
          COALESCE(SUM(m.cantidad),0)::int AS total_unidades,
          COALESCE(SUM(m.cantidad * m.costo_unitario),0)::float AS valor_estimado_despachado
        FROM public.movimiento_inventario m
        ${where}
        `,
        params
      );

      res.json(rows[0] || { total_movimientos: 0, total_unidades: 0, valor_estimado_despachado: 0 });
    } catch (err) { next(err); }
  }
);

/**
 * 8) Historial Detallado de Salidas
 * GET /api/reports/movimientos/detalle?from=&to=
 */
router.get('/reports/movimientos/detalle',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);

      const conds = [`m.tipo = 'salida'`];
      const params = [];
      let i = 1;

      if (from) { conds.push(`m.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to) { conds.push(`m.created_at < ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `
        SELECT
          m.id_movimiento_inventario AS id_salida,
          m.created_at AS fecha,
          p.nombre AS producto,
          v.sku,
          m.cantidad,
          m.motivo,
          m.ref_externa AS referencia,
          u.nombre AS autorizado_por,
          COALESCE(m.costo_unitario,0)::float AS costo_unit,
          COALESCE(m.cantidad * m.costo_unitario, 0)::float AS subtotal
        FROM public.movimiento_inventario m
        JOIN public.variante_producto v ON v.id_variante_producto = m.id_variante_producto
        JOIN public.producto p          ON p.id_producto = v.id_producto
        LEFT JOIN public.usuario u      ON u.id_usuario = m.id_usuario
        ${where}
        ORDER BY m.created_at DESC
        `,
        params
      );

      res.json({ data: rows });
    } catch (err) { next(err); }
  }
);

/**
 * DEBUG: GET /api/reports/debug/stock
 * Dumps all variants with their stock and active status.
 */
router.get('/reports/debug/stock', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
SELECT
p.id_producto,
  p.nombre AS producto,
    p.activo AS producto_activo,
      v.id_variante_producto,
      v.sku,
      v.activo AS variante_activa,
        COALESCE(i.stock, 0)::int AS stock
      FROM public.variante_producto v
      JOIN public.producto p ON p.id_producto = v.id_producto
      LEFT JOIN public.inventario i ON i.id_variante_producto = v.id_variante_producto
      ORDER BY p.id_producto, v.id_variante_producto
  `);
    res.json(rows);
  } catch (err) { next(err); }
});

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

      if (target_tipo) { conds.push(`a.target_tipo = $${i++} `); params.push(target_tipo); }
      if (target_pedido_id) { conds.push(`a.target_pedido_id = $${i++} `); params.push(target_pedido_id); }
      if (target_usuario_id) { conds.push(`a.target_usuario_id = $${i++} `); params.push(target_usuario_id); }
      if (action) { conds.push(`a.action = $${i++} `); params.push(action); }
      if (actor_id) { conds.push(`a.actor_id = $${i++} `); params.push(actor_id); }
      if (from) { conds.push(`a.created_at >= $${i++}:: timestamptz`); params.push(from); }
      if (to) { conds.push(`a.created_at < ($${i++}:: timestamptz + INTERVAL '1 day')`); params.push(to); }

      // Restricción: vendedores solo ven auditoría de pedidos e inventario
      if (isVendor && !isAdminMgr) {
        conds.push(`a.target_tipo = ANY(ARRAY['pedido', 'inventario'])`);
      }

      const where = conds.length ? `WHERE ${conds.join(' AND ')} ` : '';

      const { rows: tot } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM public.auditoria a ${where} `,
        params
      );
      const total = tot[0]?.total || 0;

      const { rows } = await pool.query(
        `
SELECT
a.id,
  a.created_at,
  a.actor_id,
  ua.nombre  AS actor_nombre,
    ua.email   AS actor_email,
      a.target_tipo,
      a.target_pedido_id,
      a.target_usuario_id,
      ut.nombre  AS target_usuario_nombre,
        ut.email   AS target_usuario_email,
          p.cliente_nombre AS target_pedido_cliente,
            pr.nombre AS target_producto_nombre,
              vp.sku AS target_variante_sku,
                a.action,
                a.payload
        FROM public.auditoria a
        LEFT JOIN public.usuario ua ON ua.id_usuario = a.actor_id
        LEFT JOIN public.usuario ut ON ut.id_usuario = COALESCE(a.target_usuario_id, (a.payload ->> 'deleted_user_id'):: int)
        LEFT JOIN public.pedido p   ON p.id_pedido = a.target_pedido_id
        LEFT JOIN public.producto pr ON pr.id_producto = (a.payload ->> 'id_producto'):: int
        LEFT JOIN public.variante_producto vp ON vp.id_variante_producto = (a.payload ->> 'id_variante_producto'):: int
        ${where}
        ORDER BY a.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
`,
        params
      );

      // arma estructuras amigables para frontend
      const data = rows.map(r => ({
        id: r.id,
        created_at: r.created_at,
        actor_id: r.actor_id,
        actor_nombre: r.actor_nombre,
        actor_email: r.actor_email,
        actor: r.actor_id ? {
          id: r.actor_id,
          nombre: r.actor_nombre,
          email: r.actor_email
        } : null,
        target_tipo: r.target_tipo,
        target_pedido_id: r.target_pedido_id,
        target_usuario_id: r.target_usuario_id,
        target_usuario_nombre: r.target_usuario_nombre,
        target_usuario_email: r.target_usuario_email,
        target_pedido_cliente: r.target_pedido_cliente,
        target_producto_nombre: r.target_producto_nombre,
        target_variante_sku: r.target_variante_sku,
        target_usuario: r.target_usuario_id ? {
          id: r.target_usuario_id,
          nombre: r.target_usuario_nombre,
          email: r.target_usuario_email
        } : null,
        target_label: (() => {
          if (r.target_tipo === 'pedido' && r.target_pedido_id) return `Pedido #${r.target_pedido_id} `;

          if (r.target_tipo === 'usuario' || r.target_usuario_id) {
            const name = (r.payload?.deleted_user_nombre || r.target_usuario_nombre || r.payload?.deleted_user_id || r.target_usuario_id || '')
              .toString().replace(/ \(ELIMINADO\)$/i, '');
            return `Usuario: ${name} `;
          }

          if (r.target_tipo === 'producto' || (r.action === 'PRODUCT_SOFT_DELETE')) {
            const name = r.target_producto_nombre || r.payload?.deleted_product_nombre || r.payload?.id_producto || '';
            return `Producto: ${name} `;
          }
          if ((r.target_tipo === 'variante' || r.target_tipo === 'variante_producto' || r.target_tipo === 'inventario') && r.target_variante_sku) return `Variante: ${r.target_variante_sku} `;

          // Fallback
          const id = r.target_pedido_id || r.target_usuario_id || (r.payload?.id_producto) || (r.payload?.id_variante_producto) || (r.payload?.deleted_user_id);
          return `${r.target_tipo}${id ? ` #${id}` : ''} `;
        })(),
        action: r.action,
        action_label: ACTION_LABELS[r.action] || r.action,
        payload: r.payload,
        detail: formatDetail(r.action, r.payload)
      }));

      res.json({ data, page, limit, total });
    } catch (err) { next(err); }
  }
);

module.exports = router;
