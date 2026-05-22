import 'dotenv/config'
import { sql } from '../src/lib/postgres.js'
import { getAlertDetail } from '../src/queries/alerts.pg.js'

// We will replicate getAlertDetailsText from notifications.ts or import it if possible
import { env } from '../src/env.js'

async function run() {
  const alert = await getAlertDetail('cabf9b60-9710-414d-b77a-b22304ff414f', '2c4b1b33-a0e9-42a4-a94c-dd8ce3b02be8')
  if (!alert) {
    console.log('Alert not found')
    await sql.end()
    return
  }

  const appUrl = env.DAPPLEPOT_APP_URL || 'http://localhost:5173'
  const viewLink = `${appUrl}/detection?alertId=${alert.alertId}`

  const payloadData = alert.payload || {}
  const findings = payloadData.top_findings || []
  const chains = payloadData.attack_chains_detected || []

  // Color border based on severity
  let severityColor = '#3b82f6' // Default info/low (Blue)
  if (alert.severity === 'critical') {
    severityColor = '#dc2626' // Red
  } else if (alert.severity === 'warning' || alert.severity === 'medium') {
    severityColor = '#ea580c' // Orange
  }

  const severityStr = alert.severity.toUpperCase()
  const agentDisplay = alert.agentName ? `${alert.agentName} (${alert.agentId})` : (alert.agentId || 'N/A')
  const llmBandStr = payloadData.llm_band ? ` (Band: ${payloadData.llm_band})` : ''
  const asiBandStr = payloadData.asi_band ? ` (Band: ${payloadData.asi_band})` : ''
  const trustTrendStr = payloadData.trust_trend ? ` (Trend: ${payloadData.trust_trend})` : ' (Trend: stable)'

  // Plain text fallback formatting matching user preference exactly
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

  // Block Kit Markdown formatting matching user preference with rich bold labels
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

  // Build Slack Block Kit layout using a single clean markdown section
  const blocks: any[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: blockMarkdownText }
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View in Dashboard' },
          url: viewLink,
          style: alert.severity === 'critical' ? 'danger' : 'primary',
          action_id: 'view_alert'
        }
      ]
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `Triggered: ${alert.triggeredAt} • DapplePot Security Service` }
      ]
    }
  ]

  const payload = {
    text: fallbackBodyText,
    attachments: [
      {
        color: severityColor,
        blocks
      }
    ]
  }

  console.log('--- NEW FORMATTED SLACK WEBHOOK PAYLOAD ---')
  console.log(JSON.stringify(payload, null, 2))

  await sql.end()
}
run().catch(console.error)
