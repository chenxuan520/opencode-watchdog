# OpenCode Watchdog Plan

## Goal

Build an OpenCode plugin package with a server half and a TUI half.

- The server half injects a default hidden `watchdog-judge` shell into runtime config.
- The TUI half lets the user toggle a watchdog on the current root session.

When enabled, the plugin should:

1. Capture a task anchor from the current session at enable time.
2. Watch each completed assistant turn for that root session.
3. Ask a hidden judge subagent to score whether the assistant should keep going.
4. Automatically inject a fixed synthetic continue prompt when the score is at or above a configured threshold.
5. Auto-disable itself once the score falls below the threshold.
6. Allow manual toggle off at any time.

## Confirmed Product Decisions

1. Package ships both `server` and `tui` entrypoints.
2. Judge model support is limited to openai-compatible models.
3. Judge requests use `chat/completions` semantics through normal OpenCode session prompting, not direct provider-specific custom APIs.
4. Judge output is reduced to a continue score instead of multiple terminal classes.
5. The continue prompt text is owned by the plugin, not by the judge.
6. This watchdog only handles "phase report but not actually finished" cases. It does not replace existing empty-output or error auto-continue logic.
7. The judge prompt should live inside the plugin code, not in a separate agent markdown file.

## Architecture Choice

Use a hidden subagent as a thin execution shell, injected by the package's server half, while keeping the real judge instructions in plugin code.

Reasoning:

- This avoids building direct provider auth and request handling in the plugin.
- It keeps the judge isolated from the main visible agent list.
- It avoids exposing a reusable human-facing agent prompt file.
- It still allows the plugin to inject a custom `system` prompt for the judge.
- It avoids forcing the user to hand-maintain a separate hidden judge shell just to use the package.

Important limitation:

- A hidden subagent still means a real child session exists.
- The parent model can remain unaware of it if the plugin never writes child results back into the parent session except for the fixed synthetic continue prompt.
- The UI may still have internal child-session state, but v1 should keep it as quiet as possible.

## Runtime Model

For each root session with watchdog enabled, keep one in-memory watchdog state record:

- `enabled`
- `rootSessionID`
- `anchorMessageID`
- `anchorText`
- `anchorCreatedAt`
- `armedAt`
- `threshold`
- `continueCount`
- `lastJudgedAssistantMessageID`
- `pendingJudge`
- `lastScore`
- `lastReason`

The plugin should keep one watchdog state per watched root session, but judge execution itself should be ephemeral. Each evaluation may create a temporary hidden child session, read the score, and delete that child session immediately afterward.

## Anchor Strategy

When the user enables watchdog on a session:

1. Read the session message list.
2. Walk backward to find the latest real user message worth anchoring.
3. Skip messages that are clearly not task anchors:
   - slash commands
   - synthetic messages
   - DCP summary write-backs
   - trivial continuation phrases such as `continue`, `ok`, `try it`, or equivalent short filler
4. Store that message as the watchdog anchor.

The anchor stays fixed for the current watchdog run.

Later user messages are treated as incremental updates, not a replacement anchor, for v1.

This keeps the behavior predictable: if the user wants a new task baseline, they should toggle watchdog off and on again.

## Judge Context Payload

Do not send full session history.

For each judge run, build a compact payload containing:

1. `anchor`
   - The captured anchor text.
2. `recent_user_updates`
   - Up to the latest 2 meaningful user messages created after watchdog was enabled.
   - Skip slash commands, synthetic messages, and trivial continuation fillers.
3. `assistant_under_review`
   - The latest completed assistant visible text.
   - Preserve head and tail if long.
4. `signals`
   - `finish`
   - `hasTool`
   - `hasPatch`
   - `hasReasoning`
   - `hasError`
   - `continueCount`

Suggested size targets:

- anchor: up to about 800 chars
- each recent user update: up to about 400 chars
- assistant under review: up to about 2400 chars, head+tail preserved

## Judge Output Contract

The judge must return strict JSON only:

```json
{
  "score": 0,
  "reason": "short explanation"
}
```

Scoring semantics:

- `0` means very confident the main assistant should not be auto-continued.
- `100` means very confident the main assistant gave only a phase report and should continue immediately.

Plugin decision rule:

- if `score >= threshold`: send the fixed synthetic continue prompt and keep watchdog enabled
- if `score < threshold`: auto-disable watchdog for that session

## Judge Agent Shell

The package should inject a minimal hidden agent shell for `watchdog-judge` through its server `config` hook.

The shell should:

