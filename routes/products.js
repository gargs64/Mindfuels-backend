const express = require('express');
const router = express.Router();
const db = require('../db');

let cachedProducts = null;
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// GET all products
router.get('/', async (req, res) => {
  try {
    const now = Date.now();
    // Check if we have valid cached products
    if (cachedProducts && (now - lastFetchTime < CACHE_DURATION)) {
      return res.json(cachedProducts);
    }

    const [rows] = await db.query('SELECT * FROM products');
    const products = rows.map(p => {
      const tags = [p.tag1, p.tag2, p.tag3].filter(t => t);
      return {
        id: p.product_id,
        name: p.title,
        price: parseFloat(p.sp),
        originalPrice: parseFloat(p.mrp),
        description: p.description || '',
        stock: p.stock_qty,
        tags: tags,
        images: [p.image1, p.image2, p.image3, p.image4, p.image5, p.image6, p.image7].filter(img => img),
        sales: p.sales || 100,
        length: p.length || '',
        subject: p.tag1 || '',
        interest: p.tag2 || '',
        ageGroup: p.tag3 || '',
        // Build searchTags: combine all searchable text for frontend filtering
        searchTags: [p.title, p.description, p.tag1, p.tag2, p.tag3].filter(Boolean).join(' ').toLowerCase()
      };
    });

    // Update cache
    cachedProducts = products;
    lastFetchTime = now;

    // Send response with caching headers
    res.set('Cache-Control', 'public, max-age=300'); // Cache in browser for 5 mins
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single product
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products WHERE product_id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Product not found' });

    const p = rows[0];
    res.json({
      id: p.product_id,
      name: p.title,
      price: parseFloat(p.sp),
      originalPrice: parseFloat(p.mrp),
      description: p.description || '',
      stock: p.stock_qty,
      images: [p.image1, p.image2, p.image3, p.image4, p.image5, p.image6, p.image7].filter(img => img),
      subject: p.tag1 || '',
      interest: p.tag2 || '',
      ageGroup: p.tag3 || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST sync products (called by Google Apps Script or external services)
router.post('/sync', async (req, res) => {
  try {
    const secret = req.headers['x-secret'];
    if (secret !== 'mindfuelssecretkey') {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { products } = req.body;
    if (!products || !Array.isArray(products)) {
      return res.status(400).json({ error: 'Invalid payload. Expected { products: [...] }' });
    }

    let successCount = 0;
    let failureCount = 0;
    const errors = [];

    for (const p of products) {
      if (!p.product_id || !p.title) {
        failureCount++;
        errors.push(`Missing required fields for product: ${JSON.stringify(p)}`);
        continue;
      }

      try {
        await db.query(`
          INSERT INTO products (
            product_id, title, sp, mrp, description, stock_qty, 
            tag1, tag2, tag3, image1, image2, image3, image4, image5, image6, image7, 
            sales, length
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            title = VALUES(title),
            sp = VALUES(sp),
            mrp = VALUES(mrp),
            description = VALUES(description),
            stock_qty = VALUES(stock_qty),
            tag1 = VALUES(tag1),
            tag2 = VALUES(tag2),
            tag3 = VALUES(tag3),
            image1 = VALUES(image1),
            image2 = VALUES(image2),
            image3 = VALUES(image3),
            image4 = VALUES(image4),
            image5 = VALUES(image5),
            image6 = VALUES(image6),
            image7 = VALUES(image7),
            sales = VALUES(sales),
            length = VALUES(length)
        `, [
          p.product_id, p.title, p.sp || 0, p.mrp || 0, p.description || '', p.stock_qty || 0,
          p.tag1 || '', p.tag2 || '', p.tag3 || '',
          p.image1 || '', p.image2 || '', p.image3 || '', p.image4 || '', p.image5 || '', p.image6 || '', p.image7 || '',
          p.sales || 100, p.length || ''
        ]);
        successCount++;
      } catch (dbErr) {
        failureCount++;
        errors.push(`Failed to insert/update ${p.product_id}: ${dbErr.message}`);
      }
    }

    // Clear cache since products have changed
    cachedProducts = null;
    lastFetchTime = 0;

    res.json({
      message: 'Sync complete',
      successCount,
      failureCount,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
