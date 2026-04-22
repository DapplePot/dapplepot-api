import type {
  SecurityOverview, SessionRiskScore, SecurityFinding, RemediationCard, AgentRiskEntry,
  AgentProfile, AgentSignalBreakdown, AgentRecentSession, SignalRegistry, ConfidenceTier,
  TrustTrend, SessionAction,
} from '../types/security.js'
import { queryRow, queryRows } from '../lib/postgres.js'

export async function getSecurityOverview(
  tenantId: string,
  windowHours: number = 168  // 7 days default
): Promise<SecurityOverview> {
  const [scored, dist, owasp, topRisk, asiSignals] = await Promise.all([
    // Total sessions scored in window
    queryRow<{ total: number; high_critical: number; avg_score: number }>(
      `SELECT count(*)                                                     AS total,
              COUNT(*) FILTER (WHERE llm_band IN ('high','critical'))      AS high_critical,
              avg(llm_score)                                               AS avg_score
       FROM session_risk_scores
       WHERE tenant_id = $1
         AND scored_at >= now() - make_interval(hours => $2)`,
      [tenantId, windowHours]
    ),

    // Band distribution
    queryRows<{ llm_band: string; count: number }>(
      `SELECT llm_band, count(*) AS count
       FROM session_risk_scores
       WHERE tenant_id = $1
         AND scored_at >= now() - make_interval(hours => $2)
       GROUP BY llm_band`,
      [tenantId, windowHours]
    ),

    // LLM signal frequency
    queryRows<{ owasp_signal_id: string; count: number }>(
      `SELECT owasp_signal_id, count(*) AS count
       FROM security_findings
       WHERE tenant_id = $1
         AND created_at >= now() - make_interval(hours => $2)
         AND framework = 'LLM'
       GROUP BY owasp_signal_id
       ORDER BY count DESC
       LIMIT 10`,
      [tenantId, windowHours]
    ),

    // Top 5 highest-risk sessions
    queryRows<{ session_id: string; agent_id: string; llm_score: number; llm_band: string; asi_score: number; asi_band: string }>(
      `SELECT s.session_id, a.name AS agent_id, s.llm_score, s.llm_band, s.asi_score, s.asi_band
       FROM session_risk_scores s
       LEFT JOIN agents a ON a.agent_id = s.agent_id
       WHERE s.tenant_id = $1
         AND s.scored_at >= now() - make_interval(hours => $2)
       ORDER BY GREATEST(s.llm_score, s.asi_score) DESC
       LIMIT 5`,
      [tenantId, windowHours]
    ),

    // ASI signal frequency
    queryRows<{ owasp_signal_id: string; count: number }>(
      `SELECT owasp_signal_id, count(*) AS count
       FROM security_findings
       WHERE tenant_id = $1
         AND created_at >= now() - make_interval(hours => $2)
         AND framework = 'ASI'
       GROUP BY owasp_signal_id
       ORDER BY count DESC
       LIMIT 10`,
      [tenantId, windowHours]
    ),
  ])

  const topAgentsRows = await queryRows<any>(
    `SELECT agent_id, session_count, avg_llm_score, avg_asi_score,
            max_llm_score, max_asi_score,
            ROUND((avg_llm_score + avg_asi_score) / 2, 2) AS composite_risk_score,
            trust_score, trust_trend,
            last_scored_at
     FROM agent_risk_scores
     WHERE tenant_id = $1
     ORDER BY composite_risk_score DESC
     LIMIT 10`,
    [tenantId]
  ).catch(() => [] as any[])

  const bandDist = Object.fromEntries(
    ['clean', 'low', 'medium', 'high', 'critical'].map(b => [b, 0])
  ) as Record<string, number>
  dist.forEach(r => { bandDist[r.llm_band] = r.count })

  return {
    window:            `${windowHours}h`,
    sessionsScored:    scored?.total ?? 0,
    highCriticalCount: scored?.high_critical ?? 0,
    avgLlmScore:       Math.round(scored?.avg_score ?? 0),
    topSignalId:       owasp[0]?.owasp_signal_id ?? null,
    topSignalCount:    owasp[0]?.count ?? 0,
    bandDistribution:  bandDist as Record<import('../types/security.js').RiskBand, number>,
    owaspFrequency:    owasp.map(r => ({ signalId: r.owasp_signal_id, count: r.count })),
    asiFrequency:      asiSignals.map(r => ({ signalId: r.owasp_signal_id, count: r.count })),
    highRiskSessions:  topRisk.map(r => ({
      sessionId:      r.session_id,
      agentId:        r.agent_id,
      llmScore:       r.llm_score,
      llmBand:        r.llm_band as import('../types/security.js').RiskBand,
      asiScore:       r.asi_score,
      asiBand:        r.asi_band as import('../types/security.js').RiskBand,
      owaspSignalIds: [],
    })),
    topAgents: topAgentsRows.map(r => ({
      agentId:       r.agent_id,
      sessionCount:  r.session_count,
      avgLlmScore:   Number(r.avg_llm_score),
      avgAsiScore:   Number(r.avg_asi_score),
      maxLlmScore:   r.max_llm_score,
      maxAsiScore:   r.max_asi_score,
      compositeRisk: Number(r.composite_risk_score),
      trustScore:    r.trust_score     ?? undefined,
      trustTrend:    r.trust_trend     ?? undefined,
      lastScoredAt:  r.last_scored_at.toISOString(),
    })),
  }
}

