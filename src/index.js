const app = require('./app');
const env = require('./config/env');
const { pool } = require('./db/pool');



const server = app.listen(env.PORT, () => {
  console.log(`🚀 API lista en http://localhost:${env.PORT}`);
});

// Apagado elegante
async function shutdown(signal) {
  console.log(`\n${signal} recibido. Cerrando servidor...`);
  server.close(async () => {
    try {
      await pool.end();
      console.log('🟢 Pool Postgres cerrado.');
      process.exit(0);
    } catch (err) {
      console.error('❌ Error cerrando pool:', err);
      process.exit(1);
    }
  });
}


process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));


app.use((err, req, res, next) => {
  // Imprime el error completo en la consola del backend
  console.error(err.stack); 
  
  // Envía una respuesta genérica de error 500 al cliente
  res.status(500).json({ 
    message: 'Algo salió mal en el servidor.',
    error: err.message // Opcional: envía el mensaje de error
  });
})