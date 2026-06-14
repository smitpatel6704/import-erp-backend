import { Router } from 'express';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '../db.js';
import { createInvitationToken, hashPassword, normalizePermissions } from '../services/auth.js';
import { isEmailConfigured, sendEmail } from '../services/email.js';

const router = Router();
const appUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

const sendInvitation = async (user, token) => {
  const inviteUrl = `${appUrl()}/setup-password?token=${encodeURIComponent(token)}`;
  if (!isEmailConfigured()) return { inviteUrl, emailSent: false, emailError: 'SMTP is not configured' };
  try {
    await sendEmail({
      to: user.email,
      subject: 'Create your Nexport ERP password',
      text: `Hello ${user.name}, create your Nexport ERP password using this link: ${inviteUrl}`,
      html: `<p>Hello ${user.name},</p><p>Your Nexport ERP account has been created.</p><p><a href="${inviteUrl}">Create your password</a></p><p>This link expires in 24 hours.</p>`,
    });
    return { inviteUrl, emailSent: true };
  } catch (error) {
    return { inviteUrl, emailSent: false, emailError: error.message };
  }
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
             isActive, passwordSetAt, lastLoginAt, createdAt, updatedAt
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
    if (!body.name || !body.email)
      return res.status(400).json({ error: 'Name and email are required' });
    const email = body.email.trim().toLowerCase();
    const [existing] = await db.query('SELECT id FROM User WHERE email = ?', [email]);
    if (existing) return res.status(409).json({ error: 'A user with this email already exists' });
    const id = createId();
    const invitation = createInvitationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.execute(`
      INSERT INTO User (
        id, email, name, password, avatar, role, department, phone, permissions,
        isActive, passwordSetupTokenHash, passwordSetupExpiresAt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)
    `, [
      id, email, body.name, hashPassword(createInvitationToken().token), body.avatar || null,
      body.role || 'user', body.department || null, body.phone || null,
      JSON.stringify(normalizePermissions(body.permissions)), body.isActive === false ? 0 : 1,
      invitation.hash, expiresAt, new Date(), new Date(),
    ]);
    const [user] = await db.query(`
      SELECT id, email, name, avatar, role, department, phone, permissions, isActive, createdAt
      FROM User WHERE id = ?
    `, [id]);
    await pool.query(`
      INSERT INTO "UserInvitation" ("tokenHash", "userId", "expiresAt")
      VALUES ($1, $2, $3)
    `, [invitation.hash, id, expiresAt]);
    const delivery = await sendInvitation(user, invitation.token);
    return res.status(201).json({ data: { user, ...delivery } });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

router.post('/:id/resend-invitation', async (req, res) => {
  try {
    const [user] = await db.query('SELECT id, email, name, isActive FROM User WHERE id = ?', [req.params.id]);
    if (!user || !user.isActive) return res.status(404).json({ error: 'User not found' });
    const invitation = createInvitationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.execute(`
      UPDATE User SET passwordSetupTokenHash = ?, passwordSetupExpiresAt = ?, updatedAt = ? WHERE id = ?
    `, [invitation.hash, expiresAt, new Date(), user.id]);
    await pool.query(`
      INSERT INTO "UserInvitation" ("tokenHash", "userId", "expiresAt")
      VALUES ($1, $2, $3)
    `, [invitation.hash, user.id, expiresAt]);
    return res.json({ data: await sendInvitation(user, invitation.token) });
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
      values.push(JSON.stringify(normalizePermissions(req.body.permissions)));
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
    if (req.params.id === req.user.id)
      return res.status(400).json({ error: 'You cannot delete your own signed-in account' });
    const result = await db.execute('DELETE FROM User WHERE id = ?', [req.params.id]);
    if (!result.rowCount)
      return res.status(404).json({ error: 'User not found' });
    return res.json({ data: { id: req.params.id, deleted: true } });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

export default router;