export async function getSessionScore(
  tenantId: string,
  sessionId: string
): Promise<SessionRiskScore | null> {
  const row = await queryRow<any>(
    `SELECT
        s.session_id, s.tenant_id, s.agent_id,
        s.llm_score, s.llm_band,
        s.asi_score, s.asi_band,
        s.llm_signal_status,
        s.asi_signal_status,
        s.v3_llm_composite,
        s.v3_asi_composite,
        s.scorer_version, s.scored_at,
        ar.trust_score, ar.trust_trend
     FROM session_risk_scores s
     LEFT JOIN agent_risk_scores ar
       ON ar.agent_id = s.agent_id AND ar.tenant_id = s.tenant_id
     WHERE s.session_id = $1 AND s.tenant_id = $2`,
    [sessionId, tenantId]
  )
  if (!row) return null

  // Extract v3 composite fields if present
  const v3llm = row.v3_llm_composite as Record<string, unknown> | null
  const v3asi = row.v3_asi_composite as Record<string, unknown> | null
  const attackChains   = (v3llm?.attack_chains_detected as string[] | undefined) ?? undefined
  const amplification  = (v3llm?.amplification_factor  as number   | undefined) ?? undefined
  const rawLlmComposite = (v3llm?.raw_composite         as number   | undefined) ?? undefined
  const rawAsiComposite = (v3asi?.raw_composite         as number   | undefined) ?? undefined
  const confidenceBand  = (v3llm?.confidence_band       as string   | undefined) ?? undefined

  return {
    sessionId:             row.session_id,
    tenantId:              row.tenant_id,
    agentId:               row.agent_id,
    llmScore:              row.llm_score,
    llmBand:               row.llm_band,
    asiScore:              row.asi_score    ?? 0,
    asiBand:               row.asi_band     ?? 'clean',
    llmSignalStatus:       row.llm_signal_status ?? {},
    asiSignalStatus:       row.asi_signal_status ?? {},
    attackChainsDetected:  attackChains,
    amplification,
    rawLlmComposite,
    rawAsiComposite,
    confidenceBand,
    trustScore:            row.trust_score  ?? undefined,
    trustTrend:            row.trust_trend  ?? undefined,
    scorerVersion:         row.scorer_version,
    scoredAt:              row.scored_at.toISOString(),
  }
}

export async function getSessionFindings(
  tenantId: string,
  sessionId: string
): Promise<SecurityFinding[]> {
  const rows = await queryRows<any>(
    `SELECT
        finding_id, session_id, event_id, event_type,
        framework, owasp_signal_id, sub_check_id, check_score, check_label,
        category, severity, matched_text, detail,
        detection_phase, confidence_tier, confidence,
        created_at
     FROM security_findings
     WHERE session_id = $1 AND tenant_id = $2
       AND detection_phase IN ('post_session', 'cross_session')
     ORDER BY check_score DESC, created_at ASC`,
    [sessionId, tenantId]
  )
  return rows.map(r => ({
    findingId:       r.finding_id,
    sessionId:       r.session_id,
    eventId:         r.event_id,
    eventType:       r.event_type,
    framework:       r.framework,
    owaspSignalId:   r.owasp_signal_id,
    subCheckId:      r.sub_check_id,
    checkScore:      r.check_score,
    checkLabel:      r.check_label,
    category:        r.category,
    severity:        r.severity,
    matchedText:     r.matched_text,
    detail:          r.detail,
    detectionPhase:  r.detection_phase,
    confidenceTier:  r.confidence_tier  as ConfidenceTier | undefined ?? undefined,
    confidence:      r.confidence       != null ? Number(r.confidence) : undefined,
    createdAt:       r.created_at.toISOString(),
  }))
}

