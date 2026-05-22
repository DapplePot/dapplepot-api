import { env } from '../env.js'
import { emailProvider } from './email/index.js'
import { securityAlertEmail } from './email/templates.js'
import type { DeliveryChannel, SlackConfig, MsteamsConfig, EmailConfig, MobileConfig, WebhookConfig, PagerdutyConfig } from '../types/channel.js'

export async function dispatchNotification(channel: DeliveryChannel, alert: Record<string, any>) {
  switch (channel.channelType) {
    case 'slack':
      await dispatchSlack(channel.config as SlackConfig, alert)
      break
    case 'msteams':
      await dispatchMsteams(channel.config as MsteamsConfig, alert)
      break
    case 'email':
      await dispatchEmail(channel.config as EmailConfig, alert)
      break
    case 'mobile':
      await dispatchMobile(channel.config as MobileConfig, alert)
      break
    case 'webhook':
      await dispatchWebhook(channel.config as WebhookConfig, alert)
      break
    case 'pagerduty':
      await dispatchPagerduty(channel.config as PagerdutyConfig, alert)
      break
    default:
      throw new Error(`Unsupported channel type: ${channel.channelType}`)
  }
}

async function dispatchSlack(config: SlackConfig, alert: Record<string, any>) {
  const appUrl = env.DAPPLEPOT_APP_URL || 'http://localhost:5173'
  const viewLink = `${appUrl}/detection?alertId=${alert.alertId}`
  
  const payloadData = alert.payload || {}
  const findings = payloadData.top_findings || []
  const chains = payloadData.attack_chains_detected || []

  const severityStr = alert.severity.toUpperCase()
  const agentDisplay = alert.agentName ? `${alert.agentName} (${alert.agentId})` : (alert.agentId || 'N/A')
  const llmBandStr = payloadData.llm_band ? ` (Band: ${payloadData.llm_band})` : ''
  const asiBandStr = payloadData.asi_band ? ` (Band: ${payloadData.asi_band})` : ''
  const trustTrendStr = payloadData.trust_trend ? ` (Trend: ${payloadData.trust_trend})` : ' (Trend: stable)'

  // 1. Plain Text Fallback
  const fallbackTextLines = [
    `🚨 ${alert.title}`,
    `Severity: ${severityStr}`,
    `Rule: ${alert.ruleName}`,
    `Triggered At: ${alert.triggeredAt}`,
    alert.sessionId ? `Session ID: ${alert.sessionId}` : null,
    alert.agentId ? `Agent: ${agentDisplay}` : null,
    alert.message ? `Message: ${alert.message}` : null,
    payloadData.llm_score !== undefined ? `LLM Risk Score: ${payloadData.llm_score}/100${llmBandStr}` : null,
    payloadData.asi_score !== undefined ? `ASI Risk Score: ${payloadData.asi_score}/100${asiBandStr}` : null,
    payloadData.trust_score !== undefined ? `Agent Trust Score: ${payloadData.trust_score}/100${trustTrendStr}` : null,
  ].filter(Boolean) as string[]

  let fallbackBodyText = fallbackTextLines.join('\n')

  if (findings.length > 0) {
    const findingsText = findings.map((f: any) => {
      const signalId = f.owasp_signal_id ? `[${f.owasp_signal_id}] ` : ''
      const subCheck = f.sub_check_id ? ` (${f.sub_check_id})` : ''
      const scoreInfo = typeof f.effective_score === 'number' ? `Score: ${f.effective_score}` : `Score: ${f.check_score}`
      return `• ${signalId}${f.check_label || f.category}${subCheck} - Severity: ${f.severity} (${scoreInfo})\n  Detail: ${f.detail || 'No detail'}`
    }).join('\n')

    fallbackBodyText += `\n\nTop Findings:\n${findingsText}`
  }

  // 2. Block Kit Markdown Text (matches your screenshot exactly)
  const markdownTextLines = [
    `🚨 *${alert.title}*`,
    `Severity: ${severityStr}`,
    `Rule: ${alert.ruleName}`,
    `Triggered At: ${alert.triggeredAt}`,
    alert.sessionId ? `Session ID: \`${alert.sessionId}\`` : null,
    alert.agentId ? `Agent: ${alert.agentName ? `\`${alert.agentName}\` ( \`${alert.agentId}\` )` : `\`${alert.agentId}\``}` : null,
    alert.message ? `Message: ${alert.message}` : null,
    payloadData.llm_score !== undefined ? `LLM Risk Score: ${payloadData.llm_score}/100${payloadData.llm_band ? ` (Band: ${payloadData.llm_band})` : ''}` : null,
    payloadData.asi_score !== undefined ? `ASI Risk Score: ${payloadData.asi_score}/100${payloadData.asi_band ? ` (Band: ${payloadData.asi_band})` : ''}` : null,
    payloadData.trust_score !== undefined ? `Agent Trust Score: ${payloadData.trust_score}/100${payloadData.trust_trend ? ` (Trend: ${payloadData.trust_trend})` : ' (Trend: stable)'}` : null,
  ].filter(Boolean) as string[]

  let blockMarkdownText = markdownTextLines[0] + '\n\n' + markdownTextLines.slice(1).join('\n')

  if (findings.length > 0) {
    const findingsText = findings.map((f: any) => {
      const signalId = f.owasp_signal_id ? `\`[${f.owasp_signal_id}]\` ` : ''
      const subCheck = f.sub_check_id ? ` ( \`${f.sub_check_id}\` )` : ''
      const scoreVal = typeof f.effective_score === 'number' ? f.effective_score : f.check_score
      const scoreInfo = scoreVal !== undefined ? ` (Score: ${scoreVal})` : ''
      return `• ${signalId}${f.check_label || f.category}${subCheck} - Severity: ${f.severity}${scoreInfo}\n  Detail: ${f.detail || 'No detail'}`
    }).join('\n')

    blockMarkdownText += `\n\n*Top Findings:*\n${findingsText}`
  }

  if (chains.length > 0) {
    blockMarkdownText += `\n\n*Attack Chains Detected:*\n🔗 ${chains.join(', ')}`
  }

  const payload = {
    text: fallbackBodyText,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: blockMarkdownText }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View in Dashboard' },
            url: viewLink,
            action_id: 'view_alert'
          }
        ]
      }
    ]
  }

  const res = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Slack API error: ${res.status} ${text}`)
  }
}

async function dispatchMsteams(config: MsteamsConfig, alert: Record<string, any>) {
  const appUrl = env.DAPPLEPOT_APP_URL || 'http://localhost:5173'
  const viewLink = `${appUrl}/detection?alertId=${alert.alertId}`
  
  const payloadData = alert.payload || {}
  const findings = payloadData.top_findings || []
  const chains = payloadData.attack_chains_detected || []

  const severityStr = alert.severity.toUpperCase()
  const agentDisplay = alert.agentName ? `${alert.agentName} (${alert.agentId})` : (alert.agentId || 'N/A')
  const llmBandStr = payloadData.llm_band ? ` (Band: ${payloadData.llm_band})` : ''
  const asiBandStr = payloadData.asi_band ? ` (Band: ${payloadData.asi_band})` : ''
  const trustTrendStr = payloadData.trust_trend ? ` (Trend: ${payloadData.trust_trend})` : ' (Trend: stable)'

  const markdownTextLines = [
    `🚨 **${alert.title}**`,
    `Severity: ${severityStr}`,
    `Rule: ${alert.ruleName}`,
    `Triggered At: ${alert.triggeredAt}`,
    alert.sessionId ? `Session ID: \`${alert.sessionId}\`` : null,
    alert.agentId ? `Agent: ${alert.agentName ? `\`${alert.agentName}\` ( \`${alert.agentId}\` )` : `\`${alert.agentId}\``}` : null,
    alert.message ? `Message: ${alert.message}` : null,
    payloadData.llm_score !== undefined ? `LLM Risk Score: ${payloadData.llm_score}/100${payloadData.llm_band ? ` (Band: ${payloadData.llm_band})` : ''}` : null,
    payloadData.asi_score !== undefined ? `ASI Risk Score: ${payloadData.asi_score}/100${payloadData.asi_band ? ` (Band: ${payloadData.asi_band})` : ''}` : null,
    payloadData.trust_score !== undefined ? `Agent Trust Score: ${payloadData.trust_score}/100${payloadData.trust_trend ? ` (Trend: ${payloadData.trust_trend})` : ' (Trend: stable)'}` : null,
  ].filter(Boolean) as string[]

  let blockMarkdownText = markdownTextLines[0] + '\n\n' + markdownTextLines.slice(1).join('\n\n')

  if (findings.length > 0) {
    const findingsText = findings.map((f: any) => {
      const signalId = f.owasp_signal_id ? `\`[${f.owasp_signal_id}]\` ` : ''
      const subCheck = f.sub_check_id ? ` ( \`${f.sub_check_id}\` )` : ''
      const scoreVal = typeof f.effective_score === 'number' ? f.effective_score : f.check_score
      const scoreInfo = scoreVal !== undefined ? ` (Score: ${scoreVal})` : ''
      return `* ${signalId}${f.check_label || f.category}${subCheck} - Severity: ${f.severity}${scoreInfo}\n  Detail: ${f.detail || 'No detail'}`
    }).join('\n\n')

    blockMarkdownText += `\n\n**Top Findings:**\n\n${findingsText}`
  }

  const payload = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    "themeColor": alert.severity === 'critical' ? "DC2626" : "EA580C",
    "summary": alert.title,
    "sections": [{
      "activityTitle": `🚨 DapplePot Security Alert: ${alert.title}`,
      "text": blockMarkdownText,
      "markdown": true
    }],
    "potentialAction": [{
      "@type": "OpenUri",
      "name": "View in Dashboard",
      "targets": [{ "os": "default", "uri": viewLink }]
    }]
  }

  const res = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`MS Teams API error: ${res.status} ${text}`)
  }
}

