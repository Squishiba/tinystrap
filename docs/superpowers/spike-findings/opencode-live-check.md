# OpenCode adapter: live check findings

**Date:** 2026-09-24
**Status:** Findings recorded; fixes tracked as follow-up work (see section 6).
**Evidence:** `fixtures/opencode-tools.json`, `fixtures/opencode-run-events.jsonl`,
`fixtures/opencode-request-shapes.json` (this directory; all scrubbed).

## 1. What was run

Task 9 of the host-runner plan added an operator-gated script,
`scripts/live-host-check-opencode.mjs`. It starts the tinystrap proxy in front of a real
model server, runs the real `opencode` binary headless (`opencode run --format json --pure`)
through `OpenCodeRunner`, and extracts a patch. It was run for the first time against a
llama.cpp server on the operator's LAN serving a Qwen3.8-Flash-Next quant (opencode 1.18.25,
Windows, Node 24).

Two script bugs had to be fixed first (both merged): the script imported workspace packages
by bare specifier, which cannot resolve from `scripts/`; and a loopback-only guard rejected
the operator's LAN upstream (a mistaken transcription of "the host only talks to the
proxy"). The `tinystrap-dist` export condition (PR #27) made the built output runnable under
plain Node: `node --conditions=tinystrap-dist scripts/live-host-check-opencode.mjs ...`.

After those fixes the script ran end to end far enough to expose the real problems below.

## 2. Result of the live run

The run did **not** complete a task. Observed over roughly 12 minutes (it should have been
stopped at 5, see F2), counted from the proxy's event stream:

| Event | Count |
| ----- | ----- |
| `tool_stream_started` | 10 |
| `tool_interrupted` | 9 |
| `reasoning_intervention` | 777 |

What did work: `opencode` spawned, read its generated `opencode.json`, sent requests to the
proxy, the proxy forwarded them to the real model, and the model streamed tool calls back.
The adapter to proxy to model chain is sound; the failures are in the layers around it.

## 3. Findings

### F1. The live-check script never populated the task workspace

`createTask()` only creates the task directories. The script never called a snapshot
function, so the task workspace contained only the `opencode.json` the runner wrote; the
file the model was asked to edit did not exist there. The project root was also not a git
repository. Fix: snapshot the project into the workspace before running the host (manifest
snapshot for a non-git root, or `git init` plus `snapshotGit`), then extract the patch.

### F2. Timeout and abort do not stop the host on Windows

`opencode` is launched through a launcher shim, so the process tree is
`node -> shim -> real opencode.exe`. `child.kill("SIGKILL")` terminates only the shim. The
real `opencode.exe` is orphaned and keeps running with the stdout pipe open, so the child's
`close` event never fires: `OpenCodeRunner.run()` never resolves, the script hangs, no
transcript is written (it is only written on close), and the orphan keeps hammering the
proxy. This is the Windows caveat anticipated in the runner's source comment, now confirmed.
Fix: kill the whole process tree (`taskkill /PID <pid> /T /F` on Windows, process-group kill
elsewhere), settle the promise without waiting for `close` after a kill, and write the
transcript incrementally. Applies equally to `PiRunner`.

### F3. The host's tool dialect does not match the policy engine

Two separate mismatches, both confirmed with real data:

1. **Unknown tool names.** The script's registry was empty, so the stream gate treated every
   real OpenCode tool as unknown and interrupted it (9 of 10 tool calls).
2. **Different argument names.** OpenCode's tools use camelCase arguments
   (`filePath`, `oldString`, `newString`), while the policy engine, edit assistance,
   guidance and stall detection read `path`, `oldText`, `newText`. Even with the tool names
   registered, path-based rules would not see OpenCode's paths, and an edit-assistance
   `rewrite` would put the corrected text under a key OpenCode ignores.

OpenCode's real tool set (10 tools, from `fixtures/opencode-tools.json`):

| Tool | Required arguments | Other arguments |
| ---- | ------------------ | --------------- |
| `bash` | `command` | `timeout`, `workdir` |
| `edit` | `filePath`, `oldString`, `newString` | `replaceAll` |
| `glob` | `pattern` | `path` |
| `grep` | `pattern` | `path`, `include` |
| `read` | `filePath` | `offset`, `limit` |
| `skill` | `name` | |
| `task` | `description`, `prompt`, `subagent_type` | `task_id`, `command` |
| `todowrite` | `todos` | |
| `webfetch` | `url` | `format`, `timeout` |
| `write` | `content`, `filePath` | |