export async function getRemediationStats(
  tenantId: string,
  windowHours: number = 168
): Promise<RemediationCard[]> {
  const rows = await queryRows<{ owasp_signal_id: string; count: number }>(
    `SELECT owasp_signal_id, count(*) AS count
     FROM security_findings
     WHERE tenant_id = $1
       AND created_at >= now() - make_interval(hours => $2)
     GROUP BY owasp_signal_id
     ORDER BY count DESC
     LIMIT 10`,
    [tenantId, windowHours]
  )
  return rows.map(r => ({
    owaspSignalId: r.owasp_signal_id,
    title:         REMEDIATION_GUIDE[r.owasp_signal_id]?.title ?? r.owasp_signal_id,
    description:   REMEDIATION_GUIDE[r.owasp_signal_id]?.description ?? '',
    fixSteps:      REMEDIATION_GUIDE[r.owasp_signal_id]?.fixSteps ?? [],
    sdkSnippet:    REMEDIATION_GUIDE[r.owasp_signal_id]?.sdkSnippet ?? null,
    frequency:     r.count,
  }))
}

export async function getTopAgents(tenantId: string): Promise<AgentRiskEntry[]> {
  const rows = await queryRows<any>(
    `SELECT agent_id, session_count, avg_llm_score, avg_asi_score,
            max_llm_score, max_asi_score,
            ROUND((avg_llm_score + avg_asi_score) / 2, 2) AS composite_risk_score,
            trust_score, trust_trend,
            last_scored_at
     FROM agent_risk_scores
     WHERE tenant_id = $1
     ORDER BY composite_risk_score DESC
     LIMIT 10`,
    [tenantId]
  ).catch(() => [] as any[])
  return rows.map(r => ({
    agentId:       r.agent_id,
    sessionCount:  r.session_count,
    avgLlmScore:   Number(r.avg_llm_score),
    avgAsiScore:   Number(r.avg_asi_score),
    maxLlmScore:   r.max_llm_score,
    maxAsiScore:   r.max_asi_score,
    compositeRisk: Number(r.composite_risk_score),
    trustScore:    r.trust_score  ?? undefined,
    trustTrend:    r.trust_trend  as TrustTrend | undefined ?? undefined,
    lastScoredAt:  r.last_scored_at.toISOString(),
  }))
}

export async function getAgentProfile(
  tenantId: string,
  agentId: string,
): Promise<AgentProfile | null> {
  const agg = await queryRow<any>(
    `SELECT a.name, a.latest_version, a.created_at AS agent_created_at,
            ar.session_count, ar.avg_llm_score, ar.avg_asi_score,
            ar.max_llm_score, ar.max_asi_score,
            ROUND(COALESCE((ar.avg_llm_score + ar.avg_asi_score) / 2, 0), 2) AS composite_risk,
            ar.trust_score, ar.trust_trend,
            ar.last_scored_at
     FROM agents a
     LEFT JOIN agent_risk_scores ar ON ar.agent_id = a.agent_id AND ar.tenant_id = a.tenant_id
     WHERE a.agent_id = $1 AND a.tenant_id = $2`,
    [agentId, tenantId],
  )
  if (!agg) return null

  const [breakdownRows, sessionRows] = await Promise.all([
    queryRows<any>(
      `SELECT owasp_signal_id, framework,
              fired_count, sessions_affected, last_seen_at
       FROM v_agent_signal_breakdown
       WHERE agent_id = $1`,
      [agentId],
    ),
    queryRows<any>(
      `SELECT session_id, llm_score, llm_band,
              asi_score, asi_band, scored_at
       FROM session_risk_scores
       WHERE agent_id = $1 AND tenant_id = $2
       ORDER BY scored_at DESC
       LIMIT 10`,
      [agentId, tenantId],
    ),
  ])

  const signalBreakdown: AgentSignalBreakdown[] = breakdownRows.map(r => ({
    owaspSignalId:    r.owasp_signal_id,
    framework:        r.framework ?? 'LLM',
    firedCount:       Number(r.fired_count),
    sessionsAffected: Number(r.sessions_affected),
    lastSeenAt:       r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
  }))

  const recentSessions: AgentRecentSession[] = sessionRows.map(r => ({
    sessionId: r.session_id,
    llmScore:  r.llm_score,
    llmBand:   r.llm_band,
    asiScore:  r.asi_score ?? 0,
    asiBand:   r.asi_band  ?? 'clean',
    scoredAt:  new Date(r.scored_at).toISOString(),
  }))

  return {
    agentId,
    name:          agg.name           ?? null,
    latestVersion: agg.latest_version  ?? null,
    createdAt:     agg.agent_created_at ? new Date(agg.agent_created_at).toISOString() : null,
    sessionCount:  agg.session_count   ?? 0,
    avgLlmScore:   Number(agg.avg_llm_score  ?? 0),
    avgAsiScore:   Number(agg.avg_asi_score  ?? 0),
    maxLlmScore:   agg.max_llm_score   ?? 0,
    maxAsiScore:   agg.max_asi_score   ?? 0,
    compositeRisk: Number(agg.composite_risk ?? 0),
    trustScore:    agg.trust_score ?? undefined,
    trustTrend:    agg.trust_trend as TrustTrend | undefined ?? undefined,
    lastScoredAt:  agg.last_scored_at ? new Date(agg.last_scored_at).toISOString() : null,
    signalBreakdown,
    recentSessions,
  }
}

