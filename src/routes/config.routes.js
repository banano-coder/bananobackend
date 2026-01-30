const { Router } = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middlewares/requireAuth');

const router = Router();

/**
 * 1) GET /api/settings
 * Devuelve todas las configuraciones de la tabla public.configuracion
 */
router.get('/settings', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT clave, valor FROM public.configuracion');
        // Convertimos a un objeto { clave: valor } para facilidad del front
        const config = {};
        rows.forEach(r => { config[r.clave] = r.valor; });
        res.json(config);
    } catch (err) { next(err); }
});

/**
 * GET /api/public/settings
 * Devuelve configuraciones públicas (tienda, catalogo, whatsapp) sin necesidad de auth.
 */
router.get('/public/settings', async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            "SELECT clave, valor FROM public.configuracion WHERE clave IN ('tienda', 'catalogo', 'whatsapp')"
        );
        const config = {};
        rows.forEach(r => { config[r.clave] = r.valor; });
        res.json(config);
    } catch (err) { next(err); }
});

/**
 * 2) PATCH /api/settings
 * Body: { clave, valor }
 */
router.patch('/settings', requireAuth, async (req, res, next) => {
    try {
        const { clave, valor } = req.body || {};

        if (!clave || valor === undefined) {
            return res.status(400).json({ message: 'clave y valor son requeridos' });
        }

        // Aseguramos que el valor se guarde como JSON válido
        const valorString = typeof valor === 'string' ? valor : JSON.stringify(valor);

        const { rows, rowCount } = await pool.query(
            `INSERT INTO public.configuracion (clave, valor) 
             VALUES ($1, $2::jsonb)
             ON CONFLICT (clave) 
             DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()
             RETURNING *`,
            [clave, valorString]
        );

        res.json({
            message: `Configuración '${clave}' actualizada`,
            data: rows[0]
        });
    } catch (err) {
        next(err);
    }
});

/**
 * 3) GET /api/profile
 * Datos del usuario logueado
 */
router.get('/profile', requireAuth, async (req, res, next) => {
    try {
        const userId = req.user.id || req.user.sub;
        const { rows } = await pool.query(
            'SELECT id_usuario, nombre, email, activo FROM public.usuario WHERE id_usuario = $1',
            [userId]
        );
        if (!rows.length) return res.status(404).json({ message: 'Usuario no encontrado' });
        res.json(rows[0]);
    } catch (err) { next(err); }
});

/**
 * 4) PATCH /api/profile
 * Actualizar nombre/email
 */
router.patch('/profile', requireAuth, async (req, res, next) => {
    try {
        const userId = req.user.id || req.user.sub;
        const { nombre, email } = req.body || {};
        if (!nombre && !email) return res.status(400).json({ message: 'Nombre o email requeridos' });

        const fields = [];
        const params = [];
        let i = 1;

        if (nombre) { fields.push(`nombre = $${i++}`); params.push(nombre); }
        if (email) { fields.push(`email = $${i++}`); params.push(email.toLowerCase().trim()); }
        params.push(userId);

        const { rowCount } = await pool.query(
            `UPDATE public.usuario SET ${fields.join(', ')} WHERE id_usuario = $${i}`,
            params
        );

        if (!rowCount) return res.status(404).json({ message: 'Usuario no encontrado' });

        // AUDITORIA
        await pool.query(
            `INSERT INTO public.auditoria (actor_id, target_usuario_id, target_tipo, action, payload, created_at)
             VALUES ($1, $1, 'usuario', 'USUARIO_UPDATE_PERFIL', $2::jsonb, NOW())`,
            [userId, JSON.stringify({ nombre, email })]
        );

        res.json({ message: 'Perfil actualizado' });
    } catch (err) { next(err); }
});

/**
 * 5) PATCH /api/profile/password
 */
router.patch('/profile/password', requireAuth, async (req, res, next) => {
    try {
        const userId = req.user.id || req.user.sub;
        const { currentPassword, newPassword } = req.body || {};

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Ambas contraseñas son requeridas' });
        }

        // 1. Obtener pass actual
        const { rows } = await pool.query('SELECT password FROM public.usuario WHERE id_usuario = $1', [userId]);
        if (!rows.length) return res.status(404).json({ message: 'Usuario no encontrado' });

        // 2. Verificar actual
        const valid = await bcrypt.compare(currentPassword, rows[0].password);
        if (!valid) return res.status(401).json({ message: 'Contraseña actual incorrecta' });

        // 3. Hashear y guardar nueva
        const hashed = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE public.usuario SET password = $1 WHERE id_usuario = $2', [hashed, userId]);

        // 4. AUDITORIA
        await pool.query(
            `INSERT INTO public.auditoria (actor_id, target_usuario_id, target_tipo, action, payload, created_at)
             VALUES ($1, $1, 'usuario', 'USUARIO_UPDATE_PASSWORD', $2::jsonb, NOW())`,
            [userId, JSON.stringify({ changed_at: new Date() })]
        );

        res.json({ message: 'Contraseña actualizada exitosamente' });
    } catch (err) { next(err); }
});

module.exports = router;
