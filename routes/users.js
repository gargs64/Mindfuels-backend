const express = require('express');
const router = express.Router();
const db = require('../db');
const checkJwt = require('../middleware/auth');

// Sync/Register user (called by frontend on login)
router.post('/sync', checkJwt, async (req, res) => {
  const { name, email, picture } = req.body;
  const auth0Id = req.auth.sub;

  try {
    // Upsert logic
    const [existing] = await db.query('SELECT id FROM users WHERE auth0_id = ?', [auth0Id]);
    
    if (existing.length > 0) {
      await db.query('UPDATE users SET name = ?, email = ?, picture = ? WHERE auth0_id = ?', 
        [name, email, picture, auth0Id]);
    } else {
      await db.query('INSERT INTO users (auth0_id, name, email, picture) VALUES (?, ?, ?, ?)', 
        [auth0Id, name, email, picture]);
    }
    
    res.json({ message: 'User synced successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