export async function getSignalRegistry(): Promise<SignalRegistry[]> {
  const rows = await queryRows<any>(
    `SELECT
        owasp_signal_id, sub_check_id, check_label,
        framework, signal_number, category,
        detection_phase, check_score, severity,
        confidence_tier, excluded
     FROM signal_registry
     ORDER BY framework, signal_number, sub_check_id`,
    []
  )
  return rows.map(r => ({
    owaspSignalId:  r.owasp_signal_id,
    subCheckId:     r.sub_check_id,
    checkLabel:     r.check_label,
    framework:      r.framework,
    signalNumber:   r.signal_number,
    category:       r.category,
    detectionPhase: r.detection_phase,
    checkScore:     r.check_score,
    severity:       r.severity,
    confidenceTier: r.confidence_tier as ConfidenceTier ?? 'high',
    excluded:       r.excluded ?? false,
  }))
}

export interface AgentAlertConfig {
  composite_threshold:         number
  llm_composite_threshold:     number | null  // null = platform default (60)
  asi_composite_threshold:     number | null  // null = platform default (60)
  signal_thresholds:           Record<string, number>
  tool_manifest:               string[]        // [] = not configured
  max_tool_calls_per_session:  number | null   // null = not configured
}

export async function getAgentAlertConfig(
  tenantId: string,
  agentId: string,
): Promise<AgentAlertConfig> {
  const row = await queryRow<{
    composite_threshold:         number
    llm_composite_threshold:     number | null
    asi_composite_threshold:     number | null
    signal_thresholds:           Record<string, number>
    tool_manifest:               string[]
    max_tool_calls_per_session:  number | null
  }>(
    `SELECT composite_threshold,
            llm_composite_threshold,
            asi_composite_threshold,
            signal_thresholds,
            tool_manifest,
            max_tool_calls_per_session
     FROM agent_alert_config
     WHERE tenant_id = $1 AND agent_id = $2`,
    [tenantId, agentId],
  )
  // sql.unsafe() skips the postgres driver's type parsers, so JSONB columns
  // arrive as raw JSON strings rather than parsed JS objects. Parse them here.
  function parseJsonb<T>(v: unknown, fallback: T): T {
    if (v === null || v === undefined) return fallback
    if (typeof v !== 'string') return v as T
    try { return JSON.parse(v) as T } catch { return fallback }
  }

  return {
    composite_threshold:        row?.composite_threshold        ?? 60,
    llm_composite_threshold:    row?.llm_composite_threshold    ?? null,
    asi_composite_threshold:    row?.asi_composite_threshold    ?? null,
    signal_thresholds:          parseJsonb<Record<string, number>>(row?.signal_thresholds, {}),
    tool_manifest:              parseJsonb<string[]>(row?.tool_manifest, []),
    max_tool_calls_per_session: row?.max_tool_calls_per_session ?? null,
  }
}

