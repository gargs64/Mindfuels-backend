const express = require('express');
const router = express.Router();
const checkJwt = require('../middleware/auth');
const db = require('../db');
const axios = require('axios');

const FSHIP_BASE = 'https://capi.fship.in'; // Production URL
const FSHIP_STAGING_BASE = 'https://capi-qc.fship.in'; // Staging for testing

// ── DIAGNOSTIC (no auth required) ──────────────
router.get('/test-production-fship', async (req, res) => {
  const results = {};
  const apiKey = process.env.FSHIP_API_KEY;
  const warehouseId = 258921; // Production warehouse ID
  const headers = { 'Content-Type': 'application/json', 'signature': apiKey };

  try {
    const createPayload = {
      customer_Name: "Production Test",
      customer_Mobile: "9050334980",
      customer_Emailid: "test@mindfuels.in",
      customer_Address: "274, 2nd floor Rajdhani enclave, Pitampura",
      customer_Address_Type: "Home",
      customer_PinCode: "110034",
      customer_City: "Delhi",
      orderId: `PROD-TEST-${Date.now()}`,
      invoice_Number: `INV-${Date.now()}`,
      payment_Mode: 2, // Prepaid
      express_TYPE: 'surface',
      order_Amount: 1,
      total_Amount: 1,
      shipment_Weight: 0.5,
      shipment_Length: 25,
      shipment_Width: 18,
      shipment_Height: 5,
      pick_Address_ID: warehouseId,
      return_Address_ID: warehouseId,
      products: [{
        productId: "PROD-TEST-1",
        productName: "Production Test Book",
        unitPrice: 1,
        quantity: 1,
        productCategory: 'Books',
        hsnCode: '4901',
        sku: "PROD-TEST-SKU"
      }],
      courierId: 0
    };

    results.payload = createPayload;
    console.log("=== PROD TEST FSHIP PAYLOAD ===", JSON.stringify(createPayload, null, 2));

    const response = await axios.post(`${FSHIP_BASE}/api/createforwardorder`, createPayload, { headers, timeout: 30000 });
    results.response = response.data;
    res.json(results);
  } catch (err) {
    results.error = err.message;
    results.error_details = err.response?.data || "No additional details";
    res.status(500).json(results);
  }
});

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
    const rateResp = await axios.post(`${FSHIP_STAGING_BASE}/api/ratecalculator`, ratePayload, { headers, timeout: 10000 });
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
    const createResp = await axios.post(`${FSHIP_STAGING_BASE}/api/createforwardorder`, createPayload, { headers, timeout: 30000 });
    results.create_order.response = createResp.data;

    // Use hardcoded AWB for testing as requested
    const awb = '90001652366';

    // 3. Tracking History
    const trackPayload = { waybill: awb };
    results.tracking = { request: trackPayload };
    try {
      const trackResp = await axios.post(`${FSHIP_STAGING_BASE}/api/trackinghistory`, trackPayload, { headers, timeout: 15000 });
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
      const cancelResp = await axios.post(`${FSHIP_STAGING_BASE}/api/cancelorder`, cancelPayload, { headers, timeout: 15000 });
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

// ──────────────────────────────────────────────
// 5. ESTIMATE SHIPPING RATE (called from cart page before checkout)
// ──────────────────────────────────────────────

router.post('/estimate-rate', async (req, res) => {
  const { destination_pincode, items } = req.body;

  if (!destination_pincode || !items || items.length === 0) {
    return res.status(400).json({ message: 'Pincode and items are required' });
  }

  try {
    let totalWeight = 0;
    let maxLength = 0;
    let maxWidth = 0;
    let totalHeight = 0;

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

    // No rates found in Fship response
    return res.status(502).json({ 
      success: false, 
      message: 'Fship API returned no shipping rates for this destination.',
      fship_response: data 
    });

  } catch (err) {
    console.error('=== FSHIP RATE CALCULATOR FAILURE ===');
    console.error('Status:', err.response?.status || 'N/A');
    console.error('Message:', err.message);
    if (err.response && err.response.data) {
      console.error('Fship Error Response:', JSON.stringify(err.response.data, null, 2));
    }
    console.error('======================================');

    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch shipping rates from Fship.',
      error: err.response?.data || err.message 
    });
  }
});

