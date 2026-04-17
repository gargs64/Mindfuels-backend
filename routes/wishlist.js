const express = require('express');
const router = express.Router();
const db = require('../db');
const checkJwt = require('../middleware/auth');

// All wishlist routes require authentication
router.use(checkJwt);

// Add to wishlist
router.post('/', async (req, res) => {
    const auth0Id = req.auth.sub;
    const { product_id } = req.body;
    try {
        const [users] = await db.query('SELECT id FROM users WHERE auth0_id = ?', [auth0Id]);
        if (users.length === 0) return res.status(404).json({ message: 'User not found' });
        const userId = users[0].id;

        await db.query(
            'INSERT INTO wishlist (user_id, product_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE product_id = product_id',
            [userId, product_id]
        );
        res.json({ message: 'Added to wishlist' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Remove from wishlist
router.delete('/:productId', async (req, res) => {
    const auth0Id = req.auth.sub;
    const productId = req.params.productId;
    try {
        const [users] = await db.query('SELECT id FROM users WHERE auth0_id = ?', [auth0Id]);
        if (users.length === 0) return res.status(404).json({ message: 'User not found' });
        const userId = users[0].id;

        await db.query('DELETE FROM wishlist WHERE user_id = ? AND product_id = ?', [userId, productId]);
        res.json({ message: 'Removed from wishlist' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get user wishlist
router.get('/', async (req, res) => {
    const auth0Id = req.auth.sub;
    try {
        const [users] = await db.query('SELECT id FROM users WHERE auth0_id = ?', [auth0Id]);
        if (users.length === 0) return res.status(404).json({ message: 'User not found' });
        const userId = users[0].id;

        const [rows] = await db.query('SELECT product_id FROM wishlist WHERE user_id = ?', [userId]);
        res.json(rows.map(row => row.product_id));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

module.exports = router;
