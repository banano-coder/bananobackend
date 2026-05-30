const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

const os = require('os');

// Configuración de multer para subidas temporales (Cambiado a /tmp para Vercel)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tempDir = os.tmpdir();
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls) o CSV (.csv)'));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

/**
 * POST /api/bulk/parse-file
 * Recibe un Excel o CSV, ignora SKU, y devuelve un array jerárquico de productos y variantes.
 */
router.post('/bulk/parse-file', requireAuth, requireRole('admin', 'manager'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No se subió ningún archivo' });
    }

    // Consultar las sedes activas en el sistema
    const { rows: warehouses } = await pool.query(
      `SELECT id_almacen, nombre FROM public.almacen WHERE eliminado = false AND activo = true`
    );

    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // header: 1 devuelve array de arrays
    const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    // Buscar encabezado (ej. "nombre") para saber dónde empiezan los datos
    let headerRowIndex = 0;
    for (let i = 0; i < rawData.length; i++) {
        const row = rawData[i];
        if (row.some(cell => String(cell).toLowerCase().includes('nombre') || String(cell).toLowerCase().includes('descripción'))) {
            headerRowIndex = i;
            break;
        }
    }

    // Identificar posiciones de columnas basándonos en el encabezado
    const headerRow = (rawData[headerRowIndex] || []).map(h => (h !== null && h !== undefined) ? String(h).toLowerCase().trim() : '');
    
    // Buscar índices flexibles
    const colNombre = headerRow.findIndex(h => h && h.includes('nombre') && !h.includes('categor'));
    const colDesc = headerRow.findIndex(h => h && h.includes('descrip'));
    const colCosto = headerRow.findIndex(h => h && h.includes('costo'));
    const colPrecio = headerRow.findIndex(h => h && h.includes('precio'));
    const colStock = headerRow.findIndex(h => h && (h.includes('existencia') || h.includes('stock')));
    const colCat = headerRow.findIndex(h => h && (h.includes('categoria') || h.includes('departamento') || h.includes('categoría')));
    const colMarca = headerRow.findIndex(h => h && h.includes('marca'));
    const colCodigo = headerRow.findIndex(h => h && (h.includes('codigo') || h.includes('código')));

    // Buscar correspondencias de columnas de sedes por nombre
    const whColumns = warehouses.map(wh => {
      const lowerName = wh.nombre.toLowerCase().trim();
      const idx = headerRow.findIndex(h => h && h.toLowerCase().trim() === lowerName);
      return {
        id_almacen: wh.id_almacen,
        nombre: wh.nombre,
        idx
      };
    }).filter(wh => wh.idx >= 0);

    const idxNombre = colNombre >= 0 ? colNombre : 4;
    const idxDesc = colDesc >= 0 ? colDesc : 5;
    const idxCosto = colCosto >= 0 ? colCosto : 7;
    const idxStock = colStock >= 0 ? colStock : 9;
    const idxPrecio = colPrecio >= 0 ? colPrecio : 10;
    const idxCat = colCat >= 0 ? colCat : 5;
    const idxMarca = colMarca >= 0 ? colMarca : -1;
    const idxCodigo = colCodigo >= 0 ? colCodigo : 0;

    const dataRows = rawData.slice(headerRowIndex + 1);
    const products = [];
    let currentProduct = null;

    for (const row of dataRows) {
        // Ignorar filas totalmente vacías
        if (!row.some(cell => cell !== undefined && cell !== null && cell !== '')) continue;

        const rawName = row[idxNombre] ? String(row[idxNombre]).trim() : '';
        const rawDesc = row[idxDesc] ? String(row[idxDesc]).trim() : '';
        const costo = parseFloat(row[idxCosto]) || 0;
        const precio = parseFloat(row[idxPrecio]) || 0;
        const codigo = row[idxCodigo] ? String(row[idxCodigo]).trim() : null;

        // Leer stock por sede
        const stock_sucursales = {};
        whColumns.forEach(wh => {
          const val = row[wh.idx];
          if (val !== undefined && val !== null && val !== '') {
            const stockVal = parseFloat(val);
            if (!isNaN(stockVal)) {
              stock_sucursales[wh.id_almacen] = stockVal;
            }
          }
        });

        // Fallback para columna clásica 'stock' si no hay columnas de sede
        if (Object.keys(stock_sucursales).length === 0 && idxStock >= 0) {
          const val = row[idxStock];
          if (val !== undefined && val !== null && val !== '') {
            const stockVal = parseFloat(val);
            if (!isNaN(stockVal)) {
              const defaultWhId = warehouses.length > 0 ? warehouses[0].id_almacen : 1;
              stock_sucursales[defaultWhId] = stockVal;
            }
          }
        }
        
        // Si hay nombre, es un producto NUEVO (fila padre)
        if (rawName !== '') {
            currentProduct = {
                nombre: rawName,
                descripcion: rawDesc,
                categoria_sugerida: row[idxCat] ? String(row[idxCat]).trim() : null,
                marca_sugerida: idxMarca >= 0 && row[idxMarca] ? String(row[idxMarca]).trim() : null,
                variants: [
                    {
                         codigo,
                         costo,
                         precio_sugerido: precio,
                         stock_sucursales,
                         atributos: {} 
                    }
                ]
            };
            products.push(currentProduct);
        } else {
            // Variante del último producto
            if (currentProduct) {
                let attrs = {};
                if (rawDesc !== '') {
                    attrs['Detalle'] = rawDesc;
                } else {
                    attrs['Tipo'] = `Variante ${currentProduct.variants.length + 1}`;
                }

                currentProduct.variants.push({
                    codigo,
                    costo,
                    precio_sugerido: precio,
                    stock_sucursales,
                    atributos: attrs
                });
            }
        }
    }

    // Limpiar archivo
    fs.unlink(req.file.path, () => {});

    res.json({
      total: products.length,
      products
    });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    next(err);
  }
});

