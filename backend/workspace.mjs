import path from "node:path";
import { realpath, readdir, readFile, lstat, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

export async function isolatedWorkspace(source, dataRoot, taskId) {
  const git = async (args) =>
    (
      await run("git", ["-C", source, ...args], {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  const repository = await git(["rev-parse", "--show-toplevel"]);
  if (await git(["status", "--porcelain"]))
    throw new Error(
      "Git 独立工作区从已提交版本创建。请先保存并提交项目修改，或关闭独立工作区选项",
    );
  const head = await git(["rev-parse", "HEAD"]);
  const parent = path.resolve(dataRoot, "workspaces"),
    destination = path.resolve(parent, taskId);
  if (
    !/^[0-9a-f-]{36}$/.test(taskId) ||
    !destination.startsWith(parent + path.sep)
  )
    throw new Error("独立工作区路径无效");
  await mkdir(parent, { recursive: true });
  await git(["worktree", "add", "--detach", destination, head]);
  return {
    cwd: await workspacePath(
      path.join(destination, path.relative(repository, source)),
    ),
    repository,
    head,
    root: destination,
  };
}

export async function workspacePath(value) {
  if (!value || !path.isAbsolute(value))
    throw new Error("请选择具体的本地工作目录");
  const resolved = await realpath(value);
  if (
    !(await lstat(resolved)).isDirectory() ||
    resolved === path.parse(resolved).root
  )
    throw new Error("工作区必须是具体文件夹，不能是盘符根目录");
  return resolved;
}
export function overlaps(a, b) {
  if (!a || !b) return false;
  const normalize = (value) =>
    path
      .resolve(value)
      .replace(/[\\/]+$/, "")
      .toLowerCase();
  a = normalize(a);
  b = normalize(b);
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}
const excluded = new Set([
  ".git",
  "node_modules",
  ".svn",
  ".p4",
  "release",
  "dist",
  "coverage",
  "test-results",
]);
export async function snapshotWorkspace(
  root,
  { maxFiles = 3000, maxBytes = 64 * 1024 * 1024, ignoredPaths = [] } = {},
) {
  const files = {};
  let count = 0,
    bytes = 0,
    complete = true;
  async function walk(folder) {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name)) continue;
      if (++count > maxFiles) {
        complete = false;
        return;
      }
      const full = path.join(folder, entry.name);
      if (ignoredPaths.includes(full)) continue;
      const relative = path.relative(root, full).replaceAll("\\", "/");
      // Never follow symlinks or junctions outside the selected workspace.
      const info = await lstat(full).catch(() => null);
      if (!info) {
        complete = false;
        continue;
      }
      if (info.isSymbolicLink()) {
        files[relative] = "link";
        continue;
      }
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) {
        if ((bytes += info.size) > maxBytes) {
          complete = false;
          continue;
        }
        try {
          files[relative] = createHash("sha256")
            .update(await readFile(full))
            .digest("hex");
        } catch {
          complete = false;
        }
      }
    }
  }
  await walk(root);
  return {
    hash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files,
    complete,
    count,
    bytes,
    at: new Date().toISOString(),
  };
}
export function changedFiles(before, after) {
  return [
    ...new Set([
      ...Object.keys(before?.files || {}),
      ...Object.keys(after?.files || {}),
    ]),
  ]
    .filter((file) => before?.files[file] !== after?.files[file])
    .sort();
}
