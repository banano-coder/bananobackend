function notFound(_req, res, _next) {
  res.status(404).json({ status: 'error', message: 'Ruta no encontrada' });
}

function errorHandler(err, _req, res, _next) {
  console.error('💥 Error:', err);
  const status = err.statusCode || 500;
  res.status(status).json({
    status: 'error',
    message: err.message || 'Error interno del servidor',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
}

module.exports = { notFound, errorHandler };
