const fs = require("node:fs");
const path = require("node:path");

function versionParts(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || ""))
    throw new Error("连接器版本无法识别，已保留现有文件，请先核对安装目录");
  return version.split(".").map(Number);
}
function installConnector(root, runtime) {
  if (!fs.existsSync(path.join(runtime, "runtime")))
    throw new Error("未检测到 AIMana++ runtime，请先安装 AIMana++");
  const source = path.join(root, "connectors", "aimana");
  const bundled = JSON.parse(
    fs.readFileSync(path.join(source, "manifest.json"), "utf8"),
  );
  const destination = path.resolve(runtime, "tweaks", bundled.id);
  if (
    bundled.id !== "com.zhangmaofa.ai-cooperation" ||
    !destination.startsWith(path.resolve(runtime, "tweaks") + path.sep)
  )
    throw new Error("连接器安装目录无效");
  const offered = versionParts(bundled.version),
    existingFile = path.join(destination, "manifest.json");
  if (fs.existsSync(existingFile)) {
    const existing = JSON.parse(fs.readFileSync(existingFile, "utf8"));
    const installed = versionParts(existing.version);
    let order = 0;
    for (let i = 0; i < 3; i++) {
      if (installed[i] !== offered[i]) {
        order = installed[i] - offered[i];
        break;
      }
    }
    if (order > 0)
      return {
        updated: false,
        path: destination,
        message: `已安装较新的连接器 v${existing.version}，保留现有文件；当前协调器内置 v${bundled.version}，不会降级覆盖。`,
      };
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ["index.js", "manifest.json"])
    fs.copyFileSync(path.join(source, name), path.join(destination, name));
  return {
    updated: true,
    path: destination,
    message: `连接器 v${bundled.version} 已安装。请在 AIMana++ 面板重载，并确认区块中显示相同版本。`,
  };
}
module.exports = { installConnector };
