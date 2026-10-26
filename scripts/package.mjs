import { build, Platform } from "electron-builder";
import path from "node:path";
import { readFileSync } from "node:fs";
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
await build({
  targets: Platform.WINDOWS.createTarget(["dir"]),
  config: {
    appId: "com.zhangmaofa.ai-cooperation",
    productName: "AI-Cooperation",
    asar: false,
    npmRebuild: false,
    electronDist: path.resolve("node_modules/electron/dist"),
    directories: { output: path.join("release", version) },
    files: [
      "desktop/**",
      "backend/**",
      "src/**",
      "connectors/**",
      "mcp.mjs",
      "dist/ui/**",
      "package.json",
    ],
    extraResources: [{ from: process.execPath, to: "runtime/node.exe" }],
    win: {
      executableName: "AI-Cooperation",
      icon: path.resolve("desktop/assets/app.ico"),
      signExecutable: false,
    },
  },
});
