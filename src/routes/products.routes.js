const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// LISTAR (últimos 50)
router.get('/products', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_producto, id_categoria, id_marca, nombre, descripcion, activo, fecha_creacion
      FROM producto
       ORDER BY fecha_creacion DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// CREAR
router.post('/products', requireAuth, requireRole('admin','manager'), async (req, res, next) => {
  try {
    const { id_categoria, id_marca, nombre, sku_base, descripcion, activo } = req.body || {};
    if (!id_categoria || !id_marca || !nombre) {
      return res.status(400).json({ message: 'id_categoria, id_marca y nombre son requeridos' });
    }
    const { rows } = await pool.query(
      `INSERT INTO producto (id_categoria, id_marca, nombre, sku_base, descripcion, activo, fecha_creacion)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, true), NOW())
       RETURNING id_producto, id_categoria, id_marca, nombre, sku_base, descripcion, activo, fecha_creacion`,
       [id_categoria, id_marca, nombre, sku_base || null, descripcion || null, activo]
    );
    res.status(201).json(rows[0]);
  } catch (err) { if (err.code === '23503') {
    return res.status(409).json({ message: 'Violación de clave foránea: verifica id_categoria / id_marca' });
  }
    next(err);
  }

  // Auditoría: creación de producto (sin target_producto_id)
await client.query(
  `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
   VALUES ($1, 'producto', 'PRODUCT_CREATE', $2::jsonb, NOW())`,
  [
    req.user.id || req.user.sub,
    JSON.stringify({
      id_producto: producto.id_producto,
      data: req.body || {}
    })
  ]
);

});

// OBTENER POR ID
router.get('/products/:id', requireAuth, requireRole('admin','manager'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT  id_producto, id_categoria, id_marca, nombre, sku_base, descripcion, activo, fecha_creacion
       FROM producto
       WHERE id_producto = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ message: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ACTUALIZAR
router.put('/products/:id', requireAuth, requireRole('admin','manager'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { id_categoria, id_marca, nombre, sku_base, descripcion, activo } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE producto
       SET id_categoria = COALESCE($2, id_categoria),
       id_marca     = COALESCE($3, id_marca),
       nombre       = COALESCE($4, nombre),
       sku_base     = COALESCE($5, sku_base),
       descripcion  = COALESCE($6, descripcion),
       activo       = COALESCE($7, activo)
       WHERE id_producto = $1
       RETURNING id_producto, id_categoria, id_marca, nombre, sku_base, descripcion, activo, fecha_creacion`,
      [id, id_categoria, id_marca, nombre, sku_base, descripcion, activo]
    );
    if (!rows[0]) return res.status(404).json({ message: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ message: 'Violación de clave foránea: verifica id_categoria / id_marca' });
    }
    next(err);
  }
  // Auditoría: actualización de producto (sin target_producto_id)
await client.query(
  `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
   VALUES ($1, 'producto', 'PRODUCT_UPDATE', $2::jsonb, NOW())`,
  [
    req.user.id || req.user.sub,
    JSON.stringify({
      id_producto: actualizado.id_producto,
      changes: req.body || {}
    })
  ]
);

});

// ELIMINAR
router.delete('/products/:id', requireAuth, requireRole('admin','manager'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE public.producto
         SET activo = false
       WHERE id_producto = $1
       RETURNING id_producto`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ message: 'No encontrado' });
    res.status(204).send();
  } catch (err) {
    next(err);
  
  }
  // Auditoría: desactivación de producto (sin target_producto_id)
await client.query(
  `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
   VALUES ($1, 'producto', 'PRODUCT_DISABLE', $2::jsonb, NOW())`,
  [
    req.user.id || req.user.sub,
    JSON.stringify({ id_producto: rows[0].id_producto })
  ]
);

});

module.exports = router;
