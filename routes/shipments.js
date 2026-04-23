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
      SELECT oi.quantity, oi.price, p.title, p.product_id, oi.weight, oi.length, oi.width, oi.height
      FROM order_items oi
      JOIN products p ON oi.product_id = p.product_id
      WHERE oi.order_id = ?
    `, [order_id]);

    // Calculate total shipment weight & dimensions
    let totalWeight = 0;
    let maxLength = 0;
    let maxWidth = 0;
    let totalHeight = 0;

    items.forEach(item => {
      const qty = item.quantity || 1;
      totalWeight += (parseFloat(item.weight) || 0.5) * qty;
      
      const l = parseFloat(item.length) || 25;
      const w = parseFloat(item.width) || 18;
      const h = parseFloat(item.height) || 5;

      if (l > maxLength) maxLength = l;
      if (w > maxWidth) maxWidth = w;
      totalHeight += h * qty; // Stack height
    });

    // Fallbacks just in case
    if (maxLength === 0) maxLength = 25;
    if (maxWidth === 0) maxWidth = 18;
    if (totalHeight === 0) totalHeight = 5;

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
      shipment_Weight: parseFloat(totalWeight.toFixed(2)),
      shipment_Length: parseFloat(maxLength.toFixed(2)),
      shipment_Width: parseFloat(maxWidth.toFixed(2)),
      shipment_Height: parseFloat(totalHeight.toFixed(2)),
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

// ──────────────────────────────────────────────
// 5. ESTIMATE SHIPPING RATE (called from cart page before checkout)
// ──────────────────────────────────────────────
router.post('/estimate-rate', async (req, res) => {
  const { destination_pincode, items } = req.body;

  if (!destination_pincode || !items || items.length === 0) {
    return res.status(400).json({ message: 'Pincode and items are required' });
  }

  try {
    // Calculate total weight & dimensions from cart items
    let totalWeight = 0;
    let maxLength = 0;
    let maxWidth = 0;
    let totalHeight = 0;

    // Fetch product dimensions from DB
    const productIds = items.map(i => i.id || i.product_id);
    const [products] = await db.query(
      'SELECT product_id, weight, length, width, height FROM products WHERE product_id IN (?)',
      [productIds]
    );

    const dimMap = {};
    products.forEach(p => { dimMap[p.product_id] = p; });

    items.forEach(item => {
      const pid = item.id || item.product_id;
      const dims = dimMap[pid];
      const qty = item.qty || item.quantity || 1;

      totalWeight += (parseFloat(dims?.weight) || 0.5) * qty;
      const l = parseFloat(dims?.length) || 25;
      const w = parseFloat(dims?.width) || 18;
      const h = parseFloat(dims?.height) || 5;

      if (l > maxLength) maxLength = l;
      if (w > maxWidth) maxWidth = w;
      totalHeight += h * qty;
    });

    const subtotal = items.reduce((sum, i) => sum + ((i.price || 0) * (i.qty || i.quantity || 1)), 0);
    const discountedTotal = Math.round(subtotal * 0.90);

    const ratePayload = {
      source_Pincode: process.env.FSHIP_SOURCE_PINCODE || '110034',
      destination_Pincode: destination_pincode,
      payment_Mode: 'P',  // Prepaid
      amount: discountedTotal,
      express_Type: 'surface',
      shipment_Wweight: parseFloat(totalWeight.toFixed(2)),
      shipment_Length: parseFloat(maxLength.toFixed(2)),
      shipment_Width: parseFloat(maxWidth.toFixed(2)),
      shipment_Hheight: parseFloat(totalHeight.toFixed(2)),
      volumetric_Wweight: 0
    };

    console.log('[FSHIP RATE] Sending payload:', JSON.stringify(ratePayload));
    console.log('[FSHIP RATE] API Key present:', !!process.env.FSHIP_API_KEY);
    console.log('[FSHIP RATE] API Key (first 10 chars):', (process.env.FSHIP_API_KEY || '').substring(0, 10));

    const fshipResponse = await axios.post(
      `${FSHIP_BASE}/api/ratecalculator`,
      ratePayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'signature': process.env.FSHIP_API_KEY
        },
        timeout: 15000
      }
    );

    console.log('[FSHIP RATE] Response status:', fshipResponse.status);
    console.log('[FSHIP RATE] Response data:', JSON.stringify(fshipResponse.data));

    const data = fshipResponse.data;

    if (data.status === true && data.shipment_rates && data.shipment_rates.length > 0) {
      // Pick the cheapest rate
      const cheapest = data.shipment_rates.reduce((min, r) =>
        r.shipping_charge < min.shipping_charge ? r : min, data.shipment_rates[0]);

      res.json({
        success: true,
        shipping_charge: cheapest.shipping_charge,
        courier_name: cheapest.courier_name,
        service_mode: cheapest.service_mode,
        all_rates: data.shipment_rates,
        fallback: false
      });
    } else {
      // Fship returned but no rates — log it
      console.log('[FSHIP RATE] No rates in response, using fallback');
      res.json({
        success: true,
        shipping_charge: subtotal >= 500 ? 0 : 50,
        courier_name: 'Standard',
        service_mode: 'surface',
        all_rates: [],
        fallback: true,
        fship_response: data
      });
    }

  } catch (err) {
    console.error('[FSHIP RATE] ERROR:', err.response?.status, err.response?.data || err.message);
    // Return fallback rate so checkout isn't blocked — but include error info
    const subtotal = (req.body.items || []).reduce((s, i) => s + ((i.price || 0) * (i.qty || 1)), 0);
    res.json({
      success: true,
      shipping_charge: subtotal >= 500 ? 0 : 50,
      courier_name: 'Standard',
      service_mode: 'surface',
      all_rates: [],
      fallback: true,
      fship_error: err.response?.data || err.message
    });
  }
});

// ──────────────────────────────────────────────
// 6. DIAGNOSTIC: Test Fship API connectivity (temporary debug endpoint)
// ──────────────────────────────────────────────
router.get('/test-fship', async (req, res) => {
  try {
    const testPayload = {
      source_Pincode: process.env.FSHIP_SOURCE_PINCODE || '110034',
      destination_Pincode: '700074',
      payment_Mode: 'P',
      amount: 295,
      express_Type: 'surface',
      shipment_Wweight: 0.5,
      shipment_Length: 25,
      shipment_Width: 18,
      shipment_Hheight: 5,
      volumetric_Wweight: 0
    };

    console.log('[FSHIP TEST] API Key:', (process.env.FSHIP_API_KEY || 'NOT SET').substring(0, 15) + '...');
    console.log('[FSHIP TEST] Base URL:', FSHIP_BASE);

    const response = await axios.post(
      `${FSHIP_BASE}/api/ratecalculator`,
      testPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'signature': process.env.FSHIP_API_KEY
        },
        timeout: 15000
      }
    );

    res.json({
      fship_status: response.status,
      fship_data: response.data,
      api_key_present: !!process.env.FSHIP_API_KEY,
      base_url: FSHIP_BASE,
      payload_sent: testPayload
    });

  } catch (err) {
    res.json({
      error: true,
      status: err.response?.status,
      error_data: err.response?.data || err.message,
      api_key_present: !!process.env.FSHIP_API_KEY,
      api_key_preview: (process.env.FSHIP_API_KEY || 'NOT SET').substring(0, 15) + '...',
      base_url: FSHIP_BASE
    });
  }
});

module.exports = router;