async function dispatchEmail(config: EmailConfig, alert: Record<string, any>) {
  const emailMsg = securityAlertEmail({ alert, appUrl: env.DAPPLEPOT_APP_URL })
  emailMsg.to = config.emailAddress
  await emailProvider.send(emailMsg)
}

async function dispatchMobile(config: MobileConfig, alert: Record<string, any>) {
  const appUrl = env.DAPPLEPOT_APP_URL || 'http://localhost:5173'
  const viewLink = `${appUrl}/detection?alertId=${alert.alertId}`
  
  const payloadData = alert.payload || {}
  const findings = payloadData.top_findings || []

  const severityStr = alert.severity.toUpperCase()
  const agentDisplay = alert.agentName ? `${alert.agentName} (${alert.agentId})` : (alert.agentId || 'N/A')
  const llmBandStr = payloadData.llm_band ? ` (Band: ${payloadData.llm_band})` : ''
  const asiBandStr = payloadData.asi_band ? ` (Band: ${payloadData.asi_band})` : ''
  const trustTrendStr = payloadData.trust_trend ? ` (Trend: ${payloadData.trust_trend})` : ' (Trend: stable)'

  const textLines = [
    `🚨 [DapplePot] ${alert.title}`,
    `Severity: ${severityStr}`,
    `Rule: ${alert.ruleName}`,
    `Triggered At: ${alert.triggeredAt}`,
    alert.sessionId ? `Session ID: ${alert.sessionId}` : null,
    alert.agentId ? `Agent: ${agentDisplay}` : null,
    alert.message ? `Message: ${alert.message}` : null,
    payloadData.llm_score !== undefined ? `LLM Risk Score: ${payloadData.llm_score}/100${llmBandStr}` : null,
    payloadData.asi_score !== undefined ? `ASI Risk Score: ${payloadData.asi_score}/100${asiBandStr}` : null,
    payloadData.trust_score !== undefined ? `Agent Trust Score: ${payloadData.trust_score}/100${trustTrendStr}` : null,
    `Link: ${viewLink}`
  ].filter(Boolean) as string[]

  let bodyText = textLines.join('\n')

  if (findings.length > 0) {
    const findingsText = findings.map((f: any) => {
      const signalId = f.owasp_signal_id ? `[${f.owasp_signal_id}] ` : ''
      const subCheck = f.sub_check_id ? ` (${f.sub_check_id})` : ''
      return `• ${signalId}${f.check_label || f.category}${subCheck} - Severity: ${f.severity}`
    }).join('\n')

    bodyText += `\n\nTop Findings:\n${findingsText}`
  }

  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
    console.log(`[SMS SANDBOX] Sending to ${config.phoneNumber}:\n${bodyText}`)
    return
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`
  const body = new URLSearchParams({
    To: config.phoneNumber,
    From: env.TWILIO_FROM_NUMBER,
    Body: bodyText
  })

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')
    },
    body: body.toString()
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Twilio API error: ${res.status} ${text}`)
  }
}

async function dispatchWebhook(config: WebhookConfig, alert: Record<string, any>) {
  const res = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.headers || {})
    },
    body: JSON.stringify(alert)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Webhook error: ${res.status} ${text}`)
  }
}

async function dispatchPagerduty(config: PagerdutyConfig, alert: Record<string, any>) {
  const payload = {
    routing_key: config.integrationKey,
    event_action: "trigger",
    payload: {
      summary: `[DapplePot] ${alert.title}`,
      severity: config.severity || alert.severity || "error",
      source: "dapplepot-security",
      custom_details: alert
    }
  }

  const res = await fetch('https://events.pagerduty.com/v2/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`PagerDuty API error: ${res.status} ${text}`)
  }
}
