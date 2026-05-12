const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');


const healthRoutes = require('./routes/health.routes');
const productsRoutes = require('./routes/products.routes');
const authRoutes = require('./routes/auth.routes');
const signupRoutes = require('./routes/signup.routes');
const usersRoutes = require('./routes/users.routes');
const catalogRoutes = require('./routes/catalog.routes');
const pedidosRoutes = require('./routes/pedidos.routes');
const inventarioRoutes = require('./routes/inventario.routes')
const imagesRoutes = require('./routes/images.routes');
const variantsRoutes = require('./routes/variants.routes');
const categoriesRoutes = require('./routes/categories.routes');
const brandsRoutes = require('./routes/brands.routes');
const reportsRoutes = require('./routes/reports.routes');
const configRoutes = require('./routes/config.routes');
const bulkRoutes = require('./routes/bulk.routes');
const { notFound, errorHandler } = require('./middlewares/error.middleware');

const app = express();

// Middlewares base
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Rutas
app.get('/', (req, res) => {
  res.json({ message: 'Banano API está activa 🚀', version: '1.0.0' });
});
app.use('/api', healthRoutes);
app.use('/api', productsRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/auth', signupRoutes);
app.use('/api', usersRoutes);
app.use('/api', catalogRoutes);
app.use('/api', pedidosRoutes)
app.use('/api', inventarioRoutes);
app.use('/uploads', (req, res, next) => { res.setHeader('Cache-Control', 'public, max-age=31536000'); next(); });
app.use('/uploads', require('express').static(path.join(__dirname, '..', 'uploads')));
app.use('/api', imagesRoutes);
app.use('/api', variantsRoutes);
app.use('/api', brandsRoutes);
app.use('/api', categoriesRoutes);
app.use('/api/', reportsRoutes);
app.use('/api/', configRoutes);
app.use('/api', bulkRoutes);

// 404 & errores
app.use(notFound);
app.use(errorHandler);

module.exports = app;
