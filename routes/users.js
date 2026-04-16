const express = require('express');
const router = express.Router();
const db = require('../db');
const checkJwt = require('../middleware/auth');

// Sync/Register user (called by frontend on login)
router.post('/sync', checkJwt, async (req, res) => {
  const { name, email, phone, picture } = req.body;
  const auth0Id = req.auth.sub;

  try {
    // Upsert logic
    const [existing] = await db.query('SELECT id FROM users WHERE auth0_id = ?', [auth0Id]);
    
    if (existing.length > 0) {
      // Update existing user — only update phone if provided
      if (phone) {
        await db.query('UPDATE users SET name = ?, email = ?, phone = ? WHERE auth0_id = ?', 
          [name, email, phone, auth0Id]);
      } else {
        await db.query('UPDATE users SET name = ?, email = ? WHERE auth0_id = ?', 
          [name, email, auth0Id]);
      }
    } else {
      // Insert new user
      await db.query(
        'INSERT INTO users (auth0_id, name, email, phone) VALUES (?, ?, ?, ?)', 
        [auth0Id, name, email, phone || null]
      );
    }
    
    res.json({ message: 'User synced successfully' });
  } catch (err) {
    console.error('User sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET current user profile (authenticated)
router.get('/me', checkJwt, async (req, res) => {
  const auth0Id = req.auth.sub;
  try {
    const [rows] = await db.query('SELECT id, name, email, phone, created_at FROM users WHERE auth0_id = ?', [auth0Id]);
    if (rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
