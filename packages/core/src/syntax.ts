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

// `python` is the Windows convention; most POSIX boxes (this one included)
// only install `python3`. Shared with pythonast.ts, which has the same
// resolution problem for a different execFile call.
//
// Exported (not just for pythonast.ts): `checkPython`'s optional `candidates`
// param is a deliberate test seam — with no interpreter-name mocking
// available, a test that wants to pin the ENOENT-retry path deterministically
// (regardless of which of python/python3 the CI box actually has) needs to
// pass its own candidate list.
export const PYTHON_CANDIDATES: readonly string[] = ["python", "python3"];

// Resolved once per process for the *default* candidate list only — this is
// a hot path (spec 12.4 runs it after every edit), so a box that only has
// python3 shouldn't pay a failed `python` spawn on every call. `null` caches
// "no interpreter found" too, so a python-less box doesn't re-probe forever.
// A caller that passes its own `candidates` (tests) bypasses the cache
// entirely — `cacheResult` is threaded explicitly through the recursion
// below rather than inferred from array identity, so the win still gets
// cached even after falling through to a later candidate.
let resolvedDefaultBin: string | null | undefined;

export function checkPython(
  content: string,
  candidates: readonly string[] = PYTHON_CANDIDATES,
): Promise<SyntaxCheck> {
  const cacheResult = candidates === PYTHON_CANDIDATES;
  if (cacheResult && resolvedDefaultBin !== undefined) {
    candidates = resolvedDefaultBin === null ? [] : [resolvedDefaultBin];
  }
  return runPythonCandidates(content, candidates, cacheResult);
}

function runPythonCandidates(
  content: string,
  candidates: readonly string[],
  cacheResult: boolean,
): Promise<SyntaxCheck> {
  const [bin, ...rest] = candidates;
  if (bin === undefined) {
    return Promise.resolve({ ok: false, error: "python interpreter not found" });
  }
  return new Promise((resolve) => {
    const child = execFile(bin,
      ["-c", "import ast,sys; ast.parse(sys.stdin.read())"],
      (err, _out, stderr) => {
        if (!err) {
          if (cacheResult) resolvedDefaultBin = bin;
          resolve({ ok: true });
          return;
        }
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          if (rest.length > 0) { resolve(runPythonCandidates(content, rest, cacheResult)); return; }
          if (cacheResult) resolvedDefaultBin = null;
          resolve({ ok: false, error: "python interpreter not found" });
          return;
        }
        const first = (stderr || "").split(/\r?\n/).find((l) => l.trim() !== "") ?? "syntax error";
        resolve({ ok: false, error: first.trim() });
      });
    child.stdin?.write(content);
    child.stdin?.end();
  });
}
