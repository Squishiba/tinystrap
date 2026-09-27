import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export type TaskHandle = {
  taskId: string;
  taskDir: string;
  workspaceDir: string;
  baselinePath: string;
  patchPath: string;
  logsDir: string;
  // Set when a host-supplied workspace was adopted (workspace provider
  // "external"): the model's work happens in this directory, not in
  // taskDir/workspace, and patch extraction reads from here.
  externalWorkspaceDir?: string;
};

export function newTaskId(): string {
  return `task-${randomBytes(2).toString("hex")}`;
}

function tasksRoot(projectRoot: string): string {
  return join(projectRoot, ".tinystrap", "tasks");
}

export async function createTask(projectRoot: string): Promise<TaskHandle> {
  const taskId = newTaskId();
  const taskDir = join(tasksRoot(projectRoot), taskId);
  const handle: TaskHandle = {
    taskId,
    taskDir,
    workspaceDir: join(taskDir, "workspace"),
    baselinePath: join(taskDir, "baseline.json"),
    patchPath: join(taskDir, "proposed.patch"),
    logsDir: join(taskDir, "logs"),
  };
  await mkdir(handle.workspaceDir, { recursive: true });
  await mkdir(handle.logsDir, { recursive: true });
  return handle;
}

export function openTask(projectRoot: string, taskId: string): TaskHandle {
  const taskDir = join(tasksRoot(projectRoot), taskId);
  if (!existsSync(taskDir)) throw new Error(`no such task: ${taskId}`);
  const handle: TaskHandle = {
    taskId,
    taskDir,
    workspaceDir: join(taskDir, "workspace"),
    baselinePath: join(taskDir, "baseline.json"),
    patchPath: join(taskDir, "proposed.patch"),
    logsDir: join(taskDir, "logs"),
  };
  const marker = join(taskDir, "external.json");
  if (existsSync(marker)) {
    handle.externalWorkspaceDir =
      (JSON.parse(readFileSync(marker, "utf8")) as { dir: string }).dir;
  }
  return handle;
}

export async function listTasks(projectRoot: string): Promise<string[]> {
  try {
    return (await readdir(tasksRoot(projectRoot))).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function destroyTask(handle: TaskHandle): Promise<void> {
  await rm(handle.taskDir, { recursive: true, force: true });
}
