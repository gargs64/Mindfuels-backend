const express = require('express');
const router = express.Router();
const checkJwt = require('../middleware/auth');
const db = require('../db');

router.use(checkJwt);

// CREATE SHIPMENT LOG
router.post('/create', async (req, res) => {
  const { order_id } = req.body;
  
  try {
    // 1. Get Order & Address details
    const [orders] = await db.query(`
      SELECT o.id, o.total_amount, sa.* 
      FROM orders o
      JOIN shipping_address sa ON o.address_id = sa.id
      WHERE o.id = ?
    `, [order_id]);

    if (!orders.length) return res.status(404).json({ message: 'Order not found' });
    const order = orders[0];

    // 2. Placeholder for Fship API Call
    // In a real scenario, you'd call Fship here using process.env.FSHIP_API_KEY
    // for now, we simulate a successful shipment creation and generate a dummy AWB
    const dummyAwb = `MF${Math.floor(100000 + Math.random() * 900000)}`;

    // 3. Log to shipments table
    await db.query(`
      INSERT INTO shipments (order_id, awb_code, status, courier_name)
      VALUES (?, ?, ?, ?)
    `, [order_id, dummyAwb, 'Booked', 'Mindfuels Internal']);

    res.json({ success: true, awb: dummyAwb });
  } catch (err) {
    console.error('Shipment creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
