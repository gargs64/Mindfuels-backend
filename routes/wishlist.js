const express = require('express');
const router = express.Router();
const db = require('../db');

// Add to wishlist
router.post('/', async (req, res) => {
    const { user_id, product_id } = req.body;
    try {
        await db.query(
            'INSERT INTO wishlist (user_id, product_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE created_at = CURRENT_TIMESTAMP',
            [user_id, product_id]
        );
        res.json({ message: 'Added to wishlist' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Remove from wishlist
router.delete('/:user_id/:product_id', async (req, res) => {
    const { user_id, product_id } = req.params;
    try {
        await db.query('DELETE FROM wishlist WHERE user_id = ? AND product_id = ?', [user_id, product_id]);
        res.json({ message: 'Removed from wishlist' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get user wishlist
router.get('/:user_id', async (req, res) => {
    const { user_id } = req.params;
    try {
        const [rows] = await db.query('SELECT product_id FROM wishlist WHERE user_id = ?', [user_id]);
        res.json(rows.map(row => row.product_id));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

module.exports = router;
