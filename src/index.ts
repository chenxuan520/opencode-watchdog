import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import type { PluginOptions } from "@opencode-ai/plugin"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

const DEFAULT_COMMAND_KEYBIND = "ctrl+q"
const DEFAULT_THRESHOLD = 70
const DEFAULT_SETTLE_MS = 1200
const DEFAULT_MAX_CONTINUES = 8
const DEFAULT_JUDGE_AGENT = "watchdog-judge"
const DEFAULT_LANGUAGE = "zh"
const SHORT_TOAST_MS = 2500
const MODE_TOAST_DURATION = 24 * 60 * 60 * 1000
const TOGGLE_DEBOUNCE_MS = 500
const PLUGIN_VERSION = "local-dev"
const DCP_SUMMARY_PREFIX = "▣ DCP |"
const AUTO_CONTINUE_ERROR_PROMPT = "继续，刚才执行报错了。请从失败处重试，并继续完成当前任务。"
const AUTO_CONTINUE_EMPTY_PROMPT = "继续，刚才回复中断了。请接着上一条继续完成，不要重复已经完成的内容。"
const DEBUG_LOG_FILE = join(process.env.HOME || ".", ".local", "share", "opencode", "log", "opencode-watchdog.log")
const JUDGE_RESPONSE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["score", "reason"],
  properties: {
    score: {
      type: "number",
      minimum: 0,
      maximum: 100,
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 200,
    },
  },
} as const

type WatchdogLanguage = "zh" | "en"

function normalizeLanguage(value: unknown): WatchdogLanguage {
  return value === "en" ? "en" : "zh"
}

function defaultContinuePrompt(language: WatchdogLanguage) {
  if (language === "en") {
    return "Continue, the last reply was only a progress update. Keep working on the current task without repeating completed work. If you believe the request is already fully finished, explain why clearly."
  }
  return "继续，刚才只是阶段性汇报。请继续完成当前任务，不要重复已经完成的内容。如果你认为需求已经完全完成，请明确说明理由。"
}

function buildJudgeSystemPrompt(language: WatchdogLanguage) {
  const prompt = [
    "You are a watchdog judge for an interactive coding agent.",
    "Your only job is to decide whether the latest assistant reply is complete enough that the main agent should stop auto-continuing.",
    "Use the anchor task as the main baseline. The score means completion confidence, not answer quality.",
    "Return a high score only when the latest assistant reply is complete enough to stop, or when it should pause for the user instead of auto-continuing.",
    "If the agent is blocked and needs the user to provide clarification, permissions, environment details, credentials, manual decisions, or any other external input, treat that as a stop condition and return a high score so the user can decide.",
    "Return a low score when the latest assistant reply is merely a phase report, partial analysis, or unfinished execution and the main agent should continue automatically without waiting for the user.",
    language === "en"
      ? "Write the reason in English."
      : "Write the reason in Chinese.",
    "Do not write code. Do not ask follow-up questions. Do not call tools. Return only the structured result.",
  ]
  return prompt.join("\n")
}

const TRIVIAL_CONTINUATIONS = new Set([
  "继续",
  "继续吧",
  "继续啊",
  "好",
  "好的",
  "ok",
  "okay",
  "goon",
  "continue",
  "tryit",
  "你试下",
  "试下",
  "试试看",
  "再看看",
])

type WatchdogOptions = PluginOptions & {
  commandKeybind?: string
  language?: WatchdogLanguage
  threshold?: number
  settleMs?: number
  maxContinues?: number
  continuePrompt?: string
  debug?: boolean
}

type SessionInfo = {
  id: string
  parentID?: string
  title?: string
}

type MessageInfo = {
  id: string
  role: string
  parentID?: string
  time?: {
    created?: number
    completed?: number
  }
  agent?: string
  providerID?: string
  modelID?: string
  variant?: string
  finish?: string
  error?: unknown
  system?: string
  format?: unknown
  model?: {
    providerID: string
    modelID: string
    variant?: string
  }
}

type MessagePart = {
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
}

type SessionMessage = {
  info: MessageInfo
  parts: MessagePart[]
}

type JudgeResult = {
  score: number
  reason: string
}

