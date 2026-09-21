import { createToolRegistry } from "@tinystrap/policy";
import type { PolicyDecision, ToolRegistry } from "@tinystrap/policy";
import { StreamGate } from "@tinystrap/proxy";

export function gateForTest(decision: PolicyDecision = { effect: "allow" }): StreamGate {
  const registry: ToolRegistry = createToolRegistry();
  for (const n of ["read", "write", "edit", "bash"]) {
    registry.register({ name: n, description: n, inputSchema: {}, capabilities: [], readOnly: false });
  }
  return new StreamGate({ registry, preflight: () => decision });
}
