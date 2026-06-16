import nodemailer from 'nodemailer';
import * as dotenv from 'dotenv';

dotenv.config();

const smtpConfig = () => {
  const user = process.env.SMTP_USER || process.env.GMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;

  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_SECURE || 'true') === 'true',
    auth: { user, pass },
  };
};

let transporter;

const getTransporter = () => {
  const config = smtpConfig();
  if (!config) throw new Error('SMTP is not configured');
  if (!transporter) transporter = nodemailer.createTransport(config);
  return { config, transporter };
};

export const isEmailConfigured = () => Boolean(smtpConfig());

export const getEmailConfiguration = () => {
  const config = smtpConfig();
  return {
    configured: Boolean(config),
    provider: 'gmail-smtp',
    host: config?.host || 'smtp.gmail.com',
    port: config?.port || 465,
    secure: config?.secure ?? true,
    from: process.env.SMTP_FROM || (config ? `NEXPORT ERP <${config.auth.user}>` : null),
  };
};

export async function verifyEmailConnection() {
  const { transporter: smtpTransporter } = getTransporter();
  await smtpTransporter.verify();
  return getEmailConfiguration();
}

export async function sendEmail({ to, subject, text, html }) {
  const { config, transporter: smtpTransporter } = getTransporter();

  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (!recipients.length) throw new Error('At least one email recipient is required');

  return smtpTransporter.sendMail({
    from: process.env.SMTP_FROM || `NEXPORT ERP <${config.auth.user}>`,
    to: recipients.join(', '),
    subject,
    text,
    html,
  });
}
