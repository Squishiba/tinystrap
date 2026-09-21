# Local AI Coding Harness

**Status:** Draft

**Date:** 2026-09-20

## 1. Summary

This project is a local coding harness for small and medium-sized AI models. It should be able to use OpenCode as an execution substrate while preserving the model-adaptation ideas demonstrated by little-coder.

The central safety and workflow rule is:

> The model never edits the user's protected project directly. It edits a disposable task workspace. The harness verifies the resulting change set and separately decides whether to promote it back to the protected project.

The harness is composed of two cooperating layers:

1. A **task supervisor** that creates isolated workspaces, launches the agent, runs verification, and controls promotion.
2. A **model/runtime adapter** that integrates with OpenCode, pi, or a future native agent loop.

The policy engine and tool preflight gate should be backend-neutral. OpenCode and pi should be adapters around those components rather than the source of truth for safety policy.

## 2. Goals

### Primary goals

- Run local coding models against a disposable project workspace.
- Give the model broad practical freedom inside that workspace.
- Prevent the model from writing to the protected project during normal execution.
- Detect unavailable or forbidden tools as early as possible during tool-call generation.
- Interrupt forbidden tool calls before the tool implementation, file operation, or shell process starts.
- Explain every interruption to the model in a concise, actionable form.
- Verify proposed changes in a fresh environment before promotion.
- Promote only the exact verified change set, never an entire scratch directory.
- Detect source drift before applying a task's changes to the protected project.
- Preserve enough logs and metadata to understand why a call was allowed, denied, rewritten, or interrupted.

### Secondary goals

- Support OpenCode first, with a future pi adapter.
- Support Git repositories and non-Git projects.
- Support different capability profiles for planning, implementation, verification, and promotion.
- Make the system useful with models that have imperfect tool-call behavior.
- Keep the policy engine deterministic and inexpensive; routine authorization should not require another LLM.

## 3. Non-goals

- Building a general-purpose host security product.
- Treating a prompt or system instruction as a sufficient security boundary.
- Letting the model decide whether its own work is safe to promote.
- Automatically pushing to a remote repository.
- Automatically accepting every change merely because tests pass.
- Requiring a single model provider or local inference server.

## 4. Design principles

### 4.1 Disposable by default

Every coding task runs in an ephemeral task workspace. If the model gets confused, loops, or damages the workspace, the default recovery action is to discard it and start from the baseline again.

### 4.2 Policy before execution

A denied tool request must not reach the actual tool implementation. In particular:

- a denied file operation must not open the target file;
- a denied shell command must not start a process;
- a denied network operation must not make a request;
- a denied subagent must not be spawned.

### 4.3 Early rejection, final validation

The harness should reject calls as soon as it has enough information to prove that they are invalid. It must still perform a complete validation after all arguments are available, because partial streaming analysis cannot safely resolve every case.

### 4.4 The model proposes; the harness decides

The model may request an action such as `promote_task_changes`, but that request is not authority to modify the protected project. Promotion is controlled by the supervisor and promotion broker.

### 4.5 Human work is never overwritten silently

The harness records the protected project's baseline state when a task begins. If the protected project changes while the task is running, promotion pauses for rebase, review, or explicit resolution.

## 5. High-level architecture

```text
                         User
                           │
                           ▼
                   Task Supervisor
             ┌─────────────┼─────────────┐
             │             │             │
             ▼             ▼             ▼
       Snapshot       Runtime        Promotion
       Manager        Adapter        Broker
             │             │             │
             ▼             ▼             ▲
      Task Workspace ◄─ Agent ──► Verification
             │             │             │
             └─────────────┴─────────────┘
                     Policy Engine
                    /              \
          Capability Compiler   Preflight Gate
```

The protected project sits outside the model's writable filesystem boundary:

```text
Protected project
      │
      │ immutable task snapshot
      ▼
Task workspace
      │
      │ model works here
      ▼
Freeze + extract exact patch
      │
      │ apply patch to a clean verifier workspace
      ▼
Deterministic verification
      │
      │ policy-approved promotion
      ▼
Protected project
```

## 6. Main components

### 6.1 Task supervisor

The supervisor owns the lifecycle of a task. It should be the only component that can transition a task into promotion.

Responsibilities:

- create and destroy task directories;
- capture the source baseline;
- select the model and capability profile;
- launch the agent runtime with the task workspace as its working root;
- monitor process lifetime and resource limits;
- freeze the workspace when the agent finishes or is interrupted;
- invoke the verifier;
- decide whether the task is promotable;
- invoke the promotion broker;
- retain logs, status, and artifacts.

