const { Router } = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');
const env = require('../config/env');

const router = Router();

/**
 * POST /api/auth/login
 * Body: { email: string, password: string }
 */
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: 'email y password son requeridos' });
    }

    // Buscar usuario
    const { rows } = await pool.query(
      `SELECT id_usuario, nombre, email, password, activo
       FROM public.usuario
       WHERE email = $1 AND eliminado = false
       LIMIT 1`,
      [email]
    );
    //console.log(rows.length)
    if (rows.length <= 0) {
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }

    const user = rows[0];
    if (user.activo === false) {
      return res.status(403).json({ message: 'Usuario inactivo' });
    }

    // Verificar contraseña
    const ok = await bcrypt.compare(password, user.password || '');
    console.log(ok)
    if (!ok) {
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }

    // Roles del usuario
    const { rows: roleRows } = await pool.query(
      `SELECT r.nombre
         FROM public.usuario_rol ur
         JOIN public.rol r ON r.id_rol = ur.id_rol
        WHERE ur.id_usuario = $1`,
      [user.id_usuario]
    );
    const roles = roleRows.map(r => r.nombre);

    // Bloquear acceso a usuarios con rol solo viewer
    const soloViewer = roles.length > 0 && roles.every(r => r === 'viewer');
    if (soloViewer) {
      return res.status(403).json({ message: 'Rol sin acceso (viewer)' });
    }

    // Generar token
    const token = jwt.sign(
      { id: user.id_usuario, email: user.email, roles },
      env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.json({
      message: 'Login exitoso',
      token,
      user: {
        id_usuario: user.id_usuario, nombre: user.nombre, email: user.email, roles
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 * Header: Authorization: Bearer <token>
 */
router.get('/me', (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ message: 'Token requerido' });

    const payload = jwt.verify(token, env.JWT_SECRET);
    res.json({ auth: true, payload });
  } catch {
    res.status(401).json({ message: 'Token inválido o expirado' });
  }
});

module.exports = router;
