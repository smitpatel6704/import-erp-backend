import * as dotenv from 'dotenv';
dotenv.config();
import { db } from './src/db.js';

async function test() {
  try {
    const search = '%%';
    const users = await db.query(`
      SELECT id, email, name, avatar, role, department, phone, permissions,
             isActive, requireOtp, passwordSetAt, lastLoginAt, createdAt, updatedAt
      FROM User WHERE isActive = 1 AND (name LIKE ? OR email LIKE ?) ORDER BY createdAt DESC
    `, [search, search]);
    console.log('Success:', users);
  } catch (err) {
    console.error('Error:', err);
  }
}

test();