The supervisor should not rely on the model to report completion correctly. Completion is a harness state transition based on the agent runtime, verification results, and policy.

### 6.2 Snapshot manager

The snapshot manager creates an immutable baseline representing the protected project at task start.

For a Git project, the baseline must account for more than `HEAD`. It should capture:

- the current commit or tree state;
- tracked unstaged changes;
- tracked staged changes;
- selected untracked files;
- relevant file modes and symlink/junction metadata;
- an explicit policy for ignored files such as build outputs and local caches.

A normal Git worktree is useful for speed and diff generation, but it is not by itself a complete security boundary. Worktrees share repository metadata and do not automatically reproduce all uncommitted or untracked state. For stronger isolation, the task should use an independent temporary clone or an isolated repository snapshot whose Git metadata is not writable by the model.

For non-Git projects, the snapshot manager should create a file manifest containing paths, hashes, sizes, modes, and link metadata, then copy the permitted source tree into the task workspace.

The baseline should have a stable identifier, for example:

```json
{
  "taskId": "task-7f31",
  "sourceRoot": "C:/work/project",
  "revision": "git:3f8c...",
  "manifestHash": "sha256:...",
  "trackedChangesHash": "sha256:...",
  "untrackedPolicy": "include-project-files-exclude-secrets",
  "createdAt": "2026-09-20T12:00:00Z"
}
```

### 6.3 Task workspace

Each task receives an isolated directory. A suggested layout is:

```text
tasks/<task-id>/
  workspace/          project visible to the model
  baseline.json       immutable source-state description
  proposed.patch      extracted change set
  verification/       verifier workspace and reports
  logs/               policy, tool, and process logs
  metadata.json       task state and configuration
```

The model should have broad permissions inside `workspace/`, subject to resource limits and the active capability profile. The original project, credentials, browser tokens, SSH keys, and unrelated host directories should not be visible from the agent process.

The harness must never copy the entire task workspace back over the protected project. Promotion is patch-based and policy-controlled.

### 6.4 Runtime adapter

The runtime adapter connects the supervisor to an agent implementation.

The first adapter should target OpenCode. A later adapter can target pi or a harness-owned agent loop.

The adapter is responsible for:

- selecting the local model provider;
- passing the task workspace as the working directory;
- loading harness tools and policy integration;
- translating runtime events into the harness event model;
- delivering structured interruption messages back to the model;
- exposing the model's stream when early preflight is enabled.

