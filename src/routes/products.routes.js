const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// LISTAR (últimos 50) con categoría/marca y stock agregado
router.get('/products', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        p.id_producto,
        p.id_categoria,
        c.nombre AS category_name,
        p.id_marca,
        m.nombre AS brand_name,
        p.nombre,
        COALESCE(p.sku_base, (
          SELECT sku FROM public.variante_producto WHERE id_producto = p.id_producto LIMIT 1
        )) AS sku_base,
        p.descripcion,
        p.activo,
        p.fecha_creacion,
        COALESCE((
          SELECT SUM(inv.stock)::int
          FROM public.variante_producto vp
          LEFT JOIN public.inventario inv ON inv.id_variante_producto = vp.id_variante_producto
          WHERE vp.id_producto = p.id_producto
        ),0) AS total_stock
      FROM public.producto p
      LEFT JOIN public.categoria c ON c.id_categoria = p.id_categoria
      LEFT JOIN public.marca m     ON m.id_marca     = p.id_marca
      ORDER BY p.fecha_creacion DESC
      `
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// CREAR
router.post('/products', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
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

    await pool.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'producto', 'PRODUCT_CREATE', $2::jsonb, NOW())`,
      [
        req.user.id || req.user.sub,
        JSON.stringify({ id_producto: rows[0].id_producto, data: req.body || {} })
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ message: 'Violación de clave foránea: verifica id_categoria / id_marca' });
    }
    next(err);
  }
});

// OBTENER POR ID
router.get('/products/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT p.id_producto, p.id_categoria, c.nombre AS category_name, 
              p.id_marca, m.nombre AS brand_name, 
              p.nombre, p.sku_base, p.descripcion, p.activo, p.fecha_creacion
       FROM producto p
       LEFT JOIN public.categoria c ON c.id_categoria = p.id_categoria
       LEFT JOIN public.marca m     ON m.id_marca     = p.id_marca
       WHERE p.id_producto = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ message: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ACTUALIZAR
router.put('/products/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
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

    await pool.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'producto', 'PRODUCT_UPDATE', $2::jsonb, NOW())`,
      [
        req.user.id || req.user.sub,
        JSON.stringify({ id_producto: updatedProduct.id_producto, changes: req.body || {} })
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

// ELIMINAR PERMANENTE (valida ventas y borra en cascada)
router.delete('/products/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'ID de producto inválido' });

    await client.query('BEGIN');

    // Si tiene ventas, no se puede borrar físicamente
    const { rows: sold } = await client.query(
      `
      SELECT 1
      FROM public.pedido_item pi
      JOIN public.variante_producto vp ON vp.id_variante_producto = pi.id_variante_producto
      WHERE vp.id_producto = $1
      LIMIT 1
      `,
      [id]
    );
    if (sold.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: 'No se puede eliminar físicamente: el producto tiene ventas. Desactívalo en su lugar.'
      });
    }

    // Inventario
    await client.query(
      `DELETE FROM inventario 
       WHERE id_variante_producto IN (
         SELECT id_variante_producto FROM variante_producto WHERE id_producto = $1
       )`,
      [id]
    );

    // Imágenes
    await client.query(
      `DELETE FROM imagen_producto WHERE id_producto = $1`,
      [id]
    );

    // Variantes
    await client.query(
      `DELETE FROM variante_producto WHERE id_producto = $1`,
      [id]
    );

    // Producto
    const { rowCount } = await client.query(
      `DELETE FROM producto WHERE id_producto = $1`,
      [id]
    );

    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Producto no encontrado' });
    }

    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'producto', 'PRODUCT_HARD_DELETE', $2::jsonb, NOW())`,
      [
        req.user.id || req.user.sub,
        JSON.stringify({ id_producto: id })
      ]
    );

    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    if (err.code === '23503') {
      return res.status(409).json({
        message: 'No se puede eliminar físicamente porque tiene registros asociados (ej. pedidos). Se recomienda desactivarlo.'
      });
    }
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
