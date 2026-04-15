const express = require('express');
const router = express.Router();
const db = require('../db');
const checkJwt = require('../middleware/auth');

// All cart routes require authentication
router.use(checkJwt);

// GET user cart
router.get('/', async (req, res) => {
  const auth0Id = req.auth.sub; // From JWT
  try {
    const [rows] = await db.query(`
      SELECT c.*, p.title, p.sp as price, p.image1 as image_url 
      FROM cart c
      JOIN users u ON c.user_id = u.id
      JOIN products p ON c.product_id = p.product_id
      WHERE u.auth0_id = ?
    `, [auth0Id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST update cart (add or set quantity)
router.post('/', async (req, res) => {
  const auth0Id = req.auth.sub;
  const { product_id, quantity } = req.body;

  try {
    // 1. Get User ID from Auth0 ID
    const [users] = await db.query('SELECT id FROM users WHERE auth0_id = ?', [auth0Id]);
    if (users.length === 0) return res.status(404).json({ message: 'User not found in DB' });
    const userId = users[0].id;

    // 2. Check if product exists in cart
    const [existing] = await db.query('SELECT * FROM cart WHERE user_id = ? AND product_id = ?', [userId, product_id]);

    if (existing.length > 0) {
      if (quantity === 0) {
        await db.query('DELETE FROM cart WHERE id = ?', [existing[0].id]);
      } else {
        // Here we can either set or increment. Let's design it to INCREMENT if not specified or SET if quantity is passed directly.
        // For simplicity with frontend, let's treat the incoming quantity as the NEW quantity or a delta?
        // Your script.js sends 1 for "add" and delta for "change".
        // Let's make it increment by default or adjust based on logic.
        const newQty = existing[0].quantity + (req.body.isSet ? 0 : quantity); 
        await db.query('UPDATE cart SET quantity = ? WHERE id = ?', [quantity, existing[0].id]);
      }
    } else if (quantity > 0) {
      await db.query('INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)', [userId, product_id, quantity]);
    }

    res.json({ message: 'Cart updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