OpenCode supports custom providers, including OpenAI-compatible local endpoints such as llama.cpp, LM Studio, and Ollama. Its plugin API supports context/request hooks, permission evaluation, and tool execution hooks. See [OpenCode providers](https://opencode.ai/docs/providers), [OpenCode plugin hooks](https://opencode.ai/v2/docs/build/plugins), and [OpenCode permissions](https://opencode.ai/v2/docs/permissions).

The exact streaming preflight behavior described below may require a provider-stream integration or a small outer agent loop. OpenCode's ordinary tool hooks operate around assembled tool executions rather than providing a general token-by-token policy boundary.

### 6.5 Tool registry

The tool registry is the authoritative list of tools known to the harness.

Each tool definition should include:

```ts
type ToolDefinition = {
  name: string
  description: string
  inputSchema: JsonSchema
  capabilities: string[]
  readOnly: boolean
  preflight: PreflightHandler
  execute: ToolExecutor
}
```

The registry answers two separate questions:

1. Does this tool exist at all?
2. Is this tool available to this agent in this phase?

An unknown or unavailable tool should be rejected before its full argument object is generated whenever the runtime exposes a streaming tool-call interface.

### 6.6 Capability compiler

Before each model request, the capability compiler creates the tool list for the current task state.

Examples:

```text
planning:
  read, grep, glob

implementation:
  read, grep, glob, edit, write, apply_patch, bash

verification:
  read, grep, glob, run_tests, run_formatter

promotion:
  no model tools
```

Tools that are not available should be omitted from the model request. This reduces hallucinated calls and narrows the model's action space. The dispatcher must still enforce the same policy if the model emits a hidden or invented tool name.

### 6.7 Tool preflight gate

The preflight gate is the component that provides the desired early interruption behavior.

Its lifecycle is:

```text
MODEL_STREAM_START
  └─ TOOL_NAME_PARTIAL
       ├─ tool not in registry       → interrupt
       ├─ tool not allowed in phase  → interrupt
       └─ tool allowed               → continue
  └─ ARGUMENT_PARTIAL
       ├─ known-invalid structure    → interrupt
       ├─ definitely forbidden       → interrupt
       └─ insufficient information    → continue
  └─ ARGUMENT_COMPLETE
       ├─ exact schema validation
       ├─ complete policy evaluation
       └─ execute only on allow
```

The preflight result needs a third state in addition to allow and deny:

```ts
type PreflightResult =
  | { decision: "continue" }
  | { decision: "need_more_input" }
  | {
      decision: "interrupt"
      reason: string
      correction?: string
      retry: "allowed" | "forbidden"
    }
```

Examples:

```text
Unknown tool:
  Tool `deploy_to_production` does not exist in this environment.
  No action was performed.
  Available alternatives: run_tests, build_project, inspect_git.

Existing-file write:
  `write` is not allowed for existing file `src/app.ts`.
  No file contents were written.
  Use `edit` or `apply_patch`.

Protected path:
  Target is outside the task workspace.
  No filesystem operation was performed.
  Use a path inside the task workspace.

Forbidden shell command:
  `git push` is forbidden for this task.
  No shell process was started.
  Inspect or commit locally instead.
```

For a file write, the gate should be able to reject as soon as it has a complete target path, before the model emits the entire file content. For a shell command, it should reject as soon as a forbidden operation is unambiguous, while still performing a complete parse before execution.

### 6.8 Policy engine

The policy engine should be deterministic and backend-neutral.

```ts
type ToolRequest = {
  tool: string
  args: unknown
  cwd: string
  sessionId: string
  agentId?: string
  phase: "planning" | "implementation" | "verification" | "promotion"
}

type PolicyDecision =
  | { effect: "allow" }
  | { effect: "ask"; reason: string }
  | {
      effect: "deny"
      reason: string
      correction?: string
      retryable: boolean
    }
  | { effect: "rewrite"; args: unknown; reason: string }
```

The policy engine should support:

- tool allowlists by phase and agent;
- workspace-root path checks;
- read-before-edit rules;
- existing-file write guards;
- path normalization;
- symlink and junction escape detection;
- shell command parsing;
- command allowlists and denylists;
- shell redirection and heredoc detection;
- compound-command inspection;
- network policy;
- subagent capability restrictions;
- file size, process, timeout, and output limits;
- promotion-specific restrictions.

Policy rules should distinguish between:

```text
unknown_tool
  No implementation exists.

phase_denied
  The tool exists but is unavailable in the current phase.

argument_denied
  The tool is available, but these arguments are forbidden.

execution_error
  The request was allowed, but the underlying operation failed.
```

Repeated identical denials should be tracked. After a model repeats the same refusal, the harness can remove the offending tool from the next request, add a correction to the active context, or stop the turn.

### 6.9 Sandbox runtime

The task workspace is not sufficient by itself. The agent process should run inside a separate runtime boundary where possible.

The sandbox should enforce:

- task workspace as the writable project root;
- no access to the protected source root;
- no access to secrets and user credential stores;
- controlled temporary directories;
- limited process creation;
- CPU, memory, process-count, and wall-time limits;
- network disabled by default;
- optional narrow network allowlists for package installation;
- controlled environment variables;
- process-tree cleanup when a task ends.

The implementation can be pluggable. On Windows, possible enforcement mechanisms include a low-privilege worker, a Windows Sandbox/VM boundary, or another host-level isolation mechanism appropriate to the required toolchain. The harness should not assume that a JavaScript or TypeScript plugin alone is a security boundary.

The sandbox profile should be more permissive inside the task workspace than the protected project policy. For example:

```text
implementation:
  filesystem: task-root read/write/delete/rename
  shell: broad, subject to task policy
  network: off by default
  secrets: none

verification:
  filesystem: verifier-root read/write for build output
  shell: configured checks only
  network: off by default

promotion:
  filesystem: no model access
  shell: no model access
  authority: promotion broker only
```

### 6.10 Verifier

Verification must happen outside the agent's mutable workspace, using a fresh verifier workspace created from the same baseline.

The verifier should perform, as configured:

1. Patch integrity validation.
2. Changed-path and operation checks.
3. Workspace-boundary checks.
4. Symlink/junction and metadata checks.
5. `git diff --check` or equivalent whitespace validation.
6. Formatting checks.
7. Type checking.
8. Unit and integration tests.
9. Build/package checks.
10. Optional static security checks.
11. Optional read-only review by a second model.

The agent must not be able to modify verifier scripts, policy files, or the verifier's baseline after verification begins.

Verification should produce both a human-readable report and machine-readable results:

```json
{
  "status": "passed",
  "baseline": "sha256:...",
  "patch": "sha256:...",
  "changedFiles": [
    "src/parser.ts",
    "tests/parser.test.ts"
  ],
  "checks": {
    "patchIntegrity": "passed",
    "pathPolicy": "passed",
    "format": "passed",
    "typecheck": "passed",
    "tests": "passed"
  }
}
```

Passing verification does not automatically imply promotion. Promotion remains a policy choice.

### 6.11 Promotion broker

The promotion broker is the only component allowed to modify the protected project after a task has started.

Promotion flow:

1. Confirm the task has a verified patch.
2. Recompute the protected project's current fingerprint.
3. Compare it with the task baseline.
4. Refuse blind promotion if the source has changed.
5. Apply only the exact proposed patch.
6. Preserve a rollback checkpoint.
7. Run post-apply checks.
8. Record the promotion result.

Supported promotion modes should include:

```text
export_patch
  Write the verified patch to an artifact; do not modify the project.

apply
  Apply the verified patch to the protected working tree.

commit_task_branch
  Create a local commit or branch containing the verified changes.

auto_promote
  Apply automatically when configured checks and policy pass.
```

`export_patch` should be the safest default during early development.

## 7. Task lifecycle

### 7.1 Prepare

- Validate the project root.
- Detect whether the project is Git-based.
- Capture the baseline and source fingerprint.
- Resolve the task policy profile.
- Create the task directory.
- Build the isolated workspace.
- Remove or redact secrets and unrelated host state.

### 7.2 Run

- Launch the model runtime with the task workspace as its working root.
- Compile the allowed tool list.
- Stream model output through the preflight gate when supported.
- Enforce complete policy checks before every execution.
- Record every tool request and policy decision.
- Provide concise correction messages for recoverable denials.

### 7.3 Freeze

- Stop accepting new model actions.
- Interrupt or clean up child processes.
- Ensure the task workspace is no longer changing.
- Generate the exact proposed patch and file manifest.

### 7.4 Verify

- Create a clean verifier workspace from the immutable baseline.
- Apply only the proposed patch.
- Run configured checks.
- Produce the verification report.

### 7.5 Promote, export, or discard

- If verification fails, return diagnostics to the model or export the failed artifact for inspection.
- If verification passes, export, apply, or commit according to policy.
- If the source baseline has drifted, require rebase or explicit resolution.
- Delete the task workspace when retention policy allows.

## 8. OpenCode integration strategy

### 8.1 OpenCode plugin responsibilities

The OpenCode adapter should use the plugin API for:

- capability filtering before model requests;
- normal permission evaluation;
- tool-call logging;
- ordinary pre-execution normalization;
- post-execution result shaping;
- concise harness intervention messages.

OpenCode's `session.context` hook can alter the tool set for a request. Its permission evaluation hook can allow, ask, or deny an operation before execution. Its tool hooks can inspect tool input and results.

### 8.2 Stream gate responsibilities

The exact early interruption feature needs access to partial model output. It should live in one of these layers:

1. A provider-stream wrapper for local model endpoints.
2. A thin fork or upstream extension to expose partial tool-call events.
3. A harness-owned agent loop using the same tool and policy interfaces.

The policy engine should not depend on which of these options is used.

### 8.3 Fallback for non-streaming backends

If a backend does not expose partial tool-call deltas, the harness should still:

- hide unavailable tools from the request;
- reject unknown tools after parsing;
- perform complete pre-execution policy checks;
- return structured corrections;
- optionally use a two-stage protocol:

```text
Stage 1: model selects the tool
Stage 2: after preflight approval, model generates arguments
```

The two-stage protocol costs an extra model turn, so native streaming should be preferred when available.

## 9. Example interaction

### Existing-file write

```text
Model stream:
  tool = write
  path = src/app.ts

Preflight:
  write exists
  write is available in implementation phase
  path is inside task root
  path already exists
  write-on-existing-file is forbidden

Harness:
  interrupt stream

Model-visible result:
  `write` was interrupted because `src/app.ts` already exists.
  No file contents were written.
  Use `edit` or `apply_patch`.
```

The model never has to emit the entire replacement file.

### Unknown tool

```text
Model stream:
  tool = install_plugin

Preflight:
  no such registered tool

Harness:
  interrupt stream

Model-visible result:
  Tool `install_plugin` does not exist in this environment.
  No action was performed.
  Use the available package or shell tools if appropriate.
```

### Forbidden shell operation

```text
Model stream:
  tool = bash
  command = git push origin main

Preflight:
  bash exists
  bash is available in implementation phase
  command is complete enough to classify
  git push is forbidden

Harness:
  interrupt before process creation

Model-visible result:
  The command was interrupted because pushing to a remote is forbidden.
  No shell process was started.
```

## 10. Event and audit model

Every significant action should produce an event:

```ts
type HarnessEvent = {
  taskId: string
  timestamp: string
  phase: string
  kind:
    | "tool_stream_started"
    | "tool_preflight"
    | "tool_interrupted"
    | "tool_executed"
    | "tool_failed"
    | "workspace_frozen"
    | "verification_started"
    | "verification_finished"
    | "promotion_requested"
    | "promotion_applied"
    | "promotion_refused"
  tool?: string
  argumentsDigest?: string
  decision?: string
  reason?: string
}
```

Do not store secrets or full sensitive argument contents in audit logs by default. Store hashes, redacted summaries, and enough context to explain decisions.

## 11. Testing strategy

### Unit tests

- tool registry lookup;
- capability compilation;
- path normalization;
- workspace-boundary checks;
- existing-file write guard;
- read-before-edit state;
- shell tokenization and compound commands;
- redirection and heredoc detection;
- partial JSON/tool-call parsing;
- preflight interruption messages;
- baseline and manifest hashing;
- patch extraction;
- source-drift detection.

### Integration tests

- model attempts an unknown tool;
- model attempts a tool forbidden by phase;
- model attempts an existing-file write;
- model attempts a protected-path write;
- model attempts a forbidden shell command;
- model attempts a safe command with a forbidden command later in a chain;
- model creates, modifies, renames, and deletes files in the task workspace;
- verifier rejects a patch that escapes the workspace;
- promotion refuses when the protected source changed;
- successful patch promotion preserves unrelated human edits.

### Runtime tests

The first runtime test suite should use a fake streaming provider that emits tool-name and argument deltas. It should verify that:

- an unknown tool is interrupted before arguments finish;
- an existing-file write is interrupted before file contents finish;
- an allowed call reaches execution only after final validation;
- the model receives a synthetic explanation after interruption.

## 12. MVP plan

### Milestone 1: lifecycle and file isolation

- task directory management;
- baseline snapshot for Git projects;
- isolated workspace creation;
- task cleanup;
- patch extraction;
- export-only mode.

### Milestone 2: deterministic policy engine

- tool registry;
- phase capability profiles;
- workspace path policy;
- existing-file write guard;
- read-before-edit guard;
- basic shell allow/deny policy;
- structured denial messages.

### Milestone 3: OpenCode adapter

- local provider configuration;
- task-root working directory;
- capability filtering;
- permission integration;
- tool/result logging;
- ordinary pre-execution enforcement.

### Milestone 4: verifier and promotion broker

- clean verifier workspace;
- patch integrity checks;
- configured test/build commands;
- source-drift detection;
- guarded apply mode;
- rollback checkpoint.

### Milestone 5: streaming preflight

- provider-stream adapter;
- partial tool-name parsing;
- partial argument parsing;
- early interruption;
- synthetic tool-result injection;
- fallback behavior for non-streaming providers.

### Milestone 6: stronger runtime containment

- low-privilege process execution;
- process-tree cleanup;
- resource limits;
- secret filtering;
- network policy;
- optional Windows Sandbox/VM backend.

## 13. Open questions

1. Which local model servers expose reliable native tool-call streaming?
2. Should the first OpenCode integration use a plugin plus a provider proxy, or a small harness-owned outer loop?
3. Which Windows isolation mechanism provides the best balance between toolchain compatibility and containment?
4. Should network access be entirely disabled initially, or should package registries be supported through a controlled proxy?
5. Which untracked and ignored files should be included in a task baseline?
6. Should `apply` or `export_patch` be the default completion behavior?
7. Should the harness support a user approval step after verification, or allow fully automatic promotion for selected repositories?
8. How should tasks behave when the model needs to edit files generated during the task rather than files present in the initial baseline?

## 14. Initial recommended defaults

```text
Protected project writes:       never direct from the model
Task workspace:                 disposable, read/write
Default promotion mode:         export_patch
Network:                        disabled
Credentials:                    hidden
Unknown tools:                  interrupt immediately
Phase-denied tools:             interrupt immediately
Forbidden arguments:            interrupt before execution
Existing-file write:            redirect to edit/apply_patch
Verification:                   fresh workspace, deterministic checks
Source drift:                   refuse blind promotion
Repeated denial:                suppress tool and explain once more
Automatic push:                 always disabled
```

## 15. References

- [little-coder README and architecture](https://github.com/itayinbarr/little-coder/blob/main/README.md)
- [little-coder changelog](https://github.com/itayinbarr/little-coder/blob/main/CHANGELOG.md)
- [OpenCode providers](https://opencode.ai/docs/providers)
- [OpenCode plugin hooks](https://opencode.ai/v2/docs/build/plugins)
- [OpenCode permissions](https://opencode.ai/v2/docs/permissions)
