# AGENTS.md

Instructions for AI agents working in this repository. Humans should read `README.md` instead — this file only covers things that are specific to editing / shipping the plugin.

## What this repo is

`opencode-watchdog` is an OpenCode plugin shipped to npm. One npm package exports two halves:

- `src/index.ts` → `./tui` entry, runs inside the OpenCode TUI process. Owns the toggle command, the right-top mode toast, the judge orchestration and all watchdog state.
- `src/server.ts` → `.` (default) entry, runs inside the OpenCode server process. Only injects the hidden `watchdog-judge` subagent shell into config.

`tsc` builds both into `dist/`. `dist/` and `node_modules/` and `package-lock.json` are gitignored. Every `npm install` re-resolves `@opencode-ai/plugin` to the latest matching `^1.x`, so upstream type changes can break CI/typecheck even when the plugin code itself is untouched.

The runtime logic still lives almost entirely in `src/index.ts` (≈900 lines). `src/server.ts` is intentionally tiny.

## Hard rules

1. **Never read `api.route.current` / `api.command` / similar host bindings inside the producer of `api.command.register(cb)`.** Read them inside the leaf callback (`onSelect`, event handler, etc.). OpenCode caches the producer's return value, so any closure variable captured in the producer is a stale snapshot. This was the bug behind the `/watchdog only works inside a session` toast even while the user was inside a session — see commit `187a776`.

2. **Treat `api.command` as optional.** `@opencode-ai/plugin@1.15` marked it `command?: TuiCommandApi` and deprecated it in favor of `api.keymap.*`. Always go through a guard like `const commandApi = api.command; commandApi?.register(...)` and write a `command-api-missing` log entry when it's absent. Same defensive style applies to any other `api.*` that flips to optional in future upstream releases.

3. **Bump both version sources together.** Version is duplicated:
   - `package.json` `version`
   - `src/index.ts` `PLUGIN_VERSION` constant (used in `writeLog("plugin-loaded", { version })` and similar)
   Bumping only one will silently make logs lie. Always change the two together in the same commit.

4. **Do not add CI for publishing.** The `.github/workflows/publish.yml` workflow that used to auto-publish on push to `master` was deleted in commit `3988b2e`. Publishing is local-only via `npm publish`. Do not re-introduce CI publish (OIDC trusted publishing was never re-bound after a previous npm-side change). If you need a CI for typecheck/lint, that is fine, but it must not call `npm publish`.

5. **No package-lock.json.** It is in `.gitignore` on purpose. Do not commit one. If you reproduce a CI-only failure locally, do `rm -rf node_modules && npm install` to align with what CI sees, then fix the code (not the lockfile).

## Release flow (local-only)

```bash
npm install
npm run typecheck   # must pass against freshly resolved @opencode-ai/plugin
npm run build       # writes dist/
npm pack --dry-run  # sanity check tarball contents

# bump package.json version + PLUGIN_VERSION together, then:
git commit -am "..."
git push origin master
npm publish
```

After publishing, also bump the consumer `tui.json` / `opencode.json` plugin pins if they pinned a specific version (the user's local config does, see below).

## User's local install pins (heads-up only — outside this repo)

The maintainer's `~/.config/opencode/tui.json` and `~/.config/opencode/opencode.json` (both symlinked into another workspace) pin this plugin to a specific version like `opencode-watchdog@0.1.7`. After every npm publish, those pins also need to be moved forward, otherwise OpenCode will keep loading the older version. This is outside the repo, so only do it when explicitly asked.

## Logging

All runtime entries go through `writeLog(...)` to:

```
~/.local/share/opencode/log/opencode-watchdog.log
```

When adding a new state transition or branch, prefer adding a new `writeLog` call with a stable string tag (e.g. `judge-skip-no-assistant`, `command-api-missing`, `toggle-invoked`) plus a structured payload, instead of relying on a free-form message. The user reads this log to diagnose issues — the tag is the contract.

`writeLog` is best-effort and synchronous (`appendFileSync` inside a try/catch). Do not promise-ify it; do not throw out of it.

## Conventions

- TypeScript strict, ESM (`"type": "module"`). Keep it that way.
- No external deps at runtime; only `@opencode-ai/plugin` types are needed. Do not add dependencies to `package.json` without a strong reason.
- Comments only when intent is non-obvious. The codebase intentionally avoids "// increment counter"-style narration.
- All toast strings and built-in continue prompts are bilingual (`zh` / `en`) and gated by the `language` plugin option. New user-visible strings must follow the same pattern (extend the `language === "en" ? ... : ...` switches near the top of `src/index.ts`).
- Judge result is constrained by a JSON schema (`JUDGE_RESPONSE_SCHEMA` in `src/index.ts`) and validated again by `parseJudgeResult`. If you change one, change the other.

## Things that are not in scope

- Multi-state workflow classifiers, multi-judge ensembles, etc. This plugin is intentionally a single score + threshold.
- Recovering from error / empty-output turns. Those are handled by a separate auto-continue plugin and are explicitly skipped in `extractAssistantSignals` / the watchdog skip branches. Do not duplicate that recovery logic here.
- Non-root sessions. `resolveRootSession` walks up `parentID` and the watchdog only ever attaches to the root session.

## When asked to "fix CI"

Check first whether `.github/` exists. If it does not, **do not create one**. CI was deliberately removed (rule 4 above). The user expects red checks on GitHub to mean "real code problem", not "publish workflow rotted again".
