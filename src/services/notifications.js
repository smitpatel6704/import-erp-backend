import { createId } from '@paralleldrive/cuid2';
import { db } from '../db.js';
import { isEmailConfigured, sendEmail } from './email.js';

const escapeHtml = (value) => String(value || '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const normalizeRecipients = (recipients) => [...new Set(
  (Array.isArray(recipients) ? recipients : [recipients])
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean)
)];

export async function notificationRecipients(shipmentId) {
  const rows = await db.query(`
    SELECT c.email AS importerEmail, e.email AS exporterEmail
    FROM Shipment s
    LEFT JOIN Company c ON s.companyId = c.id
    LEFT JOIN ExporterCompany e ON s.exporterCompanyId = e.id
    WHERE s.id = ?
  `, [shipmentId]);
  const admins = await db.query(`SELECT email FROM User WHERE isActive = 1 AND role IN ('admin', 'super_admin')`);
  return normalizeRecipients([
    rows[0]?.importerEmail,
    rows[0]?.exporterEmail,
    process.env.NOTIFICATION_EMAIL_TO,
    ...admins.map((admin) => admin.email),
  ]);
}

export async function sendNotificationEmail(notification, recipients) {
  const to = normalizeRecipients(recipients || notification.emailRecipients);
  if (!to.length) throw new Error('No notification email recipients are available');

  await sendEmail({
    to,
    subject: `[${String(notification.priority || 'normal').toUpperCase()}] ${notification.title}`,
    text: `${notification.title}\n\n${notification.message}`,
    html: `<div style="font-family:Arial,sans-serif">
      <h2>${escapeHtml(notification.title)}</h2>
      <p>${escapeHtml(notification.message)}</p>
      <p><strong>Priority:</strong> ${escapeHtml(notification.priority || 'normal')}</p>
    </div>`,
  });
  return to;
}

export async function createNotification(input) {
  const id = createId();
  const recipients = normalizeRecipients(input.recipients);
  const emailEnabled = Boolean(input.emailEnabled || input.priority === 'high' || input.priority === 'critical');

  try {
    await db.execute(`
      INSERT INTO Notification (
        id, userId, title, message, type, category, priority, isRead, actionUrl,
        emailEnabled, emailStatus, emailRecipients, dedupeKey, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, input.userId || null, input.title, input.message, input.type || 'info',
      input.category || 'system', input.priority || 'normal', 0, input.actionUrl || null,
      emailEnabled ? 1 : 0, emailEnabled ? 'pending' : 'not_requested',
      recipients.join(',') || null, input.dedupeKey || null, new Date(), new Date(),
    ]);
  } catch (error) {
    if (input.dedupeKey && String(error).includes('Notification_dedupeKey_key')) {
      const [existing] = await db.query('SELECT * FROM Notification WHERE dedupeKey = ?', [input.dedupeKey]);
      return { notification: existing, duplicate: true };
    }
    throw error;
  }

  const [notification] = await db.query('SELECT * FROM Notification WHERE id = ?', [id]);
  if (emailEnabled) {
    try {
      if (!isEmailConfigured()) throw new Error('SMTP is not configured');
      const sentTo = await sendNotificationEmail(notification, recipients);
      await db.execute(`
        UPDATE Notification
        SET emailStatus = 'sent', emailSentAt = ?, emailRecipients = ?, emailError = NULL, updatedAt = ?
        WHERE id = ?
      `, [new Date(), sentTo.join(','), new Date(), id]);
      notification.emailStatus = 'sent';
      notification.emailSentAt = new Date();
    } catch (error) {
      await db.execute(`
        UPDATE Notification SET emailStatus = 'failed', emailError = ?, updatedAt = ? WHERE id = ?
      `, [String(error.message || error), new Date(), id]);
      notification.emailStatus = 'failed';
      notification.emailError = String(error.message || error);
    }
  }
  return { notification, duplicate: false };
}

export async function runNotificationReminders() {
  const today = new Date();
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const twoDaysStart = new Date(dayStart);
  twoDaysStart.setDate(twoDaysStart.getDate() + 2);
  const dateKey = dayStart.toISOString().slice(0, 10);
  let created = 0;

  const arrivals = await db.query(`
    SELECT id, shipmentNumber, eta, destinationPort
    FROM Shipment
    WHERE isActive = 1 AND eta >= ? AND eta < ? AND status NOT IN ('delivered', 'closed')
  `, [dayStart, twoDaysStart]);

  for (const shipment of arrivals) {
    const eta = new Date(shipment.eta);
    const days = Math.round((new Date(eta.getFullYear(), eta.getMonth(), eta.getDate()) - dayStart) / 86400000);
    const when = days === 0 ? 'today' : 'tomorrow';
    const result = await createNotification({
      title: `Container arrival ${when}`,
      message: `${shipment.shipmentNumber} is expected at ${shipment.destinationPort || 'the destination port'} ${when}.`,
      category: 'eta',
      type: days === 0 ? 'warning' : 'info',
      priority: days === 0 ? 'high' : 'normal',
      actionUrl: `/shipments/${shipment.id}`,
      emailEnabled: true,
      recipients: await notificationRecipients(shipment.id),
      dedupeKey: `eta:${shipment.id}:${dateKey}:${days}`,
    });
    if (!result.duplicate) created += 1;
  }

  const pending = await db.query(`
    SELECT s.id, s.shipmentNumber, COUNT(dc.id) AS pendingCount
    FROM Shipment s
    CROSS JOIN DocumentChecklist dc
    LEFT JOIN ShipmentDocument sd ON sd.shipmentId = s.id AND sd.checklistId = dc.id
    WHERE s.isActive = 1 AND dc.isActive = 1 AND dc.isRequired = 1
      AND (sd.id IS NULL OR sd.status IN ('pending', 'rejected', 'expired'))
    GROUP BY s.id, s.shipmentNumber
  `);

  for (const shipment of pending) {
    const result = await createNotification({
      title: 'Pending shipment documents',
      message: `${shipment.shipmentNumber} has ${shipment.pendingCount} required document(s) pending.`,
      category: 'document',
      type: 'warning',
      priority: 'high',
      actionUrl: `/shipments/${shipment.id}/documents`,
      emailEnabled: true,
      recipients: await notificationRecipients(shipment.id),
      dedupeKey: `documents:${shipment.id}:${dateKey}`,
    });
    if (!result.duplicate) created += 1;
  }

  return { created, arrivalsChecked: arrivals.length, pendingShipmentsChecked: pending.length };
}

let reminderTimer;
export function startNotificationScheduler() {
  if (reminderTimer) return;
  void runNotificationReminders().catch((error) => console.error('Notification reminder scan failed:', error));
  reminderTimer = setInterval(() => {
    void runNotificationReminders().catch((error) => console.error('Notification reminder scan failed:', error));
  }, Number(process.env.NOTIFICATION_SCAN_INTERVAL_MS || 60 * 60 * 1000));
}
