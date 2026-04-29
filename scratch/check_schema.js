const mysql = require('mysql2/promise');
require('dotenv').config();

async function checkSchema() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    const [orders] = await connection.query('DESCRIBE orders');
    console.log('--- ORDERS ---');
    console.table(orders);

    const [address] = await connection.query('DESCRIBE shipping_address');
    console.log('--- SHIPPING ADDRESS ---');
    console.table(address);

    const [items] = await connection.query('DESCRIBE order_items');
    console.log('--- ORDER ITEMS ---');
    console.table(items);
  } catch (err) {
    console.error(err);
  } finally {
    await connection.end();
  }
}

checkSchema();
