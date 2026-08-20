import { db } from '../db.js';
import { getEmailConfiguration } from './email.js';
import { runNotificationReminders } from './notifications.js';
import { syncDueShipmentTrackings } from './tracking.js';
import { getJobEnabledStates, isJobEnabled } from './job-settings.js';

const jobKeys = (id) => ({
  startedAt: `cron_${id}_last_started_at`,
  finishedAt: `cron_${id}_last_finished_at`,
  result: `cron_${id}_last_result`,
});

const JOBS = [
  {
    id: 'daily',
    name: 'Daily operations cron',
    path: '/api/cron/daily',
    schedule: '30 18 * * * (12:00 AM IST)',
    timezone: 'Asia/Kolkata',
    source: 'Vercel Cron',
    runnable: true,
    description: 'Runs all daily backend automations together.',
  },
  {
    id: 'carrier_tracking',
    name: 'Carrier tracking fetch/scrape',
    path: 'backend scheduler',
    schedule: 'Once daily at 12:00 AM',
    timezone: 'Asia/Kolkata / server local',
    source: 'midnight timer + daily cron',
    runnable: true,
    description: 'Fetches Maersk, MSC, Evergreen, Hapag-Lloyd, and COSCO tracking data for due shipments.',
  },
  {
    id: 'notification_reminders',
    name: 'Notification and email reminders',
    path: 'backend scheduler',
    schedule: 'Once daily at 12:00 AM',
    timezone: 'Asia/Kolkata / server local',
    source: 'midnight timer + daily cron',
    runnable: true,
    description: 'Creates ETA and pending-document reminders. High priority reminders are sent by email when SMTP is configured.',
  },
  {
    id: 'email_delivery',
    name: 'Email delivery automation',
    path: 'SMTP / nodemailer',
    schedule: 'Event triggered',
    timezone: 'Server local',
    source: 'notification, OTP, invitation flows',
    runnable: false,
    description: 'Sends OTP, invitations, and notification emails when another workflow creates an email task.',
  },
  {
    id: 'workflow_automations',
    name: 'Shipment workflow automations',
    path: '/api/shipments',
    schedule: 'Event triggered',
    timezone: 'Server local',
    source: 'shipment create/update',
    runnable: false,
    description: 'Status-change notifications, document requirements, and immediate tracking syncs triggered by shipment changes.',
  },
];

let notificationTimer;
let carrierTrackingTimer;
const millisecondsUntilNextMidnight = (now = new Date()) => {
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);
  return nextMidnight.getTime() - now.getTime();
};

const upsertSetting = async (key, value, userId = null) => {
  await db.execute(`
    INSERT INTO "AppSetting" ("key", "value", "updatedBy", "updatedAt")
    VALUES (?, ?, ?, NOW())
    ON CONFLICT ("key") DO UPDATE
    SET "value" = EXCLUDED."value",
        "updatedBy" = EXCLUDED."updatedBy",
        "updatedAt" = NOW()
  `, [key, String(value || ''), userId]);
};

const readSettings = async (keys) => {
  const rows = await db.query(
    `SELECT "key", "value" FROM "AppSetting" WHERE "key" IN (${keys.map(() => '?').join(', ')})`,
    keys,
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
};

const parseJson = (value, fallback = null) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
};

export const getCronDashboardStatus = async () => {
  const keys = JOBS.flatMap((job) => Object.values(jobKeys(job.id)));
  const settings = await readSettings(keys);
  const enabledStates = await getJobEnabledStates();
  const emailConfig = getEmailConfiguration();
  return {
    cronSecretConfigured: Boolean(process.env.CRON_SECRET),
    email: emailConfig,
    jobs: JOBS.map((job) => {
      const keys = jobKeys(job.id);
      const result = parseJson(settings[keys.result], null);
      return {
        ...job,
        method: job.id === 'daily' ? 'POST' : null,
        enabled: enabledStates[job.id] && (job.id !== 'email_delivery' || emailConfig.configured),
        configured: job.id !== 'email_delivery' || emailConfig.configured,
        lastStartedAt: settings[keys.startedAt] || null,
        lastFinishedAt: settings[keys.finishedAt] || null,
        lastStatus: result?.status || null,
        lastDurationMs: result?.durationMs || null,
        lastRunBy: result?.triggeredBy || null,
        lastResult: result,
      };
    }),
  };
};

const runTrackedJob = async (id, handler, { triggeredBy = 'manual', userId = null } = {}) => {
  if (!(await isJobEnabled(id))) {
    return { status: 'disabled', skipped: true, triggeredBy, jobId: id };
  }
  const keys = jobKeys(id);
  const startedAt = new Date();
  await upsertSetting(keys.startedAt, startedAt.toISOString(), userId);
  try {
    const output = await handler();
    const finishedAt = new Date();
    const result = {
      status: 'success',
      triggeredBy,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      ...output,
    };
    await upsertSetting(keys.finishedAt, finishedAt.toISOString(), userId);
    await upsertSetting(keys.result, JSON.stringify(result), userId);
    return result;
  } catch (error) {
    const finishedAt = new Date();
    const result = {
      status: 'failed',
      triggeredBy,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      error: error?.message || 'Failed to run daily jobs',
    };
    await upsertSetting(keys.finishedAt, finishedAt.toISOString(), userId);
    await upsertSetting(keys.result, JSON.stringify(result), userId);
    throw error;
  }
};

export const runCarrierTrackingJob = async (options = {}) =>
  runTrackedJob('carrier_tracking', async () => ({
    carrierShipmentsChecked: await syncDueShipmentTrackings(),
  }), options);

export const runNotificationReminderJob = async (options = {}) =>
  runTrackedJob('notification_reminders', async () => ({
    notifications: await runNotificationReminders(),
  }), options);

export const runDailyCronJobs = async ({ triggeredBy = 'cron', userId = null } = {}) =>
  runTrackedJob('daily', async () => {
    const carrierTracking = await runCarrierTrackingJob({ triggeredBy, userId });
    const notificationReminders = await runNotificationReminderJob({ triggeredBy, userId });
    return {
      carrierShipmentsChecked: carrierTracking.carrierShipmentsChecked,
      notifications: notificationReminders.notifications,
      jobs: {
        carrierTracking,
        notificationReminders,
      },
    };
  }, { triggeredBy, userId });

export const runCronJobById = async (jobId, options = {}) => {
  if (jobId === 'daily') return runDailyCronJobs(options);
  if (jobId === 'carrier_tracking') return runCarrierTrackingJob(options);
  if (jobId === 'notification_reminders') return runNotificationReminderJob(options);
  const error = new Error('This automation is event-triggered and cannot be run manually.');
  error.status = 400;
  throw error;
};

export function startCronJobSchedulers() {
  if (!carrierTrackingTimer) {
    const scheduleNextCarrierTrackingRun = () => {
      carrierTrackingTimer = setTimeout(async () => {
        await runCarrierTrackingJob({ triggeredBy: 'scheduler' }).catch((error) => {
          console.error('Scheduled carrier tracking sync failed:', error);
        });
        scheduleNextCarrierTrackingRun();
      }, millisecondsUntilNextMidnight());
    };
    scheduleNextCarrierTrackingRun();
  }
  if (!notificationTimer) {
    const scheduleNextNotificationRun = () => {
      notificationTimer = setTimeout(async () => {
        await runNotificationReminderJob({ triggeredBy: 'scheduler' }).catch((error) => {
          console.error('Notification reminder scan failed:', error);
        });
        scheduleNextNotificationRun();
      }, millisecondsUntilNextMidnight());
    };
    scheduleNextNotificationRun();
  }
}
