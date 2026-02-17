const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// LIST
router.get('/brands', requireAuth, requireRole('admin', 'manager', 'vendedor', 'viewer'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT id_marca, nombre, activo FROM public.marca WHERE eliminado = false ORDER BY nombre`);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// CREATE
router.post('/brands', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { nombre, activo = true } = req.body || {};
    if (!nombre) return res.status(400).json({ message: 'nombre requerido' });

    await client.query('BEGIN');

    const { rows } = await client.query(`
      INSERT INTO public.marca (nombre, activo)
      VALUES ($1,$2)
      RETURNING id_marca, nombre, activo
    `, [nombre, Boolean(activo)]);

    await client.query(`
      INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
      VALUES ($1, 'marca', 'BRAND_CREATE', $2::jsonb, NOW())
    `, [req.user.id || req.user.sub, JSON.stringify({ id_marca: rows[0].id_marca, nombre })]);

    await client.query('COMMIT');
    res.status(201).json({ message: 'Marca creada', brand: rows[0] });
  } catch (err) { try { await client.query('ROLLBACK') } catch { }; next(err); }
  finally { client.release(); }
});

// UPDATE
router.patch('/brands/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    const { nombre, activo } = req.body || {};
    if (!id) return res.status(400).json({ message: 'id inválido' });

    await client.query('BEGIN');

    const { rowCount, rows } = await client.query(`
      UPDATE public.marca
      SET nombre = COALESCE($2, nombre),
          activo = COALESCE($3, activo)
      WHERE id_marca = $1
      RETURNING id_marca, nombre, activo
    `, [id, nombre ?? null, (activo === undefined) ? undefined : Boolean(activo)]);
    if (!rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'No encontrada' }); }

    await client.query(`
      INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
      VALUES ($1, 'marca', 'BRAND_UPDATE', $2::jsonb, NOW())
    `, [req.user.id || req.user.sub, JSON.stringify({ id_marca: id, changes: (req.body || {}) })]);

    await client.query('COMMIT');
    res.json({ message: 'Actualizada', brand: rows[0] });
  } catch (err) { try { await client.query('ROLLBACK') } catch { }; next(err); }
  finally { client.release(); }
});

// DELETE lógico con validación
router.delete('/brands/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'id inválido' });

    await client.query('BEGIN');

    const { rows: brandRows } = await client.query(`SELECT nombre FROM public.marca WHERE id_marca = $1`, [id]);
    const brandName = brandRows[0]?.nombre || 'Desconocida';

    const { rowCount } = await client.query(`UPDATE public.marca SET activo=false, eliminado=true WHERE id_marca=$1 AND eliminado=false`, [id]);
    if (!rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'No encontrada o ya eliminada' }); }

    await client.query(`
      INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
      VALUES ($1, 'marca', 'BRAND_SOFT_DELETE', $2::jsonb, NOW())
    `, [req.user.id || req.user.sub, JSON.stringify({ id_marca: id, nombre: brandName })]);

    await client.query('COMMIT');
    res.json({ message: 'Marca desactivada' });
  } catch (err) { try { await client.query('ROLLBACK') } catch { }; next(err); }
  finally { client.release(); }
});

module.exports = router;
