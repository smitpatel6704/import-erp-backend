import { Router } from 'express';
import { runNotificationReminders } from '../services/notifications.js';
import { syncDueShipmentTrackings } from '../services/tracking.js';

const router = Router();

const runDailyJobs = async (req, res) => {
    try {
        const cronSecret = process.env.CRON_SECRET;
        if ((process.env.NODE_ENV === 'production' || process.env.VERCEL) && !cronSecret) {
            return res.status(503).json({ error: 'CRON_SECRET is not configured' });
        }
        if (cronSecret &&
            req.headers.authorization !== `Bearer ${cronSecret}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const carrierShipments = await syncDueShipmentTrackings();
        const notifications = await runNotificationReminders();
        return res.json({
            data: {
                notifications,
                carrierShipmentsChecked: carrierShipments,
            },
        });
    }
    catch (error) {
        console.error('Daily cron error:', error);
        return res.status(500).json({ error: 'Failed to run daily jobs' });
    }
};

router.get('/daily', runDailyJobs);
router.post('/daily', runDailyJobs);

export default router;