type WatchdogState = {
  rootSessionID: string
  anchorMessageID: string
  anchorText: string
  anchorCreatedAt: number
  latestUserMessageCreatedAt: number
  seenUserMessageIDs: Set<string>
  armedAt: number
  threshold: number
  continueCount: number
  lastJudgedAssistantMessageID: string | null
  lastScore: number | null
  lastReason: string
  phase: "arming" | "armed" | "running" | "waiting" | "judging"
  lastDecision: "none" | "continued" | "paused" | "skipped"
  revision: number
  evaluating: boolean
  timer?: ReturnType<typeof setTimeout>
}

type AssistantSignals = {
  finish: string
  hasTool: boolean
  hasPatch: boolean
  hasReasoning: boolean
  hasError: boolean
  continueCount: number
}

function str(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function num(value: unknown, fallback: number, min = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, parsed)
}

function bool(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  return fallback
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeLoose(value: string) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
}

function truncateMiddle(value: string, max: number) {
  if (value.length <= max) return value
  const half = Math.floor((max - 5) / 2)
  return `${value.slice(0, half)}\n...\n${value.slice(value.length - half)}`
}

function previewLabel(value: string, max = 18) {
  const flat = normalizeText(value).replace(/\s+/g, " ")
  if (!flat) return "locating..."
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - 3))}...`
}

function safeTitleSuffix(value: string, max = 48) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "judge"
}

function debug(enabled: boolean, ...args: unknown[]) {
  if (!enabled) return
  writeLog("debug", ...args)
}

function writeLog(...args: unknown[]) {
  try {
    mkdirSync(dirname(DEBUG_LOG_FILE), { recursive: true })
    const line = args
      .map((item) => {
        if (typeof item === "string") return item
        try {
          return JSON.stringify(item)
        } catch {
          return String(item)
        }
      })
      .join(" ")
    appendFileSync(DEBUG_LOG_FILE, `${new Date().toISOString()} [opencode-watchdog] ${line}\n`)
  } catch {}
}

function extractText(parts: MessagePart[], options?: { includeSynthetic?: boolean; includeIgnored?: boolean }) {
  const includeSynthetic = options?.includeSynthetic === true
  const includeIgnored = options?.includeIgnored === true
  return parts
    .filter((part) => part.type === "text")
    .filter((part) => includeSynthetic || part.synthetic !== true)
    .filter((part) => includeIgnored || part.ignored !== true)
    .map((part) => normalizeText(part.text))
    .filter(Boolean)
    .join("\n")
    .trim()
}

function isDcpSummaryMessage(message: SessionMessage) {
  return message.parts.some(
    (part) => part.type === "text" && part.ignored === true && normalizeText(part.text).startsWith(DCP_SUMMARY_PREFIX),
  )
}

function isTrivialContinuation(text: string) {
  return TRIVIAL_CONTINUATIONS.has(normalizeLoose(text))
}

function isSyntheticContinueText(text: string, continuePrompt: string) {
  const normalized = normalizeText(text)
  return (
    normalized === normalizeText(continuePrompt) ||
    normalized === AUTO_CONTINUE_EMPTY_PROMPT ||
    normalized === AUTO_CONTINUE_ERROR_PROMPT
  )
}

function isSlashCommand(text: string) {
  return normalizeText(text).startsWith("/")
}

function isMeaningfulUserMessage(message: SessionMessage, continuePrompt: string) {
  if (message.info.role !== "user") return false
  if (isDcpSummaryMessage(message)) return false
  const text = extractText(message.parts)
  if (!text) return false
  if (isSlashCommand(text)) return false
  if (isSyntheticContinueText(text, continuePrompt)) return false
  if (isTrivialContinuation(text)) return false
  return true
}

function extractAssistantSignals(message: SessionMessage, continueCount: number): AssistantSignals {
  return {
    finish: typeof message.info.finish === "string" ? message.info.finish : "",
    hasTool: message.parts.some((part) => part.type === "tool"),
    hasPatch: message.parts.some((part) => part.type === "patch"),
    hasReasoning: message.parts.some((part) => part.type === "reasoning" && normalizeText(part.text).length > 0),
    hasError: Boolean(message.info.error),
    continueCount,
  }
}

function shouldSkipWatchdogJudge(message: SessionMessage, visibleText: string) {
  if (!visibleText) return true
  if (message.info.error) return true
  const finish = normalizeText(message.info.finish)
  if (finish && finish !== "stop") return true
  return false
}

function findAnchor(messages: SessionMessage[], continuePrompt: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isMeaningfulUserMessage(message, continuePrompt)) continue
    return {
      id: message.info.id,
      text: truncateMiddle(extractText(message.parts), 800),
      createdAt: message.info.time?.created ?? Date.now(),
    }
  }
  return null
}

function latestUserCreatedAt(messages: SessionMessage[]) {
  let latest = 0
  for (const message of messages) {
    if (message.info.role !== "user") continue
    const createdAt = message.info.time?.created ?? 0
    if (createdAt > latest) latest = createdAt
  }
  return latest
}

function collectSeenUserMessageIDs(messages: SessionMessage[]) {
  const seen = new Set<string>()
  for (const message of messages) {
    if (message.info.role !== "user") continue
    if (!message.info.id) continue
    seen.add(message.info.id)
  }
  return seen
}

function findAnchorPreviewFromState(api: TuiPluginApi, sessionID: string, continuePrompt: string) {
  const messages = api.state.session.messages(sessionID) as unknown as MessageInfo[]
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]
    const parts = api.state.part(info.id) as unknown as MessagePart[]
    const message = { info, parts }
    if (!isMeaningfulUserMessage(message, continuePrompt)) continue
    return previewLabel(extractText(parts))
  }
  return "locating..."
}

function collectRecentUserUpdates(messages: SessionMessage[], state: WatchdogState, continuePrompt: string) {
  const updates: string[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.info.role !== "user") continue
    if (message.info.id === state.anchorMessageID) continue
    if ((message.info.time?.created ?? 0) < state.armedAt) continue
    if (!isMeaningfulUserMessage(message, continuePrompt)) continue
    updates.push(truncateMiddle(extractText(message.parts), 400))
    if (updates.length >= 2) break
  }
  return updates.reverse()
}

function findLatestCompletedAssistant(messages: SessionMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.info.role !== "assistant") continue
    if (message.info.time?.completed || message.info.finish) return message
  }
  return null
}

function buildJudgePrompt(input: {
  state: WatchdogState
  assistant: SessionMessage
  assistantText: string
  recentUserUpdates: string[]
}) {
  return JSON.stringify(
    {
      anchor: input.state.anchorText,
      recent_user_updates: input.recentUserUpdates,
      assistant_under_review: truncateMiddle(input.assistantText, 2400),
      signals: extractAssistantSignals(input.assistant, input.state.continueCount),
    },
    null,
    2,
  )
}

function parseJudgeResult(data: unknown): JudgeResult | null {
  if (!data || typeof data !== "object") return null
  const score = Number((data as { score?: unknown }).score)
  const reason = normalizeText((data as { reason?: unknown }).reason)
  if (!Number.isFinite(score) || score < 0 || score > 100 || !reason) return null
  return {
    score,
    reason,
  }
}

function modeStatusLabel(state: WatchdogState) {
  switch (state.phase) {
    case "arming":
      return "arming"
    case "armed":
      return "armed"
    case "running":
      return "main agent running"
    case "judging":
      return "judging latest reply"
    case "waiting":
    default:
      return "waiting for next completed reply"
  }
}

function decisionLabel(state: WatchdogState) {
  switch (state.lastDecision) {
    case "continued":
      return "continued"
    case "paused":
      return "paused"
    case "skipped":
      return "skipped"
    default:
      return "none"
  }
}

function fallbackParseJudgeResult(message: { parts?: MessagePart[] } | undefined): JudgeResult | null {
  const text = extractText(message?.parts ?? [], { includeSynthetic: true, includeIgnored: true })
  if (!text) return null
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return parseJudgeResult(JSON.parse(match[0]))
  } catch {
    return null
  }
}

async function resolveRootSession(api: TuiPluginApi, sessionID: string) {
  let currentID = sessionID
  for (let depth = 0; depth < 10; depth += 1) {
    const result = await api.client.session.get({ sessionID: currentID }, { throwOnError: true })
    const info = result.data as SessionInfo | undefined
    if (!info) throw new Error(`Session not found: ${currentID}`)
    if (!info.parentID) return info
    currentID = info.parentID
  }
  throw new Error(`Failed to resolve root session for ${sessionID}`)
}

async function getSessionMessages(api: TuiPluginApi, sessionID: string) {
  const result = await api.client.session.messages({ sessionID }, { throwOnError: true })
  return ((result.data ?? []) as SessionMessage[]).slice()
}

async function validateJudgeAgent(api: TuiPluginApi, judgeAgent: string) {
  const result = await api.client.app.agents(undefined, { throwOnError: true })
  const agents = (result.data ?? []) as Array<{
    name: string
    mode: string
    hidden?: boolean
  }>
  const match = agents.find((agent) => agent.name === judgeAgent)
  if (!match) {
    throw new Error(`Judge agent not found: ${judgeAgent}`)
  }
  if (match.mode !== "subagent") {
    throw new Error(`Judge agent must be a subagent: ${judgeAgent}`)
  }
  return match
}

const tui: TuiPlugin = async (api, options) => {
  const config = {
    commandKeybind: str((options as WatchdogOptions | undefined)?.commandKeybind, DEFAULT_COMMAND_KEYBIND),
    language: normalizeLanguage((options as WatchdogOptions | undefined)?.language),
    threshold: num((options as WatchdogOptions | undefined)?.threshold, DEFAULT_THRESHOLD, 0),
    settleMs: num((options as WatchdogOptions | undefined)?.settleMs, DEFAULT_SETTLE_MS, 0),
    maxContinues: num((options as WatchdogOptions | undefined)?.maxContinues, DEFAULT_MAX_CONTINUES, 1),
    continuePrompt: "",
    debug: bool((options as WatchdogOptions | undefined)?.debug, false),
  }
  config.continuePrompt = str((options as WatchdogOptions | undefined)?.continuePrompt, defaultContinuePrompt(config.language))

  const states = new Map<string, WatchdogState>()
  const pendingEnable = new Set<string>()
  const lastToggleAt = new Map<string, number>()
  let routeKey = ""
  let modeToastSessionID: string | null = null
  let restoreToastTimer: ReturnType<typeof setTimeout> | undefined

  writeLog("plugin-init", {
    version: PLUGIN_VERSION,
    keybind: config.commandKeybind,
    judgeAgent: DEFAULT_JUDGE_AGENT,
    language: config.language,
    threshold: config.threshold,
  })

  const shouldIgnoreRapidToggle = (sessionID: string) => {
    const now = Date.now()
    const previous = lastToggleAt.get(sessionID) ?? 0
    lastToggleAt.set(sessionID, now)
    return now - previous < TOGGLE_DEBOUNCE_MS
  }

  const visibleWatchdogSession = () => {
    const route = api.route.current
    if (route.name !== "session") return null
    const sessionID = String(route.params?.sessionID || "")
    return states.has(sessionID) ? sessionID : null
  }

  const clearRestoreToastTimer = () => {
    if (!restoreToastTimer) return
    clearTimeout(restoreToastTimer)
    restoreToastTimer = undefined
  }

  const clearModeToast = () => {
    clearRestoreToastTimer()
    modeToastSessionID = null
    api.ui.toast({ title: "", message: " ", variant: "info", duration: 1 })
  }

  const showModeToast = (sessionID: string) => {
    const state = states.get(sessionID)
    if (!state) {
      clearModeToast()
      return
    }
    clearRestoreToastTimer()
    modeToastSessionID = sessionID
    const scoreText = state.lastScore === null ? "-" : `${Math.round(state.lastScore)}`
    api.ui.toast({
      title: "Watchdog mode",
      message: [
        `status: ${modeStatusLabel(state)}`,
        `input: ${previewLabel(state.anchorText)}`,
        `threshold: ${state.threshold}`,
        `continues: ${state.continueCount}/${config.maxContinues}`,
        `last score: ${scoreText}`,
      ]
        .filter(Boolean)
        .join("\n"),
      variant: "info",
      duration: MODE_TOAST_DURATION,
    })
  }

  const syncModeToast = (force = false) => {
    const route = api.route.current
    const currentSessionID = route.name === "session" ? String(route.params?.sessionID || "") : ""
    const nextRouteKey = `${route.name}:${currentSessionID}`
    if (!force && routeKey === nextRouteKey) return
    routeKey = nextRouteKey

    const visible = visibleWatchdogSession()
    if (!visible) {
      if (modeToastSessionID !== null) {
        clearModeToast()
      }
      return
    }

    if (force || modeToastSessionID !== visible) {
      showModeToast(visible)
    }
  }

  const toast = (
    message: string,
    variant: "info" | "warning" | "success" | "error" = "info",
    options?: { duration?: number; restoreMode?: boolean },
  ) => {
    const duration = options?.duration ?? SHORT_TOAST_MS
    api.ui.toast({ title: "Watchdog", message, variant, duration })
    clearRestoreToastTimer()
    if (options?.restoreMode === false) return
    restoreToastTimer = setTimeout(() => {
      restoreToastTimer = undefined
      syncModeToast(true)
    }, duration + 50)
  }

  const clearTimer = (rootSessionID: string) => {
    const state = states.get(rootSessionID)
    if (!state?.timer) return
    clearTimeout(state.timer)
    state.timer = undefined
  }

  const disableWatchdog = (rootSessionID: string, message?: string, variant: "info" | "warning" | "success" = "warning") => {
    clearTimer(rootSessionID)
    pendingEnable.delete(rootSessionID)
    states.delete(rootSessionID)
    syncModeToast(true)
    writeLog("disabled", { rootSessionID, message: message ?? "", variant })
    if (message) {
      toast(message, variant)
    }
  }

  const sendContinue = async (
    rootSessionID: string,
    assistant: SessionMessage,
    parentUser?: SessionMessage,
  ) => {
    await api.client.session.promptAsync(
      {
        sessionID: rootSessionID,
        agent: assistant.info.agent ?? parentUser?.info.agent,
        model:
          assistant.info.providerID && assistant.info.modelID
            ? {
                providerID: assistant.info.providerID,
                modelID: assistant.info.modelID,
              }
            : parentUser?.info.model
              ? {
                  providerID: parentUser.info.model.providerID,
                  modelID: parentUser.info.model.modelID,
                }
            : undefined,
        variant: assistant.info.variant ?? parentUser?.info.model?.variant,
        system: parentUser?.info.system,
        format: parentUser?.info.format as never,
        parts: [
          {
            type: "text",
            text: config.continuePrompt,
            synthetic: true,
          },
        ],
      },
      { throwOnError: true },
    )
  }

  const runJudge = async (rootSessionID: string) => {
    const state = states.get(rootSessionID)
    if (!state || state.evaluating) return

    writeLog("judge-start", {
      rootSessionID,
      revision: state.revision,
      lastJudgedAssistantMessageID: state.lastJudgedAssistantMessageID,
      continueCount: state.continueCount,
    })
    state.evaluating = true
    const revision = state.revision
    let judgeSessionID: string | undefined

    try {
      const messages = await getSessionMessages(api, rootSessionID)
      writeLog("judge-messages", { rootSessionID, count: messages.length })
      const assistant = findLatestCompletedAssistant(messages)
      if (!assistant) {
        writeLog("judge-skip-no-assistant", { rootSessionID })
        return
      }
      if (assistant.info.id === state.lastJudgedAssistantMessageID) {
        writeLog("judge-skip-already-judged", {
          rootSessionID,
          assistantMessageID: assistant.info.id,
        })
        return
      }
      if ((assistant.info.time?.created ?? 0) < state.anchorCreatedAt) {
        writeLog("judge-skip-assistant-too-old", {
          rootSessionID,
          assistantMessageID: assistant.info.id,
          assistantCreatedAt: assistant.info.time?.created ?? 0,
          anchorCreatedAt: state.anchorCreatedAt,
        })
        return
      }

      state.phase = "judging"
      syncModeToast(true)

      const assistantText = extractText(assistant.parts)
      if (shouldSkipWatchdogJudge(assistant, assistantText)) {
        state.lastJudgedAssistantMessageID = assistant.info.id
        state.lastScore = null
        state.lastDecision = "skipped"
        state.lastReason = "handled by existing recovery or non-normal reply"
        state.phase = "waiting"
        syncModeToast(true)
        writeLog("skip", {
          rootSessionID,
          assistantMessageID: assistant.info.id,
          finish: assistant.info.finish,
          hasError: Boolean(assistant.info.error),
          hasVisibleText: Boolean(assistantText),
        })
        debug(config.debug, "skip judge: handled by existing recovery or not a normal completed reply", {
          rootSessionID,
          assistantMessageID: assistant.info.id,
          finish: assistant.info.finish,
          hasError: Boolean(assistant.info.error),
          hasVisibleText: Boolean(assistantText),
        })
        return
      }

      const recentUserUpdates = collectRecentUserUpdates(messages, state, config.continuePrompt)
      const parentUser = messages.find(
        (message) => message.info.role === "user" && message.info.id === assistant.info.parentID,
      )
      const judgePrompt = buildJudgePrompt({
        state,
        assistant,
        assistantText,
        recentUserUpdates,
      })

      const created = await api.client.session.create(
        {
          parentID: rootSessionID,
          title: `Watchdog judge (${safeTitleSuffix(assistant.info.id)})`,
        },
        { throwOnError: true },
      )
      judgeSessionID = (created.data as SessionInfo | undefined)?.id
      if (!judgeSessionID) {
        throw new Error("Failed to create watchdog judge session")
      }
      writeLog("judge-session-created", {
        rootSessionID,
        judgeSessionID,
        assistantMessageID: assistant.info.id,
      })

      const judged = await api.client.session.prompt(
        {
          sessionID: judgeSessionID,
          agent: DEFAULT_JUDGE_AGENT,
          system: buildJudgeSystemPrompt(config.language),
          format: {
            type: "json_schema",
            schema: JUDGE_RESPONSE_SCHEMA,
          },
          parts: [
            {
              type: "text",
              text: judgePrompt,
            },
          ],
        },
        { throwOnError: true },
      )
      writeLog("judge-session-completed", {
        rootSessionID,
        judgeSessionID,
        assistantMessageID: assistant.info.id,
      })

      const payload = (judged.data ?? undefined) as { info?: { structured?: unknown }; parts?: MessagePart[] } | undefined
      const result = parseJudgeResult(payload?.info?.structured) ?? fallbackParseJudgeResult(payload)
      if (!result) {
        throw new Error("Judge did not return a valid score payload")
      }

      writeLog("judge-result", {
        rootSessionID,
        assistantMessageID: assistant.info.id,
        score: result.score,
        threshold: state.threshold,
        reason: result.reason,
      })

      const latest = states.get(rootSessionID)
      if (!latest || latest.revision !== revision) {
        debug(config.debug, "drop stale judge result", rootSessionID, result)
        return
      }

      latest.lastJudgedAssistantMessageID = assistant.info.id
      latest.lastScore = result.score
      latest.lastReason = result.reason

      if (result.score < latest.threshold) {
        if (latest.continueCount >= config.maxContinues) {
          disableWatchdog(
            rootSessionID,
            `Reached max auto-continues (${config.maxContinues}). Watchdog disabled.`,
            "warning",
          )
          return
        }

        await sendContinue(rootSessionID, assistant, parentUser)
        latest.continueCount += 1
        latest.lastDecision = "continued"
        latest.phase = "running"
        syncModeToast(true)
        writeLog("continued", {
          rootSessionID,
          assistantMessageID: assistant.info.id,
          score: result.score,
          threshold: latest.threshold,
          continueCount: latest.continueCount,
          reason: result.reason,
        })
        return
      }

      latest.lastDecision = "paused"
      writeLog("paused", {
        rootSessionID,
        assistantMessageID: assistant.info.id,
        score: result.score,
        threshold: latest.threshold,
        reason: result.reason,
      })
      disableWatchdog(
        rootSessionID,
        `Watchdog auto-paused (${Math.round(result.score)} >= ${latest.threshold}): ${result.reason}`,
        "success",
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      debug(config.debug, "judge failed", rootSessionID, message)
      writeLog("judge-failed", { rootSessionID, error: message })
      disableWatchdog(rootSessionID, `Watchdog judge failed: ${message}`, "warning")
    } finally {
      if (judgeSessionID) {
        writeLog("judge-session-delete", { rootSessionID, judgeSessionID })
        void api.client.session.delete({ sessionID: judgeSessionID }).catch(() => undefined)
      }
      const state = states.get(rootSessionID)
      if (state) {
        state.evaluating = false
      }
    }
  }

  const scheduleJudge = (rootSessionID: string, delay = config.settleMs) => {
    const state = states.get(rootSessionID)
    if (!state) return
    clearTimer(rootSessionID)
    state.phase = "waiting"
    writeLog("judge-scheduled", { rootSessionID, delay })
    syncModeToast(true)
    state.timer = setTimeout(() => {
      state.timer = undefined
      void runJudge(rootSessionID)
    }, delay)
  }

  const enableWatchdog = async (sessionID: string) => {
    writeLog("enable-start", { sessionID })
    const root = await resolveRootSession(api, sessionID)
    if (root.parentID || root.id !== sessionID) {
      pendingEnable.delete(sessionID)
      writeLog("enable-rejected-non-root", { sessionID, rootSessionID: root.id, parentID: root.parentID ?? null })
      throw new Error("Watchdog only supports root sessions")
    }

    const status = api.state.session.status(root.id)
    writeLog("enable-root-status", { rootSessionID: root.id, status: status?.type ?? "unknown" })
    if (!status || status.type === "idle") {
      pendingEnable.delete(sessionID)
      writeLog("arm-rejected-idle", { rootSessionID: root.id })
      states.delete(sessionID)
      syncModeToast(true)
      toast("Current session is already in user-input stage. Watchdog was not enabled.", "warning")
      return
    }

    const judgeAgent = await validateJudgeAgent(api, DEFAULT_JUDGE_AGENT)
    const messages = await getSessionMessages(api, root.id)
    const anchor = findAnchor(messages, config.continuePrompt)
    if (!anchor) {
      throw new Error("No meaningful user task message found to anchor watchdog")
    }

    if (!pendingEnable.has(sessionID)) {
      writeLog("enable-cancelled-before-arm", { sessionID, rootSessionID: root.id })
      return
    }

    states.set(root.id, {
      rootSessionID: root.id,
      anchorMessageID: anchor.id,
      anchorText: anchor.text,
      anchorCreatedAt: anchor.createdAt,
      latestUserMessageCreatedAt: latestUserCreatedAt(messages),
      seenUserMessageIDs: collectSeenUserMessageIDs(messages),
      armedAt: Date.now(),
      threshold: Math.min(config.threshold, 100),
      continueCount: 0,
      lastJudgedAssistantMessageID: null,
      lastScore: null,
      lastReason: "",
      phase: "armed",
      lastDecision: "none",
      revision: 0,
      evaluating: false,
    })

    writeLog("enabled", {
      rootSessionID: root.id,
      anchorMessageID: anchor.id,
      latestUserMessageCreatedAt: latestUserCreatedAt(messages),
      seenUserMessageIDs: Array.from(collectSeenUserMessageIDs(messages)).slice(-5),
      threshold: Math.min(config.threshold, 100),
      keybind: config.commandKeybind,
    })
    pendingEnable.delete(root.id)

    syncModeToast(true)

    if (!judgeAgent.hidden) {
      toast(`Judge agent '${DEFAULT_JUDGE_AGENT}' is not hidden. Watchdog still enabled.`, "warning")
    }
  }

  api.command.register(() => {
    const route = api.route.current
    const sessionID = route.name === "session" ? String(route.params?.sessionID || "") : ""
    const enabled = sessionID ? states.has(sessionID) : false
    return [
      {
        title: enabled ? "Disable watchdog" : "Enable watchdog",
        value: "watchdog.toggle",
        description: enabled
          ? "Disable scoring-based auto-continue for the current root session"
          : "Enable scoring-based auto-continue for the current root session",
        keybind: config.commandKeybind,
        slash: { name: "watchdog" },
        onSelect: () => {
          writeLog("toggle-invoked", {
            route: route.name,
            sessionID,
            enabled: states.has(sessionID),
            pendingEnable: pendingEnable.has(sessionID),
          })
          if (route.name !== "session" || !sessionID) {
            toast("/watchdog only works inside a session.", "warning")
            return
          }

          if (shouldIgnoreRapidToggle(sessionID)) {
            writeLog("toggle-ignored-rapid-repeat", { sessionID })
            return
          }

          if (states.has(sessionID)) {
            writeLog("disabled-manual", { sessionID })
            disableWatchdog(sessionID, "Watchdog disabled.")
            return
          }

          if (pendingEnable.has(sessionID)) {
            writeLog("toggle-ignored-pending-enable", { sessionID })
            return
          }

          const preview = findAnchorPreviewFromState(api, sessionID, config.continuePrompt)
          states.set(sessionID, {
            rootSessionID: sessionID,
            anchorMessageID: "",
            anchorText: preview,
            anchorCreatedAt: 0,
            latestUserMessageCreatedAt: 0,
            seenUserMessageIDs: new Set(),
            armedAt: Date.now(),
            threshold: Math.min(config.threshold, 100),
            continueCount: 0,
            lastJudgedAssistantMessageID: null,
            lastScore: null,
            lastReason: "",
            phase: "arming",
            lastDecision: "none",
            revision: 0,
            evaluating: false,
          })
          syncModeToast(true)
          writeLog("arming", { sessionID, inputPreview: preview })
          pendingEnable.add(sessionID)

          void enableWatchdog(sessionID).catch((error) => {
            pendingEnable.delete(sessionID)
            states.delete(sessionID)
            syncModeToast(true)
            toast(error instanceof Error ? error.message : String(error), "error")
          })
        },
      },
    ]
  })

  api.event.on("session.status", (event) => {
    const sessionID = event.properties?.sessionID
    const state = sessionID ? states.get(sessionID) : undefined
    if (!state) return
    const type = event.properties?.status?.type
    writeLog("session-status", { sessionID, type })
    if (type === "busy") {
      state.phase = "running"
      syncModeToast(true)
      clearTimer(sessionID)
      return
    }
    if (type === "idle") {
      scheduleJudge(sessionID)
    }
  })

  api.event.on("message.updated", (event) => {
    const info = event.properties?.info as MessageInfo | undefined
    const sessionID = event.properties?.sessionID
    if (!sessionID || !info || info.role !== "user") return
    const state = states.get(sessionID)
    if (!state) return
    const createdAt = info.time?.created ?? 0
    if (state.seenUserMessageIDs.has(info.id)) {
      writeLog("user-message-ignored-seen-id", {
        sessionID,
        messageID: info.id,
        createdAt,
      })
      return
    }
    if (createdAt <= state.latestUserMessageCreatedAt) {
      writeLog("user-message-ignored-stale", {
        sessionID,
        messageID: info.id,
        createdAt,
        latestUserMessageCreatedAt: state.latestUserMessageCreatedAt,
      })
      return
    }
    writeLog("user-message-updated", {
      sessionID,
      messageID: info.id,
      createdAt,
    })
    state.seenUserMessageIDs.add(info.id)
    state.latestUserMessageCreatedAt = createdAt
    state.revision += 1
    state.phase = "waiting"
    clearTimer(sessionID)
    syncModeToast(true)
  })

  api.event.on("session.error", (event) => {
    const sessionID = event.properties?.sessionID
    if (!sessionID || !states.has(sessionID)) return
    const errorName = normalizeText((event.properties?.error as { name?: string } | undefined)?.name)
    if (errorName === "MessageAbortedError") {
      writeLog("aborted", { sessionID })
      disableWatchdog(sessionID, "Watchdog disabled after session abort.", "warning")
    }
  })

  api.event.on("tui.session.select", () => {
    syncModeToast(true)
  })

  const routeSyncInterval = setInterval(() => {
    syncModeToast()
  }, 300)

  api.lifecycle.onDispose(() => {
    clearRestoreToastTimer()
    clearInterval(routeSyncInterval)
    clearModeToast()
    for (const sessionID of states.keys()) {
      clearTimer(sessionID)
    }
    states.clear()
  })
}

const plugin: TuiPluginModule = {
  id: "opencode.watchdog",
  tui,
}

export default plugin
