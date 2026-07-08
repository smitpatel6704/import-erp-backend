import { Router } from 'express';
import { runDailyCronJobs } from '../services/cron-jobs.js';

const router = Router();

const runDailyJobs = async (req, res) => {
    try {
        const cronSecret = process.env.CRON_SECRET;
        if (!cronSecret) {
            return res.status(503).json({ error: 'CRON_SECRET is not configured' });
        }
        if (req.headers.authorization !== `Bearer ${cronSecret}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const result = await runDailyCronJobs({ triggeredBy: 'cron' });
        return res.json({ data: result });
    }
    catch (error) {
        console.error('Daily cron error:', error);
        return res.status(500).json({ error: 'Failed to run daily jobs' });
    }
};

router.get('/daily', runDailyJobs);
router.post('/daily', runDailyJobs);

export default router;