- be `mode: "subagent"`
- be `hidden: true`
- have tightly denied edit/write permissions
- avoid extra tools if possible
- optionally pin to a configured openai-compatible model

If the user already defines `watchdog-judge`, their config should remain the base and the package should avoid destructive overwrites.

The shell prompt should remain minimal. The real watchdog instructions live in the plugin `system` string.

## Session Strategy

When watchdog is enabled:

1. Resolve the current root session.
2. On each evaluation, create a temporary child judge session.
3. Prompt the hidden judge subagent in that child session.
4. Read the score.
5. Delete the temporary child session.

When watchdog is disabled:

- cancel any pending judge run in plugin state
- stop reacting to later assistant completions
- do not keep any reusable child judge session around

## Trigger Rules

Watchdog should only evaluate on the root session and only after the assistant turn is complete.

Use these guards:

1. Only handle the watched root session.
2. Ignore child sessions entirely.
3. Trigger after session settles to idle, with a small debounce.
4. Judge each assistant message at most once.
5. If a newer user message arrives before a pending judge result is applied, drop the old judge result.
6. If the user manually interrupts the session, auto-disable watchdog.
7. Ignore synthetic continue prompts, DCP compression prompts, and DCP summary write-backs.

## Continue Prompt Strategy

The plugin owns the continue prompt text.

V1 fixed prompt:

```text
Continue from where you stopped and finish the remaining work. Do not repeat completed work.
```

The judge only returns score and reason. It never authors the continue prompt.

## TUI Interaction

The plugin should register:

- a slash command, for example `/watchdog`
- a configurable keybind for toggle
- a persistent right-top toast while the current session is in watchdog mode

Expected UX:

- first toggle: enable watchdog for current root session, capture anchor, create or prepare judge session, show toast
- second toggle: disable watchdog for current root session, show toast
- auto-disable after low score: show toast with score and reason summary
- auto-continue after high score: show a small toast with score and action

## Packaging Plan

This repo is empty, so create a minimal standalone plugin package similar to other OpenCode plugin repos:

1. `package.json`
2. `tsconfig.json`
3. `.gitignore`
4. `src/index.ts` for TUI
5. `src/server.ts` for runtime config injection
6. `README.md`
7. `plans/2026-04-25-watchdog-plan.md`

The package should export both a server module and a TUI module and document local-path installation first.

## File Plan

Planned files:

- `package.json`
- `tsconfig.json`
- `.gitignore`
- `src/index.ts`
- `src/server.ts`
- `README.md`

Possible optional files after the core logic works:

- `AGENTS.md`
- `src/types.ts`
- `src/context.ts`

## Implementation Steps

1. Scaffold the plugin package.
2. Add the server config hook for hidden judge shell injection.
3. Add the TUI command and keybind-driven toggle flow.
4. Add per-session watchdog state storage.
5. Implement anchor extraction from the current session history.
6. Implement root-session and ignore rules.
7. Implement temporary judge child-session creation and cleanup.
8. Embed the judge system prompt in plugin code.
9. Build the compact judge payload.
10. Parse strict judge JSON output.
11. Inject the fixed continue prompt or auto-disable based on score.
12. Add right-top watchdog mode toast, transient action toasts, and debug logging.
13. Document installation, injected judge shell behavior, and options.

## Validation Plan

Minimum validation for v1:

1. `npm install`
2. `npm run build`
3. `npm run typecheck`
4. Local plugin load smoke test
5. Unit-like smoke test for:
   - anchor extraction
   - trivial continuation filtering
   - score threshold decisions
   - judge payload construction
   - duplicate assistant message suppression

Manual runtime smoke test target:

- enable watchdog in a live TUI session
- confirm one judge child session is created and reused
- confirm high score sends synthetic continue
- confirm low score disables watchdog
- confirm manual toggle off stops further judgments

## Known Risks

1. Child sessions cannot be made truly invisible to the runtime; only minimally intrusive.
2. Score quality depends on the judge prompt and chosen model.
3. If the anchor heuristics are too loose, watchdog may lock onto a bad user message.
4. If the threshold is too low, it may over-continue; if too high, it may under-continue.
5. Reusing one child session avoids session explosion but still leaves an internal child trace.

## Non-Goals For V1

- No server plugin mode.
- No provider-agnostic direct HTTP judge calls.
- No full-session history replay into the judge.
- No plan-file ingestion.
- No multi-state `done / continue / wait_user / blocked` classifier.
- No aggressive child-session deletion on disable.
