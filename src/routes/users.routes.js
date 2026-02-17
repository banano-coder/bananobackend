const { Router } = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

async function countActiveAdmins(client = pool) {
  const { rows } = await client.query(`
    SELECT COUNT(*)::int AS total
    FROM public.usuario u
    JOIN public.usuario_rol ur ON ur.id_usuario = u.id_usuario
    JOIN public.rol r ON r.id_rol = ur.id_rol
    WHERE r.nombre = 'admin' AND u.activo = true
  `);
  return rows[0].total;
}
async function getUserRoles(userId, client = pool) {
  const { rows } = await client.query(`
    SELECT r.nombre
    FROM public.usuario_rol ur
    JOIN public.rol r ON r.id_rol = ur.id_rol
    WHERE ur.id_usuario = $1
  `, [userId]);
  return rows.map(r => r.nombre);
}

/** 1) CREATE: POST /api/users  (solo admin)
 * Body: { nombre, email, password, rol? }  // si no envían rol -> viewer
 */
router.post('/users', requireAuth, requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { nombre, email, password, rol } = req.body || {};
    if (!nombre || !email || !password) {
      return res.status(400).json({ message: 'nombre, email y password son requeridos' });
    }
    const emailNorm = String(email).trim().toLowerCase();

    await client.query('BEGIN');

    const { rows: exists } = await client.query(
      `SELECT 1 FROM public.usuario WHERE email = $1 LIMIT 1`,
      [emailNorm]
    );
    if (exists.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'El email ya está registrado' });
    }

    const hashed = await bcrypt.hash(String(password), 10);
    const { rows: userRows } = await client.query(
      `INSERT INTO public.usuario (nombre, email, password, activo)
       VALUES ($1, $2, $3, true)
       RETURNING id_usuario, nombre, email, activo`,
      [nombre, emailNorm, hashed]
    );
    const user = userRows[0];

    const rolAsignar = rol ? String(rol) : 'viewer';

    await client.query(
      `INSERT INTO public.usuario_rol (id_usuario, id_rol)
       SELECT $1, id_rol FROM public.rol WHERE nombre = $2`,
      [user.id_usuario, rolAsignar]
    );

    // auditoría 
    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_usuario_id, target_tipo, action, payload)
       VALUES ($1, $2, 'usuario', 'CREATE_USER', $3::jsonb)`,
      [req.user.id || req.user.sub, user.id_usuario, JSON.stringify({ rol: rolAsignar })]
    );

    await client.query('COMMIT');

    res.status(201).json({ message: 'Usuario creado', user: { ...user, roles: [rolAsignar] } });
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => { });
    next(err);
  } finally {
    // eslint-disable-next-line no-unsafe-finally
    client.release();
  }
});


/** 2) LIST: GET /api/users?search=&page=&limit=&sort=&dir=  (solo admin) */
router.get('/users', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const search = (req.query.search || '').toString().trim();
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const allowedSort = new Set(['created_at', 'nombre', 'email', 'activo', 'id_usuario']);
    const sort = allowedSort.has(req.query.sort) ? req.query.sort : 'id_usuario';
    const dir = (req.query.dir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

    const { rows: totalRows } = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM public.usuario u
      WHERE u.eliminado = false
        AND ($1 = '' OR u.nombre ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%')
    `, [search]);
    const total = totalRows[0].total;

    const { rows: data } = await pool.query(`
      SELECT u.id_usuario, u.nombre, u.email, u.activo,
             COALESCE(json_agg(r.nombre) FILTER (WHERE r.nombre IS NOT NULL), '[]') AS roles
      FROM public.usuario u
      LEFT JOIN public.usuario_rol ur ON ur.id_usuario = u.id_usuario
      LEFT JOIN public.rol r ON r.id_rol = ur.id_rol
      WHERE u.eliminado = false
        AND ($1 = '' OR u.nombre ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%')
      GROUP BY u.id_usuario
      ORDER BY ${sort} ${dir}
      LIMIT $2 OFFSET $3
    `, [search, limit, offset]);

    res.json({ data, page, limit, total });
  } catch (err) { next(err); }
});

/** 3) ROLES: PATCH /api/users/:id/roles (solo admin)
 * Body: { roles: ["manager"] }  // usa un selector simple y envía UNA opción
 */
