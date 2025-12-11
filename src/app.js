const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const healthRoutes = require('./routes/health.routes');
const productsRoutes = require('./routes/products.routes');
const authRoutes = require('./routes/auth.routes');
const signupRoutes = require('./routes/signup.routes');
const usersRoutes = require('./routes/users.routes');
const catalogRoutes = require('./routes/catalog.routes');
const pedidosRoutes = require('./routes/pedidos.routes');
const { notFound, errorHandler } = require('./middlewares/error.middleware');

const app = express();

// Middlewares base
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Rutas
app.use('/api', healthRoutes);
app.use('/api', productsRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/auth', signupRoutes);
app.use('/api', usersRoutes);
app.use('/api', catalogRoutes);
app.use('/api', pedidosRoutes)

// 404 & errores
app.use(notFound);
app.use(errorHandler);

module.exports = app;
