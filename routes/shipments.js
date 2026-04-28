const express = require('express');
const router = express.Router();
const checkJwt = require('../middleware/auth');
const db = require('../db');
const axios = require('axios');

const FSHIP_BASE = 'https://capi-qc.fship.in';

// ── DIAGNOSTIC (no auth required) ──────────────
// ── DIAGNOSTIC (no auth required) ──────────────
router.get('/test-fship', async (req, res) => {
  const stagingKey = '085c36066064af83c66b9dbf44d190d40feec79f437bc1c1cb';
  const headers = { 'Content-Type': 'application/json', 'signature': stagingKey };
  const results = {};

  try {
    // Hardcoded staging warehouse ID as requested
    const stagingWarehouseId = 12673;
    results.warehouse_info = { message: "Skipped add_warehouse", stagingWarehouseId };

    // 1. Rate Calculator
    const ratePayload = {
      source_Pincode: "110034", // Default source pincode for testing
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
    results.rate_calculator = { request: ratePayload };
    const rateResp = await axios.post(`${FSHIP_BASE}/api/ratecalculator`, ratePayload, { headers, timeout: 10000 });
    results.rate_calculator.response = rateResp.data;

    // 2. Create Forward Order
    const createPayload = {
      customer_Name: "Test User",
      customer_Mobile: "9999999999",
      customer_Emailid: "test@example.com",
      customer_Address: "Test Address Line 1",
      customer_Address_Type: "Home",
      customer_PinCode: "700074",
      customer_City: "Kolkata",
      orderId: `TEST-${Date.now()}`,
      invoice_Number: `INV-${Date.now()}`,
      payment_Mode: 2, // Prepaid
      express_TYPE: 'surface',
      order_Amount: 295,
      total_Amount: 295,
      shipment_Weight: 0.5,
      shipment_Length: 25,
      shipment_Width: 18,
      shipment_Height: 5,
      pick_Address_ID: stagingWarehouseId,
      return_Address_ID: stagingWarehouseId,
      products: [{
        productId: "TEST-PROD-1",
        productName: "Test Book",
        unitPrice: 295,
        quantity: 1,
        productCategory: 'Books',
        sku: "TEST-SKU-1"
      }],
      courierId: 0
    };
    results.create_order = { request: createPayload };
    const createResp = await axios.post(`${FSHIP_BASE}/api/createforwardorder`, createPayload, { headers, timeout: 30000 });
    results.create_order.response = createResp.data;

    // Use hardcoded AWB for testing as requested
    const awb = '90001652366';

    // 3. Tracking History
    const trackPayload = { waybill: awb };
    results.tracking = { request: trackPayload };
    try {
      const trackResp = await axios.post(`${FSHIP_BASE}/api/trackinghistory`, trackPayload, { headers, timeout: 15000 });
      results.tracking.response = trackResp.data;
    } catch (e) {
      results.tracking.response = e.response?.data || e.message;
    }

    // 4. Shipment Summary
    const summaryPayload = { waybill: awb };
    results.summary = { request: summaryPayload };
    try {
      // Using absolute URL as requested to resolve 404
      const summaryResp = await axios.post(`https://capi-qc.fship.in/api/shipmentsummary`, summaryPayload, { headers, timeout: 15000 });
      results.summary.response = summaryResp.data;
    } catch (e) {
      results.summary.response = e.response?.data || e.message;
    }

    // 5. Cancel Order
    const cancelPayload = { waybill: awb, reason: "Test Cancellation" };
    results.cancel = { request: cancelPayload };
    try {
      const cancelResp = await axios.post(`${FSHIP_BASE}/api/cancelorder`, cancelPayload, { headers, timeout: 15000 });
      results.cancel.response = cancelResp.data;
    } catch (e) {
      results.cancel.response = e.response?.data || e.message;
    }

    // Final response assembly
    const finalResponse = {
      success: true,
      diagnostic_timestamp: new Date().toISOString(),
      awb_used: awb,
      steps: {
        step0_warehouse_status: results.warehouse_info,
        step1_rate_calculator: results.rate_calculator,
        step2_create_order: results.create_order,
        step3_tracking: results.tracking,
        step4_summary: results.summary,
        step5_cancel_order: results.cancel
      }
    };

    res.header("Content-Type", "application/json");
    res.send(JSON.stringify(finalResponse, null, 2));

  } catch (err) {
    const errorResponse = {
      success: false,
      error_message: err.message,
      error_details: err.response?.data || "No additional details",
      partial_results: results
    };
    res.header("Content-Type", "application/json");
    res.status(500).send(JSON.stringify(errorResponse, null, 2));
  }
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
    console.log("=== FSHIP REQUEST - CREATE ORDER ===", JSON.stringify(fshipPayload, null, 2));
    const fshipResponse = await axios.post(
      `${FSHIP_BASE}/api/createforwardorder`,
      fshipPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'signature': process.env.FSHIP_STAGING_KEY
        },
        timeout: 30000
      }
    );

    const fshipData = fshipResponse.data;
    console.log("=== FSHIP RESPONSE - CREATE ORDER ===", JSON.stringify(fshipData, null, 2));

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

      // 7. Register Pickup
      try {
        console.log("=== FSHIP REQUEST - REGISTER PICKUP ===", fshipData.waybill);
        const pickupResp = await axios.post(
          'https://capi.fship.in/api/registerpickup',
          { waybills: [fshipData.waybill] },
          {
            headers: {
              'Content-Type': 'application/json',
              'signature': process.env.FSHIP_API_KEY
            },
            timeout: 15000
          }
        );
        console.log("=== FSHIP RESPONSE - REGISTER PICKUP ===", JSON.stringify(pickupResp.data, null, 2));
      } catch (pickupErr) {
        console.error("Fship Register Pickup Error:", pickupErr.response?.data || pickupErr.message);
      }

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
    const trackingPayload = { waybill: awb_code };
    console.log("=== FSHIP REQUEST - TRACKING ===", JSON.stringify(trackingPayload, null, 2));

    const fshipResponse = await axios.post(
      `${FSHIP_BASE}/api/trackinghistory`,
      trackingPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'signature': process.env.FSHIP_STAGING_KEY
        },
        timeout: 15000
      }
    );

    console.log("=== FSHIP RESPONSE - TRACKING ===", JSON.stringify(fshipResponse.data, null, 2));
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
    const cancelPayload = { waybill: shipments[0].awb_code, reason: reason || 'Cancelled by customer' };
    console.log("=== FSHIP REQUEST - CANCEL ORDER ===", JSON.stringify(cancelPayload, null, 2));

    const fshipResponse = await axios.post(
      `${FSHIP_BASE}/api/cancelorder`,
      cancelPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'signature': process.env.FSHIP_STAGING_KEY
        },
        timeout: 15000
      }
    );

    console.log("=== FSHIP RESPONSE - CANCEL ORDER ===", JSON.stringify(fshipResponse.data, null, 2));

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
    const summaryPayload = { waybill: awb_code };
    console.log("=== FSHIP REQUEST - SHIPMENT SUMMARY ===", JSON.stringify(summaryPayload, null, 2));

    const fshipResponse = await axios.post(
      `${FSHIP_BASE}/api/shipmentsummary`,
      summaryPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'signature': process.env.FSHIP_STAGING_KEY
        },
        timeout: 15000
      }
    );

    const summary = fshipResponse.data;
    console.log("=== FSHIP RESPONSE - SHIPMENT SUMMARY ===", JSON.stringify(summary, null, 2));

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

