const express = require('express');
const router = express.Router();
const checkJwt = require('../middleware/auth');
const db = require('../db');
const axios = require('axios');

const FSHIP_BASE = 'https://capi.fship.in';

router.use(checkJwt);

// ──────────────────────────────────────────────
// 1. CREATE SHIPMENT (called automatically after order placement)
// ──────────────────────────────────────────────
router.post('/create', async (req, res) => {
  const { order_id } = req.body;
  
  try {
    // 1. Get Order + Address + Items details
    const [orders] = await db.query(`
      SELECT o.id, o.total_amount, o.payment_id,
             sa.full_name, sa.phone, sa.address_line1, sa.address_line2, 
             sa.city, sa.state, sa.pincode
      FROM orders o
      JOIN shipping_address sa ON o.address_id = sa.id
      WHERE o.id = ?
    `, [order_id]);

    if (!orders.length) return res.status(404).json({ message: 'Order not found' });
    const order = orders[0];

    // 2. Get order items for product details
    const [items] = await db.query(`
      SELECT oi.quantity, oi.price, p.title, p.product_id
      FROM order_items oi
      JOIN products p ON oi.product_id = p.product_id
      WHERE oi.order_id = ?
    `, [order_id]);

    // 3. Build Fship payload
    const fshipPayload = {
      customer_Name: order.full_name,
      customer_Mobile: order.phone,
      customer_Emailid: '',
      customer_Address: order.address_line1 + (order.address_line2 ? ', ' + order.address_line2 : ''),
      landMark: order.address_line2 || '',
      customer_Address_Type: 'Home',
      customer_PinCode: order.pincode,
      customer_City: order.city,
      orderId: `MF-${order.id}`,
      invoice_Number: `INV-${order.id}`,
      payment_Mode: 2, // 2 = PREPAID (all Razorpay orders are prepaid)
      express_TYPE: 'surface',
      is_Ndd: 0,
      order_Amount: parseFloat(order.total_amount),
      tax_Amount: 0,
      extra_CHarges: 0,
      total_Amount: parseFloat(order.total_amount),
      cod_Amount: 0, // Prepaid, so no COD
      shipment_Weight: 0.5, // Default weight for books in Kgs
      shipment_Length: 25,   // Default dimensions in cms
      shipment_Width: 18,
      shipment_Height: 5,
      volumetric_Weight: 0,
      latitude: 0,
      longitude: 0,
      pick_Address_ID: parseInt(process.env.FSHIP_PICKUP_ADDRESS_ID) || 0,
      return_Address_ID: parseInt(process.env.FSHIP_PICKUP_ADDRESS_ID) || 0,
      products: items.map(item => ({
        productId: String(item.product_id),
        productName: item.title,
        unitPrice: parseFloat(item.price),
        quantity: item.quantity,
        productCategory: 'Books',
        hsnCode: '4901',   // HSN code for printed books
        sku: String(item.product_id),
        taxRate: 0,
        productDiscount: 0
      })),
      courierId: 0  // 0 = Let Fship auto-assign cheapest courier
    };

    // 4. Call Fship API
    const fshipResponse = await axios.post(
      `${FSHIP_BASE}/api/createforwardorder`,
      fshipPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'signature': process.env.FSHIP_API_KEY
        },
        timeout: 30000
      }
    );

    const fshipData = fshipResponse.data;

    if (fshipData.status === true && fshipData.waybill) {
      // 5. Save to shipments table
      await db.query(`
        INSERT INTO shipments (order_id, awb_code, status, courier_name, fship_order_id)
        VALUES (?, ?, ?, ?, ?)
      `, [
        order_id,
        fshipData.waybill,
        fshipData.order_status || 'Booked',
        fshipData.route_code || 'Fship',
        fshipData.apiorderid || null
      ]);

      // 6. Update order status
      await db.query('UPDATE orders SET status = ? WHERE id = ?', ['Confirmed', order_id]);

      res.json({ 
        success: true, 
        awb: fshipData.waybill, 
        fship_order_id: fshipData.apiorderid 
      });
    } else {
      // Fship returned an error — save a placeholder so we can retry later
      console.error('Fship API response:', fshipData);
      await db.query(`
        INSERT INTO shipments (order_id, awb_code, status, courier_name)
        VALUES (?, ?, ?, ?)
      `, [order_id, 'PENDING', 'Pending', 'Awaiting Assignment']);

      res.json({ 
        success: false, 
        message: fshipData.response || 'Fship order creation failed, saved as pending',
        fship_response: fshipData
      });
    }

  } catch (err) {
    console.error('Shipment creation error:', err.response?.data || err.message);
    
    // Save a pending record so we don't lose the order
    try {
      await db.query(`
        INSERT INTO shipments (order_id, awb_code, status, courier_name)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE status = 'Pending'
      `, [order_id, 'PENDING', 'Pending', 'Awaiting Assignment']);
    } catch (dbErr) {
      console.error('Failed to save pending shipment:', dbErr.message);
    }

    res.status(500).json({ error: err.response?.data || err.message });
  }
});


