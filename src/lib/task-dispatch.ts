import { existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { getDatabase, db_helpers } from './db'
import { callOpenClawGateway } from './openclaw-gateway'
import { eventBus } from './event-bus'
import { logger } from './logger'
import { config } from './config'
import { getAllGatewaySessions } from './sessions'
import { parseJsonlTranscript, readSessionJsonl, type TranscriptMessage } from './transcript-parser'
import { syncTaskOutbound } from './github-sync-engine'
import { classifyModelProvider, getDispatchModelId, getModelByAlias } from './models'
import type Database from 'better-sqlite3'

const AGENT_DISPATCH_ACCEPT_TIMEOUT_MS = 60_000

/** Sync task to GitHub/GNAP and broadcast escalation if task failed */
function syncAndEscalateIfFailed(task: { id: number; title: string; status: string; priority: string; project_id?: number | null; workspace_id: number; description?: string | null }, newStatus: string, errorMsg?: string, dispatchAttempts?: number): void {
  syncTaskOutbound({ ...task, status: newStatus }, task.workspace_id)
  if (newStatus === 'failed') {
    eventBus.broadcast('task.escalated', {
      id: task.id,
      title: task.title,
      reason: errorMsg?.includes('Aegis rejected') ? 'max_aegis_rejections' : errorMsg?.includes('stuck') ? 'stale_task_max_retries' : 'max_dispatch_retries',
      dispatch_attempts: dispatchAttempts ?? 0,
      error_message: (errorMsg ?? '').substring(0, 500),
      workspace_id: task.workspace_id,
    })
  }
}

interface DispatchableTask {
  id: number
  title: string
  description: string | null
  status: string
  priority: string
  assigned_to: string
  workspace_id: number
  agent_name: string
  agent_id: number
  agent_config: string | null
  /** Agent's declared runtime (set by the create-agent Runtime picker). */
  runtime_type?: string | null
  ticket_prefix: string | null
  project_ticket_no: number | null
  project_id: number | null
  tags?: string[]
  /** Raw tasks.metadata JSON — carries optional per-task sandbox overrides. */
  metadata?: string | null
}

interface DispatchTokenUsage {
  model: string
  sessionId: string
  inputTokens: number
  outputTokens: number
  workspaceId: number
}

/** Keep dispatch accounting aligned with the token_usage migration schema. */
export function insertDispatchTokenUsage(
  db: Pick<Database.Database, 'prepare'>,
  usage: DispatchTokenUsage,
  createdAt = Math.floor(Date.now() / 1000),
): void {
  db.prepare(`
    INSERT INTO token_usage (model, session_id, input_tokens, output_tokens, cost_usd, created_at, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    usage.model,
    usage.sessionId,
    usage.inputTokens,
    usage.outputTokens,
    0,
    createdAt,
    usage.workspaceId,
  )
}

function recordDispatchTokenUsage(usage: DispatchTokenUsage): void {
  try {
    insertDispatchTokenUsage(getDatabase(), usage)
  } catch (err) {
    logger.warn({ err, model: usage.model, workspaceId: usage.workspaceId }, 'Dispatch token usage insert failed')
  }
}

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------

/**
 * Return an explicit gateway model override from Mission Control agent config.
 *
 * By default, task dispatch should not inject a model override; the OpenClaw
 * agent should use its own configured default model. A Mission Control agent
 * may still opt into an override via agent.config.dispatchModel.
 */
export function resolveTaskDispatchModelOverride(task: Pick<DispatchableTask, 'agent_config'>): string | null {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.dispatchModel === 'string' && cfg.dispatchModel) return cfg.dispatchModel
      if (typeof cfg.model === 'string' && cfg.model) return null
      if (cfg.model && typeof cfg.model === 'object' && typeof cfg.model.primary === 'string' && cfg.model.primary) return null
    } catch { /* ignore */ }
  }
  return null
}

/** Extract the gateway agent identifier from the agent's config JSON.
 *  Falls back to agent_name (display name) if openclawId is not set. */
function resolveGatewayAgentId(task: DispatchableTask): string {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.openclawId === 'string' && cfg.openclawId) return cfg.openclawId
    } catch { /* ignore */ }
  }
  return task.agent_name
}

// ---------------------------------------------------------------------------
// Host-CLI sandbox flags (issue #720)
// ---------------------------------------------------------------------------
//
// Opt-in safety flags for the host CLI dispatch paths (`claude` / `codex`).
// Source of truth is the agent's config JSON (agents.config), using the same
// flat naming style as `dispatchModel`:
//
//   { "dispatchAllowedTools": ["Read", "Grep"], "dispatchMaxBudgetUsd": 5,
//     "dispatchCwd": "repos/my-project" }
//
// Each field can be overridden per task via tasks.metadata (camelCase or
// snake_case, mirroring existing metadata keys like dispatch_session_id):
//
//   { "dispatch_allowed_tools": [...], "dispatch_max_budget_usd": 2,
//     "dispatch_cwd": "..." }
//
// Absent config means today's behavior, byte-for-byte: no extra CLI flags,
// no spawn cwd.

/**
 * Tool names the Claude Code CLI accepts for `--allowedTools`. Conservative
 * exact-match allowlist — entries not listed here (including `Bash(...)`
 * specifier syntax) are dropped with a warning. `--dangerously-skip-permissions`
 * is never passed by task dispatch.
 */
export const CLAUDE_CLI_ALLOWED_TOOL_NAMES = [
  'Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'MultiEdit', 'Write',
  'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
] as const

/** Ceiling for `--max-budget-usd` regardless of what the config asks for. */
export const CLI_MAX_BUDGET_USD_CEILING = 100

export interface CliDispatchSandboxOptions {
  allowedTools: string[] | null
  maxBudgetUsd: number | null
  cwd: string | null
  /** Per-agent config/credentials dir → CLAUDE_CONFIG_DIR / CODEX_HOME. */
  configDir: string | null
}

/**
 * Validate a configured allowed-tools list against CLAUDE_CLI_ALLOWED_TOOL_NAMES.
 * Unknown entries are dropped with a warning. Returns null when the input is
 * not a list or nothing survives filtering — in `--print` mode, omitting
 * `--allowedTools` is the more restrictive default (tools stay gated), so an
 * all-invalid list fails closed, not open.
 */
export function filterCliAllowedTools(input: unknown, taskId?: number): string[] | null {
  if (!Array.isArray(input)) return null
  const valid: string[] = []
  const rejected: string[] = []
  for (const entry of input) {
    if (typeof entry === 'string' && (CLAUDE_CLI_ALLOWED_TOOL_NAMES as readonly string[]).includes(entry)) {
      if (!valid.includes(entry)) valid.push(entry)
    } else {
      rejected.push(typeof entry === 'string' ? entry : typeof entry)
    }
  }
  if (rejected.length > 0) {
    logger.warn({ taskId, rejected: rejected.slice(0, 20) },
      'Ignoring allowed-tools entries not in the Claude CLI tool allowlist')
  }
  return valid.length > 0 ? valid : null
}

/** Clamp a configured max budget to a finite positive number ≤ the ceiling. */
export function clampCliMaxBudgetUsd(input: unknown, taskId?: number): number | null {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) {
    if (input !== undefined && input !== null) {
      logger.warn({ taskId }, 'Ignoring invalid dispatch max budget (must be a finite positive number)')
    }
    return null
  }
  return Math.min(input, CLI_MAX_BUDGET_USD_CEILING)
}

/**
 * Resolve a configured dispatch cwd to a real directory inside the operator's
 * workspace root (config.workspaceRoot / MC_WORKSPACE_ROOT). Relative paths
 * resolve against the root. Both sides go through fs.realpathSync before the
 * prefix check, so `../` traversal and symlink escapes are rejected. Returns
 * null (feature off) when no workspace root is configured.
 */
export function resolveCliDispatchCwd(input: unknown, workspaceRoot: string, taskId?: number): string | null {
  if (typeof input !== 'string' || !input.trim()) return null
  if (!workspaceRoot) {
    logger.warn({ taskId }, 'Ignoring dispatch cwd: MC_WORKSPACE_ROOT is not configured')
    return null
  }
  try {
    const realRoot = realpathSync(path.resolve(workspaceRoot))
    const realCwd = realpathSync(path.resolve(realRoot, input.trim()))
    if (realCwd !== realRoot && !realCwd.startsWith(realRoot + path.sep)) {
      logger.warn({ taskId }, 'Ignoring dispatch cwd: resolves outside the configured workspace root')
      return null
    }
    if (!statSync(realCwd).isDirectory()) {
      logger.warn({ taskId }, 'Ignoring dispatch cwd: not a directory')
      return null
    }
    return realCwd
  } catch {
    logger.warn({ taskId }, 'Ignoring dispatch cwd: path does not exist or is not accessible')
    return null
  }
}

/**
 * Resolve a per-agent CLI config/credentials directory. When set, claude and
 * codex dispatch run against this dir instead of the global one, giving each
 * agent its own logged-in account / settings.json:
 *   - claude → CLAUDE_CONFIG_DIR (relocates ~/.claude: settings + credentials)
 *   - codex  → CODEX_HOME        (relocates ~/.codex: config.toml + auth.json)
 *
 * Source: agent config `dispatchConfigDir` (per-task override
 * `dispatch_config_dir`). Operator-supplied (admin-only create), so validation
 * is a light existence + directory check; a missing/invalid path degrades to
 * the global default rather than failing the task.
 */
export function resolveDispatchConfigDir(
  input: unknown,
  taskId?: number,
): string | null {
  if (typeof input !== 'string' || !input.trim()) return null
  const dir = input.trim()
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      logger.warn({ taskId, dir }, 'Ignoring dispatch config dir: not an existing directory')
      return null
    }
    return dir
  } catch {
    logger.warn({ taskId, dir }, 'Ignoring dispatch config dir: not accessible')
    return null
  }
}

/**
 * Ordered list of config-dir candidates a claude/codex agent will try.
 * Pure (validator injected) so it is unit-testable without the filesystem.
 *
 * - rotation ON with a non-empty validated pool → the pool, in order. Dispatch
 *   tries account 1, rolls to 2, 3, … on error/usage-limit (failover).
 * - rotation OFF (or empty pool) → a single-element list: the validated
 *   dispatchConfigDir, or `null` (= no env override → global settings.json).
 *
 * `null` in the returned list always means "use the global config".
 */
export function resolveConfigDirCandidates(
  opts: { rotation: boolean; credentialDirs: unknown; dispatchConfigDir: unknown },
  validate: (dir: unknown) => string | null,
): Array<string | null> {
  if (opts.rotation && Array.isArray(opts.credentialDirs)) {
    const pool = opts.credentialDirs.map(validate).filter((d): d is string => !!d)
    if (pool.length > 0) return pool
  }
  // Single account (rotation off, or nothing valid in the pool).
  return [validate(opts.dispatchConfigDir)]
}

/** Read rotation config off a task and resolve its ordered dir candidates. */
function getCredentialCandidates(task: Pick<DispatchableTask, 'id' | 'agent_config' | 'metadata'>): Array<string | null> {
  let cfg: Record<string, any> = {}
  if (task.agent_config) {
    try {
      const parsed = JSON.parse(task.agent_config)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed
    } catch { /* ignore */ }
  }
  const meta = safeParseMetadata(task.metadata)
  const pick = (camel: string, snake: string): unknown =>
    meta[camel] !== undefined ? meta[camel]
      : meta[snake] !== undefined ? meta[snake]
        : cfg[camel]

  return resolveConfigDirCandidates(
    {
      rotation: pick('credentialRotation', 'credential_rotation') === true,
      credentialDirs: pick('credentialDirs', 'credential_dirs'),
      dispatchConfigDir: pick('dispatchConfigDir', 'dispatch_config_dir'),
    },
    (dir) => resolveDispatchConfigDir(dir, task.id),
  )
}

/**
 * Run a dispatch across an ordered list of credential dirs, rolling over to the
 * next account when one errors (usage limit, auth failure, any thrown error).
 * Returns the first success; throws the last error if every account fails.
 */
async function runWithCredentialRotation(
  task: Pick<DispatchableTask, 'id' | 'agent_name'>,
  candidates: Array<string | null>,
  run: (configDir: string | null) => Promise<AgentResponseParsed>,
): Promise<AgentResponseParsed> {
  let lastErr: unknown
  for (let i = 0; i < candidates.length; i++) {
    try {
      const res = await run(candidates[i])
      if (i > 0) {
        logger.info({ taskId: task.id, agent: task.agent_name, account: i + 1, of: candidates.length },
          'Credential rollover succeeded')
      }
      return res
    } catch (err: any) {
      lastErr = err
      if (candidates.length > 1) {
        logger.warn(
          { taskId: task.id, agent: task.agent_name, account: i + 1, of: candidates.length, err: err?.message },
          i + 1 < candidates.length ? 'Credential account failed — rolling over to next' : 'Credential account failed — no accounts left',
        )
      }
    }
  }
  throw lastErr
}

/**
 * Resolve the opt-in CLI sandbox options for a task: agent config first,
 * per-field override from tasks.metadata. All fields validated; anything
 * invalid degrades to "flag not passed" (today's behavior).
 */
export function resolveCliSandboxOptions(
  task: Pick<DispatchableTask, 'id' | 'agent_config' | 'metadata'>,
  workspaceRoot: string = config.workspaceRoot,
): CliDispatchSandboxOptions {
  let agentCfg: Record<string, any> = {}
  if (task.agent_config) {
    try {
      const parsed = JSON.parse(task.agent_config)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) agentCfg = parsed
    } catch { /* ignore */ }
  }
  const meta = safeParseMetadata(task.metadata)

  const pick = (camel: string, snake: string): unknown => {
    if (meta[camel] !== undefined) return meta[camel]
    if (meta[snake] !== undefined) return meta[snake]
    return agentCfg[camel]
  }

  return {
    allowedTools: filterCliAllowedTools(pick('dispatchAllowedTools', 'dispatch_allowed_tools'), task.id),
    maxBudgetUsd: clampCliMaxBudgetUsd(pick('dispatchMaxBudgetUsd', 'dispatch_max_budget_usd'), task.id),
    cwd: resolveCliDispatchCwd(pick('dispatchCwd', 'dispatch_cwd'), workspaceRoot, task.id),
    configDir: resolveDispatchConfigDir(pick('dispatchConfigDir', 'dispatch_config_dir'), task.id),
  }
}

function buildTaskPrompt(task: DispatchableTask, rejectionFeedback?: string | null, priorProgress?: string | null): string {
  const ticket = task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
    : `TASK-${task.id}`

  const lines = [
    'You have been assigned a task in Mission Control.',
    '',
    `**[${ticket}] ${task.title}**`,
    `Priority: ${task.priority}`,
  ]

  if (task.tags && task.tags.length > 0) {
    lines.push(`Tags: ${task.tags.join(', ')}`)
  }

  if (task.description) {
    lines.push('', task.description)
  }

  if (rejectionFeedback) {
    lines.push('', '## Previous Review Feedback', rejectionFeedback, '', 'Please address this feedback in your response.')
  }

  if (priorProgress) {
    lines.push(
      '',
      '## Prior progress (previous account hit a usage limit)',
      'Another agent started this task but its account was rate-limited before finishing. Continue from where it left off — do not restart from scratch:',
      '',
      priorProgress,
    )
  }

  lines.push('', 'Complete this task and provide your response. Be concise and actionable.')
  return lines.join('\n')
}

interface AgentResponseParsed {
  text: string | null
  sessionId: string | null
}

interface DeferredCompletionTask {
  id: number
  title: string
  assigned_to: string | null
  metadata: string | null
  workspace_id: number
  ticket_prefix: string | null
  project_ticket_no: number | null
}

function parseAgentResponse(stdout: string): AgentResponseParsed {
  try {
    const parsed = JSON.parse(stdout)
    const sessionId: string | null = typeof parsed?.sessionId === 'string' ? parsed.sessionId
      : typeof parsed?.session_id === 'string' ? parsed.session_id
      : null

    // OpenClaw agent --json returns { payloads: [{ text: "..." }] }
    if (parsed?.payloads?.[0]?.text) {
      return { text: parsed.payloads[0].text, sessionId }
    }
    // Fallback: if there's a result or output field
    if (parsed?.result) return { text: String(parsed.result), sessionId }
    if (parsed?.output) return { text: String(parsed.output), sessionId }
    // Last resort: stringify the whole response
    return { text: JSON.stringify(parsed, null, 2), sessionId }
  } catch {
    // Not valid JSON — return raw stdout if non-empty
    return { text: stdout.trim() || null, sessionId: null }
  }
}

function safeParseMetadata(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function extractDeferredCompletionText(waitPayload: any): string | null {
  if (!waitPayload || typeof waitPayload !== 'object') return null

  const directCandidates = [
    waitPayload.text,
    waitPayload.message,
    waitPayload.response,
    waitPayload.output,
    waitPayload.result,
  ]
  for (const value of directCandidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  const nestedCandidates = [
    waitPayload.result?.text,
    waitPayload.result?.message,
    waitPayload.result?.response,
    waitPayload.result?.output,
    waitPayload.output?.text,
    waitPayload.output?.message,
    waitPayload.output?.content,
  ]
  for (const value of nestedCandidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  const arrays = [
    waitPayload.payloads,
    waitPayload.result?.payloads,
    waitPayload.output,
    waitPayload.result?.output,
  ]
  const parts: string[] = []
  for (const list of arrays) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      if (typeof item.text === 'string' && item.text.trim()) {
        parts.push(item.text.trim())
      }
      if (Array.isArray(item.content)) {
        for (const block of item.content) {
          if (!block || typeof block !== 'object') continue
          const blockType = String(block.type || '')
          if ((blockType === 'text' || blockType === 'output_text' || blockType === 'input_text') && typeof block.text === 'string' && block.text.trim()) {
            parts.push(block.text.trim())
          }
        }
      }
    }
  }

  return parts.length > 0 ? parts.join('\n').slice(0, 10_000) : null
}

function isCompletionStatus(status: string): boolean {
  return ['completed', 'complete', 'success', 'succeeded', 'done', 'ok'].includes(status)
}

function normalizeGatewayIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return normalized || null
}

function buildDeferredCompletionMarkers(task: DeferredCompletionTask): string[] {
  const markers = new Set<string>([
    `TASK-${task.id}`,
    `TASK-${String(task.id).padStart(3, '0')}`,
  ])

  if (task.ticket_prefix && task.project_ticket_no) {
    markers.add(`${task.ticket_prefix}-${task.project_ticket_no}`)
    markers.add(`${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`)
  }

  return [...markers]
}

function getTranscriptText(message: TranscriptMessage): string {
  return message.parts
    .map((part) => part.type === 'text' ? part.text.trim() : '')
    .filter(Boolean)
    .join('\n')
    .trim()
}

function findAssistantTextAfterTaskPrompt(rawTranscript: string, task: DeferredCompletionTask): string | null {
  const messages = parseJsonlTranscript(rawTranscript, 2000)
  if (messages.length === 0) return null

  const markers = buildDeferredCompletionMarkers(task).map((marker) => marker.toLowerCase())

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue

    const userText = getTranscriptText(message).toLowerCase()
    if (!markers.some((marker) => userText.includes(marker))) continue

    for (let j = i + 1; j < messages.length; j++) {
      const candidate = messages[j]
      if (candidate.role !== 'assistant') continue
      const text = getTranscriptText(candidate)
      if (text) return text.slice(0, 10_000)
    }
  }

  return null
}

function recoverDeferredCompletionTextFromTranscript(
  task: DeferredCompletionTask,
  metadata: Record<string, any>,
): string | null {
  if (!config.openclawStateDir) return null

  const dispatchSessionId = normalizeGatewayIdentifier(metadata.dispatch_session_id)
  const assignedAgent = normalizeGatewayIdentifier(task.assigned_to)
  const agentCandidates = new Set<string>(
    [dispatchSessionId, assignedAgent].filter((value): value is string => Boolean(value))
  )

  if (agentCandidates.size === 0) return null

  const sessions = getAllGatewaySessions(24 * 60 * 60 * 1000, true)
    .filter((session) => {
      const sessionAgent = normalizeGatewayIdentifier(session.agent)
      const sessionId = normalizeGatewayIdentifier(session.sessionId)
      const sessionKey = normalizeGatewayIdentifier(session.key)
      return Boolean(
        (sessionAgent && agentCandidates.has(sessionAgent)) ||
        (dispatchSessionId && sessionId === dispatchSessionId) ||
        (dispatchSessionId && sessionKey === dispatchSessionId)
      )
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)

  for (const session of sessions) {
    if (!session.agent || !session.sessionId) continue
    const rawTranscript = readSessionJsonl(config.openclawStateDir, session.agent, session.sessionId)
    if (!rawTranscript) continue
    const text = findAssistantTextAfterTaskPrompt(rawTranscript, task)
    if (text) return text
  }

  return null
}

async function waitForDeferredRun(runId: string): Promise<{ complete: boolean; text: string | null }> {
  const waitPayload = await callOpenClawGateway<any>(
    'agent.wait',
    { runId, timeoutMs: 1000 },
    3000,
  )
  const status = String(waitPayload?.status || waitPayload?.result?.status || '').toLowerCase()
  if (!isCompletionStatus(status)) {
    return { complete: false, text: null }
  }
  return {
    complete: true,
    text: extractDeferredCompletionText(waitPayload),
  }
}

export async function reconcileDeferredTaskCompletions(options: {
  workspaceId?: number
  taskId?: number
  limit?: number
  waitForRun?: (runId: string) => Promise<{ complete: boolean; text: string | null }>
} = {}): Promise<{ ok: boolean; message: string; checked: number; promoted: number }> {
  const db = getDatabase()
  const workspaceId = options.workspaceId ?? 1
  const limit = Math.max(1, Math.min(options.limit ?? 5, 20))
  const waitForRun = options.waitForRun ?? waitForDeferredRun
  const now = Math.floor(Date.now() / 1000)

  const params: unknown[] = [workspaceId]
  let query = `
    SELECT t.id, t.title, t.assigned_to, t.metadata, t.workspace_id,
           p.ticket_prefix, t.project_ticket_no
    FROM tasks t
    JOIN workspaces w ON w.id = t.workspace_id
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    WHERE t.workspace_id = ?
      AND w.isolation = 'shared'
      AND t.status = 'in_progress'
      AND t.metadata IS NOT NULL
      AND t.metadata LIKE '%"async_state"%'
      AND t.metadata LIKE '%"pending"%'
  `
  if (options.taskId !== undefined) {
    query += ' AND t.id = ?'
    params.push(options.taskId)
  }
  query += ' ORDER BY t.updated_at ASC LIMIT ?'
  params.push(limit)

  const tasks = db.prepare(query).all(...params) as DeferredCompletionTask[]
  let promoted = 0

  for (const task of tasks) {
    const metadata = safeParseMetadata(task.metadata)
    if (metadata.async_state !== 'pending') continue

    const runId = typeof metadata.dispatch_run_id === 'string' && metadata.dispatch_run_id.trim()
      ? metadata.dispatch_run_id.trim()
      : typeof metadata.dispatchRunId === 'string' && metadata.dispatchRunId.trim()
        ? metadata.dispatchRunId.trim()
        : typeof metadata.runId === 'string' && metadata.runId.trim()
          ? metadata.runId.trim()
          : null
    if (!runId) continue

    let completion: { complete: boolean; text: string | null }
    try {
      completion = await waitForRun(runId)
    } catch (err) {
      logger.warn({ err, taskId: task.id, runId }, 'Deferred task completion check failed')
      continue
    }
    if (!completion.complete) continue

    const recoveredText = completion.text?.trim() || recoverDeferredCompletionTextFromTranscript(task, metadata)
    const resolution = recoveredText || 'Deferred agent run completed without textual output.'
    const truncated = resolution.length > 10_000
      ? resolution.substring(0, 10_000) + '\n\n[Response truncated at 10,000 characters]'
      : resolution
    const nextMetadata: Record<string, any> = {
      ...metadata,
      async_state: 'completed',
      async_completed_at: now,
    }

    const update = db.prepare(`
      UPDATE tasks
      SET status = 'review',
          outcome = 'success',
          resolution = ?,
          metadata = ?,
          updated_at = ?
      WHERE id = ?
        AND workspace_id = ?
        AND status = 'in_progress'
    `).run(truncated, JSON.stringify(nextMetadata), now, task.id, task.workspace_id)

    if (update.changes === 0) continue

    db.prepare(`
      INSERT INTO comments (task_id, author, content, created_at, workspace_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(task.id, task.assigned_to || 'agent', truncated, now, task.workspace_id)

    eventBus.broadcast('task.status_changed', {
      id: task.id,
      status: 'review',
      previous_status: 'in_progress',
      workspace_id: task.workspace_id,
    })
    eventBus.broadcast('task.updated', {
      id: task.id,
      status: 'review',
      outcome: 'success',
      assigned_to: task.assigned_to,
      dispatch_session_id: nextMetadata.dispatch_session_id,
      dispatch_run_id: nextMetadata.dispatch_run_id,
      workspace_id: task.workspace_id,
    })

    db_helpers.logActivity(
      'task_agent_completed',
      'task',
      task.id,
      task.assigned_to || 'agent',
      `Deferred agent completed task "${task.title}" - awaiting review`,
      { response_length: truncated.length, dispatch_session_id: nextMetadata.dispatch_session_id, dispatch_run_id: nextMetadata.dispatch_run_id },
      task.workspace_id
    )

    promoted++
  }

  return {
    ok: true,
    checked: tasks.length,
    promoted,
    message: promoted > 0
      ? `Promoted ${promoted}/${tasks.length} deferred task(s) to review`
      : `Checked ${tasks.length} deferred task(s); none completed`,
  }
}

// ---------------------------------------------------------------------------
// Direct Claude API dispatch (gateway-free)
// ---------------------------------------------------------------------------

function getAnthropicApiKey(): string | null {
  return (process.env.ANTHROPIC_API_KEY || '').trim() || null
}

function isGatewayAvailable(): boolean {
  // `config.openclawHome` defaults to `~/.openclaw` even when OpenClaw is not
  // installed, so a truthy path string alone is not evidence that a gateway
  // can actually be invoked. Require physical evidence:
  //   - a real `openclaw.json` on disk (= an installed OpenClaw config), OR
  //   - a registered gateway row whose status is healthy. We explicitly
  //     reject `status = 'unknown'` because the onboarding flow seeds a
  //     `primary` row pointing at `host.docker.internal:18789` regardless
  //     of whether OpenClaw is actually running. Treating that seed row as
  //     proof of availability would route every dispatch through
  //     `runOpenClaw` and fail with `spawn openclaw ENOENT` on hosts that
  //     don't have the binary. Require the row to have been pinged
  //     successfully at least once (status in healthy set) before we trust
  //     the gateway path.
  if (config.openclawConfigPath && existsSync(config.openclawConfigPath)) return true
  try {
    const db = getDatabase()
    const row = db.prepare(
      "SELECT COUNT(*) as c FROM gateways WHERE status IN ('online', 'healthy', 'ready')"
    ).get() as { c: number } | undefined
    return (row?.c ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * Resolve the Anthropic dispatch model ID for a catalog tier alias.
 *
 * MODEL_CATALOG is the single source of truth for model IDs — classification
 * derives the exact API model ID from the catalog entry instead of
 * hard-coding ID strings here. The literal fallback only applies if the
 * catalog alias is ever removed (defensive; all three aliases exist today).
 */
function anthropicDispatchId(alias: 'opus' | 'sonnet' | 'haiku', fallback: string): string {
  const entry = getModelByAlias(alias)
  return entry && entry.provider === 'anthropic' ? getDispatchModelId(entry) : fallback
}

function classifyDirectModel(task: DispatchableTask): string {
  // Check per-agent config override first
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.dispatchModel === 'string' && cfg.dispatchModel) {
        // Strip gateway prefixes like "9router/cc/" to get bare model ID
        return cfg.dispatchModel.replace(/^.*\//, '')
      }
    } catch { /* ignore */ }
  }

  const text = `${task.title} ${task.description ?? ''}`.toLowerCase()
  const priority = task.priority?.toLowerCase() ?? ''

  // Complex → Opus
  const complexSignals = [
    'debug', 'diagnos', 'architect', 'design system', 'security audit',
    'root cause', 'investigate', 'incident', 'refactor', 'migration',
  ]
  if (priority === 'critical' || complexSignals.some(s => text.includes(s))) {
    return anthropicDispatchId('opus', 'claude-opus-4-6')
  }

  // Size heuristics → Opus for large/complex tasks
  const descLength = (task.description ?? '').length
  if (descLength > 2000) return anthropicDispatchId('opus', 'claude-opus-4-6')
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT estimated_hours FROM tasks WHERE id = ? AND workspace_id = ?')
      .get(task.id, task.workspace_id) as { estimated_hours: number | null } | undefined
    if (row?.estimated_hours && row.estimated_hours >= 4) return anthropicDispatchId('opus', 'claude-opus-4-6')
  } catch { /* ignore */ }

  // Routine → Haiku
  const routineSignals = [
    'status check', 'health check', 'format', 'rename', 'summarize',
    'translate', 'quick ', 'simple ', 'routine ', 'minor ',
  ]
  if (routineSignals.some(s => text.includes(s)) && priority !== 'high' && priority !== 'critical') {
    // Catalog carries 'claude-haiku-4-5' (Anthropic's alias for the
    // claude-haiku-4-5-20251001 snapshot) — both resolve to the same model.
    return anthropicDispatchId('haiku', 'claude-haiku-4-5')
  }

  // Default → Sonnet
  return anthropicDispatchId('sonnet', 'claude-sonnet-4-6')
}

function getAgentSoulContent(task: DispatchableTask): string | null {
  try {
    const db = getDatabase()
    const row = db.prepare(
      'SELECT soul_content FROM agents WHERE id = ? AND workspace_id = ?'
    ).get(task.agent_id, task.workspace_id) as { soul_content: string | null } | undefined
    return row?.soul_content || null
  } catch {
    return null
  }
}

async function callClaudeDirectly(
  task: DispatchableTask,
  prompt: string,
): Promise<AgentResponseParsed> {
  const apiKey = getAnthropicApiKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set — cannot dispatch without gateway')

  const model = classifyDirectModel(task)
  const soul = getAgentSoulContent(task)

  const messages: Array<{ role: string; content: string }> = [
    { role: 'user', content: prompt },
  ]

  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages,
  }

  if (soul) {
    body.system = soul
  }

  logger.info({ taskId: task.id, model, agent: task.agent_name }, 'Dispatching task via direct Claude API')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '')
    throw new Error(`Claude API ${res.status}: ${errorBody.substring(0, 500)}`)
  }

  const data = await res.json() as {
    content: Array<{ type: string; text?: string }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }

  const text = data.content
    ?.filter((b: { type: string }) => b.type === 'text')
    .map((b: { text?: string }) => b.text || '')
    .join('\n') || null

  // Record token usage
  if (data.usage) {
    recordDispatchTokenUsage({
      model,
      sessionId: `task-${task.id}`,
      inputTokens: data.usage.input_tokens || 0,
      outputTokens: data.usage.output_tokens || 0,
      workspaceId: task.workspace_id,
    })
  }

  return { text, sessionId: null }
}

