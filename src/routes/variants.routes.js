const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

function generateSku(seq) {
  const padded = String(seq).padStart(3, '0');
  return `SKU-${padded}`;
}

// LIST por producto (todos los roles leen)
router.get('/products/:id/variants', requireAuth, requireRole('admin', 'manager', 'vendedor', 'viewer'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'id inválido' });
    const { rows } = await pool.query(`
      SELECT vp.id_variante_producto, vp.id_producto, vp.sku, vp.precio_lista::float AS precio_lista,
             vp.costo::float AS costo, vp.codigo_barras, vp.atributos_json, vp.activo,
             COALESCE(inv.stock, 0)::int AS stock_actual
      FROM public.variante_producto vp
      LEFT JOIN public.inventario inv ON inv.id_variante_producto = vp.id_variante_producto
      WHERE vp.id_producto = $1
      ORDER BY vp.id_variante_producto
    `, [id]);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// CREATE (admin/manager)
router.post('/products/:id/variants', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const idProd = parseInt(req.params.id, 10);
    if (!idProd) return res.status(400).json({ message: 'id_producto inválido' });

    let { sku, precio_lista, costo, codigo_barras, atributos_json, activo = true } = req.body || {};

    if (precio_lista != null && parseFloat(precio_lista) < 0) {
      return res.status(400).json({ message: 'El precio_lista no puede ser negativo' });
    }
    if (costo != null && parseFloat(costo) < 0) {
      return res.status(400).json({ message: 'El costo no puede ser negativo' });
    }

    await client.query('BEGIN');

    const { rows: p } = await client.query(`SELECT 1 FROM public.producto WHERE id_producto=$1 AND activo=true`, [idProd]);
    if (!p.length) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'producto inactivo o no existe' }); }

    // Generar SKU si no viene uno
    if (!sku) {
      const { rows: seqRows } = await client.query(`SELECT nextval('public.variant_sku_seq') AS seq`);
      sku = generateSku(seqRows[0].seq);
    }

    const { rows } = await client.query(`
      INSERT INTO public.variante_producto
        (id_producto, sku, precio_lista, costo, codigo_barras, atributos_json, activo)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id_variante_producto, id_producto, sku, precio_lista::float AS precio_lista,
                costo::float AS costo, codigo_barras, atributos_json, activo
    `, [idProd, sku, precio_lista ?? null, costo ?? null, codigo_barras || null, atributos_json || null, Boolean(activo)]);

    await client.query(`
      INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
      VALUES ($1, 'variante_producto', 'VARIANT_CREATE', $2::jsonb, NOW())
    `, [req.user.id || req.user.sub, JSON.stringify({ id_variante_producto: rows[0].id_variante_producto, id_producto: idProd, sku })]);

    await client.query('COMMIT');
    res.status(201).json({ message: 'Variante creada', variant: rows[0] });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    if (err.code === '23505') {
      return res.status(409).json({ message: 'El SKU ya existe para este producto' });
    }
    if (err.code === '23503') {
      return res.status(400).json({ message: 'Error de integridad: el producto no existe' });
    }
    next(err);
  }
  finally { client.release(); }
});

// UPDATE (admin/manager) + auditoría de cambio de precio/costo
router.patch('/variants/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'id inválido' });

    const { sku, precio_lista, costo, codigo_barras, atributos_json, activo } = req.body || {};

    if (precio_lista != null && parseFloat(precio_lista) < 0) {
      return res.status(400).json({ message: 'El precio_lista no puede ser negativo' });
    }
    if (costo != null && parseFloat(costo) < 0) {
      return res.status(400).json({ message: 'El costo no puede ser negativo' });
    }

    await client.query('BEGIN');

    const { rows: prevRows } = await client.query(`
      SELECT id_variante_producto, sku, precio_lista::float AS precio_lista, costo::float AS costo,
             codigo_barras, atributos_json, activo
      FROM public.variante_producto WHERE id_variante_producto=$1
    `, [id]);
    if (!prevRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'No encontrada' }); }
    const prev = prevRows[0];

    const { rows, rowCount } = await client.query(`
      UPDATE public.variante_producto
      SET sku           = COALESCE($2, sku),
          precio_lista  = COALESCE($3, precio_lista),
          costo         = COALESCE($4, costo),
          codigo_barras = COALESCE($5, codigo_barras),
          atributos_json= COALESCE($6, atributos_json),
          activo        = COALESCE($7, activo)
      WHERE id_variante_producto = $1
      RETURNING id_variante_producto, id_producto, sku, precio_lista::float AS precio_lista,
                costo::float AS costo, codigo_barras, atributos_json, activo
    `, [id, sku ?? null, precio_lista ?? null, costo ?? null, codigo_barras ?? null, atributos_json ?? null, (activo === undefined) ? undefined : Boolean(activo)]);
    if (!rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'No encontrada' }); }

    const now = rows[0];

    // auditoría general
    await client.query(`
      INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
      VALUES ($1, 'variante_producto', 'VARIANT_UPDATE', $2::jsonb, NOW())
    `, [req.user.id || req.user.sub, JSON.stringify({ id_variante_producto: id, changes: (req.body || {}) })]);

    // auditoría específica de precios
    const priceChanged = (precio_lista !== undefined && Number(prev.precio_lista) !== Number(precio_lista))
      || (costo !== undefined && Number(prev.costo) !== Number(costo));
    if (priceChanged) {
      await client.query(`
        INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
        VALUES ($1, 'variante_producto', 'VARIANT_PRICE_CHANGE', $2::jsonb, NOW())
      `, [req.user.id || req.user.sub,
      JSON.stringify({
        id_variante_producto: id,
        prev: { precio_lista: prev.precio_lista, costo: prev.costo },
        next: { precio_lista, costo }
      })]);
    }

    await client.query('COMMIT');
    res.json({ message: 'Variante actualizada', variant: now });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    next(err);
  }
  finally { client.release(); }
});

// DELETE lógico (admin/manager) — no borra si hay stock > 0
router.delete('/variants/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'id inválido' });

    await client.query('BEGIN');

    const { rows: stk } = await client.query(`
      SELECT COALESCE(i.stock,0)::int AS stock
      FROM public.variante_producto v
      LEFT JOIN public.inventario i ON i.id_variante_producto = v.id_variante_producto
      WHERE v.id_variante_producto = $1
    `, [id]);
    if (stk.length && stk[0].stock > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'No se puede desactivar: stock > 0' });
    }

    const { rowCount } = await client.query(`
      UPDATE public.variante_producto SET activo=false WHERE id_variante_producto=$1
    `, [id]);
    if (!rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'No encontrada' }); }

    await client.query(`
      INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
      VALUES ($1, 'variante_producto', 'VARIANT_DISABLE', $2::jsonb, NOW())
    `, [req.user.id || req.user.sub, JSON.stringify({ id_variante_producto: id })]);

    await client.query('COMMIT');
    res.json({ message: 'Variante desactivada' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    next(err);
  }
  finally { client.release(); }
});

module.exports = router;
