const express = require('express');
const router = express.Router();
const db = require('../db');

// GET all products
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products');
    const products = rows.map(p => ({
      id: p.product_id,
      name: p.title,
      price: parseFloat(p.sp),
      originalPrice: parseFloat(p.mrp),
      description: p.description,
      stock: p.stock_qty,
      tags: [p.tag1, p.tag2, p.tag3].filter(t => t),
      images: [p.image1, p.image2, p.image3, p.image4, p.image5, p.image6, p.image7].filter(img => img),
      // Set some defaults for fields not in the table yet but used in UI
      rating: p.rating || 4.5,
      sales: p.sales || 100,
      subject: p.tag1,
      interest: p.tag2,
      ageGroup: p.tag3
    }));
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single product
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Product not found' });
    
    const p = rows[0];
    if (typeof p.images === 'string') {
      try { p.images = JSON.parse(p.images); } catch(e) { p.images = [p.images]; }
    }
    res.json(p);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
