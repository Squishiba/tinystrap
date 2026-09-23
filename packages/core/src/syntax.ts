// Fast post-edit syntax check (spec 12.4).
//
// Integration note: no edit executor exists on main yet. This function is the
// seam the future executor/host runner calls after applying an edit, surfacing
// only the first error — it is not a full verification pass. Nothing else is
// wired to it by this change.
import { execFile } from "node:child_process";
import { extname } from "node:path";
import vm from "node:vm";

export type SyntaxCheck = { ok: true } | { ok: false; error: string };

export function checkEditSyntax(filePath: string, content: string): Promise<SyntaxCheck> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".py") return checkPython(content);
  if (ext === ".js" || ext === ".cjs") return Promise.resolve(checkJs(content));
  return Promise.resolve({ ok: true }); // .mjs/.ts: no fast built-in parser (YAGNI)
}

function checkJs(content: string): SyntaxCheck {
  try { new vm.Script(content); return { ok: true }; }
  catch (err) { return { ok: false, error: (err as Error).message.split("\n")[0] }; }
}

function checkPython(content: string): Promise<SyntaxCheck> {
  return new Promise((resolve) => {
    const child = execFile("python",
      ["-c", "import ast,sys; ast.parse(sys.stdin.read())"],
      (err, _out, stderr) => {
        if (!err) { resolve({ ok: true }); return; }
        const first = (stderr || "").split(/\r?\n/).find((l) => l.trim() !== "") ?? "syntax error";
        resolve({ ok: false, error: first.trim() });
      });
    child.stdin?.write(content);
    child.stdin?.end();
  });
}
