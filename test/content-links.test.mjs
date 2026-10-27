import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import links from "../desktop/content-links.cjs";
const { classifyLink, resolveFile, previewFile } = links;
test("Markdown link parsing retains drive paths, encoded Unicode and line/column anchors while rejecting unsafe protocols", () => {
  assert.deepEqual(classifyLink("E:/项目/a.cs:116:5"), {
    kind: "file",
    path: "E:/项目/a.cs",
    line: 116,
    column: 5,
  });
  assert.equal(
    classifyLink("file:///E:/my%20project/a.cs#L116C5").path,
    "E:/my project/a.cs",
  );
  assert.equal(classifyLink("src/a.cs#L116-L120").line, 116);
  assert.equal(classifyLink("https://example.com/a").kind, "external");
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "//server/share",
    "\\\\server\\share",
    "E:/a.cs:stream",
    "E:/a.cs:0",
    "E:/a.cs:999999999999",
    "file://server/share",
    "https://u:p@example.com",
    "a%00.cs",
  ])
    assert.throws(() => classifyLink(href));
});
test("file previews bind to trusted workspace, block traversal and junction escape and bound file/directory content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-links-")),
    cwd = path.join(root, "project");
  await mkdir(cwd);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "outside");
  const source = Array.from({ length: 240 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  await writeFile(path.join(cwd, "example.cs"), source);
  const snapshot = {
      conversations: [{ id: "chat", workspace: cwd }],
      tasks: [{ id: "task", executor: { cwd } }],
    },
    scope = { conversationId: "chat" };
  const p = await previewFile(snapshot, { ...scope, href: "example.cs:116" });
  assert.equal(p.lines[116 - p.startLine], "line 116");
  assert.equal(p.lineMissing, false);
  assert.equal(
    (await previewFile(snapshot, { taskId: "task", href: "example.cs#L116" }))
      .line,
    116,
  );
  await assert.rejects(
    resolveFile(snapshot, { ...scope, href: "../outside/secret.txt" }),
    /目录内/,
  );
  await symlink(
    outside,
    path.join(cwd, "jump"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    resolveFile(snapshot, { ...scope, href: "jump/secret.txt" }),
    /目录之外/,
  );
  await assert.rejects(resolveFile(snapshot, { href: "example.cs" }), /绑定/);
  await assert.rejects(
    resolveFile(snapshot, { conversationId: "missing", href: "example.cs" }),
    /不存在/,
  );
  await writeFile(path.join(cwd, "binary"), Buffer.from([1, 0, 2]));
  await assert.rejects(
    previewFile(snapshot, { ...scope, href: "binary" }),
    /文本/,
  );
  await writeFile(path.join(cwd, "large.txt"), "a\n".repeat(600000));
  const large = await previewFile(snapshot, {
    ...scope,
    href: "large.txt:999999",
  });
  assert.equal(large.truncated, true);
  assert.equal(large.lineMissing, true);
  assert.ok(large.lines.length <= 201);
  await writeFile(
    path.join(cwd, "utf16.txt"),
    Buffer.concat([Buffer.from([255, 254]), Buffer.from("中文", "utf16le")]),
  );
  assert.equal(
    (await previewFile(snapshot, { ...scope, href: "utf16.txt" })).lines[0],
    "中文",
  );
  const folder = await previewFile(snapshot, { ...scope, href: cwd });
  assert.equal(folder.kind, "directory");
  assert.ok(folder.entries.some((e) => e.name === "example.cs"));
});
