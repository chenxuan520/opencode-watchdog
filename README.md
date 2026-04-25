# opencode-watchdog

Toggle a watchdog on the current root OpenCode session. After each completed assistant turn, the plugin asks a hidden judge subagent for a completion score. If the score is below the threshold, it injects a fixed synthetic continue prompt. If the score reaches or exceeds the threshold, the watchdog auto-pauses and disables itself.

This package now ships both:

- a `server` plugin half that injects a default hidden `watchdog-judge` shell at runtime
- a `tui` plugin half that provides the toggle command, right-top watchdog mode toast, and judge orchestration

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

## TUI plugin options

The exported TUI plugin supports these options:

- `commandKeybind`: toggle shortcut, default `ctrl+q`
- `judgeAgent`: hidden judge subagent name, default `watchdog-judge`
- `threshold`: completion score threshold for auto-pause, default `70`
- `settleMs`: idle debounce before judge runs, default `1200`
- `maxContinues`: maximum automatic continues before watchdog disables itself, default `8`
- `continuePrompt`: fixed synthetic continue prompt override
- `debug`: print debug logs to stderr when `true`

The exported server plugin also reads `judgeAgent`. If you change `judgeAgent` manually, keep the server and TUI plugin entries aligned.

Example `tui.json` plugin entry:

```json
[
  "/Users/bytedance/self/opencode-watchdog",
  {
    "commandKeybind": "ctrl+q",
    "judgeAgent": "watchdog-judge",
    "threshold": 72,
    "settleMs": 1200,
    "maxContinues": 8
  }
]
```

If OpenCode is already running, restart it after installing or upgrading the plugin so the new TUI plugin code is loaded.

## Hidden judge agent

By default, the package injects a hidden subagent shell named `watchdog-judge` through its `server` plugin half. You do not need to add it manually for the default case.

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
