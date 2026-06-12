import nodemailer from 'nodemailer';

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

export const isEmailConfigured = () => Boolean(smtpConfig());

export async function sendEmail({ to, subject, text, html }) {
  const config = smtpConfig();
  if (!config) throw new Error('SMTP is not configured');

  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (!recipients.length) throw new Error('At least one email recipient is required');

  const transporter = nodemailer.createTransport(config);
  return transporter.sendMail({
    from: process.env.SMTP_FROM || `NEXPORT ERP <${config.auth.user}>`,
    to: recipients.join(', '),
    subject,
    text,
    html,
  });
}