// ──────────────────────────────────────────────
// 2. TRACK SHIPMENT — get live tracking from Fship
// ──────────────────────────────────────────────
router.post('/track', async (req, res) => {
  const { awb_code } = req.body;

  if (!awb_code || awb_code === 'PENDING') {
    return res.status(400).json({ message: 'No valid AWB code to track' });
  }

  try {
    const fshipResponse = await axios.post(
      `${FSHIP_BASE}/api/trackinghistory`,
      { waybill: awb_code },
      {
        headers: {
          'Content-Type': 'application/json',
          'signature': process.env.FSHIP_API_KEY
        },
        timeout: 15000
      }
    );

    res.json(fshipResponse.data);
  } catch (err) {
    console.error('Tracking error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not fetch tracking info' });
  }
});


// ──────────────────────────────────────────────
// 3. CANCEL SHIPMENT
// ──────────────────────────────────────────────
router.post('/cancel', async (req, res) => {
  const { order_id, reason } = req.body;

  try {
    // Get AWB from our database
    const [shipments] = await db.query(
      'SELECT awb_code FROM shipments WHERE order_id = ?', [order_id]
    );

    if (!shipments.length || shipments[0].awb_code === 'PENDING') {
      // Just update local status if no real AWB exists
      await db.query('UPDATE orders SET status = ? WHERE id = ?', ['Cancelled', order_id]);
      await db.query('UPDATE shipments SET status = ? WHERE order_id = ?', ['Cancelled', order_id]);
      return res.json({ success: true, message: 'Order cancelled locally' });
    }

    // Call Fship cancel API
    const fshipResponse = await axios.post(
      `${FSHIP_BASE}/api/cancelorder`,
      { waybill: shipments[0].awb_code, reason: reason || 'Cancelled by customer' },
      {
        headers: {
          'Content-Type': 'application/json',
          'signature': process.env.FSHIP_API_KEY
        },
        timeout: 15000
      }
    );

    if (fshipResponse.data.status === true) {
      await db.query('UPDATE orders SET status = ? WHERE id = ?', ['Cancelled', order_id]);
      await db.query('UPDATE shipments SET status = ? WHERE order_id = ?', ['Cancelled', order_id]);
      res.json({ success: true, message: 'Shipment cancelled successfully' });
    } else {
      res.json({ success: false, message: fshipResponse.data.response || 'Could not cancel on Fship' });
    }

  } catch (err) {
    console.error('Cancel error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});


// ──────────────────────────────────────────────
// 4. GET SHIPMENT STATUS (quick status check)
// ──────────────────────────────────────────────
router.post('/status', async (req, res) => {
  const { awb_code } = req.body;

  if (!awb_code || awb_code === 'PENDING') {
    return res.json({ status: 'Pending', message: 'Shipment not yet dispatched' });
  }

  try {
    const fshipResponse = await axios.post(
      `${FSHIP_BASE}/api/shipmentsummary`,
      { waybill: awb_code },
      {
        headers: {
          'Content-Type': 'application/json',
          'signature': process.env.FSHIP_API_KEY
        },
        timeout: 15000
      }
    );

    const summary = fshipResponse.data;
    
    // Also update our local DB with latest status
    if (summary.status && summary.summary) {
      await db.query(
        'UPDATE shipments SET status = ? WHERE awb_code = ?',
        [summary.summary.status, awb_code]
      );
    }

    res.json(summary);
  } catch (err) {
    console.error('Status check error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not fetch shipment status' });
  }
});

module.exports = router;
