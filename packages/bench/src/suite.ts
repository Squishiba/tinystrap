// Scope note: public benchmark suites (SWE-bench-style) attach through
// BenchmarkSuite + verifyInFreshCopy; running them requires a container
// substrate (Docker/WSL) that is an open decision in the spec and
// unavailable on this machine — explicitly out of scope for tier-1, which
// is fixture-local by design.

import type { BenchTask } from "./taskfile.js";

export interface BenchmarkSuite {
  readonly id: string;
  loadTasks(): BenchTask[];
}