router.use(checkJwt);

// ──────────────────────────────────────────────
// 1. CREATE SHIPMENT (called automatically after order placement)
// ──────────────────────────────────────────────
router.post('/create', async (req, res) => {
  const { order_id } = req.body;

  console.log("=== SHIPMENT CREATION STARTED ===");
  console.log("Order ID:", order_id);
  
  // Diagnostic: Check environment variables
  if (!process.env.FSHIP_API_KEY) console.error("CRITICAL: FSHIP_API_KEY is missing from environment!");
  if (!process.env.FSHIP_PICKUP_ADDRESS_ID) console.error("CRITICAL: FSHIP_PICKUP_ADDRESS_ID is missing from environment!");

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
    console.log('PRODUCTION FSHIP PAYLOAD:', JSON.stringify(fshipPayload, null, 2));
    console.log('FSHIP PRODUCTION KEY EXISTS:', !!process.env.FSHIP_API_KEY);
    console.log('PICKUP ADDRESS ID:', process.env.FSHIP_PICKUP_ADDRESS_ID);
    console.log("=== FSHIP REQUEST - CREATE ORDER ===", JSON.stringify(fshipPayload, null, 2));
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
      console.error('FSHIP API FAILED! Full Response:', JSON.stringify(fshipData, null, 2));
      
      await db.query(`
        INSERT INTO shipments (order_id, awb_code, status, courier_name)
        VALUES (?, ?, ?, ?)
      `, [order_id, 'PENDING', 'Pending', 'Fship Error: ' + (fshipData.response || 'Unknown')]);

      res.json({
        success: false,
        message: fshipData.response || 'Fship order creation failed',
        fship_response: fshipData
      });
    }

  } catch (err) {
    console.error('=== FSHIP API CRITICAL FAILURE ===');
    console.error('Status Code:', err.response?.status || 'N/A');
    console.error('Error Message:', err.message);
    
    if (err.response && err.response.data) {
      console.error('FSHIP ERROR BODY:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('No response data from Fship.');
    }

    if (err.config) {
      console.log('Attempted URL:', err.config.url);
      console.log('Attempted Payload:', err.config.data);
    }
    console.error('==================================');

    // Save a pending record so we don't lose the order
    try {
      await db.query(`
        INSERT INTO shipments (order_id, awb_code, status, courier_name)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE status = 'Error'
      `, [order_id, 'PENDING', 'Error', 'Fship 500: ' + (err.message || 'Unknown')]);
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
          'signature': process.env.FSHIP_API_KEY
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


// Cancellation route removed as requested. Customers are not allowed to cancel orders.


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
          'signature': process.env.FSHIP_API_KEY
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
// 6. FSHIP WEBHOOK — Receives automated status updates
// ──────────────────────────────────────────────
router.post('/webhook/status', async (req, res) => {
  console.log("=== FSHIP WEBHOOK RECEIVED ===", JSON.stringify(req.body, null, 2));
  
  const { awb, status, current_status } = req.body;
  const newStatus = status || current_status;

  if (!awb || !newStatus) {
    return res.status(400).json({ message: 'Invalid webhook payload' });
  }

  try {
    // 1. Update Shipment Table
    await db.query(
      'UPDATE shipments SET status = ? WHERE awb_code = ?',
      [newStatus, awb]
    );

    // 2. Map Fship status to Order status
    let orderStatus = 'Processing';
    if (newStatus.toLowerCase().includes('shipped')) orderStatus = 'Shipped';
    if (newStatus.toLowerCase().includes('delivered')) orderStatus = 'Delivered';
    if (newStatus.toLowerCase().includes('out for delivery')) orderStatus = 'Out for Delivery';
    if (newStatus.toLowerCase().includes('return')) orderStatus = 'Returning';

    // 3. Update Orders Table
    await db.query(`
      UPDATE orders o
      JOIN shipments s ON o.id = s.order_id
      SET o.status = ?
      WHERE s.awb_code = ?
    `, [orderStatus, awb]);

    res.json({ success: true, message: 'Status updated via webhook' });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Internal server error processing webhook' });
  }
});

module.exports = router;
