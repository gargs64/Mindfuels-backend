const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const db = require('../db');
const checkJwt = require('../middleware/auth');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// GET Razorpay public key for frontend
router.get('/config', (req, res) => {
  res.json({ key: process.env.RAZORPAY_KEY_ID });
});

// CREATE Razorpay order
router.post('/create-order', async (req, res) => {
  const { amount, currency } = req.body;
  try {
    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: currency || 'INR',
      receipt: `receipt_${Date.now()}`
    });
    res.json(order);
  } catch (err) {
    console.error('Razorpay Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// VERIFY payment after Razorpay popup closes
router.post('/verify', checkJwt, async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    order_id,         // your DB order id
    amount
  } = req.body;

  try {
    // Step 1 — Verify signature is genuinely from Razorpay
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Payment verification failed' });
    }

    // Step 2 — Save payment record to DB
    await db.query(`
      INSERT INTO payments
        (order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature, amount, status, paid_at)
      VALUES (?, ?, ?, ?, ?, 'paid', NOW())
    `, [order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature, amount]);

    // Step 3 — Update order payment status
    await db.query(
      `UPDATE orders SET payment_status = 'Paid', status = 'Processing' WHERE id = ?`,
      [order_id]
    );

    res.json({ success: true, message: 'Payment verified successfully' });

  } catch (err) {
    console.error('CRITICAL PAYMENT VERIFY ERROR:', err);
    res.status(500).json({ 
      success: false,
      message: err.message || err.toString() || 'Unknown payment verification error',
      error: err.message || err.toString() || 'Unknown payment verification error' 
    });
  }
});

module.exports = router;