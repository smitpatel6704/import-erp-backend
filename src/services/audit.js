import { createId } from '@paralleldrive/cuid2';
import { db } from '../db.js';

const actionForMethod = (method) => {
  switch (method) {
    case 'POST':
      return 'create';
    case 'PUT':
    case 'PATCH':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return null;
  }
};

const labelForEntity = (entity) =>
  String(entity || 'record')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const displayValue = (data) => {
  if (!data || typeof data !== 'object') return null;
  return data.shipmentNumber || data.containerNumber || data.invoiceNumber || data.name ||
    data.email || data.documentType || data.category || data.id || null;
};

const entityIdFromResponse = (body) => {
  const data = body?.data;
  if (data?.id) return data.id;
  if (data?.user?.id) return data.user.id;
  if (data?.deleted && data?.id) return data.id;
  return null;
};

const entityIdFromPath = (path) => {
  const parts = String(path || '').split('?')[0].split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last || ['options', 'upload', 'merge', 'status'].includes(last)) return null;
  return last;
};

const detailForActivity = ({ action, entity, body, path }) => {
  const data = body?.data?.user || body?.data;
  const value = displayValue(data);
  const actionLabel = action === 'create' ? 'Created' : action === 'update' ? 'Updated' : 'Deleted';
  const entityLabel = labelForEntity(entity);
  if (entity === 'user' && action === 'create')
    return `Invited user${value ? ` ${value}` : ''}`;
  if (entity === 'user_invitation' && action === 'create')
    return `Resent invitation${value ? ` to ${value}` : ''}`;
  return `${actionLabel} ${entityLabel}${value ? ` ${value}` : ''}`;
};

export const recordActivity = async ({
  userId,
  action,
  entity,
  entityId = null,
  details = null,
  ipAddress = null,
}) => {
  if (!userId || !action || !entity) return;
  try {
    await db.execute(`
      INSERT INTO Activity (id, userId, action, entity, entityId, details, ipAddress, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      createId(),
      userId,
      action,
      entity,
      entityId,
      details,
      ipAddress,
      new Date(),
    ]);
  } catch (error) {
    console.error('Audit log error:', error);
  }
};

export const auditMutation = (entityOrResolver) => async (req, res, next) => {
  const action = actionForMethod(req.method);
  if (!action) return next();

  let responseBody = null;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    responseBody = body;
    return originalJson(body);
  };

  res.on('finish', async () => {
    if (res.statusCode >= 400 || !req.user?.id) return;
    try {
      const entity = typeof entityOrResolver === 'function'
        ? entityOrResolver(req, responseBody)
        : entityOrResolver;
      if (!entity) return;
      const entityId = entityIdFromResponse(responseBody) || entityIdFromPath(req.path);
      await recordActivity({
        userId: req.user.id,
        action,
        entity,
        entityId,
        details: detailForActivity({ action, entity, body: responseBody, path: req.originalUrl }),
        ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
      });
    } catch (error) {
      console.error('Audit log error:', error);
    }
  });

  return next();
};