// Realistic fallback shipping calculator (calibrated to match Fship rates)
// Verified: Delhi(110034)→Pune(411016), 2.5kg, surface = Fship ₹160.48, our calc ₹160
function calculateFallbackShipping(sourcePincode, destPincode, weightKg) {
  const srcRegion = sourcePincode.substring(0, 1);
  const dstRegion = destPincode.substring(0, 1);
  const srcZone3 = sourcePincode.substring(0, 3);
  const dstZone3 = destPincode.substring(0, 3);

  let zone;
  if (srcZone3 === dstZone3) {
    zone = 'local';       // Same area (e.g., within Delhi)
  } else if (srcRegion === dstRegion) {
    zone = 'regional';    // Same region (e.g., North India)
  } else if (['1', '2', '3', '4', '5'].includes(dstRegion)) {
    zone = 'national';    // Metro/major regions
  } else {
    zone = 'remote';      // NE India, J&K, remote areas (6-9)
  }

  // Per-kg pricing calibrated against Fship dashboard rates
  // Base = fixed handling charge, perKg = weight-proportional charge
  const rates = {
    local: { base: 30, perKg: 18 },   // ~₹48 for 1kg, ~₹66 for 2kg
    regional: { base: 38, perKg: 24 },   // ~₹62 for 1kg, ~₹86 for 2kg
    national: { base: 40, perKg: 48 },   // ~₹88 for 1kg, ~₹160 for 2.5kg (matches Fship)
    remote: { base: 55, perKg: 58 }    // ~₹113 for 1kg, ~₹200 for 2.5kg
  };

  const r = rates[zone];
  const chargeableWeight = Math.max(weightKg, 0.5); // Minimum 0.5 kg
  const shipping = Math.round(r.base + (r.perKg * chargeableWeight));

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
    console.log("=== FSHIP REQUEST - RATE CALCULATOR ===", JSON.stringify(ratePayload, null, 2));

    const fshipResponse = await axios.post(
      `${FSHIP_BASE}/api/ratecalculator`,
      ratePayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'signature': process.env.FSHIP_STAGING_KEY
        },
        timeout: 10000
      }
    );

    const data = fshipResponse.data;
    console.log("=== FSHIP RESPONSE - RATE CALCULATOR ===", JSON.stringify(data, null, 2));

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
