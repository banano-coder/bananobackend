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
        p.descripcion,
        p.activo,
        p.fecha_creacion,
        COUNT(vp.id_variante_producto)::int AS variants_count,
        COALESCE(SUM(inv.stock)::int, 0) AS total_stock
      FROM public.producto p
      LEFT JOIN public.categoria c ON c.id_categoria = p.id_categoria
      LEFT JOIN public.marca m     ON m.id_marca     = p.id_marca
      LEFT JOIN public.variante_producto vp ON vp.id_producto = p.id_producto
      LEFT JOIN public.inventario inv ON inv.id_variante_producto = vp.id_variante_producto
      WHERE p.eliminado = false
      GROUP BY p.id_producto, c.nombre, m.nombre
      ORDER BY p.fecha_creacion DESC
      `
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/products
 * Crea un producto y opcionalmente una variante "Estándar" automáticamente.
 */
router.post('/products', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id_categoria, id_marca, nombre, descripcion, activo, create_default_variant = true, initial_price = 0 } = req.body || {};

    if (initial_price != null && parseFloat(initial_price) < 0) {
      return res.status(400).json({ message: 'El precio inicial no puede ser negativo' });
    }

    if (!id_categoria || !id_marca || !nombre) {
      return res.status(400).json({ message: 'id_categoria, id_marca y nombre son requeridos' });
    }

    await client.query('BEGIN');

    // 1. Insert Producto
    const { rows: prodRows } = await client.query(
      `INSERT INTO producto (id_categoria, id_marca, nombre, descripcion, activo, fecha_creacion)
       VALUES ($1, $2, $3, $4, COALESCE($5, true), NOW())
       RETURNING id_producto, id_categoria, id_marca, nombre, descripcion, activo, fecha_creacion`,
      [id_categoria, id_marca, nombre, descripcion || null, activo]
    );
    const newProduct = prodRows[0];

    // 2. Variante automática (si se solicita)
    let defaultVariant = null;
    if (create_default_variant) {
      // Necesitamos una secuencia para el SKU. Usamos la que ya existe en variants.routes.js: public.variant_sku_seq
      const { rows: seqRows } = await client.query(`SELECT nextval('public.variant_sku_seq') AS seq`);
      const padded = String(seqRows[0].seq).padStart(3, '0');
      const generatedSku = `SKU-${padded}`;

      const { rows: varRows } = await client.query(
        `INSERT INTO public.variante_producto 
          (id_producto, sku, precio_lista, atributos_json, activo)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id_variante_producto, sku, precio_lista::float AS precio_lista`,
        [newProduct.id_producto, generatedSku, initial_price, JSON.stringify({ Tipo: "Estándar" })]
      );
      defaultVariant = varRows[0];

      // 3. Inicializar Inventario en 0
      await client.query(
        `INSERT INTO public.inventario (id_variante_producto, stock)
         VALUES ($1, 0)`,
        [defaultVariant.id_variante_producto]
      );
    }

    // AUDITORIA
    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'producto', 'PRODUCT_CREATE_WITH_VARIANT', $2::jsonb, NOW())`,
      [
        req.user.id || req.user.sub,
        JSON.stringify({
          id_producto: newProduct.id_producto,
          variant_id: defaultVariant?.id_variante_producto
        })
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({
      ...newProduct,
      default_variant: defaultVariant
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') {
      return res.status(409).json({ message: 'Violación de clave foránea: verifica id_categoria / id_marca' });
    }
    next(err);
  } finally {
    client.release();
  }
});

// OBTENER POR ID
router.get('/products/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT p.id_producto, p.id_categoria, c.nombre AS category_name, 
              p.id_marca, m.nombre AS brand_name, 
              p.nombre, p.descripcion, p.activo, p.fecha_creacion
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
    const { id_categoria, id_marca, nombre, descripcion, activo } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE producto
       SET id_categoria = COALESCE($2, id_categoria),
           id_marca     = COALESCE($3, id_marca),
           nombre       = COALESCE($4, nombre),
           descripcion  = COALESCE($5, descripcion),
           activo       = COALESCE($6, activo)
       WHERE id_producto = $1
       RETURNING id_producto, id_categoria, id_marca, nombre, descripcion, activo, fecha_creacion`,
      [id, id_categoria, id_marca, nombre, descripcion, activo]
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

    // Obtener nombre antes de borrar
    const { rows: prodRows } = await client.query(`SELECT nombre FROM producto WHERE id_producto = $1`, [id]);
    const prodName = prodRows[0]?.nombre || 'Desconocido';

    // 4. Borrado lógico (SOFT DELETE)
    // No borramos variantes ni imágenes para preservar el historial de pedidos y movimientos
    const { rowCount } = await client.query(
      `UPDATE public.producto 
       SET activo = false, 
           eliminado = true
       WHERE id_producto = $1 AND eliminado = false`,
      [id]
    );

    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Producto no encontrado o ya eliminado' });
    }

    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'producto', 'PRODUCT_SOFT_DELETE', $2::jsonb, NOW())`,
      [
        req.user.id || req.user.sub,
        JSON.stringify({ id_producto: id, deleted_product_nombre: prodName })
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
