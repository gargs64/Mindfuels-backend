const express = require('express');
const router = express.Router();
const db = require('../db');
const checkJwt = require('../middleware/auth');
const axios = require('axios');
const crypto = require('crypto');

router.use(checkJwt);

// CREATE ORDER (call this after payment verified)
router.post('/', async (req, res) => {
  const auth0Id = req.auth.sub;
  const { 
    grand_total, 
    shipping_address, 
    payment_id, 
    payment_order_id, 
    payment_signature 
  } = req.body;
  
  // Verify Payment Signature
  const secret = process.env.RAZORPAY_KEY_SECRET;
  const body = payment_order_id + "|" + payment_id;
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(body.toString())
    .digest("hex");

  if (expectedSignature !== payment_signature) {
    return res.status(400).json({ message: "Invalid payment signature" });
  }

  try {
    // 1. Get user
    const [users] = await db.query('SELECT id FROM users WHERE auth0_id = ?', [auth0Id]);
    if (users.length === 0) return res.status(404).json({ message: 'User not found' });
    const userId = users[0].id;

    // 2. Get cart items
    const [cartItems] = await db.query(`
      SELECT c.product_id, c.quantity, p.sp as price, p.title
      FROM cart c
      JOIN products p ON c.product_id = p.product_id
      WHERE c.user_id = ?
    `, [userId]);

    if (cartItems.length === 0) {
      return res.status(400).json({ message: 'Cart is empty' });
    }

    if (!shipping_address) {
      return res.status(400).json({ message: 'Shipping address is required' });
    }

    // 3. Save shipping address
    const { full_name, phone, address_line1, address_line2, city, state, pincode } = shipping_address;
    const [addrResult] = await db.query(
      `INSERT INTO shipping_address
        (user_id, full_name, phone, address_line1, address_line2, city, state, pincode, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, full_name, phone, address_line1, address_line2 || '', city, state, pincode, 0]
    );
    const addressId = addrResult.insertId;

    // 4. Create order
    const [orderResult] = await db.query(
      `INSERT INTO orders (user_id, address_id, total_amount, status, payment_status)
       VALUES (?, ?, ?, 'Processing', 'Paid')`,
      [userId, addressId, grand_total]
    );
    const orderId = orderResult.insertId;

    // 5. Save order items
    const orderItemsValues = cartItems.map(item => [
      orderId, item.product_id, item.quantity, item.price
    ]);
    await db.query(
      'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ?',
      [orderItemsValues]
    );

    // 6. Clear cart
    await db.query('DELETE FROM cart WHERE user_id = ?', [userId]);

    // 7. Auto-create Fship shipment
    try {
      await axios.post(
        `${process.env.BACKEND_URL}/api/shipments/create`,
        { order_id: orderId },
        {
          headers: {
            Authorization: req.headers.authorization
          }
        }
      );
    } catch (shipErr) {
      // Don't fail the order if shipment fails — log it and continue
      console.error('Fship auto-create warning:', shipErr.message);
    }

    res.json({
      success: true,
      orderId: orderId,
      displayId: `#ORD-${9900 + orderId}`,
      message: 'Order placed successfully!'
    });

  } catch (err) {
    console.error('Order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET all orders for logged in user
router.get('/', async (req, res) => {
  const auth0Id = req.auth.sub;
  try {
    const [users] = await db.query('SELECT id FROM users WHERE auth0_id = ?', [auth0Id]);
    if (users.length === 0) return res.status(404).json({ message: 'User not found' });

    const [orders] = await db.query(`
      SELECT o.id, o.total_amount, o.status, o.payment_status, o.created_at,
             sa.city, sa.state, sa.pincode,
             sh.awb_code, sh.status as shipment_status,
             (SELECT p.image1 
              FROM order_items oi 
              JOIN products p ON oi.product_id = p.product_id 
              WHERE oi.order_id = o.id LIMIT 1) as thumbnail
      FROM orders o
      JOIN shipping_address sa ON o.address_id = sa.id
      LEFT JOIN shipments sh ON sh.order_id = o.id
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC
    `, [users[0].id]);

    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single order with all items
router.get('/:id', async (req, res) => {
  const auth0Id = req.auth.sub;
  try {
    const [users] = await db.query('SELECT id FROM users WHERE auth0_id = ?', [auth0Id]);

    const [order] = await db.query(`
      SELECT o.*, sa.full_name, sa.phone, sa.address_line1,
             sa.address_line2, sa.city, sa.state, sa.pincode,
             sh.awb_code, sh.status as shipment_status, sh.fship_order_id
      FROM orders o
      JOIN shipping_address sa ON o.address_id = sa.id
      LEFT JOIN shipments sh ON sh.order_id = o.id
      WHERE o.id = ? AND o.user_id = ?
    `, [req.params.id, users[0].id]);

    if (!order.length) return res.status(404).json({ message: 'Order not found' });

    const [items] = await db.query(`
      SELECT oi.quantity, oi.price, p.title, p.image1, p.mrp
      FROM order_items oi
      JOIN products p ON oi.product_id = p.product_id
      WHERE oi.order_id = ?
    `, [req.params.id]);

    const orderData = order[0];
    orderData.displayId = `#ORD-${9900 + orderData.id}`;
    res.json({ ...orderData, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;