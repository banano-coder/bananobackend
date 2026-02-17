// src/routes/pedidos.routes.js
const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// Número de WhatsApp de Banano (env o fallback)
const BANANO_WA = process.env.BANANO_WA || '584129326373';

// Helpers
function toInt(v, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; }
function toFloat(v, def) { const n = parseFloat(v); return Number.isFinite(n) ? n : def; }
function normEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  return s || null;
}
function normPhone(v) {
  const raw = String(v || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits || null;
}
function normCedula(v) {
  const raw = String(v || '').trim();
  if (!raw) return null;
  const clean = raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return clean || null;
}

/**
 * 0) Buscar datos de cliente por cédula (para auto-relleno en frontend)
 * GET /api/guest/client/:cedula
 */
router.get('/guest/client/:cedula', async (req, res, next) => {
  try {
    const cedula = normCedula(req.params.cedula);
    if (!cedula) return res.status(400).json({ status: 'error', message: 'cedula es requerida' });

    const { rows } = await pool.query(
      `SELECT nombre, email, telefono FROM public.cliente WHERE cedula = $1`,
      [cedula]
    );

    if (rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Cliente no encontrado' });
    }

    res.json({ status: 'success', data: rows[0] });
  } catch (err) {
    next(err);
  }
});

async function upsertClienteByCedula(db, { cedula, nombre, email, telefono }) {
  const cedulaNorm = normCedula(cedula);
  const nombreLimpio = String(nombre || '').trim();
  const emailNorm = normEmail(email);
  const telefonoNorm = normPhone(telefono);

  try {
    await db.query(
      `INSERT INTO public.cliente (cedula, nombre, telefono, email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (cedula)
       DO UPDATE SET
         nombre = EXCLUDED.nombre,
         telefono = EXCLUDED.telefono,
         email = EXCLUDED.email,
         updated_at = NOW()`,
      [cedulaNorm, nombreLimpio, telefonoNorm, emailNorm]
    );
  } catch (e) {
    if (e?.code === '23505') {
      const err = new Error('El teléfono o email ya están registrados en otro cliente');
      err.status = 409;
      throw err;
    }
    throw e;
  }

  return cedulaNorm;
}

// Arma texto de WhatsApp
function buildWaText({ id_pedido, cliente_nombre, cliente_email, cliente_telefono, items, total, nota, welcomeMessage }) {
  const intro = welcomeMessage || '¡Hola! Me interesa este producto de Banano Shop.';
  const header = `Consulta de pedido #${id_pedido}`;
  let cliente = `Nombre: ${cliente_nombre}`;
  if (cliente_email) cliente += `\nEmail: ${cliente_email}`;
  if (cliente_telefono) cliente += `\nTel: ${cliente_telefono}`;

  const lineas = items.map(it => {
    const sku = it.sku ? ` (${it.sku})` : '';
    const subtotal = Number(it.subtotal || (it.precio_unitario * it.cantidad) || 0);
    return `• ${it.nombre_producto}${sku} x${it.cantidad} = $${subtotal.toFixed(2)}`;
  }).join('\n');

  const totalTxt = `Total estimado: $${Number(total || 0).toFixed(2)}`;
  const notaTxt = nota ? `\nNota: ${nota}` : '';

  return [intro, header, cliente, lineas, totalTxt]
    .filter(Boolean)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .join('\n\n') + notaTxt;
}

// Devuelve link wa.me con ?text=
function buildWaLink(phone, text) {
  const enc = encodeURIComponent(text);
  return `https://wa.me/${phone}?text=${enc}`;
}

/**
 * 1) Checkout invitado (sin login)
 * POST /api/guest/checkout
 * Body:
 * {
 *   "items": [ { "id_variante": 123, "cantidad": 2 }, ... ],
 *   "cliente_nombre": "Isa",
 *   "nota": "entrega hoy",
 *   "cart_token": "uuid-optional"
 * }
 * Calcula precios desde variante_producto.precio_lista,
 * guarda pedido + items (snapshot). No toca inventario.
 * Auditoría: PEDIDO_CREAR (actor_id = NULL porque es invitado).
 */
router.post('/guest/checkout', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { items, cliente_cedula, cedula, cliente_nombre, cliente_email, cliente_telefono, nota } = req.body || {};
    const clienteCedulaNorm = normCedula(cliente_cedula ?? cedula);
    const clienteEmailNorm = normEmail(cliente_email);
    const clienteTelefonoNorm = normPhone(cliente_telefono);

    // Validaciones básicas
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ status: 'error', message: 'items es requerido y no puede estar vacío' });
    }
    if (!cliente_nombre) {
      return res.status(400).json({ status: 'error', message: 'cliente_nombre es requerido' });
    }
    if (!clienteCedulaNorm) {
      return res.status(400).json({ status: 'error', message: 'cliente_cedula es requerido' });
    }
    if (!clienteEmailNorm) {
      return res.status(400).json({ status: 'error', message: 'cliente_email es requerido' });
    }
    if (!clienteTelefonoNorm) {
      return res.status(400).json({ status: 'error', message: 'cliente_telefono es requerido' });
    }

    // Normalizar items (admite id_variante_producto | id_variante | id)
    const normItems = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const rawId = it.id_variante_producto ?? it.id_variante ?? it.id;
      const idVar = Number.parseInt(rawId, 10);
      const qty = Number.parseInt(it.cantidad, 10);
      if (!Number.isInteger(idVar) || idVar <= 0) {
        return res.status(400).json({ status: 'error', message: `Cada item debe tener id_variante válido (ítem ${i + 1})` });
      }
      if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ status: 'error', message: `Cantidad inválida para el ítem ${i + 1}` });
      }
      normItems.push({ id_variante_producto: idVar, cantidad: qty });
    }
    const ids = normItems.map(x => x.id_variante_producto);

    // Traer variantes + producto + inventario
    const { rows: variantes } = await pool.query(
      `
      SELECT
        vp.id_variante_producto,
        vp.sku,
        vp.precio_lista::numeric AS precio_lista,
        COALESCE(inv.stock, 0)::int AS stock,
        vp.activo,
        p.nombre AS nombre_producto
      FROM public.variante_producto vp
      JOIN public.producto p
        ON p.id_producto = vp.id_producto
      LEFT JOIN public.inventario inv
        ON inv.id_variante_producto = vp.id_variante_producto
      WHERE vp.id_variante_producto = ANY($1::int[])
      `,
      [ids]
    );
    const mapVar = new Map(variantes.map(v => [Number(v.id_variante_producto), v]));

    // Validaciones de negocio
    for (const it of normItems) {
      const v = mapVar.get(Number(it.id_variante_producto));
      if (!v) return res.status(400).json({ status: 'error', message: `Variante ${it.id_variante_producto} no existe` });
      if (v.activo === false) return res.status(400).json({ status: 'error', message: `Variante ${it.id_variante_producto} inactiva` });
      if (v.stock < it.cantidad) return res.status(400).json({ status: 'error', message: `Stock insuficiente en variante ${it.id_variante_producto} (disp: ${v.stock})` });
      if (v.precio_lista == null) return res.status(500).json({ status: 'error', message: `Variante ${it.id_variante_producto} no tiene precio_lista` });
    }

    await client.query('BEGIN');

    const cedulaCliente = await upsertClienteByCedula(client, {
      cedula: clienteCedulaNorm,
      nombre: cliente_nombre,
      email: clienteEmailNorm,
      telefono: cliente_telefono
    });

    // Crear pedido con email y teléfono
    const { rows: ped } = await client.query(
      `INSERT INTO public.pedido (cedula_cliente, cliente_nombre, cliente_email, cliente_telefono, observacion, estado)
       VALUES ($1, $2, $3, $4, $5, 'nuevo') RETURNING id_pedido`,
      [cedulaCliente, cliente_nombre, clienteEmailNorm, clienteTelefonoNorm, nota || null]
    );
    const id_pedido = ped[0].id_pedido;

    // Insertar items y calcular total
    let total = 0;
    const snapshotItems = [];
    for (const it of normItems) {
      const v = mapVar.get(Number(it.id_variante_producto));
      const unit = Number(v.precio_lista);
      const sub = +(unit * it.cantidad).toFixed(2);

      await client.query(
        `INSERT INTO public.pedido_item (id_pedido, id_variante_producto, nombre_producto, sku, cantidad, precio_unitario, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id_pedido, v.id_variante_producto, v.nombre_producto, v.sku, it.cantidad, unit, sub]
      );
      total += sub;

      snapshotItems.push({
        id_variante: v.id_variante_producto,
        nombre_producto: v.nombre_producto,
        sku: v.sku,
        precio_unitario: unit,
        cantidad: it.cantidad,
        subtotal: sub
      });
    }

    // Auditoría
    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_pedido_id, target_tipo, action, payload, created_at)
       VALUES ($1, $2, 'pedido', 'PEDIDO_CREAR', $3::jsonb, NOW())`,
      [null, id_pedido, JSON.stringify({ cedula_cliente: cedulaCliente, cliente_nombre, cliente_email: clienteEmailNorm, cliente_telefono: clienteTelefonoNorm, total, items: normItems })]
    );

    // Obtener configuración de WhatsApp dinámica
    const { rows: waConfig } = await client.query('SELECT valor FROM public.configuracion WHERE clave = $1', ['whatsapp']);
    const waData = waConfig[0]?.valor || {};
    const targetPhone = waData.numero || BANANO_WA;
    const welcomeMsg = waData.mensaje_bienvenida;

    // Generar mensaje y link WA
    const texto = buildWaText({
      id_pedido,
      cliente_nombre,
      cliente_email: clienteEmailNorm,
      cliente_telefono: clienteTelefonoNorm,
      items: snapshotItems,
      total,
      nota,
      welcomeMessage: welcomeMsg
    });
    const waUrl = buildWaLink(targetPhone, texto);

    // Guardar snapshot WA y total_estimado (importante para el dashboard)
    await client.query(
      `UPDATE public.pedido
         SET whatsapp_text = $2, whatsapp_link = $3, total_estimado = $4, updated_at = NOW()
       WHERE id_pedido = $1`,
      [id_pedido, texto, waUrl, total]
    );

    await client.query('COMMIT');
    return res.status(201).json({ id_pedido, waUrl });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * 2) Listado (admin/manager)
 * GET /api/pedidos?estado=&from=&to=&search=&page=1&limit=20
 * (search solo por nombre ahora)
 */