/**
 * POST /api/bulk/create
 * Crea múltiples productos con sus múltiples variantes en una sola transacción.
 */
router.post('/bulk/create', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const { products } = req.body; 

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ message: 'Se requiere un array de productos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Caché local para evitar consultas repetidas en el mismo lote
    const categoryCache = {};
    const brandCache = {};

    const getOrCreateCategory = async (name) => {
      if (!name) return null;
      const cleanName = name.trim();
      const lowerName = cleanName.toLowerCase();
      if (categoryCache[lowerName]) return categoryCache[lowerName];

      const { rows } = await client.query(
        "SELECT id_categoria FROM public.categoria WHERE LOWER(nombre) = $1 AND eliminado = false LIMIT 1",
        [lowerName]
      );

      if (rows.length > 0) {
        categoryCache[lowerName] = rows[0].id_categoria;
        return rows[0].id_categoria;
      }

      const { rows: newRows } = await client.query(
        "INSERT INTO public.categoria (nombre, activo) VALUES ($1, true) RETURNING id_categoria",
        [cleanName]
      );
      categoryCache[lowerName] = newRows[0].id_categoria;
      return newRows[0].id_categoria;
    };

    const getOrCreateBrand = async (name) => {
      if (!name) return null;
      const cleanName = name.trim();
      const lowerName = cleanName.toLowerCase();
      if (brandCache[lowerName]) return brandCache[lowerName];

      const { rows } = await client.query(
        "SELECT id_marca FROM public.marca WHERE LOWER(nombre) = $1 AND eliminado = false LIMIT 1",
        [lowerName]
      );

      if (rows.length > 0) {
        brandCache[lowerName] = rows[0].id_marca;
        return rows[0].id_marca;
      }

      const { rows: newRows } = await client.query(
        "INSERT INTO public.marca (nombre, activo) VALUES ($1, true) RETURNING id_marca",
        [cleanName]
      );
      brandCache[lowerName] = newRows[0].id_marca;
      return newRows[0].id_marca;
    };

    const createdProductIds = [];
    let variantsCount = 0;

    for (const p of products) {
      const { 
        nombre, 
        descripcion, 
        id_categoria, 
        id_marca, 
        categoria_sugerida,
        marca_sugerida,
        activo = true,
        variants = []
      } = p;

      // RESOLUCIÓN AUTOMÁTICA DE TAXONOMÍAS
      const finalIdCat = id_categoria || await getOrCreateCategory(categoria_sugerida);
      const finalIdMarca = id_marca || await getOrCreateBrand(marca_sugerida);

      // Inserción del producto padre (Nace como pendiente de revisión)
      const { rows: prodRows } = await client.query(
        `INSERT INTO public.producto (id_categoria, id_marca, nombre, descripcion, activo, necesita_revision, fecha_creacion)
         VALUES ($1, $2, $3, $4, $5, true, NOW())
         RETURNING id_producto`,
        [finalIdCat, finalIdMarca, nombre, descripcion || null, activo]
      );
      const productId = prodRows[0].id_producto;
      createdProductIds.push({ id: productId, nombre });

      // Inserción de variantes hijas
      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        
        // Generar SKU automáticamente
        const { rows: seqRows } = await client.query(`SELECT nextval('public.variant_sku_seq') AS seq`);
        const generatedSku = `SKU-B-${String(seqRows[0].seq).padStart(4, '0')}`;

        // Atributo (Si está vacío, usar "Estándar")
        let finalAttrs = v.atributos || {};
        if (Object.keys(finalAttrs).length === 0 && i === 0) finalAttrs = { Tipo: "Estándar" };

        const { rows: varRows } = await client.query(
          `INSERT INTO public.variante_producto (id_producto, sku, codigo_barras, costo, precio_lista, atributos_json, activo)
           VALUES ($1, $2, $3, $4, $5, $6, true)
           RETURNING id_variante_producto`,
          [productId, generatedSku, v.codigo || null, v.costo || 0, v.precio_sugerido || v.precio || v.initial_price || 0, JSON.stringify(finalAttrs)]
        );
        const variantId = varRows[0].id_variante_producto;
        variantsCount++;

        // Inventario por sede
        const activeWarehouses = brandCache.__activeWarehouses || (await client.query("SELECT id_almacen FROM public.almacen WHERE eliminado = false AND activo = true")).rows;
        brandCache.__activeWarehouses = activeWarehouses;

        if (v.stock_sucursales && typeof v.stock_sucursales === 'object') {
          for (const [whId, qty] of Object.entries(v.stock_sucursales)) {
            const stockVal = parseInt(qty, 10);
            if (!isNaN(stockVal) && stockVal > 0) {
              await client.query(
                `INSERT INTO public.inventario (id_variante_producto, id_almacen, stock)
                 VALUES ($1, $2, $3)`,
                [variantId, parseInt(whId, 10), stockVal]
              );
            }
          }
        } else {
          // Fallback legacy
          const legacyStock = v.stock_inicial || v.stock || 0;
          const defaultWhId = activeWarehouses.length > 0 ? activeWarehouses[0].id_almacen : 1;
          await client.query(
            `INSERT INTO public.inventario (id_variante_producto, id_almacen, stock)
             VALUES ($1, $2, $3)`,
            [variantId, defaultWhId, legacyStock]
          );
        }
      }
    }

    // AUDITORIA
    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'producto', 'BULK_CREATE_HIERARCHICAL', $2::jsonb, NOW())`,
      [
        req.user.id || req.user.sub,
        JSON.stringify({ 
           products_count: products.length, 
           variants_count: variantsCount,
           product_ids: createdProductIds.map(p => p.id) 
        })
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({
      message: `${products.length} productos y ${variantsCount} variantes creadas exitosamente`,
      createdCount: products.length,
      variantsCount,
      createdProducts: createdProductIds // Array con info { id, nombre }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * GET /api/bulk/template
 * Genera dinámicamente una plantilla Excel (.xlsx) con los nombres de las sedes como columnas.
 */
router.get('/bulk/template', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const { rows: warehouses } = await pool.query(
      `SELECT nombre FROM public.almacen WHERE eliminado = false AND activo = true ORDER BY nombre`
    );

    const headers = [
      'codigo',
      'nombre',
      'descripcion',
      'costo',
      'precio_lista',
      ...warehouses.map(wh => wh.nombre),
      'categoria_no',
      'marca_nombre'
    ];

    const sampleRow = {
      codigo: '771234567890',
      nombre: 'MEDIAS MALLA LUNEL',
      descripcion: 'Negro / Talla M',
      costo: 3.00,
      precio_lista: 8.00,
      categoria_no: 'Ropa',
      marca_nombre: 'Lunel'
    };

    warehouses.forEach(wh => {
      sampleRow[wh.nombre] = 10;
    });

    const worksheet = XLSX.utils.json_to_sheet([sampleRow], { header: headers });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Plantilla');

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=plantilla_productos.xlsx');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
