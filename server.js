const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware — CORS whitelist
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5500,http://127.0.0.1:5500').split(',');

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json());

// Routes
const productRoutes = require('./routes/products');
const cartRoutes = require('./routes/cart');
const wishlistRoutes = require('./routes/wishlist');
const userRoutes = require('./routes/users');
const orderRoutes = require('./routes/orders');
const paymentRoutes = require('./routes/payments');

app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/users', userRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Mindfuels Backend is running' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Add with other requires at top
const shipmentRoutes = require('./routes/shipments');

// Add with other app.use lines
app.use('/api/shipments', shipmentRoutes);