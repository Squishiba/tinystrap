import { describe, expect, it } from "vitest";
import { analyzeShell } from "@tinystrap/policy";

describe("shell analyzer", () => {
  it("parses a simple command", () => {
    const a = analyzeShell("git commit -m 'fix bug'");
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.statements).toEqual([
      { program: "git", args: ["commit", "-m", "fix bug"], redirects: [] },
    ]);
  });
  it("splits compound statements", () => {
    const a = analyzeShell("npm install && npm test; echo done");
    expect(a.ok && a.statements.map((s) => s.program)).toEqual(["npm", "npm", "echo"]);
  });
  it("captures redirections", () => {
    const a = analyzeShell("echo hi > out.txt");
    expect(a.ok && a.statements[0].redirects)
      .toEqual([{ target: "out.txt", mode: "write" }]);
  });
  it("fails closed on eval, subshell, backtick, expansion, heredoc, unterminated quote", () => {
    for (const cmd of ["eval rm -rf /", "echo `id`", "echo $(whoami)",
                       "echo $HOME/x", "cat <<EOF", "echo 'unterminated"]) {
      expect(analyzeShell(cmd).ok, cmd).toBe(false);
    }
  });
  it("fails closed on expansion-bearing redirect target", () => {
    expect(analyzeShell("echo x > $TARGET").ok).toBe(false);
  });
});
