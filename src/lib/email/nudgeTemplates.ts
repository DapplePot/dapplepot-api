import type { EmailMessage } from './index.js'
import { env } from '../../env.js'

export type QuotaWarningKind     = '80' | '100'
export type TrialMilestoneKind   = 'day_25' | 'day_30'
export type LifecycleKind        = 'readonly_warning_30d' | 'suspension_warning' | 'deletion_warning_30d' | 'deletion_imminent'

const APP_URL = env.APP_URL ?? 'https://app.dapplepot.com'

function shell(title: string, body: string, ctaLabel: string, ctaUrl: string): string {
    return `
<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
  <h1 style="margin:0 0 12px;font-size:18px;font-weight:600">${title}</h1>
  <div style="font-size:14px;line-height:1.55;color:#334155">${body}</div>
  <p style="margin:24px 0 0">
    <a href="${ctaUrl}" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:500;text-decoration:none">${ctaLabel}</a>
  </p>
  <hr style="border:0;border-top:1px solid #e2e8f0;margin:32px 0 16px"/>
  <p style="font-size:11px;color:#94a3b8">DapplePot — AI Agent Security & Observability</p>
</div>`
}

// ─────────────────────────────────────────────────────────────────────────────
// Quota warnings
// ─────────────────────────────────────────────────────────────────────────────

export function quotaWarningEmail(p: { to: string; kind: QuotaWarningKind }): EmailMessage {
    if (p.kind === '80') {
        return {
            to:      p.to,
            subject: "You're approaching your monthly event quota",
            text:    `You've used 80% of your DapplePot event quota for this billing period. Upgrade to keep your agents covered: ${APP_URL}/upgrade`,
            html:    shell(
                "You're approaching your quota",
                `You've used <strong>80%</strong> of your monthly billed-event quota. To avoid your agents losing security coverage, upgrade now or top up.`,
                'View usage',
                `${APP_URL}/settings`,
            ),
        }
    }
    return {
        to:      p.to,
        subject: "You've hit your monthly event quota",
        text:    `You've consumed your DapplePot event quota for this period. Upgrade now to restore security coverage: ${APP_URL}/upgrade`,
        html:    shell(
            "You've hit your event quota",
            `Your monthly billed-event quota is exhausted. New events from your agents are being rejected. Upgrade now to restore real-time security detection.`,
            'Upgrade plan',
            `${APP_URL}/upgrade`,
        ),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Trial milestones
// ─────────────────────────────────────────────────────────────────────────────

export function trialMilestoneEmail(p: { to: string; kind: TrialMilestoneKind }): EmailMessage {
    switch (p.kind) {
        case 'day_25':
            return {
                to:      p.to,
                subject: '5 days left in your trial',
                text:    `Your DapplePot trial ends in 5 days. Lock in 2 months free by upgrading to annual: ${APP_URL}`,
                html:    shell(
                    '5 days left in your trial',
                    `Your free trial ends in <strong>5 days</strong>. Annual billing saves you 2 months — lock it in before your trial expires.`,
                    'See plans',
                    APP_URL,
                ),
            }
        case 'day_30':
            return {
                to:      p.to,
                subject: 'Your trial ends today — read-only mode starts tomorrow',
                text:    `Your DapplePot trial expires today. Your account becomes read-only tomorrow — no new events, agents, or config changes. Upgrade to keep going: ${APP_URL}`,
                html:    shell(
                    'Your trial ends today',
                    `Your free trial expires today. Tomorrow your account enters <strong>read-only mode</strong> — you can still view existing data, but new events, agents, and config changes are blocked.<br/><br/>You'll have 90 days in read-only before the account is suspended. Upgrade now to keep everything running.`,
                    'Upgrade now',
                    APP_URL,
                ),
            }
    }
}

export function lifecycleEmail(p: { to: string; kind: LifecycleKind }): EmailMessage {
    switch (p.kind) {
        case 'readonly_warning_30d':
            return {
                to:      p.to,
                subject: '30 days left of read-only access',
                text:    `Your DapplePot account has been read-only for 60 days. In 30 days it will be suspended (you won't be able to log in). Upgrade to restore full access: ${APP_URL}`,
                html:    shell(
                    '30 days left of read-only access',
                    `Your account has been in read-only mode for 60 days. In <strong>30 days</strong> it will be suspended — you won't be able to log in or view your data. Upgrade now to restore full access and keep your data live.`,
                    'Upgrade now',
                    APP_URL,
                ),
            }
        case 'suspension_warning':
            return {
                to:      p.to,
                subject: 'Your account is now suspended',
                text:    `Your DapplePot account has been suspended. You can log in to upgrade, but no other features are available. Data will be permanently deleted in 90 days. Upgrade: ${APP_URL}`,
                html:    shell(
                    'Account suspended',
                    `Your DapplePot account has been suspended after 90 days of read-only inactivity. The only thing you can do now is upgrade or log out.<br/><br/><strong>Your data will be permanently deleted in 90 days.</strong> Upgrade now to restore full access immediately.`,
                    'Upgrade now',
                    APP_URL,
                ),
            }
        case 'deletion_warning_30d':
            return {
                to:      p.to,
                subject: 'Final warning — your data will be deleted in 30 days',
                text:    `Your DapplePot account data will be permanently deleted in 30 days. Upgrade now to retain it: ${APP_URL}`,
                html:    shell(
                    'Data deletion in 30 days',
                    `Your DapplePot account has been suspended for 60 days. <strong>In 30 days</strong>, all account data — including agents, sessions, security findings, and audit history — will be permanently deleted.<br/><br/>Upgrade now to retain everything.`,
                    'Upgrade now',
                    APP_URL,
                ),
            }
        case 'deletion_imminent':
            return {
                to:      p.to,
                subject: 'Your data will be deleted tomorrow',
                text:    `Your DapplePot account data will be permanently deleted in 24 hours. This is your last chance to upgrade: ${APP_URL}`,
                html:    shell(
                    'Final warning — data deletion in 24 hours',
                    `This is your final notice. <strong>Tomorrow</strong>, all account data will be permanently deleted from our systems. There is no recovery after this point.<br/><br/>Upgrade now to retain everything.`,
                    'Upgrade now',
                    APP_URL,
                ),
            }
    }
}
