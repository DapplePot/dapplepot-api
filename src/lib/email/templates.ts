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

// ─────────────────────────────────────────────────────────────────────────────
// Superadmin "Onboard Client" wizard — confirmation emails
// ─────────────────────────────────────────────────────────────────────────────

type OnboardPlan = 'Internal' | 'Enterprise'

/**
 * Sent when a superadmin creates a brand-new DapplePot user via the Onboard
 * Client wizard. Includes a password-set link instead of sharing the raw
 * password the superadmin typed — safer for handoff.
 */
export function onboardNewUserEmail(params: {
    appUrl:        string
    resetToken:    string
    userName:      string
    userEmail:     string
    tenantName:    string
    plan:          OnboardPlan
}): EmailMessage {
    const setupLink = `${params.appUrl}/reset-password?token=${params.resetToken}`
    const planLabel = params.plan === 'Internal' ? 'Internal (comp)' : 'Enterprise'
    const text = [
        `Hi ${params.userName},`,
        ``,
        `Your DapplePot account is ready.`,
        ``,
        `Workspace: ${params.tenantName}`,
        `Plan:      ${planLabel}`,
        `Email:     ${params.userEmail}`,
        ``,
        `Set up your password to log in:`,
        setupLink,
        ``,
        `This setup link expires in 1 hour.`,
        `If you weren't expecting this, you can safely ignore this email.`,
    ].join('\n')

    const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin-bottom:4px">Welcome to DapplePot</h2>
  <p style="color:#555;margin-top:0">${escapeHtml(params.tenantName)} — ${planLabel}</p>
  <p>Hi ${escapeHtml(params.userName)},</p>
  <p>A DapplePot workspace has been provisioned for you. Click below to set your password and log in.</p>
  <p style="margin:32px 0">
    <a href="${setupLink}"
       style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
      Set up your password
    </a>
  </p>
  <p style="color:#888;font-size:13px">Workspace: <strong>${escapeHtml(params.tenantName)}</strong></p>
  <p style="color:#888;font-size:13px">Plan: <strong>${planLabel}</strong></p>
  <p style="color:#888;font-size:13px">This setup link expires in 1 hour.</p>
</body>
</html>`

    return {
        to: '',
        subject: `Welcome to DapplePot — ${params.tenantName}`,
        html,
        text,
    }
}

/**
 * Sent when a superadmin links an existing DapplePot user as the admin of
 * a newly-created Internal-Org or Enterprise workspace. Their existing
 * account is unchanged — they just see a new workspace in the sidebar.
 */
export function onboardLinkedExistingUserEmail(params: {
    appUrl:     string
    userName:   string
    tenantName: string
    plan:       OnboardPlan
}): EmailMessage {
    const link = `${params.appUrl}/`
    const planLabel = params.plan === 'Internal' ? 'Internal (comp)' : 'Enterprise'
    const text = [
        `Hi ${params.userName},`,
        ``,
        `You've been added as admin to a new DapplePot workspace.`,
        ``,
        `Workspace: ${params.tenantName}`,
        `Plan:      ${planLabel}`,
        ``,
        `Log in and use the workspace switcher in the sidebar to access it:`,
        link,
        ``,
        `Your existing workspaces are unchanged.`,
    ].join('\n')

    const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin-bottom:4px">You've been added to a new workspace</h2>
  <p style="color:#555;margin-top:0">${escapeHtml(params.tenantName)} — ${planLabel}</p>
  <p>Hi ${escapeHtml(params.userName)},</p>
  <p>
    A new DapplePot workspace has been provisioned and you've been added as
    <strong>admin</strong>. Your existing workspaces are unchanged — use the
    workspace switcher in the sidebar to move between them.
  </p>
  <p style="margin:32px 0">
    <a href="${link}"
       style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
      Open DapplePot
    </a>
  </p>
  <p style="color:#888;font-size:13px">Workspace: <strong>${escapeHtml(params.tenantName)}</strong></p>
  <p style="color:#888;font-size:13px">Plan: <strong>${planLabel}</strong></p>
</body>
</html>`

    return {
        to: '',
        subject: `You've been added to ${params.tenantName}`,
        html,
        text,
    }
}

/**
 * Sent when a superadmin Internal-Individual onboards an existing user
 * whose personal workspace gets upgraded to plan_tier='internal'.
 */
export function onboardWorkspaceUpgradedEmail(params: {
    appUrl:     string
    userName:   string
    tenantName: string
}): EmailMessage {
    const link = `${params.appUrl}/`
    const text = [
        `Hi ${params.userName},`,
        ``,
        `Good news — your personal workspace "${params.tenantName}" has been`,
        `upgraded to the Internal (comp) plan.`,
        ``,
        `What changed:`,
        `  - No more trial timer or quota`,
        `  - Unlimited agents, seats, and events`,
        `  - Any active paid subscription on this workspace is cancelled`,
        ``,
        `Your data, password, and SDK key are unchanged. Just log in normally:`,
        link,
    ].join('\n')

    const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin-bottom:4px">Your workspace has been upgraded</h2>
  <p style="color:#555;margin-top:0">${escapeHtml(params.tenantName)} → Internal (comp)</p>
  <p>Hi ${escapeHtml(params.userName)},</p>
  <p>
    Your personal workspace <strong>${escapeHtml(params.tenantName)}</strong> has
    been upgraded to the Internal (comp) plan. No more trial timer, no quotas, and
    your data + SDK key are unchanged.
  </p>
  <p style="color:#555">
    Any active paid subscription on this workspace has been cancelled — you won't
    be billed further.
  </p>
  <p style="margin:32px 0">
    <a href="${link}"
       style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
      Open DapplePot
    </a>
  </p>
</body>
</html>`

    return {
        to: '',
        subject: `Your DapplePot workspace has been upgraded`,
        html,
        text,
    }
}
