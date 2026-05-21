const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// 1. LIST WAREHOUSES
// Accessible by all authenticated roles (admin, manager, vendedor, viewer)
router.get('/almacenes', requireAuth, requireRole('admin', 'manager', 'vendedor', 'viewer'), async (req, res, next) => {
  try {
    const { activo, incluir_eliminados, search } = req.query;

    const conds = [];
    const params = [];
    let i = 1;

    // By default, do not return logically deleted warehouses
    if (incluir_eliminados !== 'true') {
      conds.push('eliminado = false');
    }

    // Optional filter by active status
    if (activo !== undefined) {
      conds.push(`activo = $${i++}`);
      params.push(activo === 'true');
    }

    // Optional filter by search query (name or address)
    if (search && search.trim() !== '') {
      conds.push(`(nombre ILIKE $${i} OR direccion ILIKE $${i})`);
      params.push(`%${search.trim()}%`);
      i++;
    }

    const whereClause = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const query = `
      SELECT id_almacen, nombre, direccion, telefono, activo, created_at, updated_at
      FROM public.almacen
      ${whereClause}
      ORDER BY nombre ASC
    `;

    const { rows } = await pool.query(query, params);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// 2. GET WAREHOUSE BY ID
router.get('/almacenes/:id', requireAuth, requireRole('admin', 'manager', 'vendedor', 'viewer'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'id de almacén inválido' });

    const { rows } = await pool.query(`
      SELECT id_almacen, nombre, direccion, telefono, activo, created_at, updated_at
      FROM public.almacen
      WHERE id_almacen = $1 AND eliminado = false
    `, [id]);

    if (!rows[0]) return res.status(404).json({ message: 'Almacén no encontrado o eliminado' });
    res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// 3. CREATE WAREHOUSE
router.post('/almacenes', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    let { nombre, direccion, telefono, activo } = req.body || {};
    if (typeof nombre !== 'string' || nombre.trim() === '') {
      return res.status(400).json({ message: 'El nombre del almacén es requerido' });
    }

    nombre = nombre.trim();
    direccion = typeof direccion === 'string' ? direccion.trim() : '';
    telefono = typeof telefono === 'string' ? telefono.trim() : '';
    activo = activo !== undefined && activo !== null ? Boolean(activo) : true;

    await client.query('BEGIN');

    const { rows } = await client.query(`
      INSERT INTO public.almacen (nombre, direccion, telefono, activo)
      VALUES ($1, $2, $3, $4)
      RETURNING id_almacen, nombre, direccion, telefono, activo, created_at, updated_at
    `, [nombre, direccion, telefono, activo]);

    const newWarehouse = rows[0];

    // Log to auditoria
    await client.query(`
      INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
      VALUES ($1, 'almacen', 'ALMACEN_CREATE', $2::jsonb, NOW())
    `, [
      req.user.id || req.user.sub,
      JSON.stringify({ id_almacen: newWarehouse.id_almacen, nombre: newWarehouse.nombre })
    ]);

    await client.query('COMMIT');
    res.status(201).json({ message: 'Almacén creado', warehouse: newWarehouse });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Ya existe un almacén con ese nombre' });
    }
    next(err);
  } finally {
    client.release();
  }
});

// 4. UPDATE WAREHOUSE
router.patch('/almacenes/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'id de almacén inválido' });

    let { nombre, direccion, telefono, activo } = req.body || {};

    if (nombre !== undefined && (typeof nombre !== 'string' || nombre.trim() === '')) {
      return res.status(400).json({ message: 'El nombre del almacén no puede estar vacío' });
    }

    await client.query('BEGIN');

    // First check if it exists and isn't deleted
    const { rows: checkRows } = await client.query(
      `SELECT id_almacen FROM public.almacen WHERE id_almacen = $1 AND eliminado = false`,
      [id]
    );
    if (!checkRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Almacén no encontrado' });
    }

    const { rowCount, rows } = await client.query(`
      UPDATE public.almacen
      SET nombre = COALESCE($2, nombre),
          direccion = COALESCE($3, direccion),
          telefono = COALESCE($4, telefono),
          activo = COALESCE($5, activo),
          updated_at = NOW()
      WHERE id_almacen = $1 AND eliminado = false
      RETURNING id_almacen, nombre, direccion, telefono, activo, created_at, updated_at
    `, [
      id,
      typeof nombre === 'string' ? nombre.trim() : null,
      typeof direccion === 'string' ? direccion.trim() : null,
      typeof telefono === 'string' ? telefono.trim() : null,
      activo !== undefined && activo !== null ? Boolean(activo) : null
    ]);

    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Almacén no encontrado' });
    }

    const updatedWarehouse = rows[0];

    // Log to auditoria
    await client.query(`
      INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
      VALUES ($1, 'almacen', 'ALMACEN_UPDATE', $2::jsonb, NOW())
    `, [
      req.user.id || req.user.sub,
      JSON.stringify({ id_almacen: id, changes: req.body || {} })
    ]);

    await client.query('COMMIT');
    res.json({ message: 'Almacén actualizado', warehouse: updatedWarehouse });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Ya existe un almacén con ese nombre' });
    }
    next(err);
  } finally {
    client.release();
  }
});

// 5. LOGICAL DELETE (SOFT DELETE)
router.delete('/almacenes/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'id de almacén inválido' });

    await client.query('BEGIN');

    // Retrieve name before deletion for auditing
    const { rows: checkRows } = await client.query(
      `SELECT nombre FROM public.almacen WHERE id_almacen = $1 AND eliminado = false`,
      [id]
    );
    if (!checkRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Almacén no encontrado o ya eliminado' });
    }
    const warehouseName = checkRows[0].nombre;

    // Logical delete
    const { rowCount } = await client.query(`
      UPDATE public.almacen 
      SET activo = false, 
          eliminado = true,
          updated_at = NOW()
      WHERE id_almacen = $1 AND eliminado = false
    `, [id]);

    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Almacén no encontrado o ya eliminado' });
    }

    // Log to auditoria
    await client.query(`
      INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
      VALUES ($1, 'almacen', 'ALMACEN_SOFT_DELETE', $2::jsonb, NOW())
    `, [
      req.user.id || req.user.sub,
      JSON.stringify({ id_almacen: id, nombre: warehouseName })
    ]);

    await client.query('COMMIT');
    res.json({ message: 'Almacén eliminado (desactivado)' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
