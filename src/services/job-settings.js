import { db } from '../db.js';

export const JOB_IDS = [
  'daily',
  'carrier_tracking',
  'eta_email_reminders',
  'document_email_reminders',
  'email_delivery',
  'workflow_automations',
];

const settingKey = (jobId) => `cron_job_enabled_${jobId}`;

export const isKnownJob = (jobId) => JOB_IDS.includes(String(jobId || ''));

export async function isJobEnabled(jobId) {
  if (!isKnownJob(jobId)) return false;
  const [row] = await db.query('SELECT "value" FROM "AppSetting" WHERE "key" = ?', [settingKey(jobId)]);
  return !row || String(row.value).toLowerCase() !== 'false';
}

export async function getJobEnabledStates() {
  const rows = await db.query(
    `SELECT "key", "value" FROM "AppSetting" WHERE "key" LIKE 'cron_job_enabled_%'`,
  );
  const saved = Object.fromEntries(rows.map((row) => [row.key, String(row.value).toLowerCase() !== 'false']));
  return Object.fromEntries(JOB_IDS.map((jobId) => [jobId, saved[settingKey(jobId)] ?? true]));
}

export async function setJobEnabled(jobId, enabled, userId = null) {
  if (!isKnownJob(jobId)) {
    const error = new Error('Unknown job');
    error.status = 404;
    throw error;
  }
  await db.execute(`
    INSERT INTO "AppSetting" ("key", "value", "updatedBy", "updatedAt")
    VALUES (?, ?, ?, NOW())
    ON CONFLICT ("key") DO UPDATE
    SET "value" = EXCLUDED."value", "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = NOW()
  `, [settingKey(jobId), enabled ? 'true' : 'false', userId]);
  return { jobId, enabled: Boolean(enabled) };
}