router.patch('/users/:id/roles', requireAuth, requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const targetId = parseInt(req.params.id, 10);
    const roles = req.body?.roles;

    if (!Array.isArray(roles) || roles.length === 0) {
      return res.status(400).json({ message: 'roles debe ser un arreglo no vacío' });
    }
    // recomendamos que mandes SOLO 1 rol desde el selector; este endpoint igual soporta varios

    await client.query('BEGIN');

    const { rows: validRows } = await client.query(`SELECT nombre FROM public.rol`);
    const validSet = new Set(validRows.map(r => r.nombre));
    const invalid = roles.filter(r => !validSet.has(r));
    if (invalid.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Roles inválidos: ${invalid.join(', ')}` });
    }

    const prevRoles = await getUserRoles(targetId, client);

    const isRemovingAdmin = prevRoles.includes('admin') && !roles.includes('admin');
    if (isRemovingAdmin) {
      const admins = await countActiveAdmins(client);
      if (admins <= 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'No puedes quitar el último admin activo del sistema' });
      }
    }

    await client.query(`DELETE FROM public.usuario_rol WHERE id_usuario = $1`, [targetId]);
    await client.query(
      `INSERT INTO public.usuario_rol (id_usuario, id_rol)
       SELECT $1, r.id_rol FROM public.rol r WHERE r.nombre = ANY($2::text[])`,
      [targetId, roles]
    );

    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_usuario_id, target_tipo, action, payload)
       VALUES ($1, $2, 'usuario', 'REPLACE_ROLES', $3::jsonb)`,
      [req.user.id || req.user.sub, targetId, JSON.stringify({ roles })]
    );

    await client.query('COMMIT');
    res.json({ message: 'Roles actualizados', roles });
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => { });
    next(err);
  } finally {
    client.release();
  }
});

/** 4) STATUS: PATCH /api/users/:id/status (solo admin)
 * Body: { activo: true|false }
 */
router.patch('/users/:id/status', requireAuth, requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const targetId = parseInt(req.params.id, 10);
    const activo = Boolean(req.body?.activo);

    await client.query('BEGIN');

    if (activo === false) {
      const roles = await getUserRoles(targetId, client);
      const isAdmin = roles.includes('admin');
      if (isAdmin) {
        const admins = await countActiveAdmins(client);
        if (admins <= 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ message: 'No puedes desactivar al último admin activo del sistema' });
        }
      }
    }

    const { rowCount } = await client.query(
      `UPDATE public.usuario SET activo = $2 WHERE id_usuario = $1`,
      [targetId, activo]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_usuario_id, action, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        req.user.id || req.user.sub,
        targetId,
        activo ? 'ENABLE' : 'DISABLE',
        JSON.stringify({ activo })
      ]
    );

    await client.query('COMMIT');
    res.json({ message: 'Estado actualizado', activo });
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => { });
    next(err);
  } finally {
    client.release();
  }
});

/** 5) PASSWORD: PATCH /api/users/:id/password (solo admin)
 * Body: { password: "NuevaClave123!" }
 */
router.patch('/users/:id/password', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const password = String(req.body?.password || '');
    if (!password || password.length < 6) {
      return res.status(400).json({ message: 'password requerido (mín. 6 caracteres)' });
    }

    const hashed = await bcrypt.hash(password, 10);

    const { rowCount } = await pool.query(
      `UPDATE public.usuario SET password = $2 WHERE id_usuario = $1`,
      [targetId, hashed]
    );
    if (!rowCount) return res.status(404).json({ message: 'Usuario no encontrado' });

    await pool.query(
      `INSERT INTO public.auditoria (actor_id, target_usuario_id, action, payload)
       VALUES ($1, $2, 'RESET_PASSWORD', $3::jsonb)`,
      [req.user.id || req.user.sub, targetId, JSON.stringify({ by: 'admin' })]
    );

    res.json({ message: 'Contraseña actualizada por admin' });
  } catch (err) {
    next(err);
  }
});


// 6) DELETE: DELETE /api/users/:id (solo admin)
// Realiza un borrado físico (HARD DELETE)
router.delete('/users/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const targetId = parseInt(req.params.id, 10);
    if (!targetId) return res.status(400).json({ message: 'ID de usuario inválido' });

    await client.query('BEGIN');

    // Protección: no borrar al último admin activo
    const roles = await getUserRoles(targetId, client);
    if (roles.includes('admin')) {
      const admins = await countActiveAdmins(client);
      if (admins <= 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'No puedes eliminar al último admin activo del sistema' });
      }
    }

    // 0. Obtener nombre antes de borrar para auditoría
    const { rows: targetUser } = await client.query(`SELECT nombre FROM public.usuario WHERE id_usuario = $1`, [targetId]);
    const targetName = targetUser[0]?.nombre || 'Desconocido';

    // 1. Eliminar asociaciones de roles
    await client.query(`DELETE FROM public.usuario_rol WHERE id_usuario = $1`, [targetId]);


    /* 
       No limpiamos referencias en auditoría ni pedidos. 
       Al usar SOFT DELETE con columna 'eliminado', el registro de usuario permanece en la BD
       y los JOINs de auditoría/movimientos seguirán funcionando para mostrar el nombre.
    */

    // 4. Borrado lógico (SOFT DELETE con columna eliminado)
    // No nullificamos referencias para que el nombre del actor se preserve en auditoría y movimientos
    const { rowCount } = await client.query(
      `UPDATE public.usuario 
       SET activo = false, 
           eliminado = true
       WHERE id_usuario = $1 AND eliminado = false`,
      [targetId]
    );

    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Usuario no encontrado o ya eliminado' });
    }

    // Auditoría del borrado lógico
    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_usuario_id, target_tipo, action, payload)
       VALUES ($1, $2, 'usuario', 'SOFT_DELETE_USER', $3::jsonb)`,
      [req.user.id || req.user.sub, targetId, JSON.stringify({ deleted_user_id: targetId, deleted_user_nombre: targetName })]
    );

    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;