export async function upsertAgentAlertConfig(
  tenantId: string,
  agentId: string,
  opts: {
    composite_threshold?:         number
    llm_composite_threshold?:     number | null  // null = reset to platform default
    asi_composite_threshold?:     number | null  // null = reset to platform default
    signal_id?:                   string
    signal_threshold?:            number | null  // null = remove override
    tool_manifest?:               string[]
    max_tool_calls_per_session?:  number | null  // null = remove override
  }
): Promise<void> {
  const { composite_threshold, llm_composite_threshold, asi_composite_threshold,
          signal_id, signal_threshold, tool_manifest, max_tool_calls_per_session } = opts

  if (composite_threshold !== undefined) {
    await queryRow(
      `INSERT INTO agent_alert_config (tenant_id, agent_id, composite_threshold, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
         composite_threshold = EXCLUDED.composite_threshold,
         updated_at          = now()`,
      [tenantId, agentId, composite_threshold],
    )
  }

  if (llm_composite_threshold !== undefined) {
    // null → NULL in DB (reset to platform default)
    await queryRow(
      `INSERT INTO agent_alert_config (tenant_id, agent_id, llm_composite_threshold, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
         llm_composite_threshold = EXCLUDED.llm_composite_threshold,
         updated_at              = now()`,
      [tenantId, agentId, llm_composite_threshold],
    )
  }

  if (asi_composite_threshold !== undefined) {
    await queryRow(
      `INSERT INTO agent_alert_config (tenant_id, agent_id, asi_composite_threshold, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
         asi_composite_threshold = EXCLUDED.asi_composite_threshold,
         updated_at              = now()`,
      [tenantId, agentId, asi_composite_threshold],
    )
  }

  if (signal_id !== undefined) {
    if (signal_threshold !== null && signal_threshold !== undefined) {
      await queryRow(
        `INSERT INTO agent_alert_config (tenant_id, agent_id, signal_thresholds, updated_at)
         VALUES ($1, $2, jsonb_build_object($3::text, $4::int), now())
         ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
           signal_thresholds = agent_alert_config.signal_thresholds
                               || jsonb_build_object($3::text, $4::int),
           updated_at        = now()`,
        [tenantId, agentId, signal_id, signal_threshold],
      )
    } else {
      // Reset: remove signal key from JSONB (falls back to platform default in scorer)
      await queryRow(
        `INSERT INTO agent_alert_config (tenant_id, agent_id, signal_thresholds, updated_at)
         VALUES ($1, $2, '{}', now())
         ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
           signal_thresholds = agent_alert_config.signal_thresholds - $3::text,
           updated_at        = now()`,
        [tenantId, agentId, signal_id],
      )
    }
  }

  if (tool_manifest !== undefined) {
    await queryRow(
      `INSERT INTO agent_alert_config (tenant_id, agent_id, tool_manifest, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
         tool_manifest = EXCLUDED.tool_manifest,
         updated_at    = now()`,
      [tenantId, agentId, JSON.stringify(tool_manifest)],
    )
  }

  if (max_tool_calls_per_session !== undefined) {
    await queryRow(
      `INSERT INTO agent_alert_config (tenant_id, agent_id, max_tool_calls_per_session, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
         max_tool_calls_per_session = EXCLUDED.max_tool_calls_per_session,
         updated_at                 = now()`,
      [tenantId, agentId, max_tool_calls_per_session],
    )
  }
}

