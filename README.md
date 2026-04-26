# opencode-watchdog

Toggle a watchdog on the current root OpenCode session. After each completed assistant turn, the plugin asks a hidden judge subagent for a completion score. If the score is below the threshold, it injects a fixed synthetic continue prompt. If the score reaches or exceeds the threshold, the watchdog auto-pauses and disables itself.

This package now ships both:

- a `server` plugin half that injects a default hidden `watchdog-judge` shell at runtime
- a `tui` plugin half that provides the toggle command, right-top watchdog mode toast, and judge orchestration

## Quick start

1. Install the plugin:

```bash
opencode plugin opencode-watchdog@latest --global
```

2. Restart OpenCode.

3. Open a session that is still actively running, then enable watchdog with either:

- `ctrl+q`
- `/watchdog`

If you enable it after the session is already back at the normal user-input stage, watchdog will refuse to arm. This is intentional: it only watches future turns and does not retroactively judge the already-finished last reply.

## What you will see

- A long-lived toast titled `Watchdog mode` appears while watchdog is active for the current root session.
- The toast shows four fields:
  - `status`
  - `input`
  - `threshold`
  - `last score`
- Short result toasts use severity on purpose:
  - `success`: judge passed, watchdog auto-paused
  - `warning`: judge did not pass and watchdog keeps going, or watchdog was manually/statically stopped
- After each later assistant completion, watchdog waits briefly, runs a hidden judge, then either:
  - auto-continues when `score < threshold`
  - auto-pauses and disables itself when `score >= threshold`

## Install

Preferred install command:

```bash
opencode plugin opencode-watchdog@latest --global
```

If you only want it in the current project instead of globally, omit `--global`:

```bash
opencode plugin opencode-watchdog@latest
```

For local development before publishing or while iterating:

```bash
opencode plugin "/Users/bytedance/self/opencode-watchdog"
```

This package exposes both `server` and `tui` entries. A normal `opencode plugin ...` install will wire both halves automatically.

## TUI plugin options

The exported TUI plugin supports these options:

- `commandKeybind`: toggle shortcut, default `ctrl+q`
- `language`: default language for the built-in continue prompt and judge reason, default `zh`, allowed values: `zh`, `en`
- `threshold`: completion score threshold for auto-pause, default `70`
- `settleMs`: delay after root session becomes `idle` before judge runs, default `1200`
- `maxContinues`: maximum automatic continues before watchdog disables itself, default `8`
- `continuePrompt`: fixed synthetic continue prompt override
- `debug`: enable extra debug entries in the watchdog log file

Parameter meanings:

- `language`
  - `zh`: built-in continue prompt is Chinese, judge reason is requested in Chinese
  - `en`: built-in continue prompt is English, judge reason is requested in English
- `threshold`
  - `score < threshold`: watchdog sends the synthetic continue prompt
  - `score >= threshold`: watchdog auto-pauses and disables itself
- `settleMs`
  - debounce window after `idle`
  - prevents judging too early while tail events are still arriving
- `maxContinues`
  - hard safety cap for one watchdog run on the same root session
- `continuePrompt`
  - override only if you really want a different synthetic continue text
  - default `zh` text is: `继续，刚才只是阶段性汇报。请继续完成当前任务，不要重复已经完成的内容。如果你认为需求已经完全完成，请明确说明理由。`
  - default `en` text is: `Continue, the last reply was only a progress update. Keep working on the current task without repeating completed work. If you believe the request is already fully finished, explain why clearly.`
- `debug`
  - adds more detail into the watchdog log file; it does not print to stdout/stderr

Example `tui.json` plugin entry:

```json
[
  "/Users/bytedance/self/opencode-watchdog",
  {
    "commandKeybind": "ctrl+q",
    "language": "zh",
    "threshold": 72,
    "settleMs": 1200,
    "maxContinues": 8
  }
]
```

If OpenCode is already running, restart it after installing or upgrading the plugin so the new TUI plugin code is loaded.

## Hidden judge agent

By default, the package injects a fixed hidden subagent shell named `watchdog-judge` through its `server` plugin half. You do not need to add it manually for the default case, and its name is no longer a public plugin option.

Injected default shell:

