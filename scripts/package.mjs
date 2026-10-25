import { build, Platform } from "electron-builder";
import path from "node:path";
await build({
  targets: Platform.WINDOWS.createTarget(["dir"]),
  config: {
    appId: "com.zhangmaofa.ai-cooperation",
    productName: "AI-Cooperation",
    asar: false,
    npmRebuild: false,
    electronDist: path.resolve("node_modules/electron/dist"),
    directories: { output: "release" },
    files: ["desktop/**", "backend/**", "src/**", "dist/ui/**", "package.json"],
    extraResources: [{ from: process.execPath, to: "runtime/node.exe" }],
    win: { executableName: "AI-Cooperation", signAndEditExecutable: false },
  },
});
