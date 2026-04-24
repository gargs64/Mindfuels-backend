const express = require('express');
const router = express.Router();
const checkJwt = require('../middleware/auth');
const db = require('../db');
const axios = require('axios');

const FSHIP_BASE = 'https://capi.fship.in';

// ── DIAGNOSTIC (no auth required) ──────────────
router.get('/test-fship', async (req, res) => {
  const apiKey = process.env.FSHIP_API_KEY;
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

  const tests = [
    { name: 'capi + signature', url: 'https://capi.fship.in/api/ratecalculator', headers: { 'signature': apiKey } },
    { name: 'capi + signature bearer', url: 'https://capi.fship.in/api/ratecalculator', headers: { 'signature': `bearer ${apiKey}` } },
    { name: 'capi + Authorization Bearer', url: 'https://capi.fship.in/api/ratecalculator', headers: { 'Authorization': `Bearer ${apiKey}` } },
    { name: 'capi + token', url: 'https://capi.fship.in/api/ratecalculator', headers: { 'token': apiKey } },
    { name: 'capi-qc + signature', url: 'https://capi-qc.fship.in/api/ratecalculator', headers: { 'signature': apiKey } },
    { name: 'api.fship + signature', url: 'https://api.fship.in/api/ratecalculator', headers: { 'signature': apiKey } },
  ];

  const results = [];
  for (const test of tests) {
    try {
      const resp = await axios.post(test.url, testPayload, {
        headers: { 'Content-Type': 'application/json', ...test.headers },
        timeout: 10000
      });
      results.push({ name: test.name, status: resp.status, data: resp.data });
    } catch (err) {
      results.push({ name: test.name, status: err.response?.status || 'NETWORK_ERROR', data: err.response?.data || err.message });
    }
  }

  res.json({
    api_key_present: !!apiKey,
    api_key_length: (apiKey || '').length,
    api_key_preview: (apiKey || 'NOT SET').substring(0, 15) + '...',
    results
  });
});

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

// Realistic fallback shipping calculator (used when Fship API is unavailable)
function calculateFallbackShipping(sourcePincode, destPincode, weightKg) {
  // Determine zone based on first 3 digits of pincode (India postal zones)
  const srcZone = sourcePincode.substring(0, 3);
  const dstZone = destPincode.substring(0, 3);
  const srcRegion = sourcePincode.substring(0, 1);
  const dstRegion = destPincode.substring(0, 1);

  let zone; // local, regional, national, remote
  if (srcZone === dstZone) {
    zone = 'local';       // Same area (e.g., within Delhi)
  } else if (srcRegion === dstRegion) {
    zone = 'regional';    // Same region (e.g., North India)
  } else if (['1', '2', '3', '4', '5'].includes(dstRegion)) {
    zone = 'national';    // Metro/major regions
  } else {
    zone = 'remote';      // NE India, J&K, remote areas
  }

  // Base rates per zone (for first 0.5 kg)
  const baseRates = {
    local: 35,
    regional: 50,
    national: 65,
    remote: 85
  };

  // Additional charge per 0.5 kg
  const additionalPer500g = {
    local: 15,
    regional: 20,
    national: 25,
    remote: 35
  };

  const base = baseRates[zone];
  const extra = Math.max(0, Math.ceil((weightKg - 0.5) / 0.5)) * additionalPer500g[zone];
  const shipping = base + extra;

  return {
    shipping_charge: shipping,
    courier_name: 'Standard Delivery',
    service_mode: 'surface',
    zone: zone
  };
}

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
    const sourcePincode = process.env.FSHIP_SOURCE_PINCODE || '110034';

    // Try Fship API first
    const ratePayload = {
      source_Pincode: sourcePincode,
      destination_Pincode: destination_pincode,
      payment_Mode: 'P',
      amount: discountedTotal,
      express_Type: 'surface',
      shipment_Wweight: parseFloat(totalWeight.toFixed(2)),
      shipment_Length: parseFloat(maxLength.toFixed(2)),
      shipment_Width: parseFloat(maxWidth.toFixed(2)),
      shipment_Hheight: parseFloat(totalHeight.toFixed(2)),
      volumetric_Wweight: 0
    };

    console.log('[FSHIP RATE] Trying Fship API...');

    const fshipResponse = await axios.post(
      `${FSHIP_BASE}/api/ratecalculator`,
      ratePayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'signature': process.env.FSHIP_API_KEY
        },
        timeout: 10000
      }
    );

    const data = fshipResponse.data;

    if (data.status === true && data.shipment_rates && data.shipment_rates.length > 0) {
      console.log('[FSHIP RATE] Got rates from Fship!');
      const cheapest = data.shipment_rates.reduce((min, r) =>
        r.shipping_charge < min.shipping_charge ? r : min, data.shipment_rates[0]);

      return res.json({
        success: true,
        shipping_charge: cheapest.shipping_charge,
        courier_name: cheapest.courier_name,
        service_mode: cheapest.service_mode,
        all_rates: data.shipment_rates,
        fallback: false
      });
    }

    // Fship returned but no rates — use weight-based fallback
    console.log('[FSHIP RATE] No rates from Fship, using weight-based fallback');
    const fallback = calculateFallbackShipping(sourcePincode, destination_pincode, totalWeight);
    return res.json({
      success: true,
      ...fallback,
      all_rates: [],
      fallback: true
    });

  } catch (err) {
    console.error('[FSHIP RATE] API error:', err.response?.status || err.message);
    // Fship unavailable — use weight-based fallback
    const sourcePincode = process.env.FSHIP_SOURCE_PINCODE || '110034';
    let totalWeight = 0;
    (req.body.items || []).forEach(i => {
      totalWeight += (parseFloat(i.weight) || 0.5) * (i.qty || i.quantity || 1);
    });
    if (totalWeight === 0) totalWeight = 0.5;

    const fallback = calculateFallbackShipping(sourcePincode, destination_pincode, totalWeight);
    return res.json({
      success: true,
      ...fallback,
      all_rates: [],
      fallback: true
    });
  }
});

module.exports = router;