router.get('/pedidos', requireAuth, requireRole('admin', 'manager', 'vendedor'), async (req, res, next) => {
  try {
    const estado = (req.query.estado || '').trim();
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const search = (req.query.search || '').trim();
    const page = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
    const offset = (page - 1) * limit;

    const conds = [];
    const params = [];
    let i = 1;

    if (estado) { conds.push(`p.estado = $${i++}`); params.push(estado); }
    if (from) { conds.push(`p.created_at >= $${i++}::timestamptz`); params.push(from); }
    if (to) { conds.push(`p.created_at <  ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
    if (search) {
      conds.push(`(p.cliente_nombre ILIKE $${i})`);
      params.push(`%${search}%`); i++;
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const allowedSort = new Set(['created_at', 'estado', 'total']);
    const sort = allowedSort.has((req.query.sort || '').toLowerCase()) ? req.query.sort.toLowerCase() : 'created_at';
    const dir = (req.query.dir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const sortCol = sort === 'total' ? 'p.total_estimado' : sort === 'estado' ? 'p.estado' : 'p.created_at';


    const { rows: t } = await pool.query(`SELECT COUNT(*)::int AS total FROM public.pedido p ${where}`, params);
    const total = t[0].total;

    const { rows: data } = await pool.query(
      `
      SELECT p.id_pedido, p.cedula_cliente, p.origen, p.cliente_nombre, p.cliente_email, p.cliente_telefono,
             p.total_estimado::float AS total_estimado, p.estado, p.created_at, p.updated_at
      FROM public.pedido p
      ${where}
      ORDER BY ${sortCol} ${dir}
      LIMIT ${limit} OFFSET ${offset}
      `,
      params
    );

    res.json({ data, page, limit, total });
  } catch (err) {
    next(err);
  }
});

/** 3) Detalle (admin/manager o vendedor) */
router.get('/pedidos/:id', requireAuth, requireRole('admin', 'manager', 'vendedor'), async (req, res, next) => {
  try {
    const id = toInt(req.params.id, 0);
    if (!id) return res.status(400).json({ message: 'id inválido' });

    const { rows: head } = await pool.query(
      `
      SELECT id_pedido, cedula_cliente, origen, cliente_nombre, cliente_email, cliente_telefono,
             total_estimado::float AS total_estimado, estado, whatsapp_text, whatsapp_link,
             observacion, created_at, updated_at
      FROM public.pedido WHERE id_pedido = $1
      `,
      [id]
    );
    if (!head.length) return res.status(404).json({ message: 'Pedido no encontrado' });

    const { rows: items } = await pool.query(
      `
      SELECT id_pedido_item, id_variante_producto, nombre_producto, sku,
             precio_unitario::float AS precio_unitario, cantidad, subtotal::float AS subtotal
      FROM public.pedido_item WHERE id_pedido = $1 ORDER BY id_pedido_item
      `,
      [id]
    );

    res.json({ ...head[0], items });
  } catch (err) { next(err); }
});

/**
 * 4) Cambiar estado (admin/manager o vendedor)
 * PATCH /api/pedidos/:id/estado
 * Body: { "estado": "contactado|concretado|cancelado" }
 * Auditoría: PEDIDO_CAMBIAR_ESTADO
 */
router.patch('/pedidos/:id/estado', requireAuth, requireRole('admin', 'manager', 'vendedor'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = toInt(req.params.id, 0);
    const estado = String(req.body?.estado || '').trim();
    const valid = new Set(['nuevo', 'contactado', 'concretado', 'cancelado']);
    if (!id) return res.status(400).json({ message: 'id inválido' });
    if (!valid.has(estado)) return res.status(400).json({ message: 'estado inválido' });

    await client.query('BEGIN');

    const { rowCount } = await client.query(
      `UPDATE public.pedido SET estado = $2, updated_at = NOW() WHERE id_pedido = $1`,
      [id, estado]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Pedido no encontrado' });
    }

    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_pedido_id, target_tipo, action, payload, created_at)
       VALUES ($1, $2, 'pedido', 'PEDIDO_CAMBIAR_ESTADO', $3::jsonb, NOW())`,
      [req.user.id || req.user.sub, id, JSON.stringify({ estado })]
    );

    await client.query('COMMIT');
    res.json({ message: 'Estado actualizado', estado });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    next(err);
  } finally {
    client.release();
  }
});


module.exports = router;
