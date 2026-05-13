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
    const headerRow = rawData[headerRowIndex].map(h => typeof h === 'string' ? h.toLowerCase().trim() : '');
    
    // Buscar índices flexibles
    const colNombre = headerRow.findIndex(h => h.includes('nombre') && !h.includes('categor'));
    const colDesc = headerRow.findIndex(h => h.includes('descrip'));
    const colCosto = headerRow.findIndex(h => h.includes('costo'));
    const colPrecio = headerRow.findIndex(h => h.includes('precio'));
    const colStock = headerRow.findIndex(h => h.includes('existencia') || h.includes('stock'));
    const colCat = headerRow.findIndex(h => h.includes('categoria') || h.includes('departamento') || h.includes('categoría'));
    const colMarca = headerRow.findIndex(h => h.includes('marca'));
    const colCodigo = headerRow.findIndex(h => h.includes('codigo') || h.includes('código'));

    // Si no se encuentran columnas requeridas, usar fallback genérico (según el formato inicial del usuario)
    const idxNombre = colNombre >= 0 ? colNombre : 4;
    const idxDesc = colDesc >= 0 ? colDesc : 5; // Usado antes para 'unidad', ahora para descripción/tamaño
    const idxCosto = colCosto >= 0 ? colCosto : 7;
    const idxStock = colStock >= 0 ? colStock : 9;
    const idxPrecio = colPrecio >= 0 ? colPrecio : 10;
    const idxCat = colCat >= 0 ? colCat : 5; // Si se comparte con otra, se usa la que el usuario defina
    const idxMarca = colMarca >= 0 ? colMarca : -1; // Por si no viene
    const idxCodigo = colCodigo >= 0 ? colCodigo : 0; // Fallback al index 0 si no se encuentra

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
        const stock = parseFloat(row[idxStock]) || 0;
        const codigo = row[idxCodigo] ? String(row[idxCodigo]).trim() : null;
        
        // Si hay nombre, es un producto NUEVO (fila padre)
        if (rawName !== '') {
            currentProduct = {
                nombre: rawName,
                descripcion: rawDesc, // Se usa para la descripción principal
                categoria_sugerida: row[idxCat] ? String(row[idxCat]).trim() : null,
                marca_sugerida: idxMarca >= 0 && row[idxMarca] ? String(row[idxMarca]).trim() : null,
                variants: [
                    {
                         codigo,
                         costo,
                         precio_sugerido: precio,
                         stock_inicial: stock,
                         // Atributos base si se usan en un futuro
                         atributos: {} 
                    }
                ]
            };
            products.push(currentProduct);
        } else {
            // Si la columna nombre ESTÁ VACÍA (y hay datos numéricos o descripción extra)
            // Es una fila HIJA (variante del último producto)
            if (currentProduct) {
                // Usamos la descripción como nombre del diferencial o atributo (ej: "100ml") si viene sola
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
                    stock_inicial: stock,
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

    const createdProductIds = [];
    let variantsCount = 0;

    for (const p of products) {
      const { 
        nombre, 
        descripcion, 
        id_categoria, 
        id_marca, 
        activo = true,
        variants = []
      } = p;

      // Inserción del producto padre
      const { rows: prodRows } = await client.query(
        `INSERT INTO public.producto (id_categoria, id_marca, nombre, descripcion, activo, fecha_creacion)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id_producto`,
        [id_categoria || null, id_marca || null, nombre, descripcion || null, activo]
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

        // Inventario
        await client.query(
          `INSERT INTO public.inventario (id_variante_producto, stock)
           VALUES ($1, $2)`,
          [variantId, v.stock_inicial || v.stock || 0]
        );
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

module.exports = router;
