const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

const { storage, cloudinary } = require('../config/cloudinary');

// --- Multer: almacenamiento en Cloudinary -----------------------------
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Helper: ya no hace falta armar la URL porque cloudinary la devuelve completa en req.file.path
const publicUrl = (file) => file.path;

// --- Endpoints --------------------------------------------------------

/**
 * POST /api/products/:id/images
 * Sube imagen y la registra en BD.
 * Roles: admin, manager (crear)
 * Body form-data: field "image" (file)
 */
router.post('/products/:id/images',
  upload.single('image'),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const idProd = parseInt(req.params.id, 10);
      if (!Number.isInteger(idProd) || idProd <= 0) return res.status(400).json({ message: 'id inválido' });
      if (!req.file) return res.status(400).json({ message: 'Archivo "image" requerido' });

      // Support for optional variant association
      let idVariante = req.body.id_variante_producto ? parseInt(req.body.id_variante_producto, 10) : null;
      if (idVariante && isNaN(idVariante)) idVariante = null;

      const url = publicUrl(req.file);

      await client.query('BEGIN');

      // ¿ya hay principal? (Global per product OR per variant? Let's keep "principal" per product for now, or complicated)
      // Implementation: If I upload for a variant, does it become principal of the product? Maybe not automatically.
      // Logic: LIMIT 1 scope.
      const { rows: rp } = await client.query(
        `SELECT 1 FROM public.imagen_producto WHERE id_producto = $1 AND es_principal = true AND activo = true LIMIT 1`,
        [idProd]
      );
      const esPrincipal = rp.length === 0;

      const { rows } = await client.query(
        `INSERT INTO public.imagen_producto (id_producto, id_variante_producto, url, es_principal, activo)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id_imagen_producto, id_producto, id_variante_producto, url, es_principal, activo`,
        [idProd, idVariante, url, esPrincipal]
      );


      await client.query('COMMIT');
      res.status(201).json({ message: 'Imagen subida', image: rows[0] });
    } catch (err) {
      try { await pool.query('ROLLBACK'); } catch {}
      next(err);
    } finally { client.release(); }
  }
);

/**
 * GET /api/products/:id/images
 * Roles: admin, manager, vendedor, viewer (lectura)
 */
router.get('/products/:id/images',
  async (req, res, next) => {
    try {
      const idProd = parseInt(req.params.id, 10);
      if (!Number.isInteger(idProd) || idProd <= 0) return res.status(400).json({ message: 'id inválido' });

      // Return all images for the product, including those assigned to variants
      const { rows } = await pool.query(
        `SELECT id_imagen_producto, id_producto, id_variante_producto, url, es_principal, activo
           FROM public.imagen_producto
          WHERE id_producto = $1 AND activo = true
          ORDER BY es_principal DESC, id_variante_producto NULLS FIRST, id_imagen_producto`,
        [idProd]
      );
      res.json({ data: rows });
    } catch (err) { next(err); }
  }
);

/**
 * PATCH /api/products/:id/images/:imgId/principal
 * Establece imagen principal (pone las demás en false).
 * Roles: admin, manager
 */
router.patch('/products/:id/images/:imgId/principal',
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const idProd = parseInt(req.params.id, 10);
      const idImg  = parseInt(req.params.imgId, 10);
      if (!idProd || !idImg) return res.status(400).json({ message: 'ids inválidos' });

      await client.query('BEGIN');

      // valida que la imagen pertenezca al producto
      const { rows: chk } = await client.query(
        `SELECT id_imagen_producto FROM public.imagen_producto WHERE id_imagen_producto=$1 AND id_producto=$2 AND activo=true`,
        [idImg, idProd]
      );
      if (!chk.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Imagen no encontrada/activa' }); }

      await client.query(
        `UPDATE public.imagen_producto SET es_principal=false WHERE id_producto=$1`,
        [idProd]
      );
      await client.query(
        `UPDATE public.imagen_producto SET es_principal=true WHERE id_imagen_producto=$1`,
        [idImg]
      );

      await client.query('COMMIT');
      res.json({ message: 'Imagen establecida como principal' });
    } catch (err) {
      try { await pool.query('ROLLBACK'); } catch {}
      next(err);
    } finally { client.release(); }
  }
);

/**
 * DELETE /api/products/:id/images/:imgId
 * Baja lógica (activo=false). Opcional: borrar archivo físico.
 * Roles: admin, manager
 */
router.delete('/products/:id/images/:imgId',
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const idProd = parseInt(req.params.id, 10);
      const idImg  = parseInt(req.params.imgId, 10);
      if (!idProd || !idImg) return res.status(400).json({ message: 'ids inválidos' });

      await client.query('BEGIN');

      const { rows } = await client.query(
        `DELETE FROM public.imagen_producto
          WHERE id_imagen_producto=$1 AND id_producto=$2
          RETURNING url`,
        [idImg, idProd]
      );
      if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Imagen no encontrada' }); }

      await client.query('COMMIT');

      // Borrar de Cloudinary:
      try {
        const url = rows[0].url;
        // Extraer public_id: "banano_products/p72_..."
        const parts = url.split('/');
        const filenameWithExtension = parts.pop(); // "p72_...jpg"
        const folder = parts.pop(); // "banano_products"
        const publicId = `${folder}/${filenameWithExtension.split('.')[0]}`;
        
        await cloudinary.uploader.destroy(publicId);
      } catch (e) {
        console.error("Error deleting from Cloudinary", e);
      }

      res.json({ message: 'Imagen eliminada permanentemente' });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      next(err);
    } finally { client.release(); }
  }
);

module.exports = router;
