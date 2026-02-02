// src/routes/catalog.routes.js
const PRICE_COL = 'precio_lista';
const { Router } = require('express');
const { pool } = require('../db/pool');

const router = Router();

/* ----------------------------- utils sencillas ----------------------------- */
function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function toFloat(v, def) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}
function boolParam(v, def = true) {
  if (v === undefined) return def;
  const s = String(v).toLowerCase();
  return s === 'true' || s === '1';
}

/* -------------------------------- categorías ------------------------------- */
/** GET /api/catalog/categories?onlyActive=true */
router.get('/catalog/categories', async (req, res, next) => {
  try {
    const onlyActive = boolParam(req.query.onlyActive, true);
    const { rows } = await pool.query(
      `
      SELECT id_categoria AS id, nombre
      FROM public.categoria
      WHERE eliminado = false ${onlyActive ? 'AND activo = true' : ''}
      ORDER BY nombre ASC
      `
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/* ---------------------------------- marcas --------------------------------- */
/** GET /api/catalog/brands?onlyActive=true */
router.get('/catalog/brands', async (req, res, next) => {
  try {
    const onlyActive = boolParam(req.query.onlyActive, true);
    const { rows } = await pool.query(
      `
      SELECT id_marca AS id, nombre
      FROM public.marca
      WHERE eliminado = false ${onlyActive ? 'AND activo = true' : ''}
      ORDER BY nombre ASC
      `
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/* ---------------------------- listado de productos -------------------------- */
/**
 * GET /api/catalog/products
 * q, category, brand, min, max, page, limit, sort=popularity|price|name, dir=asc|desc
 */
router.get('/catalog/products', async (req, res, next) => {
  try {
    // 1. Verificar si la tienda está abierta
    const { rows: configRows } = await pool.query(
      "SELECT clave, valor FROM public.configuracion WHERE clave IN ('tienda', 'catalogo')"
    );
    const config = {};
    configRows.forEach(r => { config[r.clave] = r.valor; });

    const tiendaAbierta = config.tienda?.abierto ?? true;
    const ocultarSinStock = config.catalogo?.ocultar_sin_stock ?? false;

    if (!tiendaAbierta) {
      return res.json({ data: [], page: 1, limit: 12, total: 0, pages: 1, message: 'Tienda cerrada' });
    }

    const q = (req.query.q || '').toString().trim();
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '12', 10)));
    const offset = (page - 1) * limit;

    // Mapeo seguro de sorts
    const SORT_MAP = {
      name: 'p.nombre',
      created_at: 'p.fecha_creacion',
      price: 'min_price'
    };

    const sortParam = (req.query.sort || 'created_at').toString();
    const orderBy = SORT_MAP[sortParam] || SORT_MAP.created_at;
    const dir = (req.query.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Filtro de búsqueda
    const searchSql = q ? `AND (p.nombre ILIKE $1 OR p.sku_base ILIKE $1)` : '';

    // Filtro de stock (calculado como suma de stock de variantes)
    const stockFilterSql = ocultarSinStock
      ? `AND (SELECT SUM(COALESCE(inv.stock, 0)) 
                FROM public.variante_producto vp2 
                LEFT JOIN public.inventario inv ON inv.id_variante_producto = vp2.id_variante_producto 
                WHERE vp2.id_producto = p.id_producto AND vp2.activo = true) > 0`
      : '';

    const paramsBase = q ? [`%${q}%`] : [];

    // Total
    const { rows: tot } = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM public.producto p
      WHERE p.activo = true AND p.eliminado = false
      ${searchSql}
      ${stockFilterSql}
      `,
      paramsBase
    );
    const total = tot[0]?.total || 0;

    // Datos con precio mínimo de variantes
    const paramsData = q ? [`%${q}%`, limit, offset] : [limit, offset];
    const { rows: items } = await pool.query(
      `
      SELECT
        p.id_producto,
        p.nombre,
        p.sku_base,
        p.descripcion,
        p.fecha_creacion,
        p.id_categoria,
        p.id_marca,
        MIN(vp.precio_lista) AS min_price,
        COUNT(vp.precio_lista) FILTER (WHERE vp.activo = true) AS variantes_activas,
        (SELECT url FROM public.imagen_producto WHERE id_producto = p.id_producto AND activo = true ORDER BY es_principal DESC, id_imagen_producto ASC LIMIT 1) AS imagen_principal
      FROM public.producto p
      LEFT JOIN public.variante_producto vp
        ON vp.id_producto = p.id_producto
       AND vp.activo = true
      WHERE p.activo = true AND p.eliminado = false
      ${searchSql}
      ${stockFilterSql}
      GROUP BY p.id_producto
      ORDER BY ${orderBy} ${dir}
      LIMIT $${q ? 2 : 1} OFFSET $${q ? 3 : 2}
      `,
      paramsData
    );

    res.json({
      data: items,
      page,
      limit,
      total,
      pages: Math.max(Math.ceil(total / limit), 1)
    });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- detalle de producto ------------------------- */
/** GET /api/catalog/products/:id */
router.get('/catalog/products/:id', async (req, res, next) => {
  try {
    const id = toInt(req.params.id, 0);
    if (!id) return res.status(400).json({ message: 'id inválido' });

    // Detalle base + categoría + marca
    const { rows: prodRows } = await pool.query(
      `
      SELECT
        p.id_producto AS id,
        p.nombre,
        p.descripcion,
        jsonb_build_object('id', c.id_categoria, 'nombre', c.nombre) AS categoria,
        jsonb_build_object('id', m.id_marca,    'nombre', m.nombre)  AS marca
      FROM public.producto p
      LEFT JOIN public.categoria c ON c.id_categoria = p.id_categoria
      LEFT JOIN public.marca     m ON m.id_marca     = p.id_marca  -- ⚠️ si tu columna fuera id_mrca, cambia aquí
      WHERE p.id_producto = $1 AND p.activo = true AND p.eliminado = false
      LIMIT 1
      `,
      [id]
    );
    if (!prodRows.length) return res.status(404).json({ message: 'Producto no encontrado' });
    const product = prodRows[0];

    // Imágenes (sin columna 'orden'): prioriza principal, luego por id
    const { rows: imgs } = await pool.query(
      `
      SELECT url
      FROM public.imagen_producto
      WHERE id_producto = $1 AND activo = true
      ORDER BY es_principal DESC, id_imagen_producto ASC
      `,
      [id]
    );
    product.imagenes = imgs.map(r => r.url);

    // Variantes + stock (JOIN inventario)
    const { rows: variants } = await pool.query(
      `
      SELECT
        vp.id_variante_producto AS id,
        vp.sku,
        vp.precio_lista::float AS precio_lista,
        COALESCE(inv.stock, 0)::int AS stock,
        vp.atributos_json,
        vp.activo
      FROM public.variante_producto vp
      LEFT JOIN public.inventario inv
        ON inv.id_variante_producto = vp.id_variante_producto
      WHERE vp.id_producto = $1 AND vp.activo = true
      ORDER BY vp.id_variante_producto ASC
      `,
      [id]
    );
    product.variantes = variants;

    res.json(product);
  } catch (err) { next(err); }
});

/* ----------------------------- variantes de un producto -------------------- */
/** GET /api/catalog/products/:id/variants */
router.get('/catalog/products/:id/variants', async (req, res, next) => {
  try {
    const id = toInt(req.params.id, 0);
    if (!id) return res.status(400).json({ message: 'id inválido' });

    const { rows } = await pool.query(
      `
      SELECT
        vp.id_variante_producto AS id,
        vp.sku,
        vp.precio_lista::float AS precio_lista,
        COALESCE(inv.stock, 0)::int AS stock,
        vp.atributos_json,
        vp.activo
      FROM public.variante_producto vp
      LEFT JOIN public.inventario inv
        ON inv.id_variante_producto = vp.id_variante_producto
      WHERE vp.id_producto = $1 AND vp.activo = true
      ORDER BY vp.id_variante_producto ASC
      `,
      [id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/* ------------------------------- imágenes de un producto ------------------- */
/** GET /api/catalog/products/:id/images */
router.get('/catalog/products/:id/images', async (req, res, next) => {
  try {
    const id = toInt(req.params.id, 0);
    if (!id) return res.status(400).json({ message: 'id inválido' });

    const { rows } = await pool.query(
      `
      SELECT url
      FROM public.imagen_producto
      WHERE id_producto = $1 AND activo = true
      ORDER BY es_principal DESC, id_imagen_producto ASC
      `,
      [id]
    );
    res.json(rows.map(r => r.url));
  } catch (err) { next(err); }
});

module.exports = router;
