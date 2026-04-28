const express = require('express');
const router = express.Router();
const db = require('../db');
const checkJwt = require('../middleware/auth');
const axios = require('axios');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

router.use(checkJwt);

// CREATE ORDER (call this after payment verified)
router.post('/', async (req, res) => {
  console.log("=== CREATE ORDER REQUEST RECEIVED ===");
  console.log("Payload:", JSON.stringify(req.body, null, 2));

  const auth0Id = req.auth.sub;
  const {
    grand_total,
    shipping_charge: clientShippingCharge,
    shipping_address,
    payment_id,
    payment_order_id,
    payment_signature,
    items: frontendItems  // Accept items from frontend to ensure accuracy
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

  // 0. Setup Nodemailer Transporter
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });

  try {
    // 1. Get user
    const [users] = await db.query('SELECT id, email FROM users WHERE auth0_id = ?', [auth0Id]);
    if (users.length === 0) return res.status(404).json({ message: 'User not found' });
    const userId = users[0].id;
    const userEmail = users[0].email;

    // 2. Build order items — use frontend items (what user actually checked out)
    //    but validate prices against the products table for security
    let orderItems = [];

    if (frontendItems && frontendItems.length > 0) {
      // Frontend sent the exact items the user checked out with
      const productIds = frontendItems.map(i => i.id || i.product_id);
      const [products] = await db.query(
        `SELECT product_id, sp as price, title, weight, length, width, height FROM products WHERE product_id IN (?)`,
        [productIds]
      );
      const priceMap = {};
      products.forEach(p => { priceMap[p.product_id] = p; });

      orderItems = frontendItems.map(item => {
        const pid = item.id || item.product_id;
        const dbProduct = priceMap[pid];
        return {
          product_id: pid,
          quantity: item.qty || item.quantity || 1,
          price: dbProduct ? dbProduct.price : (item.price || 0),
          weight: dbProduct ? dbProduct.weight : 0.50,
          length: dbProduct ? dbProduct.length : 25.00,
          width: dbProduct ? dbProduct.width : 18.00,
          height: dbProduct ? dbProduct.height : 5.00
        };
      }).filter(item => item.product_id);
    } else {
      // Fallback: read from backend cart (legacy behavior)
      const [cartItems] = await db.query(`
        SELECT c.product_id, c.quantity, p.sp as price, p.title, p.weight, p.length, p.width, p.height
        FROM cart c
        JOIN products p ON c.product_id = p.product_id
        WHERE c.user_id = ?
      `, [userId]);
      orderItems = cartItems;
    }

    if (orderItems.length === 0) {
      return res.status(400).json({ message: 'No items to order' });
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

    // 4. Create order — recalculate total from validated items for accuracy
    const verifiedSubtotal = orderItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const discountAmount = Math.round(verifiedSubtotal * 0.10); // 10% discount (matches frontend)
    const verifiedTotal = verifiedSubtotal - discountAmount;
    const finalTotal = verifiedTotal || grand_total; // Use verified total, fallback to frontend total

    const shippingCharge = parseFloat(clientShippingCharge) || 0;
    const grandTotal = finalTotal + shippingCharge;

    const [orderResult] = await db.query(
      `INSERT INTO orders (user_id, address_id, total_amount, shipping_charge, status, payment_status, payment_id)
       VALUES (?, ?, ?, ?, 'Ordered', 'Paid', ?)`,
      [userId, addressId, grandTotal, shippingCharge, payment_id]
    );
    const orderId = orderResult.insertId;

    // 5. Save order items — ONLY the items the user actually ordered
    const orderItemsValues = orderItems.map(item => [
      orderId, item.product_id, item.quantity, item.price, item.weight, item.length, item.width, item.height
    ]);

    if (!orderItemsValues || orderItemsValues.length === 0) {
      throw new Error("No items found in order to save.");
    }

    try {
      await db.query(
        'INSERT INTO order_items (order_id, product_id, quantity, price, weight, length, width, height) VALUES ?',
        [orderItemsValues]
      );
    } catch (oiErr) {
      console.error('Order Items Insertion Failed. Check if weight/length/width/height columns exist in order_items table.');
      console.error('SQL Error:', oiErr.sqlMessage || oiErr.message);
      // Fallback: try inserting without dimensions if they are missing from DB
      if (oiErr.code === 'ER_BAD_FIELD_ERROR') {
        console.log('Retrying order_items insert without dimensions...');
        const simplifiedValues = orderItems.map(item => [orderId, item.product_id, item.quantity, item.price]);
        await db.query(
          'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ?',
          [simplifiedValues]
        );
      } else {
        throw oiErr;
      }
    }

    // 6. Clear cart completely
    await db.query('DELETE FROM cart WHERE user_id = ?', [userId]);

    // 7. Auto-create Fship shipment
    let awb = 'Pending Assignment';
    try {
      const shipResp = await axios.post(
        `${process.env.BACKEND_URL}/api/shipments/create`,
        { order_id: orderId },
        {
          headers: {
            Authorization: req.headers.authorization
          }
        }
      );
      if (shipResp.data.success) {
        awb = shipResp.data.awb;
      }
    } catch (shipErr) {
      console.error('Fship auto-create warning:', shipErr.message);
    }

    // 8. Send Confirmation Email
    try {
      const itemsHtml = orderItems.map(item => `
        <li>${item.title} (x${item.quantity}) - ₹${item.price}</li>
      `).join('');

      const mailOptions = {
        from: '"Mindfuels" <noreply@mindfuels.in>',
        to: userEmail,
        subject: `Order Confirmed - #ORD-${9900 + orderId}`,
        html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h2 style="color: #F6AB06;">Thank you for your order!</h2>
            <p>Hi,</p>
            <p>Your order <strong>#ORD-${9900 + orderId}</strong> has been successfully placed and is being processed.</p>
            <h3>Order Summary:</h3>
            <ul>${itemsHtml}</ul>
            <p><strong>Total Amount Paid:</strong> ₹${grandTotal}</p>
            <p><strong>Shipping Address:</strong> ${address_line1}, ${city}, ${pincode}</p>
            <hr />
            <p><strong>Logistics Partner:</strong> Fship</p>
            <p><strong>AWB Number:</strong> ${awb}</p>
            <p>You can track your order in the "My Orders" section of our website.</p>
            <br />
            <p>Happy Reading!<br/>Team Mindfuels</p>
          </div>
        `
      };

      await transporter.sendMail(mailOptions);
      console.log('Confirmation email sent to:', userEmail);
    } catch (emailErr) {
      console.error('Email delivery error:', emailErr.message);
    }

    res.json({
      success: true,
      orderId: orderId,
      displayId: `#ORD-${9900 + orderId}`,
      message: 'Order placed successfully!'
    });

  } catch (err) {
    console.error('CRITICAL ORDER ERROR:', err);
    if (err.sqlMessage) console.error('SQL Message:', err.sqlMessage);
    
    res.status(500).json({ 
      success: false,
      message: err.message || err.toString() || 'Unknown order recording error',
      error: err.sqlMessage || err.message || err.toString() 
    });
  }
});

