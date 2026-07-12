import { db } from '../db.js';
import { Router } from 'express';
import { createId } from '@paralleldrive/cuid2';
const router = Router();

const shipmentActionLabel = (action) => {
    if (action === 'create')
        return 'Created Shipment';
    if (action === 'update')
        return 'Updated Shipment';
    if (action === 'delete')
        return 'Deleted Shipment';
    return 'Shipment';
};

const buildShipmentDetails = (activity, shipment) => {
    if (activity.details && (/\bchanged from\b/i.test(activity.details) || /\bChanges:\s/i.test(activity.details)))
        return activity.details;
    if (!shipment)
        return activity.details;
    const parties = [
        shipment.importerName ? `Importer: ${shipment.importerName}` : null,
        shipment.exporterName ? `Exporter: ${shipment.exporterName}` : null,
    ].filter(Boolean);
    const partyText = parties.length ? ` — ${parties.join(' | ')}` : '';
    const shipmentNumber = shipment.shipmentNumber || shipment.blNumber || activity.entityId;
    return `${shipmentActionLabel(activity.action)}${shipmentNumber ? ` ${shipmentNumber}` : ''}${partyText}`;
};

// GET /api/activities - List activity logs with filtering, sorting, pagination
router.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page || '1');
        const limit = parseInt(req.query.limit || '20');
    const action = req.query.action || '';
    const entity = req.query.entity || '';
    const userId = req.query.userId || '';
    const adminOnly = req.query.adminOnly === 'true';
        const sortBy = req.query.sortBy || 'createdAt';
        const sortOrder = req.query.sortOrder || 'desc';
        const skip = (page - 1) * limit;
        let whereClause = '1=1';
        const params = [];
        if (action) {
            whereClause += ' AND action = ?';
            params.push(action);
        }
        if (entity) {
            const entities = entity.split(',');
            whereClause += ` AND entity IN (${entities.map(() => '?').join(',')})`;
            params.push(...entities);
        }
    if (userId) {
      whereClause += ' AND userId = ?';
      params.push(userId);
    }
    if (adminOnly) {
      const adminUsers = await db.query(
        `SELECT id FROM User WHERE role IN ('admin', 'super_admin')`
      );

      if (adminUsers.length === 0) {
        whereClause += ' AND 1 = 0';
      } else {
        whereClause += ` AND userId IN (${adminUsers.map(() => '?').join(', ')})`;
        params.push(...adminUsers.map((user) => user.id));
      }
    }
        const countRows = await db.query(`SELECT COUNT(*) as c FROM Activity WHERE ${whereClause}`, params);
        const total = countRows[0].c;
        const allowedSort = ['createdAt', 'action', 'entity'].includes(sortBy) ? sortBy : 'createdAt';
        const allowedDir = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const queryParams = [...params, limit, skip];
        const activities = await db.query(`
      SELECT a.*, u.name as userName, u.avatar as userAvatar, u.role as userRole,
             u.department as userDepartment
      FROM Activity a 
      LEFT JOIN User u ON a.userId = u.id 
      WHERE ${whereClause} 
      ORDER BY a.${allowedSort} ${allowedDir} 
      LIMIT ? OFFSET ?
    `, queryParams);
        const shipmentIds = [...new Set(activities
            .filter((activity) => activity.entity === 'shipment' && activity.entityId)
            .map((activity) => activity.entityId))];
        const shipmentById = new Map();
        if (shipmentIds.length) {
            const shipmentRows = await db.query(`
              SELECT
                s.id,
                s.shipmentNumber,
                s.blNumber,
                c.name AS importerName,
                e.name AS exporterName
              FROM Shipment s
              LEFT JOIN Company c ON s.companyId = c.id
              LEFT JOIN ExporterCompany e ON s.exporterCompanyId = e.id
              WHERE s.id IN (${shipmentIds.map(() => '?').join(',')})
            `, shipmentIds);
            shipmentRows.forEach((shipment) => shipmentById.set(shipment.id, shipment));
        }
        const formattedActivities = activities.map((a) => ({
            ...a,
            details: a.entity === 'shipment'
                ? buildShipmentDetails(a, shipmentById.get(a.entityId))
                : a.details,
            user: a.userId ? {
                id: a.userId,
                name: a.userName,
                avatar: a.userAvatar,
                role: a.userRole,
                department: a.userDepartment,
            } : null,
            userName: undefined,
            userAvatar: undefined,
            userRole: undefined,
            userDepartment: undefined
        }));
        return res.json({ data: formattedActivities, pagination: { total, page, limit } });
    }
    catch (error) {
        console.error('Activities GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch activities' });
    }
});
// POST /api/activities - Create a new activity log
router.post('/', async (req, res) => {
    try {
        const body = req.body;
        const id = createId();
        await db.execute(`
      INSERT INTO Activity (id, userId, action, entity, entityId, details, ipAddress, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            id, body.userId || null, body.action || null, body.entity || null, body.entityId || null,
            body.details ? JSON.stringify(body.details) : null, body.ipAddress || null, new Date()
        ]);
        const activities = await db.query(`
      SELECT a.*, u.name as userName, u.avatar as userAvatar 
      FROM Activity a 
      LEFT JOIN User u ON a.userId = u.id 
      WHERE a.id = ?
    `, [id]);
        const activity = activities[0];
        if (activity) {
            activity.user = activity.userId ? { id: activity.userId, name: activity.userName, avatar: activity.userAvatar } : null;
            delete activity.userName;
            delete activity.userAvatar;
        }
        return res.status(201).json({ data: activity });
    }
    catch (error) {
        console.error('Activities POST error:', error);
        return res.status(500).json({ error: 'Failed to create activity' });
    }
});
export default router;
