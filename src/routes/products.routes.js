const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// LISTAR (últimos 50)
router.get('/products', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT 
        p.id_producto, 
        p.id_categoria, 
        p.id_marca, 
        p.nombre, 
        p.sku_base, 
        p.descripcion, 
        p.activo, 
        p.fecha_creacion,
        c.nombre as category_name,
        m.nombre as brand_name,
        (
          SELECT COALESCE(SUM(i.stock), 0)::int
          FROM variante_producto vp
          LEFT JOIN inventario i ON vp.id_variante_producto = i.id_variante_producto
          WHERE vp.id_producto = p.id_producto
        ) as total_stock
      FROM producto p
      LEFT JOIN categoria c ON p.id_categoria = c.id_categoria
      LEFT JOIN marca m ON p.id_marca = m.id_marca
      ORDER BY p.fecha_creacion DESC`
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
    const newProduct = rows[0];

    // Auditoría: creación de producto
    await pool.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'producto', 'PRODUCT_CREATE', $2::jsonb, NOW())`,
      [
        req.user.id || req.user.sub,
        JSON.stringify({
          id_producto: newProduct.id_producto,
          data: req.body || {}
        })
      ]
    );

    res.status(201).json(newProduct);
  } catch (err) { 
    if (err.code === '23503') {
      return res.status(409).json({ message: 'Violación de clave foránea: verifica id_categoria / id_marca' });
    }
    next(err);
  }

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
    const updatedProduct = rows[0];
    if (!updatedProduct) return res.status(404).json({ message: 'No encontrado' });

    // Auditoría: actualización de producto
    await pool.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'producto', 'PRODUCT_UPDATE', $2::jsonb, NOW())`,
      [
        req.user.id || req.user.sub,
        JSON.stringify({
          id_producto: updatedProduct.id_producto,
          changes: req.body || {}
        })
      ]
    );

    res.json(updatedProduct);
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ message: 'Violación de clave foránea: verifica id_categoria / id_marca' });
    }
    next(err);
  }

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
    const deletedProduct = rows[0];
    if (!deletedProduct) return res.status(404).json({ message: 'No encontrado' });

    // Auditoría: desactivación de producto
    await pool.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'producto', 'PRODUCT_DISABLE', $2::jsonb, NOW())`,
      [
        req.user.id || req.user.sub,
        JSON.stringify({ id_producto: deletedProduct.id_producto })
      ]
    );

    res.status(204).send();
  } catch (err) {
    next(err);
  }

});

module.exports = router;
