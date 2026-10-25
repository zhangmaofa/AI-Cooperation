import { spawn, execFile } from "node:child_process";
import { z } from "zod";

export const verificationSchema = z
  .array(
    z.object({
      command: z.string().trim().min(1).max(2000),
      args: z.array(z.string().max(8000)).max(100).default([]),
      timeoutMs: z.number().int().min(1000).max(300000).default(120000),
    }),
  )
  .max(8);

export function verifyCommand(spec, cwd, { signal } = {}) {
  return new Promise((resolve) => {
    let output = "",
      timedOut = false,
      settled = false;
    const child = spawn(spec.command, spec.args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({
        command: spec.command,
        args: spec.args,
        code,
        passed: code === 0 && !timedOut && !error,
        timedOut,
        output,
        error,
        at: new Date().toISOString(),
      });
    };
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === "win32")
        execFile(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true },
          () => {},
        );
      else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const collect = (data) => {
      output = (output + data.toString()).slice(-20000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => finish(null, error.message));
    child.on("exit", (code) =>
      finish(code, signal?.aborted ? "已取消验证" : undefined),
    );
  });
}
