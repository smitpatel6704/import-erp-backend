const mysql = require('mysql2/promise');
require('dotenv').config();

async function run() {
  const pool = mysql.createPool(process.env.DATABASE_URL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS SettingOption (
      id VARCHAR(191) PRIMARY KEY,
      category VARCHAR(50) NOT NULL,
      value VARCHAR(100) NOT NULL,
      label VARCHAR(100) NOT NULL,
      isActive BOOLEAN DEFAULT 1,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log("Table created.");
  
  // Insert some defaults if empty
  const [rows] = await pool.query('SELECT COUNT(*) as c FROM SettingOption');
  if (rows[0].c === 0) {
    const defaults = [
      { id: '1', category: 'shipping_line', value: 'Maersk', label: 'Maersk' },
      { id: '2', category: 'shipping_line', value: 'MSC', label: 'MSC' },
      { id: '3', category: 'shipping_line', value: 'CMA CGM', label: 'CMA CGM' },
      { id: 'evergreen', category: 'shipping_line', value: 'Evergreen', label: 'Evergreen' },
      { id: '4', category: 'container_size', value: '20FT', label: '20FT' },
      { id: '5', category: 'container_size', value: '40FT', label: '40FT' },
      { id: '6', category: 'container_size', value: '45FT', label: '45FT' },
      { id: '7', category: 'container_type', value: 'Dry Container', label: 'Dry Container' },
      { id: '8', category: 'container_type', value: 'High Cube', label: 'High Cube' },
      { id: '9', category: 'container_type', value: 'Reefer', label: 'Reefer' },
    ];
    for (const d of defaults) {
      await pool.query('INSERT INTO SettingOption (id, category, value, label) VALUES (?, ?, ?, ?)', [d.id, d.category, d.value, d.label]);
    }
    console.log("Defaults inserted.");
  }
  process.exit(0);
}
run();
