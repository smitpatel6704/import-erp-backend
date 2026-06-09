import { db } from '../db.js';
import { Router } from 'express';
import { createId } from '@paralleldrive/cuid2';
const router = Router();
// GET /api/activities - List activity logs with filtering, sorting, pagination
router.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page || '1');
        const limit = parseInt(req.query.limit || '20');
        const action = req.query.action || '';
        const entity = req.query.entity || '';
        const userId = req.query.userId || '';
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
        const countRows = await db.query(`SELECT COUNT(*) as c FROM Activity WHERE ${whereClause}`, params);
        const total = countRows[0].c;
        const allowedSort = ['createdAt', 'action', 'entity'].includes(sortBy) ? sortBy : 'createdAt';
        const allowedDir = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const queryParams = [...params, limit, skip];
        const activities = await db.query(`
      SELECT a.*, u.name as userName, u.avatar as userAvatar, u.role as userRole 
      FROM Activity a 
      LEFT JOIN User u ON a.userId = u.id 
      WHERE ${whereClause} 
      ORDER BY a.${allowedSort} ${allowedDir} 
      LIMIT ? OFFSET ?
    `, queryParams);
        const formattedActivities = activities.map((a) => ({
            ...a,
            user: a.userId ? { id: a.userId, name: a.userName, avatar: a.userAvatar, role: a.userRole } : null,
            userName: undefined,
            userAvatar: undefined,
            userRole: undefined
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
