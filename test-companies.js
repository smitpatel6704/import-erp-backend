import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

async function test() {
  const pool = mysql.createPool(process.env.DATABASE_URL);
  try {
    const [res] = await pool.query(`
      INSERT INTO Company (
        id, name, contactPerson, mobile, email, officeAddress, gstNumber, 
        iecCode, panNumber, bankName, bankAccount, bankIfsc, billingAddress, 
        shippingAddress, creditLimit, isActive, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      "test_id_123", "Acme Imports Pvt Ltd", "John Doe", "+91 98765 43210", "contact@acme.com", "", 
      "", "", "", "", "", 
      "", "", "", 500000, 
      1, new Date(), new Date()
    ]);
    console.log("Success:", res);
  } catch (err) {
    console.error("DB Error:", err);
  }
  pool.end();
}
test();
