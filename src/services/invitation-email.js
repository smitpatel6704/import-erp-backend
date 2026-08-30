const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const humanizeRole = (role) => String(role || 'user')
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

export function buildInvitationEmail({ user, inviteUrl, logoCid = null }) {
  const appName = process.env.APP_NAME || 'Nexport ERP';
  const safeName = escapeHtml(user.name || 'there');
  const safeEmail = escapeHtml(user.email);
  const safeRole = escapeHtml(humanizeRole(user.role));
  const safeUrl = escapeHtml(inviteUrl);
  const safeAppName = escapeHtml(appName);
  const preheader = `Your ${appName} account is ready. Create your password to get started.`;

  const brand = logoCid
    ? `<img src="cid:${escapeHtml(logoCid)}" alt="${safeAppName}" width="180" style="display:block;max-width:180px;max-height:56px;width:auto;height:auto;border:0;outline:none;text-decoration:none;">`
    : `<div style="font-size:23px;line-height:30px;font-weight:700;letter-spacing:-0.3px;color:#ffffff;">${safeAppName}</div>`;

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${safeAppName} invitation</title></head>
<body style="margin:0;padding:0;background-color:#f3f6f8;font-family:Arial,Helvetica,sans-serif;color:#17202a;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:#f3f6f8;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e2e8ec;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:24px 32px;background-color:#0d8f83;">${brand}</td></tr>
        <tr><td style="padding:38px 32px 14px;">
          <div style="font-size:12px;line-height:18px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#0d8f83;">You’re invited</div>
          <h1 style="margin:8px 0 16px;font-size:28px;line-height:36px;font-weight:700;color:#17202a;">Welcome to ${safeAppName}</h1>
          <p style="margin:0 0 16px;font-size:16px;line-height:25px;color:#4b5563;">Hello ${safeName},</p>
          <p style="margin:0 0 24px;font-size:16px;line-height:25px;color:#4b5563;">An account has been created for you. Set your password to access your workspace and get started.</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 26px;background-color:#f7fafb;border:1px solid #e5eaed;border-radius:8px;">
            <tr><td style="padding:14px 16px;font-size:13px;line-height:20px;color:#6b7280;">Email</td><td align="right" style="padding:14px 16px;font-size:13px;line-height:20px;font-weight:600;color:#17202a;">${safeEmail}</td></tr>
            <tr><td style="padding:0 16px 14px;font-size:13px;line-height:20px;color:#6b7280;">Role</td><td align="right" style="padding:0 16px 14px;font-size:13px;line-height:20px;font-weight:600;color:#17202a;">${safeRole}</td></tr>
          </table>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="#0d8f83" style="border-radius:7px;"><a href="${safeUrl}" target="_blank" style="display:inline-block;padding:14px 24px;font-size:16px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:7px;">Create your password</a></td></tr></table>
          <p style="margin:24px 0 8px;font-size:13px;line-height:21px;color:#6b7280;">This secure link expires in 24 hours. If you weren’t expecting this invitation, you can safely ignore this email.</p>
          <p style="margin:0;font-size:12px;line-height:19px;color:#8a94a0;word-break:break-all;">Button not working? Copy and paste this link into your browser:<br><a href="${safeUrl}" style="color:#0d8f83;text-decoration:underline;">${safeUrl}</a></p>
        </td></tr>
        <tr><td style="padding:22px 32px;border-top:1px solid #edf0f2;font-size:12px;line-height:19px;color:#8a94a0;">This is an automated account invitation from ${safeAppName}. Please do not reply.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Hello ${user.name || 'there'},`, '',
    `You have been invited to ${appName}.`,
    `Account: ${user.email}`,
    `Role: ${humanizeRole(user.role)}`, '',
    `Create your password: ${inviteUrl}`, '',
    'This secure link expires in 24 hours. If you were not expecting this invitation, you can ignore this email.',
  ].join('\n');

  return { subject: `You're invited to ${appName}`, text, html };
}
