const express = require('express');
const router = express.Router();
const db = require('../db');
const checkJwt = require('../middleware/auth');

// All cart routes require authentication
router.use(checkJwt);

// GET user cart
router.get('/', async (req, res) => {
  const auth0Id = req.auth.sub;
  try {
    const [rows] = await db.query(`
      SELECT c.product_id, c.quantity, p.title, p.sp as price, p.image1 as image_url 
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

// POST — set absolute quantity for a product (qty=0 means delete)
router.post('/', async (req, res) => {
  const auth0Id = req.auth.sub;
  const { product_id, quantity } = req.body;

  try {
    const [users] = await db.query('SELECT id FROM users WHERE auth0_id = ?', [auth0Id]);
    if (users.length === 0) return res.status(404).json({ message: 'User not found in DB' });
    const userId = users[0].id;

    const [existing] = await db.query(
      'SELECT * FROM cart WHERE user_id = ? AND product_id = ?', [userId, product_id]
    );

    if (existing.length > 0) {
      if (quantity <= 0) {
        await db.query('DELETE FROM cart WHERE id = ?', [existing[0].id]);
      } else {
        await db.query('UPDATE cart SET quantity = ? WHERE id = ?', [quantity, existing[0].id]);
      }
    } else if (quantity > 0) {
      await db.query(
        'INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)',
        [userId, product_id, quantity]
      );
    }

    res.json({ message: 'Cart updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE — remove item from cart
router.delete('/:productId', async (req, res) => {
  const auth0Id = req.auth.sub;
  const productId = req.params.productId;

  try {
    const [users] = await db.query('SELECT id FROM users WHERE auth0_id = ?', [auth0Id]);
    if (users.length === 0) return res.status(404).json({ message: 'User not found' });

    await db.query(
      'DELETE FROM cart WHERE user_id = ? AND product_id = ?',
      [users[0].id, productId]
    );
    res.json({ message: 'Item removed from cart' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
