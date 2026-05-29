const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// LISTAR con categoría/marca, stock agregado, filtrado y paginación
router.get('/products', async (req, res, next) => {
  try {
    const { search, id_categoria, id_marca, status, id_almacen, stock_status } = req.query;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const idAlmacen = id_almacen ? parseInt(id_almacen, 10) : null;

    // --- Build Count Query ---
    const countConds = ['p.eliminado = false'];
    const countParams = [];
    let countParamIndex = 1;

    if (search) {
      countConds.push(`(p.nombre ILIKE $${countParamIndex} OR c.nombre ILIKE $${countParamIndex} OR m.nombre ILIKE $${countParamIndex} OR EXISTS (SELECT 1 FROM public.variante_producto vp2 WHERE vp2.id_producto = p.id_producto AND (vp2.sku ILIKE $${countParamIndex} OR vp2.codigo_barras ILIKE $${countParamIndex})))`);
      countParams.push(`%${search}%`);
      countParamIndex++;
    }

    if (id_categoria) {
      countConds.push(`p.id_categoria = $${countParamIndex}`);
      countParams.push(parseInt(id_categoria, 10));
      countParamIndex++;
    }

    if (id_marca) {
      countConds.push(`p.id_marca = $${countParamIndex}`);
      countParams.push(parseInt(id_marca, 10));
      countParamIndex++;
    }

    if (status === 'activo') {
      countConds.push(`p.activo = true AND p.necesita_revision = false`);
    } else if (status === 'inactivo') {
      countConds.push(`p.activo = false`);
    } else if (status === 'borrador') {
      countConds.push(`p.necesita_revision = true`);
    }

    if (stock_status === 'positivo') {
      if (idAlmacen) {
        countConds.push(`(
          SELECT COALESCE(SUM(inv2.stock), 0)::int
          FROM public.variante_producto vp2
          LEFT JOIN public.inventario inv2 ON inv2.id_variante_producto = vp2.id_variante_producto
          WHERE vp2.id_producto = p.id_producto AND inv2.id_almacen = $${countParamIndex}
        ) > 0`);
        countParams.push(idAlmacen);
        countParamIndex++;
      } else {
        countConds.push(`(
          SELECT COALESCE(SUM(inv2.stock), 0)::int
          FROM public.variante_producto vp2
          LEFT JOIN public.inventario inv2 ON inv2.id_variante_producto = vp2.id_variante_producto
          WHERE vp2.id_producto = p.id_producto
        ) > 0`);
      }
    } else if (stock_status === 'cero') {
      if (idAlmacen) {
        countConds.push(`(
          SELECT COALESCE(SUM(inv2.stock), 0)::int
          FROM public.variante_producto vp2
          LEFT JOIN public.inventario inv2 ON inv2.id_variante_producto = vp2.id_variante_producto
          WHERE vp2.id_producto = p.id_producto AND inv2.id_almacen = $${countParamIndex}
        ) = 0`);
        countParams.push(idAlmacen);
        countParamIndex++;
      } else {
        countConds.push(`(
          SELECT COALESCE(SUM(inv2.stock), 0)::int
          FROM public.variante_producto vp2
          LEFT JOIN public.inventario inv2 ON inv2.id_variante_producto = vp2.id_variante_producto
          WHERE vp2.id_producto = p.id_producto
        ) = 0`);
      }
    }

    const countWhere = countConds.length ? `WHERE ${countConds.join(' AND ')}` : '';
    const countQuery = `
      SELECT COUNT(DISTINCT p.id_producto)::int AS total
      FROM public.producto p
      LEFT JOIN public.categoria c ON c.id_categoria = p.id_categoria
      LEFT JOIN public.marca m     ON m.id_marca     = p.id_marca
      ${countWhere}
    `;
    const { rows: countRows } = await pool.query(countQuery, countParams);
    const total = countRows[0]?.total || 0;

    // --- Build Main Query ---
    const mainConds = ['p.eliminado = false'];
    const mainParams = [];
    let mainParamIndex = 1;

    let idAlmacenParamIndex = null;
    if (idAlmacen) {
      mainParams.push(idAlmacen);
      idAlmacenParamIndex = mainParamIndex;
      mainParamIndex++;
    }

    if (search) {
      mainConds.push(`(p.nombre ILIKE $${mainParamIndex} OR c.nombre ILIKE $${mainParamIndex} OR m.nombre ILIKE $${mainParamIndex} OR EXISTS (SELECT 1 FROM public.variante_producto vp2 WHERE vp2.id_producto = p.id_producto AND (vp2.sku ILIKE $${mainParamIndex} OR vp2.codigo_barras ILIKE $${mainParamIndex})))`);
      mainParams.push(`%${search}%`);
      mainParamIndex++;
    }

    if (id_categoria) {
      mainConds.push(`p.id_categoria = $${mainParamIndex}`);
      mainParams.push(parseInt(id_categoria, 10));
      mainParamIndex++;
    }

    if (id_marca) {
      mainConds.push(`p.id_marca = $${mainParamIndex}`);
      mainParams.push(parseInt(id_marca, 10));
      mainParamIndex++;
    }

    if (status === 'activo') {
      mainConds.push(`p.activo = true AND p.necesita_revision = false`);
    } else if (status === 'inactivo') {
      mainConds.push(`p.activo = false`);
    } else if (status === 'borrador') {
      mainConds.push(`p.necesita_revision = true`);
    }

    if (stock_status === 'positivo') {
      if (idAlmacen) {
        mainConds.push(`(
          SELECT COALESCE(SUM(inv2.stock), 0)::int
          FROM public.variante_producto vp2
          LEFT JOIN public.inventario inv2 ON inv2.id_variante_producto = vp2.id_variante_producto
          WHERE vp2.id_producto = p.id_producto AND inv2.id_almacen = $${idAlmacenParamIndex}
        ) > 0`);
      } else {
        mainConds.push(`(
          SELECT COALESCE(SUM(inv2.stock), 0)::int
          FROM public.variante_producto vp2
          LEFT JOIN public.inventario inv2 ON inv2.id_variante_producto = vp2.id_variante_producto
          WHERE vp2.id_producto = p.id_producto
        ) > 0`);
      }
    } else if (stock_status === 'cero') {
      if (idAlmacen) {
        mainConds.push(`(
          SELECT COALESCE(SUM(inv2.stock), 0)::int
          FROM public.variante_producto vp2
          LEFT JOIN public.inventario inv2 ON inv2.id_variante_producto = vp2.id_variante_producto
          WHERE vp2.id_producto = p.id_producto AND inv2.id_almacen = $${idAlmacenParamIndex}
        ) = 0`);
      } else {
        mainConds.push(`(
          SELECT COALESCE(SUM(inv2.stock), 0)::int
          FROM public.variante_producto vp2
          LEFT JOIN public.inventario inv2 ON inv2.id_variante_producto = vp2.id_variante_producto
          WHERE vp2.id_producto = p.id_producto
        ) = 0`);
      }
    }

    const mainWhere = mainConds.length ? `WHERE ${mainConds.join(' AND ')}` : '';
    const limitIndex = mainParamIndex;
    const offsetIndex = mainParamIndex + 1;
    mainParams.push(limit, offset);

    let query = `
      SELECT
        p.id_producto,
        p.id_categoria,
        c.nombre AS category_name,
        p.id_marca,
        m.nombre AS brand_name,
        p.nombre,
        p.descripcion,
        p.activo,
        p.necesita_revision,
        p.fecha_creacion,
        (SELECT url FROM public.imagen_producto WHERE id_producto = p.id_producto AND activo = true ORDER BY es_principal DESC, id_imagen_producto ASC LIMIT 1) AS image,
        (SELECT id_variante_producto FROM public.variante_producto WHERE id_producto = p.id_producto AND activo = true ORDER BY id_variante_producto ASC LIMIT 1) AS default_variant_id,
        COUNT(DISTINCT vp.id_variante_producto)::int AS variants_count,
        COALESCE(SUM(inv.stock)::int, 0) AS total_stock
      FROM public.producto p
      LEFT JOIN public.categoria c ON c.id_categoria = p.id_categoria
      LEFT JOIN public.marca m     ON m.id_marca     = p.id_marca
      LEFT JOIN public.variante_producto vp ON vp.id_producto = p.id_producto
      LEFT JOIN public.inventario inv ON inv.id_variante_producto = vp.id_variante_producto
        ${idAlmacen ? `AND inv.id_almacen = $${idAlmacenParamIndex}` : ''}
      ${mainWhere}
      GROUP BY p.id_producto, c.nombre, m.nombre, p.necesita_revision
      ORDER BY p.fecha_creacion DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
    `;

    const { rows } = await pool.query(query, mainParams);
    res.json({ data: rows, page, limit, total });
  } catch (err) {
    next(err);
  }
});

// LISTAR PENDIENTES DE REVISIÓN
router.get('/products/pending', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        p.id_producto AS id,
        p.nombre,
        p.descripcion,
        p.necesita_revision,
        c.nombre AS categoria_sugerida,
        m.nombre AS marca_sugerida
      FROM public.producto p
      LEFT JOIN public.categoria c ON c.id_categoria = p.id_categoria
      LEFT JOIN public.marca m     ON m.id_marca     = p.id_marca
      WHERE p.eliminado = false AND p.necesita_revision = true
      ORDER BY p.fecha_creacion ASC
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
           activo       = COALESCE($6, activo),
           necesita_revision = false 
       WHERE id_producto = $1
       RETURNING id_producto, id_categoria, id_marca, nombre, descripcion, activo, necesita_revision, fecha_creacion`,
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
