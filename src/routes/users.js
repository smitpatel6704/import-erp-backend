import { Router } from 'express';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '../db.js';
import { createInvitationToken, hashPassword, normalizePermissions } from '../services/auth.js';
import { isEmailConfigured, sendEmail } from '../services/email.js';
import { buildInvitationEmail } from '../services/invitation-email.js';
import { readDocumentFileBuffer } from '../services/document-files.js';

const router = Router();
const appUrl = () => {
  const value = process.env.APP_URL || process.env.FRONTEND_URL;
  if (!value)
    throw new Error('APP_URL or FRONTEND_URL must be configured to create invitation links');
  return value.replace(/\/$/, '');
};

const sendInvitation = async (user, token) => {
  const inviteUrl = `${appUrl()}/setup-password?token=${encodeURIComponent(token)}`;
  if (!isEmailConfigured()) return { inviteUrl, emailSent: false, emailError: 'SMTP is not configured' };
  try {
    const { rows: logoSettings } = await pool.query(`SELECT "value" FROM "AppSetting" WHERE "key" IN ('brand_logo_light', 'brand_logo_collapsed', 'brand_logo_dark') ORDER BY CASE "key" WHEN 'brand_logo_light' THEN 1 WHEN 'brand_logo_collapsed' THEN 2 ELSE 3 END LIMIT 1`);
    let logo = null;
    if (logoSettings[0]?.value?.includes('.blob.vercel-storage.com')) {
      const content = await readDocumentFileBuffer(logoSettings[0].value);
      if (content) {
        const extension = new URL(logoSettings[0].value).pathname.split('.').pop()?.toLowerCase();
        const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
        logo = { fileData: content, mimeType: mimeTypes[extension] || 'image/png' };
      }
    } else {
      const { rows: legacyLogos } = await pool.query(`SELECT "fileData", "mimeType" FROM "BrandLogo" WHERE "mode" IN ('light', 'collapsed', 'dark') ORDER BY CASE "mode" WHEN 'light' THEN 1 WHEN 'collapsed' THEN 2 ELSE 3 END LIMIT 1`);
      logo = legacyLogos[0] || null;
    }
    const logoCid = logo ? 'nexport-brand-logo' : null;
    const email = buildInvitationEmail({ user, inviteUrl, logoCid });
    await sendEmail({
      to: user.email,
      ...email,
      attachments: logo ? [{
        filename: `brand-logo.${logo.mimeType === 'image/svg+xml' ? 'svg' : (logo.mimeType || 'image/png').split('/')[1]}`,
        content: logo.fileData,
        contentType: logo.mimeType || 'image/png',
        cid: logoCid,
      }] : undefined,
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
             isActive, requireOtp, passwordSetAt, lastLoginAt, createdAt, updatedAt
      FROM User WHERE isActive = 1 AND (name LIKE ? OR email LIKE ?) ORDER BY createdAt DESC
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
        isActive, requireOtp, passwordSetupTokenHash, passwordSetupExpiresAt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?)
    `, [
      id, email, body.name, hashPassword(createInvitationToken().token), body.avatar || null,
      body.role || 'user', body.department || null, body.phone || null,
      JSON.stringify(normalizePermissions(body.permissions)), body.isActive === false ? 0 : 1,
      body.requireOtp === false ? 0 : 1, invitation.hash, expiresAt, new Date(), new Date(),
    ]);
    const [user] = await db.query(`
      SELECT id, email, name, avatar, role, department, phone, permissions, isActive, requireOtp, createdAt
      FROM User WHERE id = ?
    `, [id]);
    await pool.query(`
      INSERT INTO "UserInvitation" ("tokenHash", "userId", "expiresAt")
      VALUES ($1, $2, $3)
    `, [invitation.hash, id, expiresAt]);
    const delivery = await sendInvitation(user, invitation.token);
    const safeDelivery = { emailSent: delivery.emailSent };
    if (delivery.emailError) safeDelivery.emailError = delivery.emailError;
    return res.status(201).json({ data: { user, ...safeDelivery } });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

router.post('/:id/resend-invitation', async (req, res) => {
  try {
    const [user] = await db.query('SELECT id, email, name, role, isActive FROM User WHERE id = ?', [req.params.id]);
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
    const fields = ['email', 'name', 'avatar', 'role', 'department', 'phone', 'isActive', 'requireOtp'];
    const updates = [];
    const values = [];
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(['isActive', 'requireOtp'].includes(field) ? (req.body[field] ? 1 : 0) : req.body[field]);
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
      SELECT id, email, name, avatar, role, department, phone, permissions, isActive, requireOtp, updatedAt
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
    const result = await db.execute('UPDATE User SET isActive = 0, updatedAt = ? WHERE id = ?', [new Date(), req.params.id]);
    if (!result.rowCount)
      return res.status(404).json({ error: 'User not found' });
    
    // Invalidate sessions
    await db.execute('UPDATE User SET tokenVersion = tokenVersion + 1 WHERE id = ?', [req.params.id]);

    return res.json({ data: { id: req.params.id, deleted: true } });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

export default router;