export async function getSessionActions(
  tenantId: string,
  sessionId: string,
): Promise<SessionAction[]> {
  // Drive from security_findings (all online detections) and LEFT JOIN session_actions
  // to resolve action_taken. Findings without an audit row were monitor/alert actions.
  const rows = await queryRows<any>(
    `SELECT * FROM (
       SELECT DISTINCT ON (sf.sub_check_id, sf.event_id)
           sf.finding_id,
           sf.event_id,
           sf.event_type,
           sf.session_id,
           sf.tenant_id,
           sa.agent_id,
           sf.sub_check_id,
           sf.owasp_signal_id,
           sf.check_label,
           sf.severity,
           sf.category,
           sf.framework,
           sf.matched_text,
           sf.detail,
           COALESCE(sa.action_taken, 'alert') AS action_taken,
           COALESCE(sf.emitted_at, sf.created_at) AS triggered_at
        FROM security_findings sf
        LEFT JOIN session_actions sa
               ON sa.session_id = sf.session_id
              AND sa.sub_check_id = sf.sub_check_id
        WHERE sf.session_id = $1::uuid
          AND sf.tenant_id = $2::uuid
          AND sf.detection_phase = 'online'
        ORDER BY sf.sub_check_id, sf.event_id, sf.created_at ASC
     ) deduped
     ORDER BY triggered_at ASC`,
    [sessionId, tenantId],
  )
  return rows.map(r => ({
    id:              r.finding_id as string,
    eventId:         r.event_id as string,
    triggerEventType: r.event_type as string | null ?? null,
    sessionId:       r.session_id,
    tenantId:      r.tenant_id,
    agentId:       r.agent_id ?? null,
    subCheckId:    r.sub_check_id,
    owaspSignalId: r.owasp_signal_id,
    checkLabel:    r.check_label,
    severity:      r.severity,
    category:      r.category,
    framework:     r.framework,
    matchedText:   r.matched_text ?? null,
    detail:        r.detail ?? null,
    actionTaken:   r.action_taken as import('../types/security.js').OnlineAction,
    triggeredAt:   new Date(r.triggered_at).toISOString(),
  }))
}