// GET all orders for logged in user
router.get('/', async (req, res) => {
  const auth0Id = req.auth.sub;
  try {
    const [users] = await db.query('SELECT id FROM users WHERE auth0_id = ?', [auth0Id]);
    if (users.length === 0) return res.status(404).json({ message: 'User not found' });
    const userId = users[0].id;

    const [orders] = await db.query(`
      SELECT o.id, o.total_amount, o.shipping_charge, o.status, o.payment_status, o.created_at,
             sa.city, sa.state, sa.pincode,
             sh.awb_code, sh.courier_name, sh.status as shipment_status
      FROM orders o
      JOIN shipping_address sa ON o.address_id = sa.id
      LEFT JOIN shipments sh ON sh.order_id = o.id
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC
    `, [userId]);

    // Fetch products for each order
    const enrichedOrders = await Promise.all(orders.map(async (order) => {
      const [items] = await db.query(`
        SELECT oi.quantity, oi.price, p.title, p.image1
        FROM order_items oi
        JOIN products p ON oi.product_id = p.product_id
        WHERE oi.order_id = ?
      `, [order.id]);
      return { ...order, products: items };
    }));

    res.json(enrichedOrders);
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
             sh.awb_code, sh.status as shipment_status, sh.fship_order_id, 
             sh.courier_name, sh.tracking_url, sh.shipped_at, sh.delivered_at
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