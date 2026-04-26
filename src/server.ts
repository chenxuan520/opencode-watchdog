import type { Config, Plugin, PluginModule, PluginOptions } from "@opencode-ai/plugin"

const DEFAULT_JUDGE_AGENT = "watchdog-judge"
const THIN_JUDGE_PROMPT = "Follow the provided system instructions exactly and return only the requested structured result."

function injectedJudgeShell(existing: Record<string, unknown> | undefined) {
  const existingPermission =
    existing && typeof existing.permission === "object" && existing.permission !== null && !Array.isArray(existing.permission)
      ? (existing.permission as Record<string, unknown>)
      : {}
  const permission = {
    ...existingPermission,
    "*": "deny",
    StructuredOutput: "allow",
  }

  return {
    ...(existing ?? {}),
    mode: "subagent",
    hidden: true,
    description:
      typeof existing?.description === "string" && existing.description.trim()
        ? existing.description
        : "Internal watchdog judge.",
    prompt:
      typeof existing?.prompt === "string" && existing.prompt.trim()
        ? existing.prompt
        : THIN_JUDGE_PROMPT,
    permission,
  } as const
}

const server: Plugin = async (_input, _options: PluginOptions | undefined) => {
  return {
    config: async (cfg: Config) => {
      cfg.agent ??= {}
      const existing = cfg.agent[DEFAULT_JUDGE_AGENT]
      cfg.agent[DEFAULT_JUDGE_AGENT] = injectedJudgeShell(existing as Record<string, unknown> | undefined) as any
    },
  }
}

const plugin: PluginModule = {
  id: "opencode.watchdog",
  server,
}

export default plugin