```json
{
  "agent": {
    "watchdog-judge": {
      "mode": "subagent",
      "hidden": true,
      "description": "Internal watchdog judge.",
      "prompt": "Follow the provided system instructions exactly and return only the requested structured result.",
      "permission": {
        "*": "deny",
        "StructuredOutput": "allow"
      }
    }
  }
}
```

The real watchdog judging instructions still live inside the plugin code. This hidden agent is only a narrow execution shell.

If you already define `watchdog-judge` yourself, the plugin keeps your entry and does not require a second manual shell.

`model` is optional.

- If you configure `watchdog-judge.model`, OpenCode will use that model for judge runs.
- If you do not configure `watchdog-judge.model`, the plugin still works and OpenCode falls back to its normal model resolution path for that judge session.

Example with an explicit model is allowed but not required:

```json
{
  "agent": {
    "watchdog-judge": {
      "mode": "subagent",
      "hidden": true,
      "description": "Internal watchdog judge.",
      "model": "openai/gpt-4.1-mini",
      "prompt": "Follow the provided system instructions exactly and return only the requested structured result.",
      "permission": {
        "*": "deny",
        "StructuredOutput": "allow"
      }
    }
  }
}
```

That override is only needed if you want to customize the judge shell. It is not required for the package to function.

## How it works

1. You enable watchdog on the current root session.
2. The plugin captures the latest meaningful user message as the anchor task.
3. Each time the root session later becomes `idle`, watchdog waits `settleMs`.
4. It creates a temporary hidden child session named like `Watchdog judge (...)`.
5. That child returns structured JSON with `{ score, reason }`.
6. The child session is deleted.
7. Watchdog either auto-continues or auto-pauses based on the threshold.

The score means completion confidence, not answer quality:

- high score: the latest assistant reply is complete enough to stop or pause for the user
- low score: the latest assistant reply is still a phase report / incomplete execution and should continue
- if the agent is blocked and needs user clarification, permissions, environment details, credentials, or a manual decision, that also counts as a stop condition and should score high
- the `reason` field follows `language`: Chinese when `language=zh`, English when `language=en`

## Behavior

- First toggle enables watchdog for the current root session.
- If the current root session is already idle and back in user-input stage, watchdog refuses to arm and shows a warning toast instead of judging the last completed reply.
- The plugin captures a task anchor from the latest meaningful user message.
- On later root-session idle events, the plugin evaluates the latest completed assistant message.
- It creates a temporary hidden child session for the judge, reads the score, then deletes that child session.
- Replies that already fall into recovery territory for the existing auto-continue plugin are skipped by watchdog, including error turns, empty-output turns, and other non-normal finishes.
- While watchdog is active on the current root session, a persistent right-top toast shows `Watchdog mode`, including current status, last score, and last decision.
- If `score < threshold`, it sends a fixed synthetic continue prompt.
- If `score >= threshold`, watchdog auto-pauses and disables itself.
- Toggling again manually disables watchdog immediately.

## Common usage pattern

Use watchdog when you expect the agent to keep working through several turns and you want automatic continuation only while it is obviously unfinished.

Typical flow:

1. Ask the agent to do a longer coding/debugging task.
2. While it is still running, press `ctrl+q` or run `/watchdog`.
3. Let it continue working.
4. Watch the `Watchdog mode` toast:
   - low score means watchdog will keep pushing it forward
   - high score means watchdog will stop and return control to you

Do not enable it after the run is already fully back to idle and waiting for input; in that case watchdog intentionally refuses to arm.

## Logs

The plugin writes runtime state transitions to:

- `~/.local/share/opencode/log/opencode-watchdog.log`

Important entries include:

- `enabled`
- `skip`
- `judge-result`
- `continued`
- `paused`
- `judge-failed`
- `aborted`

## Current limits

- Root session only
- TUI only
- Uses a score-based judge, not a full multi-state workflow classifier
- Existing empty-output / error auto-continue behavior is intentionally out of scope

## Build

```bash
npm install
npm run typecheck
npm run build
```

Dry-run package verification:

```bash
npm pack --dry-run
```

## Plan

Implementation plan lives in:

- `plans/2026-04-25-watchdog-plan.md`
