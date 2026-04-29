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

    console.log(`[Wishlist] Add attempt - User: ${auth0Id}, Product: ${product_id}`);

    try {
        const [users] = await db.query('SELECT id FROM users WHERE auth0_id = ?', [auth0Id]);
        if (users.length === 0) {
            console.error(`[Wishlist] User not found for Auth0 ID: ${auth0Id}`);
            return res.status(404).json({ message: 'User not found in database' });
        }
        const userId = users[0].id;

        // Using added_at as seen in the database screenshot
        await db.query(
            'INSERT INTO wishlist (user_id, product_id, added_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE added_at = CURRENT_TIMESTAMP',
            [userId, product_id]
        );

        console.log(`[Wishlist] Successfully added ${product_id} for user ${userId}`);
        res.json({ message: 'Added to wishlist' });
    } catch (err) {
        console.error('[Wishlist] Database error:', err);
        res.status(500).json({ error: 'Database error', details: err.message });
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
