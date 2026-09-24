import { spawnSync } from "node:child_process";

// Kill a host process and everything it spawned. On Windows the real binary
// often sits behind a launcher shim, so killing the direct child orphans the
// real process (which keeps holding inherited stdio pipes); taskkill /T walks
// the whole tree. On POSIX the child must have been spawned detached so it
// leads its own process group and -pid signals every member of it.
// Never throws: an already-dead (or invalid) pid is a no-op.
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL"); // whole process group
      } catch {
        process.kill(pid, "SIGKILL"); // fallback: the child itself
      }
    }
  } catch {
    /* already dead or not killable: nothing to do */
  }
}
