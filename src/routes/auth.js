import { Router } from 'express';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '../db.js';
import {
  authenticate,
  createOtpCode,
  createPendingOtpToken,
  createSessionToken,
  hashOtpCode,
  hashInvitationToken,
  hashPassword,
  normalizePermissions,
  verifyPendingOtpToken,
  verifyPassword,
} from '../services/auth.js';
import { recordActivity } from '../services/audit.js';
import { sendEmail } from '../services/email.js';

const router = Router();

const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  avatar: user.avatar,
  role: user.role,
  department: user.department,
  phone: user.phone,
  permissions: normalizePermissions(user.permissions),
  isActive: user.isActive,
});

const maskEmail = (value) => {
  const [name = '', domain = ''] = String(value || '').split('@');
  if (!name || !domain) return 'your email';
  const visible = name.length <= 2 ? name[0] : `${name[0]}${name[name.length - 1]}`;
  return `${visible.padEnd(Math.min(name.length, 4), '*')}@${domain}`;
};

const sendLoginOtpEmail = (user, code) => sendEmail({
  to: user.email,
  subject: 'Your Nexport ERP login OTP',
  text: `Your Nexport ERP login OTP is ${code}. It expires in 5 minutes.`,
  html: `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">
      <h2 style="margin:0 0 12px">Nexport ERP login OTP</h2>
      <p>Use this code to finish signing in:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:18px 0">${code}</p>
      <p>This code expires in 5 minutes. If you did not request it, you can ignore this email.</p>
    </div>
  `,
});

router.get('/status', async (_req, res) => {
  const [{ count }] = await db.query('SELECT COUNT(*) as count FROM User');
  return res.json({ data: { needsBootstrap: Number(count) === 0 } });
});

router.post('/bootstrap', async (req, res) => {
  try {
    const [{ count }] = await db.query('SELECT COUNT(*) as count FROM User');
    if (Number(count) > 0) return res.status(409).json({ error: 'Administrator already exists' });
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 8)
      return res.status(400).json({ error: 'Name, email and a password of at least 8 characters are required' });
    const id = createId();
    await db.execute(`
      INSERT INTO User (
        id, email, name, password, role, permissions, isActive, passwordSetAt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)
    `, [id, email.toLowerCase(), name, hashPassword(password), 'admin', JSON.stringify([]), 1, new Date(), new Date(), new Date()]);
    const [user] = await db.query('SELECT * FROM User WHERE id = ?', [id]);
    await recordActivity({
      userId: user.id,
      action: 'create',
      entity: 'user',
      entityId: user.id,
      details: `Created initial administrator ${user.email}`,
      ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
    });
    return res.status(201).json({ data: { token: createSessionToken(user), user: publicUser(user) } });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const [user] = await db.query('SELECT * FROM User WHERE email = ?', [email]);
    if (!user || !user.isActive || !verifyPassword(req.body.password, user.password))
      return res.status(401).json({ error: 'Invalid email or password' });
    const code = createOtpCode();
    const otpId = createId();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await db.execute(`
      INSERT INTO LoginOtp (id, userId, codeHash, expiresAt, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `, [otpId, user.id, hashOtpCode(code), expiresAt, new Date()]);
    await sendLoginOtpEmail(user, code);
    return res.json({
      data: {
        otpRequired: true,
        otpToken: createPendingOtpToken(user),
        maskedEmail: maskEmail(user.email),
      },
    });
  } catch (error) {
    const message = String(error?.message || error || '');
    if (message.includes('SMTP is not configured'))
      return res.status(500).json({ error: 'Email OTP is not configured. Set SMTP_USER and SMTP_PASS in backend/.env.' });
    console.error('Login OTP error:', error);
    return res.status(500).json({ error: 'Unable to send login OTP' });
  }
});

router.post('/verify-email-otp', async (req, res) => {
  try {
    const pending = verifyPendingOtpToken(String(req.body.otpToken || ''));
    const code = String(req.body.code || '').trim();
    if (!pending?.sub)
      return res.status(401).json({ error: 'Password verification expired. Please sign in again.' });
    if (!/^\d{6}$/.test(code))
      return res.status(400).json({ error: 'Enter the 6 digit OTP from your email' });
    const [otp] = await db.query(`
      SELECT *
      FROM LoginOtp
      WHERE userId = ?
        AND codeHash = ?
        AND consumedAt IS NULL
        AND expiresAt > ?
      ORDER BY createdAt DESC
      LIMIT 1
    `, [pending.sub, hashOtpCode(code), new Date()]);
    if (!otp)
      return res.status(401).json({ error: 'Invalid or expired OTP' });
    const [user] = await db.query('SELECT * FROM User WHERE id = ? AND isActive = 1', [pending.sub]);
    if (!user)
      return res.status(401).json({ error: 'Account is inactive or unavailable' });
    const now = new Date();
    await db.execute('UPDATE LoginOtp SET consumedAt = ? WHERE id = ?', [now, otp.id]);
    await db.execute('UPDATE User SET lastLoginAt = ?, updatedAt = ? WHERE id = ?', [now, now, user.id]);
    await recordActivity({
      userId: user.id,
      action: 'login',
      entity: 'user',
      entityId: user.id,
      details: `Logged in with email OTP as ${user.email}`,
      ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
    });
    return res.json({ data: { token: createSessionToken(user), user: publicUser(user) } });
  } catch (error) {
    console.error('Email OTP verification error:', error);
    return res.status(500).json({ error: String(error) });
  }
});

router.get('/invitation', async (req, res) => {
  try {
    const hash = hashInvitationToken(req.query.token);
    const { rows: [user] } = await pool.query(`
      SELECT u."id", u."email", u."name", u."role", i."expiresAt"
      FROM "UserInvitation" i
      JOIN "User" u ON u."id" = i."userId"
      WHERE i."tokenHash" = $1 AND u."isActive" = TRUE
    `, [hash]);
    if (!user || !user.expiresAt || new Date(user.expiresAt) < new Date())
      return res.status(400).json({ error: 'This password setup link is invalid or expired' });
    return res.json({ data: { email: user.email, name: user.name, role: user.role } });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

router.post('/setup-password', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!req.body.password || req.body.password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hash = hashInvitationToken(req.body.token);
    await client.query('BEGIN');
    const { rows: [user] } = await client.query(`
      SELECT u.*, i."expiresAt"
      FROM "UserInvitation" i
      JOIN "User" u ON u."id" = i."userId"
      WHERE i."tokenHash" = $1 AND u."isActive" = TRUE
      FOR UPDATE OF u
    `, [hash]);
    if (!user || !user.expiresAt || new Date(user.expiresAt) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This password setup link is invalid or expired' });
    }
    const now = new Date();
    const { rows: [updated] } = await client.query(`
      UPDATE "User"
      SET "password" = $1, "passwordSetupTokenHash" = NULL,
        "passwordSetupExpiresAt" = NULL, "passwordSetAt" = $2, "updatedAt" = $2
      WHERE "id" = $3
      RETURNING *
    `, [hashPassword(req.body.password), now, user.id]);
    await client.query('DELETE FROM "UserInvitation" WHERE "userId" = $1', [user.id]);
    await client.query('COMMIT');
    await recordActivity({
      userId: updated.id,
      action: 'update',
      entity: 'user',
      entityId: updated.id,
      details: `Password setup completed for ${updated.email}`,
      ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
    });
    return res.json({ data: { token: createSessionToken(updated), user: publicUser(updated) } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: String(error) });
  } finally {
    client.release();
  }
});

router.get('/me', authenticate, (req, res) => res.json({ data: publicUser(req.user) }));

export default router;