// ---------------------------------------------------------------------------
// Direct OpenAI / OpenAI-compatible local dispatch — also gateway-free.
//
// The "local" provider path is intentionally generic: it speaks the OpenAI
// `/v1/chat/completions` REST shape, which is what LMStudio, Ollama, vLLM and
// liteLLM proxies all expose. Operators who run multiple local backends
// behind a single liteLLM endpoint can point LOCAL_LLM_ENDPOINT at it and
// route every "local model" request through one process.
//
// Model routing is done by prefix on the agent's `dispatchModel`:
//   "openai/gpt-4o-mini", "gpt-4.1-mini", "o1-*", "o3-*"  → OpenAI cloud
//   "local/<model>", "ollama/<model>", "lmstudio/<model>" → LOCAL_LLM_ENDPOINT
//   anything else (incl. "claude-*")                      → Anthropic
// ---------------------------------------------------------------------------

type DirectProvider = 'anthropic' | 'openai' | 'local'

function getOpenAIApiKey(): string | null {
  return (process.env.OPENAI_API_KEY || '').trim() || null
}

/**
 * OpenAI-compatible local endpoint. Defaults to LMStudio's stock listener on
 * the docker host (`host.docker.internal:1234/v1`). Set LOCAL_LLM_ENDPOINT to
 * point at Ollama (`http://host.docker.internal:11434/v1`), a liteLLM proxy
 * (`http://litellm:4000`), or any other OpenAI-compatible service.
 */
