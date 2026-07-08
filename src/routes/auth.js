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
  validatePasswordStrength,
  verifyPendingOtpToken,
  verifyPassword,
} from '../services/auth.js';
import { recordActivity } from '../services/audit.js';
import { sendEmail } from '../services/email.js';

const router = Router();
const authAttempts = new Map();
const rateLimitAuth = (name, identifierForRequest) => (req, res, next) => {
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 8;
  const now = Date.now();
  const identifier = identifierForRequest(req);
  const clientIp = String(req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const key = `${name}:${clientIp}:${identifier}`;
  const current = authAttempts.get(key);
  if (!current || current.resetAt <= now) {
    authAttempts.set(key, { count: 1, resetAt: now + windowMs });
    return next();
  }
  current.count += 1;
  if (current.count > maxAttempts) {
    res.setHeader('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }
  return next();
};

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
  if (name.length <= 2) return `${name[0]}*@${domain}`;
  if (name.length <= 4) return `${name.slice(0, 2)}${'*'.repeat(name.length - 2)}@${domain}`;
  const visibleStart = name.slice(0, 2);
  const visibleEnd = name.slice(-2);
  return `${visibleStart}${'*'.repeat(Math.max(name.length - 4, 3))}${visibleEnd}@${domain}`;
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

const sendPasswordChangeOtpEmail = (user, code) => sendEmail({
  to: user.email,
  subject: 'Your Nexport ERP password change OTP',
  text: `Your Nexport ERP password change OTP is ${code}. It expires in 5 minutes.`,
  html: `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">
      <h2 style="margin:0 0 12px">Nexport ERP password change OTP</h2>
      <p>Use this code to confirm your password change:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:18px 0">${code}</p>
      <p>This code expires in 5 minutes. If you did not request it, change your password immediately or contact an administrator.</p>
    </div>
  `,
});

const isSmtpAuthError = (error) => {
  const message = String(error?.message || error?.response || error || '');
  return error?.code === 'EAUTH' ||
    error?.responseCode === 535 ||
    message.includes('Username and Password not accepted');
};
router.get('/status', async (_req, res) => {
  const [{ count }] = await db.query('SELECT COUNT(*) as count FROM User');
  return res.json({ data: { needsBootstrap: Number(count) === 0 } });
});

router.post('/bootstrap', rateLimitAuth('bootstrap', (req) => String(req.body.email || '').trim().toLowerCase()), async (req, res) => {
  try {
    const [{ count }] = await db.query('SELECT COUNT(*) as count FROM User');
    if (Number(count) > 0) return res.status(409).json({ error: 'Administrator already exists' });
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required' });
    const passwordError = validatePasswordStrength(String(password));
    if (passwordError)
      return res.status(400).json({ error: passwordError });
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

router.post('/login', rateLimitAuth('login', (req) => String(req.body.email || '').trim().toLowerCase()), async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const [user] = await db.query('SELECT * FROM User WHERE email = ?', [email]);
    if (!user || !user.isActive || !verifyPassword(req.body.password, user.password))
      return res.status(401).json({ error: 'Invalid email or password' });

    if (user.requireOtp === false || user.requireOtp === 0) {
      const now = new Date();
      await db.execute('UPDATE User SET lastLoginAt = ?, updatedAt = ? WHERE id = ?', [now, now, user.id]);
      await recordActivity({
        userId: user.id,
        action: 'login',
        entity: 'user',
        entityId: user.id,
        details: `Logged in directly (OTP bypassed) as ${user.email}`,
        ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
      });
      return res.json({
        data: {
          otpRequired: false,
          token: createSessionToken(user),
          user: publicUser(user)
        }
      });
    }

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
        otpToken: createPendingOtpToken(user, req),
        maskedEmail: maskEmail(user.email),
      },
    });
  } catch (error) {
    const message = String(error?.message || error || '');
    if (message.includes('SMTP is not configured'))
      return res.status(500).json({ error: 'Email OTP is not configured. Set SMTP_USER and SMTP_PASS in backend/.env.' });
    if (isSmtpAuthError(error)) {
      console.error('Login OTP SMTP authentication error:', error?.response || error?.message || error);
      return res.status(500).json({
        error: 'Gmail rejected the SMTP credentials. Use a Google App Password in SMTP_PASS, not the Gmail account password.',
      });
    }
    console.error('Login OTP error:', error);
    return res.status(500).json({ error: 'Unable to send login OTP' });
  }
});

router.post('/verify-email-otp', rateLimitAuth('otp', (req) => String(req.body.otpToken || '').slice(0, 32)), async (req, res) => {
  try {
    const pending = verifyPendingOtpToken(String(req.body.otpToken || ''), req);
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

router.get('/invitation', rateLimitAuth('invitation', (req) => String(req.query.token || '').slice(0, 32)), async (req, res) => {
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

router.post('/setup-password', rateLimitAuth('setup-password', (req) => String(req.body.token || '').slice(0, 32)), async (req, res) => {
  const client = await pool.connect();
  try {
    const passwordError = validatePasswordStrength(String(req.body.password || ''));
    if (passwordError)
      return res.status(400).json({ error: passwordError });
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
    return res.json({
      data: {
        passwordSet: true,
        user: {
          email: updated.email,
          name: updated.name,
        },
      },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: String(error) });
  } finally {
    client.release();
  }
});

router.get('/me', authenticate, (req, res) => res.json({ data: publicUser(req.user) }));

router.put('/me', authenticate, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = req.body.phone === undefined ? req.user.phone : String(req.body.phone || '').trim();
    const department = req.body.department === undefined ? req.user.department : String(req.body.department || '').trim();
    const avatar = req.body.avatar === undefined ? req.user.avatar : String(req.body.avatar || '').trim();

    if (!name || !email)
      return res.status(400).json({ error: 'Name and email are required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Enter a valid email address' });

    const [existing] = await db.query('SELECT id FROM User WHERE email = ? AND id <> ?', [email, req.user.id]);
    if (existing)
      return res.status(409).json({ error: 'A user with this email already exists' });

    const now = new Date();
    await db.execute(`
      UPDATE User
      SET name = ?, email = ?, phone = ?, department = ?, avatar = ?, updatedAt = ?
      WHERE id = ?
    `, [
      name,
      email,
      phone || null,
      department || null,
      avatar || null,
      now,
      req.user.id,
    ]);

    const [updated] = await db.query('SELECT * FROM User WHERE id = ?', [req.user.id]);
    await recordActivity({
      userId: req.user.id,
      action: 'update',
      entity: 'user',
      entityId: req.user.id,
      details: `Updated profile for ${updated.email}`,
      ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
    });

    return res.json({ data: publicUser(updated) });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

router.post('/password/otp', authenticate, rateLimitAuth('password-otp', (req) => req.user?.email || req.user?.id || 'unknown'), async (req, res) => {
  try {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');

    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Current password and new password are required' });
    const passwordError = validatePasswordStrength(newPassword);
    if (passwordError)
      return res.status(400).json({ error: passwordError });

    const [user] = await db.query('SELECT * FROM User WHERE id = ?', [req.user.id]);
    if (!user || !verifyPassword(currentPassword, user.password))
      return res.status(401).json({ error: 'Current password is incorrect' });

    const code = createOtpCode();
    const otpId = createId();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await db.execute(`
      INSERT INTO LoginOtp (id, userId, codeHash, expiresAt, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `, [otpId, user.id, hashOtpCode(code), expiresAt, new Date()]);
    await sendPasswordChangeOtpEmail(user, code);

    return res.json({ data: { otpSent: true, maskedEmail: maskEmail(user.email) } });
  } catch (error) {
    const message = String(error?.message || error || '');
    if (message.includes('SMTP is not configured'))
      return res.status(500).json({ error: 'Email OTP is not configured. Set SMTP_USER and SMTP_PASS in backend/.env.' });
    if (isSmtpAuthError(error)) {
      console.error('Password OTP SMTP authentication error:', error?.response || error?.message || error);
      return res.status(500).json({
        error: 'Gmail rejected the SMTP credentials. Use a Google App Password in SMTP_PASS, not the Gmail account password.',
      });
    }
    console.error('Password OTP error:', error);
    return res.status(500).json({ error: 'Unable to send password change OTP' });
  }
});

router.put('/password', authenticate, async (req, res) => {
  try {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    const otpCode = String(req.body.otpCode || '').trim();

    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Current password and new password are required' });
    const passwordError = validatePasswordStrength(newPassword);
    if (passwordError)
      return res.status(400).json({ error: passwordError });
    if (!/^\d{6}$/.test(otpCode))
      return res.status(400).json({ error: 'Enter the 6 digit OTP from your email' });

    const [user] = await db.query('SELECT * FROM User WHERE id = ?', [req.user.id]);
    if (!user || !verifyPassword(currentPassword, user.password))
      return res.status(401).json({ error: 'Current password is incorrect' });

    const [otp] = await db.query(`
      SELECT *
      FROM LoginOtp
      WHERE userId = ?
        AND codeHash = ?
        AND consumedAt IS NULL
        AND expiresAt > ?
      ORDER BY createdAt DESC
      LIMIT 1
    `, [user.id, hashOtpCode(otpCode), new Date()]);
    if (!otp)
      return res.status(401).json({ error: 'Invalid or expired OTP' });

    const now = new Date();
    await db.execute('UPDATE LoginOtp SET consumedAt = ? WHERE id = ?', [now, otp.id]);
    await db.execute(`
      UPDATE User
      SET password = ?, passwordSetAt = ?, updatedAt = ?, tokenVersion = tokenVersion + 1
      WHERE id = ?
    `, [hashPassword(newPassword), now, now, user.id]);

    await recordActivity({
      userId: user.id,
      action: 'update',
      entity: 'user',
      entityId: user.id,
      details: `Changed password for ${user.email}`,
      ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
    });

    return res.json({ data: { success: true } });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

export default router;
