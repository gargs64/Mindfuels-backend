require('dotenv').config();
const db = require('../db');

async function audit() {
  const tables = ['orders', 'order_items', 'shipments', 'payments', 'shipping_address'];
  
  for (const table of tables) {
    console.log(`\n--- TABLE: ${table} ---`);
    try {
      const [columns] = await db.query(`SHOW COLUMNS FROM ${table}`);
      console.log('COLUMNS:', columns.map(c => c.Field).join(', '));
      
      const [indexes] = await db.query(`SHOW INDEXES FROM ${table}`);
      console.log('INDEXES:', indexes.map(i => `${i.Key_name} (${i.Column_name})`).join(', '));
      
      const [fks] = await db.query(`
        SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME 
        FROM information_schema.KEY_COLUMN_USAGE 
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      `, [process.env.DB_NAME, table]);
      console.log('FOREIGN KEYS:', fks.map(fk => `${fk.COLUMN_NAME} -> ${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME}`).join(', '));
      
    } catch (err) {
      console.log(`Error checking table ${table}: ${err.message}`);
    }
  }

  process.exit(0);
}

audit().catch(err => { console.error(err); process.exit(1); });