function getLocalEndpoint(): string | null {
  return (process.env.LOCAL_LLM_ENDPOINT || 'http://host.docker.internal:1234/v1').trim() || null
}

function getLocalApiKey(): string | null {
  // Some liteLLM/proxy setups require a master key even for local routing.
  return (process.env.LOCAL_LLM_API_KEY || '').trim() || null
}

function pickProvider(model: string): DirectProvider {
  // Consult MODEL_CATALOG first (single source of truth). Only providers
  // with a direct dispatch path map to a DirectProvider; catalog providers
  // without one (google, groq, moonshot, venice, minimax) fall through to
  // the prefix rules below, which keeps their routing identical to before.
  const catalogProvider = classifyModelProvider(model)
  if (catalogProvider === 'anthropic') return 'anthropic'
  if (catalogProvider === 'openai') return 'openai'
  if (catalogProvider === 'ollama') return 'local'

  // Prefix-match fallback for models not in the catalog — behavior for
  // unknown IDs is unchanged (default remains 'anthropic').
  const m = model.toLowerCase()
  if (m.startsWith('openai/') || m.startsWith('gpt-') || m.startsWith('o1-') || m.startsWith('o3-')) return 'openai'
  if (m.startsWith('local/') || m.startsWith('ollama/') || m.startsWith('lmstudio/') || m.startsWith('litellm/')) return 'local'
  return 'anthropic'
}

