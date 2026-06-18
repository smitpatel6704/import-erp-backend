import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'crypto';
import { db } from '../db.js';

const SESSION_TTL_SECONDS = 60 * 60 * 12;
const isProduction = () => process.env.NODE_ENV === 'production' || process.env.VERCEL;
const secret = () => {
  const value = process.env.AUTH_SECRET || (!isProduction() ? process.env.CRON_SECRET : '');
  if (value && value !== 'replace-with-a-long-random-secret') return value;
  if (isProduction()) throw new Error('AUTH_SECRET must be configured in production');
  return 'nexport-local-development-secret';
};

const encode = (value) => Buffer.from(value).toString('base64url');
const sign = (value) => createHmac('sha256', secret()).update(value).digest('base64url');

export const hashPassword = (password) => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
};

export const verifyPassword = (password, storedHash) => {
  const [algorithm, salt, hash] = String(storedHash || '').split(':');
  if (algorithm !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export const createSessionToken = (user) => {
  const payload = encode(JSON.stringify({
    sub: user.id,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  }));
  return `${payload}.${sign(payload)}`;
};

export const createPendingOtpToken = (user) => {
  const payload = encode(JSON.stringify({
    sub: user.id,
    purpose: 'otp_login',
    exp: Math.floor(Date.now() / 1000) + 5 * 60,
  }));
  return `${payload}.${sign(payload)}`;
};

export const createOtpCode = () => String(randomInt(0, 1000000)).padStart(6, '0');

export const hashOtpCode = (code) =>
  createHmac('sha256', secret()).update(String(code || '').trim()).digest('hex');

const parseSessionToken = (token) => {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!parsed.sub || parsed.exp < Math.floor(Date.now() / 1000)) return null;
  return parsed;
};

export const verifyPendingOtpToken = (token) => {
  const parsed = parseSessionToken(token);
  if (!parsed || parsed.purpose !== 'otp_login')
    return null;
  return parsed;
};

export const createInvitationToken = () => {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: createHmac('sha256', secret()).update(token).digest('hex'),
  };
};

export const hashInvitationToken = (token) =>
  createHmac('sha256', secret()).update(String(token || '')).digest('hex');

export const normalizePermissions = (permissions) => {
  if (!Array.isArray(permissions)) return [];
  return permissions
    .filter((item) => item && typeof item.module === 'string')
    .map((item) => ({
      module: item.module,
      access: item.access === 'edit' ? 'edit' : 'view',
    }));
};

export const permissionFor = (user, module) => {
  if (user?.role === 'admin' || user?.role === 'super_admin') return 'edit';
  const permissions = normalizePermissions(user?.permissions);
  return permissions.find((item) => item.module === module)?.access || null;
};

export async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const parsed = parseSessionToken(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (!parsed) return res.status(401).json({ error: 'Authentication required' });
    const [user] = await db.query(`
      SELECT id, email, name, avatar, role, department, phone, permissions, isActive
      FROM User WHERE id = ?
    `, [parsed.sub]);
    if (!user || !user.isActive) return res.status(401).json({ error: 'Account is inactive or unavailable' });
    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid session' });
  }
}

export const requireAdmin = (req, res, next) => {
  if (!['admin', 'super_admin'].includes(req.user?.role))
    return res.status(403).json({ error: 'Administrator access required' });
  return next();
};

export const requireModulePermission = (module) => (req, res, next) => {
  const access = permissionFor(req.user, module);
  const writeRequest = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (!access || (writeRequest && access !== 'edit'))
    return res.status(403).json({ error: `You do not have ${writeRequest ? 'edit' : 'view'} access to ${module}` });
  return next();
};
