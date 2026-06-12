import { Router } from 'express';
import { createId } from '@paralleldrive/cuid2';
import { randomBytes, scryptSync } from 'crypto';
import { db } from '../db.js';

const router = Router();
const hashPassword = (password) => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
};

router.get('/stats', async (_req, res) => {
  try {
    const [{ total }] = await db.query('SELECT COUNT(*) as total FROM User');
    const [{ active }] = await db.query('SELECT COUNT(*) as active FROM User WHERE isActive = 1');
    const byRole = await db.query('SELECT role, COUNT(*) as count FROM User GROUP BY role');
    return res.json({ data: { total, active, byRole } });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

router.get('/', async (req, res) => {
  try {
    const search = `%${req.query.search || ''}%`;
    const users = await db.query(`
      SELECT id, email, name, avatar, role, department, phone, permissions,
             isActive, lastLoginAt, createdAt, updatedAt
      FROM User WHERE name LIKE ? OR email LIKE ? ORDER BY createdAt DESC
    `, [search, search]);
    return res.json({ data: users });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body;
    if (!body.name || !body.email || !body.password)
      return res.status(400).json({ error: 'name, email and password are required' });
    const id = createId();
    await db.execute(`
      INSERT INTO User (
        id, email, name, password, avatar, role, department, phone, permissions,
        isActive, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, body.email.toLowerCase(), body.name, hashPassword(body.password), body.avatar || null,
      body.role || 'user', body.department || null, body.phone || null,
      JSON.stringify(body.permissions || []), body.isActive === false ? 0 : 1, new Date(), new Date(),
    ]);
    const [user] = await db.query(`
      SELECT id, email, name, avatar, role, department, phone, permissions, isActive, createdAt
      FROM User WHERE id = ?
    `, [id]);
    return res.status(201).json({ data: user });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const fields = ['email', 'name', 'avatar', 'role', 'department', 'phone', 'isActive'];
    const updates = [];
    const values = [];
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(field === 'isActive' ? (req.body[field] ? 1 : 0) : req.body[field]);
      }
    }
    if (req.body.permissions !== undefined) {
      updates.push('permissions = ?');
      values.push(JSON.stringify(req.body.permissions || []));
    }
    if (req.body.password) {
      updates.push('password = ?');
      values.push(hashPassword(req.body.password));
    }
    if (updates.length) {
      updates.push('updatedAt = ?');
      values.push(new Date(), req.params.id);
      await db.execute(`UPDATE User SET ${updates.join(', ')} WHERE id = ?`, values);
    }
    const [user] = await db.query(`
      SELECT id, email, name, avatar, role, department, phone, permissions, isActive, updatedAt
      FROM User WHERE id = ?
    `, [req.params.id]);
    return res.json({ data: user });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.execute('UPDATE User SET isActive = 0, updatedAt = ? WHERE id = ?', [new Date(), req.params.id]);
    return res.json({ data: { id: req.params.id, isActive: false } });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

export default router;
