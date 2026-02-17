const jwt = require('jsonwebtoken');
const env = require('../config/env');

function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ message: 'Token requerido' });

    const payload = jwt.verify(token, env.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ message: 'Token inválido o expirado' });
  }
}

function requireRole(...allowed) {
  return (req, res, next) => {
    const roles = req.user?.roles || [];
    if (!roles.length) return res.status(401).json({ message: 'No autenticado' });
    if (!roles.some(r => allowed.includes(r))) {
      return res.status(403).json({
        message: `Acceso denegado. Esta acción solo está permitida para usuarios con rol: ${allowed.join(', ')}`
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
