// src/routes/signup.routes.js
const { Router } = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db/pool');

const router = Router();

/**
 * POST /api/auth/signup
 * Body: { nombre, email, password }
 * - Si NO existe todavía ningún admin -> este primer usuario queda como 'admin'
 * - Si YA existe admin -> el nuevo usuario queda como 'viewer'
 */
router.post('/signup', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { nombre, email, password } = req.body || {};
    if (!nombre || !email || !password) {
      return res.status(400).json({ message: 'nombre, email y password son requeridos' });
    }

    // Normaliza email en minúsculas
    const emailNorm = String(email).trim().toLowerCase();

    await client.query('BEGIN');

    // Bloqueo fuerte: garantiza que dos signups concurrentes NO creen dos admins
    // (elige un número fijo para tu app; 42 es un ejemplo)
    await client.query('SELECT pg_advisory_lock(42)');

    // 1) Verifica email único dentro de la misma transacción
    const { rows: exists } = await client.query(
      `SELECT 1 FROM public.usuario WHERE email = $1 LIMIT 1`,
      [emailNorm]
    );
    if (exists.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'El email ya está registrado' });
    }

    // 2) Crea el usuario
    const hashed = await bcrypt.hash(String(password), 10);

    const { rows: userRows } = await client.query(
      `INSERT INTO public.usuario (nombre, email, password, activo)
       VALUES ($1, $2, $3, true)
       RETURNING id_usuario, nombre, email, activo`,
      [nombre, emailNorm, hashed]
    );
    const user = userRows[0];

    // 3) ¿Existe ya algún admin?
    const { rows: admins } = await client.query(`
      SELECT 1
      FROM public.usuario_rol ur
      JOIN public.rol r ON r.id_rol = ur.id_rol
      WHERE r.nombre = 'admin'
      LIMIT 1
    `);

    const rolInicial = admins.length === 0 ? 'admin' : 'viewer';

    // 4) Asigna rol inicial (admin si es el primero; viewer en lo demás)
    await client.query(
      `INSERT INTO public.usuario_rol (id_usuario, id_rol)
       SELECT $1, r.id_rol FROM public.rol r WHERE r.nombre = $2
       ON CONFLICT DO NOTHING`,
      [user.id_usuario, rolInicial]
    );


/** 🔎 AUDITORÍA DEL SIGNUP*/
await client.query(
  `INSERT INTO public.auditoria (actor_id, action, target_tipo, payload)
   VALUES ($1, $2, $3, $4::jsonb)`,
  [
    user.id_usuario,
    'CREATE_USER_SIGNUP',
    'usuario', // o 'auth_user' si tienes varios tipos de entidades
    JSON.stringify({ rol: rolInicial, email: emailNorm })
  ]
);


    // 5) Obtén los roles para responder
    const { rows: roleRows } = await client.query(
      `SELECT r.nombre
         FROM public.usuario_rol ur
         JOIN public.rol r ON r.id_rol = ur.id_rol
        WHERE ur.id_usuario = $1`,
      [user.id_usuario]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Usuario registrado exitosamente',
      user: { ...user, roles: roleRows.map(r => r.nombre) }
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    // Libera el advisory lock si lo tomaste (no falla si no estaba tomado)
    await client.query('SELECT pg_advisory_unlock(42)').catch(() => {});
    client.release();
  }
});

module.exports = router;
