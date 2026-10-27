const fs = require("node:fs/promises");
const path = require("node:path");
const maxBytes = 1024 * 1024;
function classifyLink(href) {
  if (
    typeof href !== "string" ||
    !href ||
    href.length > 8000 ||
    /[\x00-\x1f]/.test(href)
  )
    throw new Error("链接格式不正确");
  if (/^https?:\/\//i.test(href)) {
    const value = new URL(href);
    if (value.username || value.password)
      throw new Error("不支持带账户凭据的网页链接");
    return { kind: "external", url: value.href };
  }
  if (href.startsWith("#")) return { kind: "anchor", fragment: href };
  let raw = href,
    fragment = "";
  if (/^file:/i.test(raw)) {
    const value = new URL(raw);
    if (value.hostname && value.hostname !== "localhost")
      throw new Error("只支持本机项目文件");
    if (value.search) throw new Error("不支持此文件链接参数");
    raw = value.pathname;
    fragment = value.hash.slice(1);
    if (/^\/[a-z]:\//i.test(raw)) raw = raw.slice(1);
  } else {
    const hash = raw.indexOf("#");
    if (hash !== -1) {
      fragment = raw.slice(hash + 1);
      raw = raw.slice(0, hash);
    }
    if (/^(?:javascript|data|vbscript):/i.test(raw))
      throw new Error("不支持此链接类型");
  }
  try {
    raw = decodeURIComponent(raw);
  } catch {
    throw new Error("文件链接编码不正确");
  }
  if (
    !raw ||
    /[\x00-\x1f]/.test(raw) ||
    /^[\\/]{2}/.test(raw) ||
    /^\\\?/.test(raw)
  )
    throw new Error("只支持本机项目文件");
  const suffix = /:(\d+)(?::(\d+))?$/.exec(raw);
  let line = 1,
    column = 1;
  if (suffix) {
    line = Number(suffix[1]);
    column = Number(suffix[2] || 1);
    raw = raw.slice(0, suffix.index);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw))
    throw new Error("不支持此链接类型");
  const anchor = /^(?:L|line=)(\d+)(?:C(\d+)|-L\d+)?$/i.exec(fragment);
  if (anchor) {
    line = Number(anchor[1]);
    column = Number(anchor[2] || 1);
  }
  if (
    !Number.isSafeInteger(line) ||
    line < 1 ||
    line > 10000000 ||
    !Number.isSafeInteger(column) ||
    column < 1 ||
    column > 1000000
  )
    throw new Error("文件行号不正确");
  const withoutDrive = /^[a-z]:[\\/]/i.test(raw) ? raw.slice(2) : raw;
  if (withoutDrive.includes(":")) throw new Error("文件路径不正确");
  return { kind: "file", path: raw, line, column };
}
function rootsFor(snapshot, scope) {
  if (!!scope?.conversationId === !!scope?.taskId)
    throw new Error("文件链接需要绑定一个项目对话或任务");
  if (scope.conversationId) {
    const chat = snapshot.conversations?.find(
      (c) => c.id === scope.conversationId,
    );
    if (!chat) throw new Error("对话不存在");
    return [chat.workspace].filter(Boolean);
  }
  const task = snapshot.tasks?.find((t) => t.id === scope.taskId);
  if (!task) throw new Error("任务不存在");
  return [task.executor?.cwd, task.workspace, task.sourceWorkspace].filter(
    Boolean,
  );
}
const contains = (root, target) => {
  const relative = path.relative(root, target);
  return (
    !relative ||
    (relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative))
  );
};
async function resolveFile(snapshot, input) {
  const link = classifyLink(input.href);
  if (link.kind !== "file") throw new Error("这不是项目文件链接");
  const roots = await Promise.all(
    rootsFor(snapshot, input).map((p) => fs.realpath(p)),
  );
  if (!roots.length)
    throw new Error("此任务没有本地工作目录，请在原软件查看该文件");
  const candidate = path.isAbsolute(link.path)
    ? link.path
    : path.resolve(roots[0], link.path);
  if (!roots.some((root) => contains(root, candidate)))
    throw new Error("该文件不在当前项目工作目录内");
  const resolved = await fs.realpath(candidate);
  if (!roots.some((root) => contains(root, resolved)))
    throw new Error("文件链接指向了项目目录之外");
  return { ...link, path: resolved };
}
async function previewFile(snapshot, input) {
  const link = await resolveFile(snapshot, input);
  const stat = await fs.stat(link.path);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(link.path, { withFileTypes: true });
    return {
      kind: "directory",
      path: link.path,
      entries: entries
        .sort(
          (a, b) =>
            Number(b.isDirectory()) - Number(a.isDirectory()) ||
            a.name.localeCompare(b.name),
        )
        .slice(0, 200)
        .map((e) => ({
          name: e.name,
          path: path.join(link.path, e.name),
          directory: e.isDirectory(),
        })),
      truncated: entries.length > 200,
    };
  }
  if (!stat.isFile()) throw new Error("只支持普通文件或目录");
  const handle = await fs.open(link.path, "r");
  let buffer;
  try {
    const data = Buffer.alloc(Math.min(stat.size, maxBytes));
    const read = await handle.read(data, 0, data.length, 0);
    buffer = data.subarray(0, read.bytesRead);
  } finally {
    await handle.close();
  }
  let text;
  if (buffer[0] === 0xff && buffer[1] === 0xfe)
    text = buffer.subarray(2).toString("utf16le");
  else {
    if (buffer.includes(0))
      throw new Error("此文件不是可预览的文本，请在原软件查看");
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer, {
        stream: stat.size > maxBytes,
      });
    } catch {
      throw new Error("该文件不是 UTF-8/UTF-16 文本，请在原软件查看");
    }
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const focus = Math.min(link.line, lines.length);
  const start = Math.max(1, focus - 100),
    end = Math.min(lines.length, focus + 100);
  return {
    kind: "file",
    path: link.path,
    line: link.line,
    column: link.column,
    startLine: start,
    lines: lines.slice(start - 1, end),
    lineCount: lines.length,
    truncated: stat.size > maxBytes,
    lineMissing: link.line > lines.length,
  };
}
module.exports = { classifyLink, resolveFile, previewFile };