function stripProviderPrefix(model: string): string {
  return model.replace(/^(openai|local|ollama|lmstudio|litellm|anthropic)\//, '')
}

/**
 * The Claude Code CLI on the container's PATH (mounted from the host's
 * `~/.local/bin`). When present and authenticated (host's `~/.claude.json`
 * is bind-mounted in), we prefer it over the raw Anthropic API: it inherits
 * the operator's existing login, plan, and rate limits without requiring
 * an `ANTHROPIC_API_KEY` to be exported into the container.
 */
let claudeCliAvailableCache: boolean | null = null
function isClaudeCliAvailable(): boolean {
  try {
    if (existsSync('/home/nextjs/.local/bin/claude')
      || existsSync('/usr/local/bin/claude')
      || existsSync('/usr/bin/claude')) return true
    // Windows native install (~/.local/bin/claude.exe) or any PATH-resolvable
    // binary: the container paths above never exist outside Docker, so fall
    // back to actually resolving the CLI. Cached — spawnSync costs ~1s.
    if (claudeCliAvailableCache !== null) return claudeCliAvailableCache
    const os = require('node:os')
    const path = require('node:path')
    if (existsSync(path.join(os.homedir(), '.local', 'bin', 'claude.exe'))) {
      claudeCliAvailableCache = true
      return true
    }
    const { spawnSync } = require('node:child_process')
    const r = spawnSync('claude', ['--version'], { stdio: 'ignore', timeout: 5000 })
    claudeCliAvailableCache = r.status === 0
    return claudeCliAvailableCache
  } catch { return false }
}

/**
 * The Codex CLI authenticated via ChatGPT subscription login. When present,
 * OpenAI-model tasks can dispatch through `codex exec` without an
 * OPENAI_API_KEY — same idea as the Claude Code CLI path above.
 */
let codexCliAvailableCache: boolean | null = null
function isCodexCliAvailable(): boolean {
  try {
    if (codexCliAvailableCache !== null) return codexCliAvailableCache
    const { spawnSync } = require('node:child_process')
    const r = spawnSync('codex', ['--version'], { stdio: 'ignore', timeout: 5000 })
    codexCliAvailableCache = r.status === 0
    return codexCliAvailableCache
  } catch { return false }
}

/**
 * The Hermes Agent CLI. When present, tasks assigned to a hermes-runtime agent
 * dispatch through `hermes -z` (one-shot) using the operator's configured
 * hermes provider/model — no API key needed here.
 */
let hermesCliAvailableCache: boolean | null = null
function isHermesCliAvailable(): boolean {
  try {
    if (hermesCliAvailableCache !== null) return hermesCliAvailableCache
    const { spawnSync } = require('node:child_process')
    const r = spawnSync('hermes', ['--version'], { stdio: 'ignore', timeout: 5000 })
    hermesCliAvailableCache = r.status === 0
    return hermesCliAvailableCache
  } catch { return false }
}

function isDirectDispatchAvailable(provider?: DirectProvider): boolean {
  if (provider === 'anthropic') return !!getAnthropicApiKey() || isClaudeCliAvailable()
  if (provider === 'openai') return !!getOpenAIApiKey() || isCodexCliAvailable()
  if (provider === 'local') return !!getLocalEndpoint()
  return !!getAnthropicApiKey() || !!getOpenAIApiKey() || !!getLocalEndpoint()
    || isClaudeCliAvailable() || isCodexCliAvailable() || isHermesCliAvailable()
}

/**
 * Dispatch via the host-mounted Claude Code CLI, using the operator's existing
 * login (no API key required). Reads the prompt over stdin and asks for a
 * machine-readable result via `--output-format json`.
 *
 * The CLI accepts model aliases ("opus" / "sonnet" / "haiku") and the long
 * `claude-...` IDs. We try the bare ID first (already produced by
 * `classifyDirectModel`), and fall back to the alias derived from the family
 * keyword so a stale `claude-opus-4-5` mapping still routes correctly.
 */
async function callClaudeViaCli(
  task: DispatchableTask,
  prompt: string,
  model: string,
  configDir?: string | null,
): Promise<AgentResponseParsed> {
  const soul = getAgentSoulContent(task)
  const sandbox = resolveCliSandboxOptions(task)
  // Explicit configDir (incl. null) from rotation wins; otherwise the single
  // dispatchConfigDir resolved in sandbox options (backward compatible).
  const effectiveConfigDir = configDir === undefined ? sandbox.configDir : configDir
  const args = ['--print', '--output-format', 'json', '--model', model]
  if (sandbox.allowedTools) args.push('--allowedTools', sandbox.allowedTools.join(','))
  if (sandbox.maxBudgetUsd !== null) args.push('--max-budget-usd', String(sandbox.maxBudgetUsd))
  if (soul) args.push('--append-system-prompt', soul)

  const sandboxApplied = sandbox.allowedTools !== null || sandbox.maxBudgetUsd !== null || sandbox.cwd !== null
  logger.info(
    {
      taskId: task.id, model, agent: task.agent_name,
      ...(sandboxApplied ? { sandbox: { allowedTools: sandbox.allowedTools, maxBudgetUsd: sandbox.maxBudgetUsd, cwd: sandbox.cwd } } : {}),
    },
    'Dispatching task via Claude CLI',
  )

  return await new Promise<AgentResponseParsed>((resolve, reject) => {
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CI: '1',
        // Per-agent credentials/settings: relocate the whole ~/.claude dir
        // (settings.json + .credentials.json). ponytail: distinct agents use
        // distinct dirs so they never share; the same claude agent dispatched
        // concurrently could still race on OAuth token refresh in one dir —
        // give that agent's dir a settings.json apiKeyHelper (or its own API
        // key login) if you push it into parallel dispatch.
        ...(effectiveConfigDir ? { CLAUDE_CONFIG_DIR: effectiveConfigDir } : {}),
      },
      ...(sandbox.cwd ? { cwd: sandbox.cwd } : {}),
    })
    let stdout = ''
    let stderr = ''
    const timeoutMs = 180_000
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error(`Claude CLI timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const e = new Error(`claude CLI exited ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`)
        // Carry any partial output so a usage-limit failover can continue it.
        ;(e as any).partialOutput = stdout
        return reject(e)
      }
      try {
        const parsed = JSON.parse(stdout)
        const text: string | null = (typeof parsed?.result === 'string' && parsed.result)
          || (typeof parsed?.output === 'string' && parsed.output)
          || (typeof parsed?.text === 'string' && parsed.text)
          || stdout.trim()
          || null
        const sessionId: string | null = (typeof parsed?.session_id === 'string' && parsed.session_id)
          || (typeof parsed?.sessionId === 'string' && parsed.sessionId)
          || null

        // Record token usage if reported.
        if (parsed?.usage && (parsed.usage.input_tokens || parsed.usage.output_tokens)) {
          recordDispatchTokenUsage({
            model,
            sessionId: sessionId || `task-${task.id}`,
            inputTokens: parsed.usage.input_tokens || 0,
            outputTokens: parsed.usage.output_tokens || 0,
            workspaceId: task.workspace_id,
          })
        }

        resolve({ text, sessionId })
      } catch {
        resolve({ text: stdout.trim() || null, sessionId: null })
      }
    })

    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

async function callOpenAICompatible(
  task: DispatchableTask,
  prompt: string,
  endpoint: string,
  apiKey: string | null,
  model: string,
  providerLabel: DirectProvider,
): Promise<AgentResponseParsed> {
  const soul = getAgentSoulContent(task)
  const messages: Array<{ role: string; content: string }> = []
  if (soul) messages.push({ role: 'system', content: soul })
  messages.push({ role: 'user', content: prompt })

  const body = { model, messages, max_tokens: 4096 }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  logger.info({ taskId: task.id, model, agent: task.agent_name, provider: providerLabel },
    `Dispatching task via direct ${providerLabel} API`)

  const res = await fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '')
    throw new Error(`${providerLabel} API ${res.status}: ${errorBody.substring(0, 500)}`)
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const text = data.choices?.[0]?.message?.content?.trim() || null

  if (data.usage) {
    recordDispatchTokenUsage({
      model,
      sessionId: `task-${task.id}`,
      inputTokens: data.usage.prompt_tokens || 0,
      outputTokens: data.usage.completion_tokens || 0,
      workspaceId: task.workspace_id,
    })
  }

  return { text, sessionId: null }
}

async function callOpenAIDirectly(task: DispatchableTask, prompt: string, model: string): Promise<AgentResponseParsed> {
  const apiKey = getOpenAIApiKey()
  if (!apiKey) {
    // No API key — fall back to the host Codex CLI (ChatGPT subscription
    // login), mirroring the Claude CLI path used for Anthropic models.
    if (isCodexCliAvailable()) return callCodexViaCli(task, prompt, stripProviderPrefix(model))
    throw new Error('OPENAI_API_KEY not set and Codex CLI not found — cannot dispatch to OpenAI without gateway')
  }
  return callOpenAICompatible(task, prompt, 'https://api.openai.com/v1', apiKey, stripProviderPrefix(model), 'openai')
}

/**
 * Dispatch via the host Codex CLI using the operator's ChatGPT login (no API
 * key required). One-shot `codex exec` run: prompt over stdin (`-` arg, avoids
 * Windows argv length limits and quoting), clean result text retrieved via
 * --output-last-message. The agent soul has no system-prompt flag on codex,
 * so it is prepended to the prompt body.
 */
async function callCodexViaCli(
  task: DispatchableTask,
  prompt: string,
  model: string,
  configDir?: string | null,
): Promise<AgentResponseParsed> {
  const os = require('node:os')
  const path = require('node:path')
  const { readFileSync, rmSync } = require('node:fs')
  const outPath = path.join(os.tmpdir(), `mc-codex-task-${task.id}-${process.pid}-${Date.now()}.txt`)

  const soul = getAgentSoulContent(task)
  const fullPrompt = soul ? `${soul}\n\n---\n\n${prompt}` : prompt

  const args = ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--output-last-message', outPath]
  // ChatGPT-subscription auth only supports the account's model lineup (e.g.
  // gpt-5.5); claude-* or unsupported gpt ids would 400. Pass --model only for
  // explicit gpt overrides, otherwise let the CLI use its configured default.
  if (model && /^gpt-/i.test(model)) args.push('--model', model)
  args.push('-')

  // Workspace-scoped cwd only (issue #720) — codex's own --sandbox flag
  // handling above stays untouched.
  const sandbox = resolveCliSandboxOptions(task)
  const dispatchCwd = sandbox.cwd
  // Explicit configDir (incl. null) from rotation wins; else the single
  // dispatchConfigDir from sandbox options (backward compatible).
  const effectiveConfigDir = configDir === undefined ? sandbox.configDir : configDir
  logger.info(
    { taskId: task.id, model, agent: task.agent_name, ...(dispatchCwd ? { sandbox: { cwd: dispatchCwd } } : {}) },
    'Dispatching task via Codex CLI',
  )

  return await new Promise<AgentResponseParsed>((resolve, reject) => {
    const proc = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Per-agent credentials/config: relocate the whole ~/.codex dir.
        ...(effectiveConfigDir ? { CODEX_HOME: effectiveConfigDir } : {}),
      },
      ...(dispatchCwd ? { cwd: dispatchCwd } : {}),
    })
    let stdout = ''
    let stderr = ''
    const timeoutMs = 300_000
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error(`Codex CLI timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      let text: string | null = null
      try { text = (readFileSync(outPath, 'utf8') as string).trim() || null } catch { /* no output file written */ }
      try { rmSync(outPath, { force: true }) } catch { /* ignore */ }
      // A usage limit can exit non-zero *with* partial output; treat it as a
      // failure (so failover fires) rather than a completed task, and carry
      // the partial output forward.
      const combined = stderr || stdout
      if (isUsageLimitError(combined)) {
        const e = new Error(`codex usage limit: ${combined.slice(0, 300)}`)
        ;(e as any).partialOutput = text || stdout
        return reject(e)
      }
      if (code !== 0 && !text) {
        const e = new Error(`codex CLI exited ${code}: ${(stderr || stdout).slice(0, 500)}`)
        ;(e as any).partialOutput = stdout
        return reject(e)
      }
      resolve({ text: text || stdout.trim() || null, sessionId: null })
    })

    proc.stdin.write(fullPrompt)
    proc.stdin.end()
  })
}