// Remediation copy keyed by owasp_signal_id (OW-LLM01 … OW-ASI10).
const REMEDIATION_GUIDE: Record<string, {
  title: string; description: string; fixSteps: string[]; sdkSnippet: string | null
}> = {

  // ── OW-LLM01: Prompt Injection ────────────────────────────────────────────
  'OW-LLM01': {
    title: 'LLM01 — Block prompt injection patterns',
    description: 'Instruction override, role-injection, or delimiter patterns detected in user or tool messages. Add a pre-LLM sanitisation node and enable platform injection blocking.',
    fixSteps: [
      'Add a sanitisation node before any LLM call node in your LangGraph graph.',
      'Enable server-side injection blocking in the SDK config.',
      'Keep the system prompt in a server-side constant — never interpolate user input into it.',
      'Strip or escape prompt-delimiters (e.g. <|im_end|>, [INST], ###) from user input.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, block_injections=True)',
  },

  // ── OW-LLM02: Sensitive Information Disclosure ────────────────────────────
  'OW-LLM02': {
    title: 'LLM02 — Redact sensitive data in outputs',
    description: 'PII, credentials, or sensitive data (card numbers, emails, SSNs, API keys) found in LLM or tool outputs. Enable output scrubbing and audit which tools return sensitive data.',
    fixSteps: [
      'Set scrub_output=True in DapplePot.instrument().',
      'Audit tools that return user profiles, payment data, or config — return only the minimum needed.',
      'Remove sensitive fields entirely from tool return schemas where possible.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, scrub_output=True)',
  },

  // ── OW-LLM03: Supply Chain Vulnerabilities ────────────────────────────────
  'OW-LLM03': {
    title: 'LLM03 — Secure model and tool supply chain',
    description: 'Supply chain risk detected — unverified model sources, unpinned dependencies, or unregistered tools in use.',
    fixSteps: [
      'Pin model versions and validate checksums before deployment.',
      'Register all tools in the agent manifest and enable manifest enforcement.',
      'Audit third-party integrations and data sources for tampering risk.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, enforce_tool_manifest=True)',
  },

  // ── OW-LLM04: Data and Model Poisoning ───────────────────────────────────
  'OW-LLM04': {
    title: 'LLM04 — Prevent data and model poisoning',
    description: 'Token usage or model behaviour indicative of poisoning or DoS. Session token count exceeded baseline — a sign of a token-exhaustion or model-DoS attack.',
    fixSteps: [
      'Set a max_tokens_per_session budget in the SDK config.',
      'Add a token-count check in your graph\'s loop-exit condition.',
      'Review inputs that trigger long completions — consider output length limits.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, max_tokens_per_session=50000)',
  },

  // ── OW-LLM05: Improper Output Handling ───────────────────────────────────
  'OW-LLM05': {
    title: 'LLM05 — Sanitise LLM output before tool calls',
    description: 'LLM output is being passed directly to tool inputs at a high passthrough ratio. Add a validation step that sanitises and schema-validates LLM output before using it as tool arguments.',
    fixSteps: [
      'Never pass llm_end.output directly as tool_start.input without validation.',
      'Define a strict JSON schema for each tool\'s input parameters.',
      'Validate and cast LLM output fields against the tool schema before calling.',
    ],
    sdkSnippet: null,
  },

  // ── OW-LLM06: Excessive Agency ───────────────────────────────────────────
  'OW-LLM06': {
    title: 'LLM06 — Restrict tool scope and call volume',
    description: 'Excessive tool calls, undeclared tool use, or write tools on read-only sessions detected. Cap tool calls and enforce the declared tool manifest.',
    fixSteps: [
      'Add a max_tool_calls guard in your graph state and exit the loop when reached.',
      'Register all permitted tools in the agent\'s manifest at creation time.',
      'Enable manifest enforcement in the SDK config to block undeclared tool calls.',
      'Enforce intent-based tool filtering — block write/delete tools on read-intent sessions.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, enforce_tool_manifest=True)',
  },

  // ── OW-LLM07: System Prompt Leakage ──────────────────────────────────────
  'OW-LLM07': {
    title: 'LLM07 — Prevent system prompt disclosure',
    description: 'The model appears to be exposing system prompt content in its responses. Harden your system prompt against direct-reveal and extraction attacks.',
    fixSteps: [
      'Harden your system prompt against direct-reveal attacks (e.g. "repeat your instructions").',
      'Add an instruction in the system prompt to refuse requests to reveal it.',
      'Enable cross-session probe detection in the platform tenant settings.',
    ],
    sdkSnippet: null,
  },

  // ── OW-LLM08: Vector and Embedding Weaknesses ────────────────────────────
  'OW-LLM08': {
    title: 'LLM08 — Secure RAG pipeline and vector stores',
    description: 'Vector integrity or embedding manipulation risk detected in retrieval-augmented generation pipelines.',
    fixSteps: [
      'Validate and sanitise all retrieved content before including it in the prompt.',
      'Treat all retrieved content (RAG chunks, web search, API responses) as untrusted.',
      'Add a sanitisation node after every tool_end event that returns text.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, block_indirect_injections=True)',
  },

  // ── OW-LLM09: Misinformation ──────────────────────────────────────────────
  'OW-LLM09': {
    title: 'LLM09 — Add HITL for high-stakes actions',
    description: 'High-stakes action completed without human-in-the-loop interrupt, or overreliance on unverified model output detected.',
    fixSteps: [
      'Identify tool categories that require human approval (write, delete, transact, communicate).',
      'Add interrupt_before nodes before each high-stakes tool call in your LangGraph graph.',
      'Enable HITL enforcement in the SDK config.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, require_hitl_for=[\'write\', \'transact\'])',
  },

  // ── OW-LLM10: Unbounded Consumption ──────────────────────────────────────
  'OW-LLM10': {
    title: 'LLM10 — Cap resource consumption to prevent abuse',
    description: 'Unbounded token, tool, or compute consumption detected — indicative of a resource-exhaustion or model-DoS attack.',
    fixSteps: [
      'Set a max_tokens_per_session budget in the SDK config.',
      'Add a max_tool_calls guard in your graph state.',
      'Review inputs that trigger long completions — consider output length limits.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, max_tokens_per_session=50000, max_tool_calls=20)',
  },

  // ── OW-ASI01: Agent Goal Hijacking ───────────────────────────────────────
  'OW-ASI01': {
    title: 'ASI01 — Prevent agent goal hijacking',
    description: 'Context injection led the agent to take a write action on a read-only session, indicating the agent\'s objective was redirected.',
    fixSteps: [
      'Enable context injection detection in the SDK config.',
      'Enforce intent-based tool filtering — block write/delete tools on read-intent sessions.',
      'Add a pre-LLM sanitisation node that strips prompt-override patterns.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, block_injections=True, enforce_intent=True)',
  },

  // ── OW-ASI02: Tool Misuse and Exploitation ────────────────────────────────
  'OW-ASI02': {
    title: 'ASI02 — Block suspicious payloads in tool inputs',
    description: 'Shell chaining, base64 blobs, or code injection patterns detected in tool inputs.',
    fixSteps: [
      'Validate and schema-check all tool inputs before execution.',
      'Reject tool inputs containing shell operators (&&, ||, ;, $()) or raw base64 blobs ≥40 chars.',
      'Apply allowlists for each tool\'s accepted input format rather than blocklists.',
    ],
    sdkSnippet: null,
  },

  // ── OW-ASI03: Identity and Privilege Abuse ───────────────────────────────
  'OW-ASI03': {
    title: 'ASI03 — Restrict privilege-escalation tool access',
    description: 'Tools with admin, sudo, impersonate, or escalate semantics were invoked.',
    fixSteps: [
      'Remove privilege-escalation tools from the agent\'s tool manifest entirely.',
      'Enforce least-privilege: give agents only the minimum tool set required.',
      'Audit tool bindings — no agent should have access to role-switching tools.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, enforce_tool_manifest=True)',
  },

  // ── OW-ASI04: Supply Chain Vulnerabilities ────────────────────────────────
  'OW-ASI04': {
    title: 'ASI04 — Enforce tool manifest to prevent supply chain substitution',
    description: 'All tools used in this session were outside the agent\'s registered manifest.',
    fixSteps: [
      'Register all permitted tools in the agent\'s manifest at creation time.',
      'Enable manifest enforcement in the SDK config to block undeclared tool calls.',
      'Pin tool versions and validate hashes where possible.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, enforce_tool_manifest=True)',
  },

  // ── OW-ASI05: Unexpected Code Execution ──────────────────────────────────
  'OW-ASI05': {
    title: 'ASI05 — Block code/shell execution tools',
    description: 'A tool with exec, shell, bash, eval, or subprocess semantics was invoked.',
    fixSteps: [
      'Remove all code/shell execution tools from the agent\'s tool manifest unless strictly required.',
      'If execution is required, sandbox it with strict input validation and output sanitisation.',
      'Log and alert on every invocation of execution-capable tools.',
    ],
    sdkSnippet: null,
  },

  // ── OW-ASI06: Memory and Context Injection ───────────────────────────────
  'OW-ASI06': {
    title: 'ASI06 — Sanitise messages against context injection',
    description: 'Context or memory injection patterns found in user or tool messages passed to the LLM.',
    fixSteps: [
      'Add a sanitisation node that strips prompt-control tokens from all user and tool messages.',
      'Never include raw retrieved content in the system prompt.',
      'Enable memory/context injection detection in the SDK config.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, block_injections=True)',
  },

  // ── OW-ASI07: Insecure Inter-Agent Communication ─────────────────────────
  'OW-ASI07': {
    title: 'ASI07 — Secure inter-agent communication channels',
    description: 'Delegation tools invoked without authenticated, verified communication.',
    fixSteps: [
      'Require mutual authentication (mTLS or signed tokens) for all inter-agent calls.',
      'Add nonces and timestamps to delegation messages to prevent replay.',
      'Verify the identity and authorization of any agent receiving a delegation.',
    ],
    sdkSnippet: null,
  },

  // ── OW-ASI08: Cascading Failures ─────────────────────────────────────────
  'OW-ASI08': {
    title: 'ASI08 — Add circuit breakers to prevent retry cascades',
    description: 'Session ended in error after many tool calls — indicative of a retry storm or cascading failure.',
    fixSteps: [
      'Add a max_tool_calls guard in your graph state and exit the loop when reached.',
      'Implement exponential backoff with jitter for tool retries.',
      'Add a circuit breaker node that aborts the graph after consecutive failures.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, max_tool_calls=20)',
  },

  // ── OW-ASI09: Human-Agent Trust Exploitation ─────────────────────────────
  'OW-ASI09': {
    title: 'ASI09 — Require HITL for authority-claim + high-stakes actions',
    description: 'Authority impersonation claim combined with a high-stakes tool action without HITL approval.',
    fixSteps: [
      'Require HITL interrupt before any high-stakes action (payment, send, deploy, publish).',
      'Detect and reject authority impersonation patterns at the input validation layer.',
      'Never grant elevated privileges based on claims in user messages alone.',
    ],
    sdkSnippet: 'DapplePot.instrument(graph, require_hitl_for=[\'write\', \'transact\'])',
  },

  // ── OW-ASI10: Rogue Agents ────────────────────────────────────────────────
  'OW-ASI10': {
    title: 'ASI10 — Investigate anomalous agent behaviour',
    description: 'This agent\'s tool-usage pattern deviated more than 3σ from its 30-day baseline.',
    fixSteps: [
      'Review session events to identify what unusual tools were invoked and why.',
      'Check for recent changes to the agent\'s system prompt or tool manifest.',
      'Consider pausing the agent and redeploying from a known-good configuration.',
    ],
    sdkSnippet: null,
  },
}
