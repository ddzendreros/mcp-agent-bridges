---
name: delegate-coding-tasks
description: Plan coding work yourself and delegate the mechanical execution to other coding agents (OpenCode, Cursor CLI, Antigravity CLI, Codex) through their MCP tools (opencode_task, cursor_task, antigravity_task, codex), then verify the result. Use this whenever those tools are available and the user asks to delegate, offload, save tokens, "have another agent do it", compare agents or models, or hands you a well-specified implementation, refactor, test-writing, boilerplate or migration task, even if they do not name a delegate.
---

# Delegate coding tasks

You are the orchestrator: you own the plan, the decisions and the final check. The delegates do the typing. This saves your context and lets cheaper or free models do the mechanical work. It only works if you write tasks that need no further questions and you check what comes back.

## What to delegate and what to keep

Delegate work that is mechanical and fully specified: implementing a plan you already decided, repetitive refactors, writing tests against a spec, boilerplate, renames, simple migrations, docs.

Keep for yourself anything that needs judgment: design decisions, hard debugging, security-sensitive changes, and anything where a wrong guess is expensive to undo. When unsure, do the thinking first, then delegate the typing.

## Picking a delegate

Pick by the task, and pass `model` explicitly on every call rather than relying on defaults: defaults differ per account and may be wrong.

| Situation | Good choice | Why |
|---|---|---|
| Important or tricky change | Codex (`codex` tool, e.g. `gpt-5.6-sol`, `sandbox: "workspace-write"`, `approval-policy: "never"`) | Strong models, honest short reports, runs its own tests. Its report lacks files/commands, so check the diff. |
| Volume, mechanical, cost-sensitive | `opencode_task` with a free model | Costs nothing; the most detailed report (files, commands, tokens); `fallback_models` switches models on failure. |
| Quick, small task | `cursor_task` with `model: "auto"` | Usually the fastest. On a free plan only some models run; the bridge falls back to `auto`. |
| Backup or when the others are unavailable | `antigravity_task` | Slower and subject to usage limits. It cannot run commands unless you pass them exactly in `allow_commands`. |

If a delegate reports a usage limit or an account problem, tell the user and let them decide (they may switch account or plan). Do not try to work around limits.

## Writing the task prompt

The delegate starts with no context, so the prompt must stand on its own:

1. **Goal** in one or two sentences.
2. **Files**: which to read and which to change, by path.
3. **Definition of done**: concrete, checkable criteria.
4. **Verification**: the exact command to run (for Antigravity, pass the same string in `allow_commands`).
5. **Do not touch**: protected files, public APIs, config.
6. **Report**: ask for a 3–5 line summary of what changed and the test result.

Always pass `cwd` as an absolute path.

## After the call

The report is a summary, not proof. Before telling the user it is done:

- Read the diff of the files listed in `files_edited` (or `git diff`).
- Run the verification command yourself, plus any check the delegate could not see.
- Check that the protected files are unchanged.

For corrections, call the same tool again with `session_id` (Codex: `codex-reply` with the thread id) and a short message about what is wrong; the delegate keeps its context, so you do not need to repeat the whole task.

## Several delegates at once

Calls to different bridges can be issued together, but clients often run them one after another, so do not expect a speed-up. When comparing agents or models, give each one its own copy of the project and the same prompt, then score all of them with the same independent check.