The policy engine needs a per-host **tool dialect**: normalize a host tool call into the
canonical form before evaluating it, map rewrites back, and seed the registry from the
`tools` array that every request already carries. It also needs a default policy for the
tools with reach beyond the workspace (`webfetch`: network; `task`, `skill`: spawn further
agents). Note that OpenCode embeds machine-specific facts (OS, shell, temp directory) in the
tool descriptions, so the `tools` array differs per host machine.

### F4. The loop detector nudges on every chunk once tripped

777 `reasoning_intervention` events in one run: once the loop score crossed the threshold
the detector returned "nudge" for essentially every subsequent reasoning delta, and each
one writes a nudge chunk into the stream. A nudge must fire once per episode, back off for a
cooldown, and escalate (close reasoning where supported, then the backstop) rather than
repeat. The run also shows the detector had never been exercised on real reasoning traffic;
its thresholds remain unvalidated. The volume was probably amplified by the model reacting to
F3's repeated interruptions, but the missing cooldown is a defect regardless.

### F5. The event parser guessed the wrong OpenCode event shapes

Real `opencode run --format json` events (from `fixtures/opencode-run-events.jsonl`):

| `type` | `part.type` | Notes |
| ------ | ----------- | ----- |
| `step_start` | `step-start` | |
| `tool_use` | `tool` | One event per tool call: `part.tool`, `part.callID`, and `part.state` with `status`, `input`, `output`, `metadata`. Observed status: `completed`. |
| `text` | `text` | `part.text` |
| `step_finish` | `step-finish` | `part.reason` (`tool-calls` or `stop`), `part.tokens` (`input`, `output`, `reasoning`, `cache.read`, `cache.write`), `part.cost` |

There are **no** separate `tool_result` or `tool_error` events. The parser maps `tool_use`
to `tool_executed`, which is right for success, but it maps `tool_error` to `tool_failed`,
an event that never occurs; a failed tool would be reported as executed. Failure appears to
be `part.state.status` other than `completed` (not yet observed; to verify). `step_finish`
carries the host's own token counts.

### F6. Smaller observations

- OpenCode already sends `stream_options: {"include_usage": true}`, so the proxy does not
  need to inject it for `model_usage` capture (resolves the note in the usage-capture task).
- Headless `opencode run` without `--auto` still executed `read` and `edit` on a file inside
  `--dir`: default permissions did not block workspace edits.
- OpenCode's system prompt is about 15,900 characters (roughly 4k tokens) before the task,
  and it requests `max_tokens` 32000. This matters for small-context models.
- Tool results come back as `role: "tool"` messages keyed by `tool_call_id`; the assistant's
  `tool_calls` are replayed in history with their accumulated arguments.
- Running from Git Bash rewrites a `--model` argument that begins with `/` into a Windows
  path (`C:/Program Files/Git/...`). Use `MSYS_NO_PATHCONV=1` or a short model alias.
- The model server exposes its model only under the full file path as its id (no alias).

## 4. Verified with a scripted stand-in model

To isolate the host from the real model, `opencode` was pointed at a loopback stub that
replied with a scripted `read` then `edit` tool call. `opencode` executed both and the target
file changed as instructed, and the run exited cleanly. That confirms the host side of the
loop, the event shapes in F5, and the message format in F6. Fixtures were derived from this
run and scrubbed.

## 5. Open questions

1. What does OpenCode do when the model calls a tool it does not have, such as the harness's
   synthetic `harness_notice`? This decides whether interruption feedback survives the host
   (the correction text may need to be injected by rewriting the next request's history
   instead). A probe hung at startup before it could answer; see the next item.
2. After two successful headless runs, later `opencode run` invocations stalled at startup
   (log ends after `init`, no request sent), even for the previously working scenario. Cause
   not determined (possible shared local state). It matters for running several hosts in
   parallel, as the benchmark harness will.
3. Is the reported context length per slot or the total across slots? (Carried over; still
   open.)

## 6. Follow-up work

| Finding | Follow-up |
| ------- | --------- |
| F1 | Fix the live-check script (snapshot step). |
| F2 | Process-tree kill, settle-after-kill, incremental transcript in both runners. |
| F3 | Plan and build host tool dialects and registry seeding. |
| F4 | Nudge cooldown and escalation in the loop detector, with a regression test. |
| F5 | Update the OpenCode parser to the real event shapes; use the fixtures. |
| Open questions 1 and 2 | Investigate after the above; re-run the live check once F1 to F5 are fixed. |
