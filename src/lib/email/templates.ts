import type { EmailMessage } from './index.js'

function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function inviteEmail(params: {
    appUrl: string
    token: string
    tenantName: string
    inviterName: string
    role: string
}): EmailMessage {
    const link = `${params.appUrl}/accept-invite?token=${params.token}`
    const text = [
        `You've been invited to join ${params.tenantName} on DapplePot.`,
        ``,
        `Invited by: ${params.inviterName}`,
        `Your role:  ${params.role}`,
        ``,
        `Accept your invitation here:`,
        link,
        ``,
        `This link expires in 7 days.`,
        `If you did not expect this invitation, you can safely ignore this email.`,
    ].join('\n')

    const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin-bottom:4px">You've been invited to DapplePot</h2>
  <p style="color:#555;margin-top:0">${params.tenantName}</p>
  <p>
    <strong>${params.inviterName}</strong> has invited you to join as
    <strong>${params.role}</strong>.
  </p>
  <p style="margin:32px 0">
    <a href="${link}"
       style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
      Accept Invitation
    </a>
  </p>
  <p style="color:#888;font-size:13px">This link expires in 7 days.</p>
  <p style="color:#888;font-size:13px">If you did not expect this, you can safely ignore this email.</p>
</body>
</html>`

    return {
        to: '',
        subject: `You've been invited to ${params.tenantName} on DapplePot`,
        html,
        text,
    }
}

export function resetEmail(params: {
    appUrl: string
    token: string
    userName: string
}): EmailMessage {
    const link = `${params.appUrl}/reset-password?token=${params.token}`
    const text = [
        `Hi ${params.userName},`,
        ``,
        `You requested a password reset for your DapplePot account.`,
        ``,
        `Reset your password here:`,
        link,
        ``,
        `This link expires in 1 hour.`,
        `If you did not request this, you can safely ignore this email.`,
    ].join('\n')

    const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h2>Reset your DapplePot password</h2>
  <p>Hi ${escapeHtml(params.userName)},</p>
  <p>You requested a password reset. Click the button below to choose a new password.</p>
  <p style="margin:32px 0">
    <a href="${link}"
       style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
      Reset Password
    </a>
  </p>
  <p style="color:#888;font-size:13px">This link expires in 1 hour.</p>
  <p style="color:#888;font-size:13px">If you did not request this, you can safely ignore this email.</p>
</body>
</html>`

    return {
        to: '',
        subject: 'Reset your DapplePot password',
        html,
        text,
    }
}

export function verifyEmailEmail(params: {
    appUrl: string
    token: string
    userName: string
}): EmailMessage {
    const link = `${params.appUrl}/verify-email?token=${params.token}`
    const text = [
        `Hi ${params.userName},`,
        ``,
        `Welcome to DapplePot! Please verify your email to start using the platform.`,
        ``,
        `Verify your email here:`,
        link,
        ``,
        `This link expires in 24 hours.`,
        `If you did not sign up for DapplePot, you can safely ignore this email.`,
    ].join('\n')

    const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h2>Verify your email</h2>
  <p>Hi ${escapeHtml(params.userName)},</p>
  <p>Welcome to DapplePot! Click the button below to verify your email and start using the platform.</p>
  <p style="margin:32px 0">
    <a href="${link}"
       style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
      Verify Email
    </a>
  </p>
  <p style="color:#888;font-size:13px">This link expires in 24 hours.</p>
  <p style="color:#888;font-size:13px">If you did not sign up for DapplePot, you can safely ignore this email.</p>
</body>
</html>`

    return {
        to: '',
        subject: 'Verify your DapplePot email',
        html,
        text,
    }
}

export function securityAlertEmail(params: {
    alert: Record<string, any>
    appUrl: string
}): EmailMessage {
    const link = `${params.appUrl}/detection?alertId=${params.alert.alertId}`
    const text = [
        `🚨 DapplePot Security Alert: ${params.alert.title}`,
        `Severity: ${params.alert.severity.toUpperCase()}`,
        `Rule: ${params.alert.ruleName}`,
        `Triggered: ${params.alert.triggeredAt}`,
        params.alert.message || '',
        `View alert: ${link}`
    ].join('\n')

    const html = `
<!DOCTYPE html>
<html>
<body>
  <h2>🚨 DapplePot Security Alert</h2>
  <p><strong>${params.alert.title}</strong></p>
  <p><strong>Severity:</strong> ${params.alert.severity.toUpperCase()}</p>
  <p><strong>Rule:</strong> ${params.alert.ruleName}</p>
  <p><strong>Triggered:</strong> ${params.alert.triggeredAt}</p>
  <p>${params.alert.message || ''}</p>
  <p><a href="${link}">View Alert Details</a></p>
</body>
</html>`

    return {
        to: '',
        subject: `[DapplePot] ${params.alert.severity.toUpperCase()}: ${params.alert.title}`,
        html,
        text,
    }
}