async function callLocalDirectly(task: DispatchableTask, prompt: string, model: string): Promise<AgentResponseParsed> {
  const endpoint = getLocalEndpoint()
  if (!endpoint) throw new Error('LOCAL_LLM_ENDPOINT not set — cannot dispatch to local model')
  return callOpenAICompatible(task, prompt, endpoint, getLocalApiKey(), stripProviderPrefix(model), 'local')
}

/**
 * Dispatch via the Hermes Agent one-shot CLI (`hermes -z`), which prints only
 * the final response text. Uses the operator's configured hermes provider/model.
 *
 * ponytail: runs hermes's default profile/config — per-agent hermes model or
 * profile selection is not wired through. Add `--profile <name>` / `-m <model>`
 * here if MC-created hermes profiles need to diverge from the default.
 */
async function callHermesViaCli(task: DispatchableTask, prompt: string): Promise<AgentResponseParsed> {
  const soul = getAgentSoulContent(task)
  const fullPrompt = soul ? `${soul}\n\n---\n\n${prompt}` : prompt
  logger.info({ taskId: task.id, agent: task.agent_name }, 'Dispatching task via Hermes CLI')

  return await new Promise<AgentResponseParsed>((resolve, reject) => {
    const proc = spawn('hermes', ['-z', fullPrompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    let stdout = ''
    let stderr = ''
    const timeoutMs = 300_000
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error(`Hermes CLI timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      const text = stdout.trim() || null
      if (code !== 0 && !text) {
        return reject(new Error(`hermes CLI exited ${code}: ${(stderr || stdout).slice(0, 500)}`))
      }
      resolve({ text, sessionId: null })
    })
  })
}

/**
 * Decide which dispatch route an agent's declared runtime maps to.
 * Pure so it can be unit-tested without spawning a CLI.
 *
 * - hermes  → 'hermes' when the hermes CLI is installed, else fall back to
 *             model-based routing (so a hermes agent still runs somewhere).
 * - claude  → 'claude' (CLI or Anthropic API resolved downstream).
 * - codex   → 'codex'  (CLI or OpenAI API resolved downstream).
 * - anything else (openclaw/custom/legacy/unset) → 'model' (route by model id).
 */
export function pickRuntimeRoute(
  runtimeType: string | null | undefined,
  avail: { hermes: boolean },
): 'hermes' | 'claude' | 'codex' | 'model' {
  switch ((runtimeType || '').toLowerCase()) {
    case 'hermes': return avail.hermes ? 'hermes' : 'model'
    case 'claude': return 'claude'
    case 'codex': return 'codex'
    default: return 'model'
  }
}

/**
 * True when there is no reachable OpenClaw gateway but a direct CLI/API path
 * exists — i.e. callers that would normally invoke the gateway should instead
 * run through `callDirectly`. This is the hermes/claude/codex-first setup.
 */
export function shouldDispatchDirectly(): boolean {
  return !isGatewayAvailable() && isDirectDispatchAvailable()
}

/**
 * Run an ad-hoc prompt (not a stored task) through the gateway-free dispatch
 * path, so "spawn agent" works without OpenClaw. Routing is model-based: pass
 * `model` to steer it, otherwise the task-complexity classifier picks the tier.
 *
 * ponytail: builds a synthetic DispatchableTask because the direct path is
 * task-shaped. id 0 is safe — the only DB read it drives is the soul lookup,
 * which simply returns null for a non-existent agent.
 */
export async function runDirectSpawn(opts: {
  prompt: string
  label: string
  model?: string | null
  workspaceId: number
}): Promise<AgentResponseParsed> {
  const synthetic: DispatchableTask = {
    id: 0,
    title: opts.label,
    description: opts.prompt,
    status: 'in_progress',
    priority: 'medium',
    assigned_to: opts.label,
    workspace_id: opts.workspaceId,
    agent_name: opts.label,
    agent_id: 0,
    // dispatchModel is how callDirectly honors an explicit model override.
    agent_config: opts.model ? JSON.stringify({ dispatchModel: opts.model }) : null,
    ticket_prefix: null,
    project_ticket_no: null,
    project_id: null,
  }
  return callDirectly(synthetic, opts.prompt)
}

async function callDirectly(task: DispatchableTask, prompt: string): Promise<AgentResponseParsed> {
  // Honor the agent's declared runtime first — this is what the create-agent
  // Runtime picker sets, so "delegate to claude/codex/hermes" routes to the
  // runtime the operator chose regardless of the model tier heuristic.
  const route = pickRuntimeRoute(task.runtime_type, { hermes: isHermesCliAvailable() })
  if (route === 'hermes') {
    return callHermesViaCli(task, prompt)
  }
  if (route === 'claude') {
    // Roll over across the agent's credential accounts on error/usage-limit.
    const candidates = getCredentialCandidates(task)
    const claudeModel = stripProviderPrefix(classifyDirectModel(task))
    return runWithCredentialRotation(task, candidates, (dir) =>
      isClaudeCliAvailable()
        ? callClaudeViaCli(task, prompt, claudeModel, dir)
        : callClaudeDirectly(task, prompt))
  }
  if (route === 'codex') {
    const candidates = getCredentialCandidates(task)
    return runWithCredentialRotation(task, candidates, (dir) =>
      isCodexCliAvailable()
        ? callCodexViaCli(task, prompt, '', dir)
        : callOpenAIDirectly(task, prompt, classifyDirectModel(task)))
  }

  // No explicit runtime (openclaw/custom/legacy agents): route by model.
  const model = classifyDirectModel(task)
  const provider = pickProvider(model)
  if (provider === 'openai') return callOpenAIDirectly(task, prompt, model)
  if (provider === 'local') return callLocalDirectly(task, prompt, model)
  // Anthropic: prefer the host Claude Code CLI when available — it uses the
  // operator's existing login, no API key needed. Fall back to the API key
  // path only if the CLI isn't installed.
  if (isClaudeCliAvailable()) return callClaudeViaCli(task, prompt, stripProviderPrefix(model))
  return callClaudeDirectly(task, prompt)
}

interface ReviewableTask {
  id: number
  title: string
  description: string | null
  status: string
  priority: string
  resolution: string | null
  assigned_to: string | null
  agent_config: string | null
  workspace_id: number
  project_id: number | null
  ticket_prefix: string | null
  project_ticket_no: number | null
}

function resolveGatewayAgentIdForReview(task: ReviewableTask): string {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.openclawId === 'string' && cfg.openclawId) return cfg.openclawId
    } catch { /* ignore */ }
  }
  return task.assigned_to || 'jarv'
}

function buildReviewPrompt(task: ReviewableTask): string {
  const ticket = task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
    : `TASK-${task.id}`

  const lines = [
    'You are Aegis, the quality reviewer for Mission Control.',
    'Review the following completed task and its resolution.',
    '',
    `**[${ticket}] ${task.title}**`,
  ]

  if (task.description) {
    lines.push('', '## Task Description', task.description)
  }

  if (task.resolution) {
    lines.push('', '## Agent Resolution', task.resolution.substring(0, 6000))
  }

  lines.push(
    '',
    '## Instructions',
    'Evaluate whether the agent\'s response adequately addresses the task.',
    'Respond with EXACTLY one of these two formats:',
    '',
    'If the work is acceptable:',
    'VERDICT: APPROVED',
    'NOTES: <brief summary of why it passes>',
    '',
    'If the work needs improvement:',
    'VERDICT: REJECTED',
    'NOTES: <specific issues that need to be fixed>',
  )

  return lines.join('\n')
}

function parseReviewVerdict(text: string): { status: 'approved' | 'rejected'; notes: string } {
  const upper = text.toUpperCase()
  const status = upper.includes('VERDICT: APPROVED') ? 'approved' as const : 'rejected' as const
  const notesMatch = text.match(/NOTES:\s*(.+)/i)
  const notes = notesMatch?.[1]?.trim().substring(0, 2000) || (status === 'approved' ? 'Quality check passed' : 'Quality check failed')
  return { status, notes }
}

/**
 * Run Aegis quality reviews on tasks in 'review' status.
 * Uses an agent to evaluate the task resolution, then approves or rejects.
 */
export async function runAegisReviews(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()

  const tasks = db.prepare(`
    SELECT t.id, t.title, t.description, t.status, t.priority, t.resolution, t.assigned_to, t.workspace_id,
           t.project_id, p.ticket_prefix, t.project_ticket_no, a.config as agent_config
    FROM tasks t
    JOIN workspaces w ON w.id = t.workspace_id
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    LEFT JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    WHERE t.status = 'review'
      AND w.isolation = 'shared'
    ORDER BY t.updated_at ASC
    LIMIT 3
  `).all() as ReviewableTask[]

  if (tasks.length === 0) {
    return { ok: true, message: 'No tasks awaiting review' }
  }

  const results: Array<{ id: number; verdict: string; error?: string }> = []

  for (const task of tasks) {
    // Move to quality_review to prevent re-processing
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
      .run('quality_review', Math.floor(Date.now() / 1000), task.id, task.workspace_id)

    eventBus.broadcast('task.status_changed', {
      id: task.id,
      status: 'quality_review',
      previous_status: 'review',
      workspace_id: task.workspace_id,
    })

    try {
      const prompt = buildReviewPrompt(task)
      let agentResponse: AgentResponseParsed

      if (!isGatewayAvailable() && isDirectDispatchAvailable()) {
        // Direct API review — no gateway needed (Anthropic / OpenAI / local).
        // Pass through agent_config so Aegis honors per-agent dispatchModel
        // overrides and routes to the matching provider.
        const reviewTask: DispatchableTask = {
          id: task.id, title: task.title, description: task.description,
          status: 'quality_review', priority: 'high', assigned_to: 'aegis',
          workspace_id: task.workspace_id, agent_name: 'aegis', agent_id: 0,
          agent_config: task.agent_config, ticket_prefix: task.ticket_prefix,
          project_ticket_no: task.project_ticket_no, project_id: null,
        }
        agentResponse = await callDirectly(reviewTask, prompt)
      } else {
        // Resolve the gateway agent ID from config, falling back to assigned_to or default
        const reviewAgent = resolveGatewayAgentIdForReview(task)

        const invokeParams = {
          message: prompt,
          agentId: reviewAgent,
          idempotencyKey: `aegis-review-${task.id}-${Date.now()}`,
          deliver: false,
        }
        const finalPayload = await callOpenClawGateway<any>(
          'agent',
          invokeParams,
          125_000,
          { expectFinal: true },
        )
        agentResponse = parseAgentResponse(
          finalPayload?.result ? JSON.stringify(finalPayload.result) : JSON.stringify(finalPayload)
        )
      }

      if (!agentResponse.text) {
        throw new Error('Aegis review returned empty response')
      }

      const verdict = parseReviewVerdict(agentResponse.text)

      // Insert quality review record
      db.prepare(`
        INSERT INTO quality_reviews (task_id, reviewer, status, notes, workspace_id)
        VALUES (?, 'aegis', ?, ?, ?)
      `).run(task.id, verdict.status, verdict.notes, task.workspace_id)

      if (verdict.status === 'approved') {
        db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
          .run('done', Math.floor(Date.now() / 1000), task.id, task.workspace_id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'done',
          previous_status: 'quality_review',
          workspace_id: task.workspace_id,
        })
        syncAndEscalateIfFailed(task, 'done')
      } else {
        // Rejected: check dispatch_attempts to decide next status
        const now = Math.floor(Date.now() / 1000)
        const currentAttempts = (db.prepare('SELECT dispatch_attempts FROM tasks WHERE id = ? AND workspace_id = ?').get(task.id, task.workspace_id) as { dispatch_attempts: number } | undefined)?.dispatch_attempts ?? 0
        const newAttempts = currentAttempts + 1
        const maxAegisRetries = 3

        if (newAttempts >= maxAegisRetries) {
          // Too many rejections — move to failed
          db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
            .run('failed', `Aegis rejected ${newAttempts} times. Last: ${verdict.notes}`, newAttempts, now, task.id, task.workspace_id)

          eventBus.broadcast('task.status_changed', {
            id: task.id,
            status: 'failed',
            previous_status: 'quality_review',
            error_message: `Aegis rejected ${newAttempts} times`,
            reason: 'max_aegis_retries_exceeded',
            workspace_id: task.workspace_id,
          })
          syncAndEscalateIfFailed(task, 'failed', `Aegis rejected ${newAttempts} times`, newAttempts)
        } else {
          // Requeue to assigned for re-dispatch with feedback
          db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
            .run('assigned', `Aegis rejected: ${verdict.notes}`, newAttempts, now, task.id, task.workspace_id)

          eventBus.broadcast('task.status_changed', {
            id: task.id,
            status: 'assigned',
            previous_status: 'quality_review',
            error_message: `Aegis rejected: ${verdict.notes}`,
            reason: 'aegis_rejection',
            workspace_id: task.workspace_id,
          })
          syncAndEscalateIfFailed(task, 'assigned')
        }

        // Add rejection as a comment so the agent sees it on next dispatch
        db.prepare(`
          INSERT INTO comments (task_id, author, content, created_at, workspace_id)
          VALUES (?, 'aegis', ?, ?, ?)
        `).run(task.id, `Quality Review Rejected (attempt ${newAttempts}/${maxAegisRetries}):\n${verdict.notes}`, now, task.workspace_id)
      }

      db_helpers.logActivity(
        'aegis_review',
        'task',
        task.id,
        'aegis',
        `Aegis ${verdict.status} task "${task.title}": ${verdict.notes.substring(0, 200)}`,
        { verdict: verdict.status, notes: verdict.notes },
        task.workspace_id
      )

      results.push({ id: task.id, verdict: verdict.status })
      logger.info({ taskId: task.id, verdict: verdict.status }, 'Aegis review completed')
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error'
      logger.error({ taskId: task.id, err }, 'Aegis review failed')

      // Revert to review so it can be retried
      db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
        .run('review', Math.floor(Date.now() / 1000), task.id, task.workspace_id)

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'review',
        previous_status: 'quality_review',
        workspace_id: task.workspace_id,
      })

      results.push({ id: task.id, verdict: 'error', error: errorMsg.substring(0, 100) })
    }
  }

  const approved = results.filter(r => r.verdict === 'approved').length
  const rejected = results.filter(r => r.verdict === 'rejected').length
  const errors = results.filter(r => r.verdict === 'error').length

  return {
    ok: errors === 0,
    message: `Reviewed ${tasks.length}: ${approved} approved, ${rejected} rejected${errors ? `, ${errors} error(s)` : ''}`,
  }
}

/**
 * Requeue stale tasks stuck in 'in_progress' whose assigned agent is offline.
 * Prevents tasks from being permanently stuck when agents crash or disconnect.
 */
export async function requeueStaleTasks(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const staleThreshold = now - 10 * 60 // 10 minutes
  const maxDispatchRetries = 5

  const staleTasks = db.prepare(`
    SELECT t.id, t.title, t.assigned_to, t.dispatch_attempts, t.workspace_id,
           a.status as agent_status, a.last_seen as agent_last_seen
    FROM tasks t
    LEFT JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    WHERE t.status = 'in_progress'
      AND t.updated_at < ?
  `).all(staleThreshold) as Array<{
    id: number; title: string; assigned_to: string | null; dispatch_attempts: number
    workspace_id: number; agent_status: string | null; agent_last_seen: number | null
  }>

  if (staleTasks.length === 0) {
    return { ok: true, message: 'No stale tasks found' }
  }

  let requeued = 0
  let failed = 0

  // When MC runs in direct-API mode (no gateway), the agent has no heartbeat
  // and stays "offline" by design — but tasks still get dispatched via the
  // direct provider (Anthropic/OpenAI/local). Skip the offline-stale check
  // entirely in that mode, otherwise every task is failed after 5 cycles
  // before any direct-API dispatch can run.
  const directApiSkipsStaleCheck = !isGatewayAvailable() && isDirectDispatchAvailable()

  for (const task of staleTasks) {
    if (directApiSkipsStaleCheck) continue
    // Only requeue if the agent is offline or unknown
    const agentOffline = !task.agent_status || task.agent_status === 'offline'
    if (!agentOffline) continue

    const newAttempts = (task.dispatch_attempts ?? 0) + 1

    if (newAttempts >= maxDispatchRetries) {
      db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
        .run('failed', `Task stuck in_progress ${newAttempts} times — agent "${task.assigned_to}" offline. Moved to failed.`, newAttempts, now, task.id, task.workspace_id)

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'failed',
        previous_status: 'in_progress',
        error_message: `Stale task — agent offline after ${newAttempts} attempts`,
        reason: 'stale_task_max_retries',
        workspace_id: task.workspace_id,
      })

      syncAndEscalateIfFailed(task as any, 'failed', `Task stuck in_progress ${newAttempts} times`, newAttempts)
      failed++
    } else {
      db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
        .run('assigned', `Requeued: agent "${task.assigned_to}" went offline while task was in_progress`, newAttempts, now, task.id, task.workspace_id)

      // Add a comment explaining the requeue
      db.prepare(`
        INSERT INTO comments (task_id, author, content, created_at, workspace_id)
        VALUES (?, 'scheduler', ?, ?, ?)
      `).run(task.id, `Task requeued (attempt ${newAttempts}/${maxDispatchRetries}): agent "${task.assigned_to}" went offline while task was in_progress.`, now, task.workspace_id)

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'assigned',
        previous_status: 'in_progress',
        error_message: `Agent "${task.assigned_to}" went offline`,
        reason: 'stale_task_requeue',
        workspace_id: task.workspace_id,
      })
      syncAndEscalateIfFailed(task as any, 'assigned')

      requeued++
    }
  }

  const total = requeued + failed
  return {
    ok: true,
    message: total === 0
      ? `Found ${staleTasks.length} stale task(s) but agents still online`
      : `Requeued ${requeued}, failed ${failed} of ${staleTasks.length} stale task(s)`,
  }
}

/**
 * Heuristic: does a dispatch error look like a provider usage / rate limit?
 * ponytail: matches common claude/codex wording; widen the pattern if a real
 * limit message slips through and fails the task instead of failing over.
 */
export function isUsageLimitError(message: string | null | undefined): boolean {
  if (!message) return false
  return /rate[\s_-]?limit|usage limit|limit reached|quota|too many requests|\b429\b|\b529\b|overloaded|insufficient[_ ]?quota|exceeded your/i.test(message)
}

/** Cooldown (minutes) a rate-limited agent is skipped as a failover target. */
function ratelimitCooldownMinutes(): number {
  try {
    const row = getDatabase().prepare("SELECT value FROM settings WHERE key = 'general.agent_ratelimit_cooldown_minutes'").get() as { value: string } | undefined
    const n = row ? parseInt(row.value) : NaN
    return Number.isFinite(n) && n > 0 ? n : 60
  } catch { return 60 }
}

/** Is credential rotation / cross-agent failover enabled on this agent? */
function failoverEnabled(agentConfig: string | null): boolean {
  if (!agentConfig) return false
  try { return JSON.parse(agentConfig)?.credentialRotation === true } catch { return false }
}

/**
 * Pick another agent of the same runtime, in the same workspace, that has
 * failover enabled and is not currently rate-limited, to take over a task.
 */
function pickFailoverAgent(
  runtimeType: string | null | undefined,
  workspaceId: number,
  excludeAgentId: number,
  now: number,
): { id: number; name: string } | null {
  if (!runtimeType) return null
  try {
    const rows = getDatabase().prepare(`
      SELECT id, name, config FROM agents
      WHERE workspace_id = ? AND runtime_type = ? AND id != ?
        AND (rate_limited_until IS NULL OR rate_limited_until < ?)
      ORDER BY id ASC
    `).all(workspaceId, runtimeType, excludeAgentId, now) as Array<{ id: number; name: string; config: string | null }>
    for (const r of rows) {
      if (failoverEnabled(r.config)) return { id: r.id, name: r.name }
    }
    return null
  } catch { return null }
}

export async function dispatchAssignedTasks(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()

  const tasks = db.prepare(`
    SELECT t.*, a.name as agent_name, a.id as agent_id, a.config as agent_config,
           a.runtime_type as runtime_type,
           p.ticket_prefix, t.project_ticket_no
    FROM tasks t
    JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    JOIN workspaces w ON w.id = t.workspace_id
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    WHERE t.status = 'assigned'
      AND w.isolation = 'shared'
      AND t.assigned_to IS NOT NULL
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
      t.created_at ASC
    LIMIT 3
  `).all() as (DispatchableTask & { tags?: string })[]

  if (tasks.length === 0) {
    return { ok: true, message: 'No assigned tasks to dispatch' }
  }

  // Parse JSON tags column
  for (const task of tasks) {
    if (typeof task.tags === 'string') {
      try { task.tags = JSON.parse(task.tags as string) } catch { task.tags = undefined }
    }
  }

  const results: Array<{ id: number; success: boolean; error?: string }> = []
  const now = Math.floor(Date.now() / 1000)

  for (const task of tasks) {
    // Atomically claim the task: only flip to in_progress if it is still
    // 'assigned'. If two dispatchers race (e.g. concurrent scheduler ticks or
    // multiple workers polling), exactly one UPDATE reports changes=1 and the
    // loser skips this task — preventing double-dispatch (issue/PR #698).
    const claim = db
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'assigned' AND workspace_id = ?")
      .run('in_progress', now, task.id, task.workspace_id)

    if (claim.changes === 0) {
      // Another dispatcher won the race (or the task was cancelled between
      // SELECT and UPDATE). Skip silently — no event, no activity, no work.
      continue
    }

    eventBus.broadcast('task.status_changed', {
      id: task.id,
      status: 'in_progress',
      previous_status: 'assigned',
      workspace_id: task.workspace_id,
    })

    db_helpers.logActivity(
      'task_dispatched',
      'task',
      task.id,
      'scheduler',
      `Dispatching task "${task.title}" to agent ${task.agent_name}`,
      { agent: task.agent_name, priority: task.priority },
      task.workspace_id
    )

    try {
      // Check for previous Aegis rejection feedback
      const rejectionRow = db.prepare(`
        SELECT content FROM comments
        WHERE task_id = ? AND author = 'aegis' AND content LIKE 'Quality Review Rejected:%' AND workspace_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(task.id, task.workspace_id) as { content: string } | undefined
      const rejectionFeedback = rejectionRow?.content?.replace(/^Quality Review Rejected:\n?/, '') || null

      // Read task metadata up front — carries target_session and, after a
      // usage-limit failover, the partial progress from the previous account.
      const taskMeta = (() => {
        try {
          const row = db.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?')
            .get(task.id, task.workspace_id) as { metadata: string } | undefined
          return row?.metadata ? JSON.parse(row.metadata) : {}
        } catch { return {} }
      })()
      const failoverContext = typeof taskMeta?.failover_context === 'string' && taskMeta.failover_context.trim()
        ? taskMeta.failover_context.trim()
        : null

      const prompt = buildTaskPrompt(task, rejectionFeedback, failoverContext)

      // Check if task has a target session specified in metadata
      const targetSession: string | null = typeof taskMeta?.target_session === 'string' && taskMeta.target_session
        ? taskMeta.target_session
        : null

      let agentResponse: AgentResponseParsed
      const useDirectApi = !isGatewayAvailable() && isDirectDispatchAvailable()

      if (useDirectApi && !targetSession) {
        // Direct API dispatch — provider chosen by `dispatchModel` prefix
        // (Anthropic / OpenAI / OpenAI-compatible local). No gateway needed.
        agentResponse = await callDirectly(task, prompt)
      } else if (targetSession) {
        // Dispatch to a specific existing session via chat.send
        logger.info({ taskId: task.id, targetSession, agent: task.agent_name }, 'Dispatching task to targeted session')
        const sendResult = await callOpenClawGateway<any>(
          'chat.send',
          {
            sessionKey: targetSession,
            message: prompt,
            idempotencyKey: `task-dispatch-${task.id}-${Date.now()}`,
            deliver: false,
          },
          125_000,
        )
        const status = String(sendResult?.status || '').toLowerCase()
        if (status !== 'started' && status !== 'ok' && status !== 'in_flight' && status !== 'accepted') {
          throw new Error(`chat.send to session ${targetSession} returned status: ${status}`)
        }
        // chat.send is fire-and-forget. Only runs with a runId can be safely
        // reconciled by agent.wait; accepted sends without one need explicit
        // manual/later recovery instead of looking pending forever.
        const dispatchRunId = typeof sendResult?.runId === 'string' && sendResult.runId.trim()
          ? sendResult.runId.trim()
          : null
        const asyncState = dispatchRunId ? 'pending' : 'accepted_without_run_id'
        const pendingMeta: Record<string, any> = {
          ...taskMeta,
          target_session: targetSession,
          dispatch_session_id: targetSession,
          ...(dispatchRunId ? { dispatch_run_id: dispatchRunId } : {
            async_reconciliation: 'manual_required',
            async_warning: 'chat.send accepted without a runId; automatic completion reconciliation cannot safely wait on this session.',
          }),
          async_state: asyncState,
          async_dispatched_at: Math.floor(Date.now() / 1000),
        }
        db.prepare('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
          .run(JSON.stringify(pendingMeta), Math.floor(Date.now() / 1000), task.id, task.workspace_id)

        eventBus.broadcast('task.updated', {
          id: task.id,
          status: 'in_progress',
          assigned_to: task.assigned_to,
          dispatch_session_id: targetSession,
          dispatch_run_id: pendingMeta.dispatch_run_id,
          async_state: asyncState,
          workspace_id: task.workspace_id,
        })

        db_helpers.logActivity(
          dispatchRunId ? 'task_deferred_dispatch' : 'task_deferred_dispatch_unreconcilable',
          'task',
          task.id,
          'scheduler',
          dispatchRunId
            ? `Deferred task "${task.title}" to existing session ${targetSession}`
            : `Accepted task "${task.title}" in existing session ${targetSession} without a runId; manual reconciliation required`,
          { dispatch_session_id: targetSession, dispatch_run_id: pendingMeta.dispatch_run_id, async_state: asyncState },
          task.workspace_id
        )

        results.push({ id: task.id, success: true })
        continue
      } else {
        // Step 1: Invoke via gateway (new session)
        const gatewayAgentId = resolveGatewayAgentId(task)
        const dispatchModel = resolveTaskDispatchModelOverride(task)
        const invokeParams: Record<string, unknown> = {
          message: prompt,
          agentId: gatewayAgentId,
          idempotencyKey: `task-dispatch-${task.id}-${Date.now()}`,
          deliver: false,
        }
        // Route to appropriate model tier based on task complexity.
        // null = no override, agent uses its own configured default model.
        if (dispatchModel) invokeParams.model = dispatchModel

        const acceptedPayload = await callOpenClawGateway<any>(
          'agent',
          invokeParams,
          AGENT_DISPATCH_ACCEPT_TIMEOUT_MS,
        )
        const status = String(acceptedPayload?.status || '').toLowerCase()
        if (status && !['started', 'ok', 'in_flight', 'accepted'].includes(status)) {
          throw new Error(`agent dispatch returned status: ${status}`)
        }

        const dispatchRunId = typeof acceptedPayload?.runId === 'string' && acceptedPayload.runId.trim()
          ? acceptedPayload.runId.trim()
          : null
        const dispatchSessionId = typeof acceptedPayload?.sessionId === 'string' && acceptedPayload.sessionId.trim()
          ? acceptedPayload.sessionId.trim()
          : typeof acceptedPayload?.session_id === 'string' && acceptedPayload.session_id.trim()
            ? acceptedPayload.session_id.trim()
            : gatewayAgentId
        const asyncState = dispatchRunId ? 'pending' : 'accepted_without_run_id'
        const pendingMeta: Record<string, any> = {
          ...taskMeta,
          dispatch_session_id: dispatchSessionId,
          ...(dispatchRunId ? { dispatch_run_id: dispatchRunId } : {
            async_reconciliation: 'manual_required',
            async_warning: 'agent dispatch accepted without a runId; automatic completion reconciliation cannot safely wait on this run.',
          }),
          async_state: asyncState,
          async_dispatched_at: Math.floor(Date.now() / 1000),
        }
        db.prepare('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
          .run(JSON.stringify(pendingMeta), Math.floor(Date.now() / 1000), task.id, task.workspace_id)

        eventBus.broadcast('task.updated', {
          id: task.id,
          status: 'in_progress',
          assigned_to: task.assigned_to,
          dispatch_session_id: dispatchSessionId,
          dispatch_run_id: pendingMeta.dispatch_run_id,
          async_state: asyncState,
          workspace_id: task.workspace_id,
        })

        db_helpers.logActivity(
          dispatchRunId ? 'task_deferred_dispatch' : 'task_deferred_dispatch_unreconcilable',
          'task',
          task.id,
          'scheduler',
          dispatchRunId
            ? `Deferred task "${task.title}" to agent ${task.agent_name}`
            : `Accepted task "${task.title}" for agent ${task.agent_name} without a runId; manual reconciliation required`,
          { dispatch_session_id: dispatchSessionId, dispatch_run_id: pendingMeta.dispatch_run_id, async_state: asyncState },
          task.workspace_id
        )

        results.push({ id: task.id, success: true })
        continue
      } // end else (new session dispatch)

      if (!agentResponse.text) {
        throw new Error('Agent returned empty response')
      }

      const truncated = agentResponse.text.length > 10_000
        ? agentResponse.text.substring(0, 10_000) + '\n\n[Response truncated at 10,000 characters]'
        : agentResponse.text

      // Merge dispatch_session_id into existing metadata
      const existingMeta = (() => {
        try {
          const row = db.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?')
            .get(task.id, task.workspace_id) as { metadata: string } | undefined
          return row?.metadata ? JSON.parse(row.metadata) : {}
        } catch { return {} }
      })()
      if (agentResponse.sessionId) {
        existingMeta.dispatch_session_id = agentResponse.sessionId
      }

      // Update task: status → review, set outcome
      db.prepare(`
        UPDATE tasks SET status = ?, outcome = ?, resolution = ?, metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?
      `).run('review', 'success', truncated, JSON.stringify(existingMeta), Math.floor(Date.now() / 1000), task.id, task.workspace_id)

      // Add a comment from the agent with the full response
      db.prepare(`
        INSERT INTO comments (task_id, author, content, created_at, workspace_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.agent_name,
        truncated,
        Math.floor(Date.now() / 1000),
        task.workspace_id
      )

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'review',
        previous_status: 'in_progress',
        workspace_id: task.workspace_id,
      })

      eventBus.broadcast('task.updated', {
        id: task.id,
        status: 'review',
        outcome: 'success',
        assigned_to: task.assigned_to,
        dispatch_session_id: agentResponse.sessionId,
        workspace_id: task.workspace_id,
      })
      syncAndEscalateIfFailed(task, 'review')

      db_helpers.logActivity(
        'task_agent_completed',
        'task',
        task.id,
        task.agent_name,
        `Agent completed task "${task.title}" — awaiting review`,
        { response_length: agentResponse.text.length, dispatch_session_id: agentResponse.sessionId },
        task.workspace_id
      )

      // Successful run → clear any stale rate-limit cooldown on this agent.
      db.prepare('UPDATE agents SET rate_limited_until = NULL WHERE id = ? AND workspace_id = ? AND rate_limited_until IS NOT NULL')
        .run(task.agent_id, task.workspace_id)

      results.push({ id: task.id, success: true })
      logger.info({ taskId: task.id, agent: task.agent_name }, 'Task dispatched and completed')
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error'
      logger.error({ taskId: task.id, agent: task.agent_name, err }, 'Task dispatch failed')

      // Cross-agent usage-limit failover: if this agent hit a usage limit and
      // has rotation enabled, cool it down and hand the task to another
      // same-runtime agent that's still available — carrying partial progress
      // so the next account continues rather than restarting. Does NOT count
      // toward dispatch_attempts (a rate limit isn't the task's fault).
      if (isUsageLimitError(errorMsg) && failoverEnabled(task.agent_config)) {
        const fnow = Math.floor(Date.now() / 1000)
        db.prepare('UPDATE agents SET rate_limited_until = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
          .run(fnow + ratelimitCooldownMinutes() * 60, fnow, task.agent_id, task.workspace_id)

        const next = pickFailoverAgent(task.runtime_type, task.workspace_id, task.agent_id, fnow)
        if (next) {
          const partial = typeof err.partialOutput === 'string' && err.partialOutput.trim()
            ? err.partialOutput.trim().slice(0, 8000)
            : null
          const meta = (() => {
            try {
              const row = db.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?')
                .get(task.id, task.workspace_id) as { metadata: string } | undefined
              return row?.metadata ? JSON.parse(row.metadata) : {}
            } catch { return {} }
          })()
          meta.failover_from = task.agent_name
          if (partial) meta.failover_context = partial; else delete meta.failover_context

          db.prepare("UPDATE tasks SET status = 'assigned', assigned_to = ?, metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
            .run(next.name, JSON.stringify(meta), fnow, task.id, task.workspace_id)
          db.prepare(`INSERT INTO comments (task_id, author, content, created_at, workspace_id) VALUES (?, 'scheduler', ?, ?, ?)`)
            .run(task.id, `Agent "${task.agent_name}" hit a usage limit — failing over to "${next.name}".${partial ? ' Partial progress carried forward.' : ''}`, fnow, task.workspace_id)

          eventBus.broadcast('task.status_changed', {
            id: task.id, status: 'assigned', previous_status: 'in_progress',
            reason: 'usage_limit_failover', assigned_to: next.name, workspace_id: task.workspace_id,
          })
          db_helpers.logActivity('task_failover', 'task', task.id, 'scheduler',
            `Failed over "${task.title}" from ${task.agent_name} to ${next.name} (usage limit)`,
            { from: task.agent_name, to: next.name, carried_context: !!partial }, task.workspace_id)

          logger.warn({ taskId: task.id, from: task.agent_name, to: next.name }, 'Usage-limit failover to alternate agent')
          results.push({ id: task.id, success: true })
          continue
        }
        // No available same-runtime agent — fall through to normal failure
        // handling (all accounts exhausted → bounded retries → escalate).
        logger.warn({ taskId: task.id, agent: task.agent_name }, 'Usage limit hit but no failover agent available')
      }

      // Increment dispatch_attempts and decide next status
      const currentAttempts = (db.prepare('SELECT dispatch_attempts FROM tasks WHERE id = ? AND workspace_id = ?')
        .get(task.id, task.workspace_id) as { dispatch_attempts: number } | undefined)?.dispatch_attempts ?? 0
      const newAttempts = currentAttempts + 1
      const maxDispatchRetries = 5

      if (newAttempts >= maxDispatchRetries) {
        const failureMessage = `Dispatch failed ${newAttempts} times. Last: ${errorMsg.substring(0, 5000)}`
        // Too many failures — move to failed
        db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
          .run('failed', failureMessage, newAttempts, Math.floor(Date.now() / 1000), task.id, task.workspace_id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'failed',
          previous_status: 'in_progress',
          error_message: failureMessage,
          reason: 'max_dispatch_retries_exceeded',
          workspace_id: task.workspace_id,
        })
        syncAndEscalateIfFailed(task, 'failed', `Dispatch failed ${newAttempts} times`, newAttempts)
      } else {
        // Revert to assigned so it can be retried on the next tick
        db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
          .run('assigned', errorMsg.substring(0, 5000), newAttempts, Math.floor(Date.now() / 1000), task.id, task.workspace_id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'assigned',
          previous_status: 'in_progress',
          error_message: errorMsg.substring(0, 500),
          reason: 'dispatch_failed',
          workspace_id: task.workspace_id,
        })
        syncAndEscalateIfFailed(task, 'assigned')
      }

      db_helpers.logActivity(
        'task_dispatch_failed',
        'task',
        task.id,
        'scheduler',
        `Task dispatch failed for "${task.title}": ${errorMsg.substring(0, 200)}`,
        { error: errorMsg.substring(0, 1000) },
        task.workspace_id
      )

      results.push({ id: task.id, success: false, error: errorMsg.substring(0, 100) })
    }
  }

  const succeeded = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success)
  const failSummary = failed.length > 0
    ? ` (${failed.length} failed: ${failed.map(f => f.error).join('; ')})`
    : ''

  return {
    ok: failed.length === 0,
    message: `Dispatched ${succeeded}/${tasks.length} tasks${failSummary}`,
  }
}

// ---------------------------------------------------------------------------
// Auto-routing: assign inbox tasks to available agents
// ---------------------------------------------------------------------------

/** Role affinity mapping — which task keywords match which agent roles. */
const ROLE_AFFINITY: Record<string, string[]> = {
  coder: ['code', 'implement', 'build', 'fix', 'bug', 'test', 'unit test', 'refactor', 'feature', 'api', 'endpoint', 'function', 'class', 'module', 'component', 'deploy', 'ci', 'pipeline'],
  researcher: ['research', 'investigate', 'analyze', 'compare', 'find', 'discover', 'audit', 'review', 'survey', 'benchmark', 'evaluate', 'assess', 'competitor', 'market', 'trend'],
  reviewer: ['review', 'audit', 'check', 'verify', 'validate', 'quality', 'security', 'compliance', 'approve'],
  tester: ['test', 'qa', 'e2e', 'integration test', 'regression', 'coverage', 'verify', 'validate'],
  devops: ['deploy', 'infrastructure', 'ci', 'cd', 'docker', 'kubernetes', 'monitoring', 'pipeline', 'server', 'nginx', 'ssl'],
  assistant: ['write', 'draft', 'summarize', 'translate', 'format', 'document', 'docs', 'readme', 'email', 'message', 'report'],
  agent: [], // generic fallback
}

function scoreAgentForTask(
  agent: { name: string; role: string; status: string; config: string | null },
  taskText: string,
): number {
  // Offline agents can't take work — unless we're in direct-API mode where
  // the agent has no heartbeat by design and the dispatcher invokes the
  // provider HTTP API directly (no live agent process required).
  const directApiOk = !isGatewayAvailable() && isDirectDispatchAvailable()
  if (!directApiOk && (agent.status === 'offline' || agent.status === 'error' || agent.status === 'sleeping')) return -1

  const text = taskText.toLowerCase()
  const keywords = ROLE_AFFINITY[agent.role] || []

  let score = 0
  // Role keyword match
  for (const kw of keywords) {
    if (text.includes(kw)) score += 10
  }

  // Idle agents get a bonus (prefer agents not currently busy)
  if (agent.status === 'idle') score += 5

  // Check agent capabilities from config
  if (agent.config) {
    try {
      const cfg = JSON.parse(agent.config)
      const caps = Array.isArray(cfg.capabilities) ? cfg.capabilities : []
      for (const cap of caps) {
        if (typeof cap === 'string' && text.includes(cap.toLowerCase())) score += 15
      }
    } catch { /* ignore */ }
  }

  // Any non-offline agent gets at least 1 (can be a fallback)
  return Math.max(score, 1)
}

/**
 * Auto-route inbox tasks to the best available agent.
 * Runs before dispatch — moves tasks from inbox → assigned.
 */
export async function autoRouteInboxTasks(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()

  const inboxTasks = db.prepare(`
    SELECT id, title, description, priority, tags, workspace_id
    FROM tasks
    WHERE status = 'inbox' AND assigned_to IS NULL
    ORDER BY
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
      created_at ASC
    LIMIT 5
  `).all() as Array<{ id: number; title: string; description: string | null; priority: string; tags: string | null; workspace_id: number }>

  if (inboxTasks.length === 0) {
    return { ok: true, message: 'No inbox tasks to route' }
  }

  let routed = 0
  const now = Math.floor(Date.now() / 1000)

  for (const task of inboxTasks) {
    const agents = db.prepare(`
      SELECT id, name, role, status, config
      FROM agents
      WHERE workspace_id = ?
        AND hidden = 0
        AND status NOT IN ('offline', 'error')
      LIMIT 50
    `).all(task.workspace_id) as Array<{ id: number; name: string; role: string; status: string; config: string | null }>
    if (agents.length === 0) continue

    const taskText = `${task.title} ${task.description || ''}`
    let parsedTags: string[] = []
    if (task.tags) {
      try { parsedTags = JSON.parse(task.tags) } catch { /* ignore */ }
    }
    const fullText = `${taskText} ${parsedTags.join(' ')}`

    // Score each agent
    const scored = agents
      .map(a => ({ agent: a, score: scoreAgentForTask(a, fullText) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    if (scored.length === 0) continue

    const best = scored[0].agent

    // Check capacity — skip agents with 3+ in-progress tasks
    const inProgressCount = (db.prepare(
      'SELECT COUNT(*) as c FROM tasks WHERE assigned_to = ? AND status = \'in_progress\' AND workspace_id = ?'
    ).get(best.name, task.workspace_id) as { c: number }).c

    if (inProgressCount >= 3) {
      // Try next best agent
      const alt = scored.find(s => {
        const c = (db.prepare(
          'SELECT COUNT(*) as c FROM tasks WHERE assigned_to = ? AND status = \'in_progress\' AND workspace_id = ?'
        ).get(s.agent.name, task.workspace_id) as { c: number }).c
        return c < 3
      })
      if (!alt) continue // all agents at capacity
      db.prepare('UPDATE tasks SET status = ?, assigned_to = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
        .run('assigned', alt.agent.name, now, task.id, task.workspace_id)

      db_helpers.logActivity('task_auto_routed', 'task', task.id, 'scheduler',
        `Auto-assigned "${task.title}" to ${alt.agent.name} (${alt.agent.role}, score: ${alt.score})`,
        { agent: alt.agent.name, role: alt.agent.role, score: alt.score },
        task.workspace_id)

      eventBus.broadcast('task.status_changed', { id: task.id, status: 'assigned', previous_status: 'inbox', assigned_to: alt.agent.name, workspace_id: task.workspace_id })
      syncAndEscalateIfFailed(task as any, 'assigned')
      routed++
      continue
    }

    db.prepare('UPDATE tasks SET status = ?, assigned_to = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
      .run('assigned', best.name, now, task.id, task.workspace_id)

    db_helpers.logActivity('task_auto_routed', 'task', task.id, 'scheduler',
      `Auto-assigned "${task.title}" to ${best.name} (${best.role}, score: ${scored[0].score})`,
      { agent: best.name, role: best.role, score: scored[0].score },
      task.workspace_id)

    eventBus.broadcast('task.status_changed', { id: task.id, status: 'assigned', previous_status: 'inbox', assigned_to: best.name, workspace_id: task.workspace_id })
    syncAndEscalateIfFailed(task as any, 'assigned')
    routed++
  }

  return {
    ok: true,
    message: routed > 0
      ? `Auto-routed ${routed}/${inboxTasks.length} inbox task(s)`
      : `${inboxTasks.length} inbox task(s), no suitable agents found`,
  }
}
