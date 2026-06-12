import { db } from '../db.js';
import { Router } from 'express';
import { createNotification, runNotificationReminders, sendNotificationEmail } from '../services/notifications.js';
import { getEmailConfiguration, verifyEmailConnection } from '../services/email.js';
const router = Router();
router.get('/email/status', (_req, res) => {
    return res.json({ data: getEmailConfiguration() });
});
router.post('/email/test', async (_req, res) => {
    try {
        return res.json({ data: { ...(await verifyEmailConnection()), connected: true } });
    }
    catch (error) {
        return res.status(500).json({
            error: String(error.message || error),
            data: { ...getEmailConfiguration(), connected: false },
        });
    }
});
const runReminders = async (req, res) => {
    try {
        if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
            return res.status(401).json({ error: 'Unauthorized' });
        return res.json({ data: await runNotificationReminders() });
    }
    catch (error) {
        console.error('Notification reminder error:', error);
        return res.status(500).json({ error: 'Failed to run notification reminders' });
    }
};
router.get('/run-reminders', runReminders);
router.post('/run-reminders', runReminders);
router.post('/:id/send-email', async (req, res) => {
    try {
        const [notification] = await db.query('SELECT * FROM Notification WHERE id = ?', [req.params.id]);
        if (!notification)
            return res.status(404).json({ error: 'Notification not found' });
        const recipients = req.body.recipients || notification.emailRecipients;
        await db.execute(`
          UPDATE Notification
          SET emailEnabled = 1, emailStatus = 'sending', emailError = NULL, updatedAt = ?
          WHERE id = ?
        `, [new Date(), notification.id]);
        const sentTo = await sendNotificationEmail(notification, recipients);
        await db.execute(`
          UPDATE Notification
          SET emailEnabled = 1, emailStatus = 'sent', emailSentAt = ?, emailRecipients = ?,
              emailError = NULL, updatedAt = ?
          WHERE id = ?
        `, [new Date(), sentTo.join(','), new Date(), notification.id]);
        const [updated] = await db.query('SELECT * FROM Notification WHERE id = ?', [notification.id]);
        return res.json({ data: updated });
    }
    catch (error) {
        await db.execute(`
          UPDATE Notification SET emailStatus = 'failed', emailError = ?, updatedAt = ? WHERE id = ?
        `, [String(error.message || error), new Date(), req.params.id]).catch(() => {});
        return res.status(500).json({ error: String(error.message || error) });
    }
});
// GET /api/notifications/[id]
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const notificationRows = await db.query(`
      SELECT n.*, 
             u.id as userId, u.name as userName, u.avatar as userAvatar
      FROM Notification n
      LEFT JOIN User u ON n.userId = u.id
      WHERE n.id = ?
    `, [id]);
        if (notificationRows.length === 0) {
            return res.status(404).json({ error: 'Notification not found' });
        }
        const row = notificationRows[0];
        const formattedNotification = {
            ...row,
            isRead: Boolean(row.isRead),
            user: row.userId ? {
                id: row.userId,
                name: row.userName,
                avatar: row.userAvatar
            } : null
        };
        return res.json({ data: formattedNotification });
    }
    catch (error) {
        console.error('Notification GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch notification' });
    }
});
// PUT /api/notifications/[id]
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const body = req.body;
        const updates = [];
        const values = [];
        const settableFields = ['title', 'message', 'type', 'category', 'actionUrl'];
        for (const field of settableFields) {
            if (body[field] !== undefined) {
                updates.push(`${field} = ?`);
                values.push(body[field]);
            }
        }
        if (body.isRead !== undefined) {
            updates.push(`isRead = ?`);
            values.push(body.isRead ? 1 : 0);
        }
        updates.push(`updatedAt = ?`);
        values.push(new Date());
        if (updates.length > 0) {
            const sql = `UPDATE Notification SET ${updates.join(', ')} WHERE id = ?`;
            values.push(id);
            await db.execute(sql, values);
        }
        const updatedNotification = await db.query(`SELECT * FROM Notification WHERE id = ?`, [id]);
        return res.json({ data: updatedNotification[0] });
    }
    catch (error) {
        console.error('Notification PUT error:', error);
        return res.status(500).json({ error: 'Failed to update notification' });
    }
});
// DELETE /api/notifications/[id]
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute(`DELETE FROM Notification WHERE id = ?`, [id]);
        return res.json({ data: { id, deleted: true } });
    }
    catch (error) {
        console.error('Notification DELETE error:', error);
        return res.status(500).json({ error: 'Failed to delete notification' });
    }
});
// GET /api/notifications - List notifications with filtering, sorting, pagination
router.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page || '1');
        const limit = parseInt(req.query.limit || '20');
        const type = req.query.type || '';
        const category = req.query.category || '';
        const isRead = req.query.isRead;
        const userId = req.query.userId || '';
        const sortBy = req.query.sortBy || 'createdAt';
        const sortOrder = req.query.sortOrder || 'desc';
        const skip = (page - 1) * limit;
        let whereClause = '1=1';
        const params = [];
        if (type) {
            whereClause += ` AND n.type = ?`;
            params.push(type);
        }
        if (category) {
            whereClause += ` AND n.category = ?`;
            params.push(category);
        }
        if (isRead !== undefined && isRead !== '') {
            whereClause += ` AND n.isRead = ?`;
            params.push(isRead === 'true' ? 1 : 0);
        }
        if (userId) {
            whereClause += ` AND n.userId = ?`;
            params.push(userId);
        }
        const allowedSortColumns = ['title', 'type', 'category', 'isRead', 'createdAt'];
        const safeSortBy = allowedSortColumns.includes(sortBy) ? `n.${sortBy}` : 'n.createdAt';
        const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        const sql = `
      SELECT n.*, 
             u.id as rel_userId, u.name as userName, u.avatar as userAvatar
      FROM Notification n
      LEFT JOIN User u ON n.userId = u.id
      WHERE ${whereClause}
      ORDER BY ${safeSortBy} ${safeSortOrder}
      LIMIT ? OFFSET ?
    `;
        const countSql = `SELECT COUNT(*) as total FROM Notification n WHERE ${whereClause}`;
        const sqlParams = [...params, limit, skip];
        const [notifications, countResult] = await Promise.all([
            db.query(sql, sqlParams),
            db.query(countSql, params)
        ]);
        const formattedNotifications = notifications.map(row => {
            return {
                ...row,
                isRead: Boolean(row.isRead),
                user: row.rel_userId ? {
                    id: row.rel_userId,
                    name: row.userName,
                    avatar: row.userAvatar
                } : null
            };
        });
        const total = Number(countResult[0]?.total || 0);
        return res.json({
            data: formattedNotifications,
            pagination: { total, page, limit }
        });
    }
    catch (error) {
        console.error('Notifications GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});
// POST /api/notifications - Create a new notification
router.post('/', async (req, res) => {
    try {
        const body = req.body;
        if (!body.title || !body.message)
            return res.status(400).json({ error: 'title and message are required' });
        const { notification } = await createNotification({
            ...body,
            emailEnabled: body.emailEnabled || body.sendEmail,
            recipients: body.recipients,
        });
        const id = notification.id;
        const notificationRows = await db.query(`
      SELECT n.*, 
             u.id as rel_userId, u.name as userName, u.avatar as userAvatar
      FROM Notification n
      LEFT JOIN User u ON n.userId = u.id
      WHERE n.id = ?
    `, [id]);
        const row = notificationRows[0];
        const formattedNotification = {
            ...row,
            isRead: Boolean(row.isRead),
            user: row.rel_userId ? { id: row.rel_userId, name: row.userName, avatar: row.userAvatar } : null
        };
        return res.status(201).json({ data: formattedNotification });
    }
    catch (error) {
        console.error('Notifications POST error:', error);
        return res.status(500).json({ error: 'Failed to create notification' });
    }
});
// PUT /api/notifications - Bulk update (mark as read, etc.)
router.put('/', async (req, res) => {
    try {
        const body = req.body;
        if (body.markAllRead) {
            await db.execute(`UPDATE Notification SET isRead = 1 WHERE isRead = 0`);
            return res.json({ data: { markedAllRead: true } });
        }
        if (body.ids && Array.isArray(body.ids) && body.ids.length > 0) {
            const placeholders = body.ids.map(() => '?').join(',');
            const isReadVal = body.isRead !== undefined ? (body.isRead ? 1 : 0) : 1;
            const sql = `UPDATE Notification SET isRead = ? WHERE id IN (${placeholders})`;
            await db.execute(sql, [isReadVal, ...body.ids]);
            return res.status(200).json({ data: { updated: body.ids.length } }); // Note: was 400 in original code by mistake
        }
        return res.json({});
    }
    catch (error) {
        console.error('Notifications PUT error:', error);
        return res.status(500).json({ error: 'Failed to update notifications' });
    }
});
export default router;
