import fs from "node:fs";
import path from "node:path";

// PGlite corrupts its on-disk data if two processes open the same directory
// at once (confirmed the hard way). Only scripts/pglite-server.ts ever opens
// the directory directly now — everything else (the Next.js app, every CLI
// script) connects to it over the network instead, so the one remaining
// thing to guard against is starting a second pglite-server by mistake.
function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function acquirePgliteLock(pgliteDir: string): void {
  fs.mkdirSync(pgliteDir, { recursive: true });
  const lockFile = path.join(pgliteDir, "holder.pid");

  if (fs.existsSync(lockFile)) {
    const holderPid = Number(fs.readFileSync(lockFile, "utf-8").trim());
    if (Number.isInteger(holderPid) && isPidRunning(holderPid)) {
      throw new Error(
        `Another pglite-server (pid ${holderPid}) is already running. ` +
          "PGlite can't be opened by two processes at once without corrupting its data.",
      );
    }
    // Stale lock from a process that no longer exists (e.g. a crash) — safe
    // to reclaim.
    fs.rmSync(lockFile, { force: true });
  }

  fs.writeFileSync(lockFile, String(process.pid));

  const release = () => {
    try {
      if (fs.readFileSync(lockFile, "utf-8").trim() === String(process.pid)) {
        fs.rmSync(lockFile, { force: true });
      }
    } catch {
      // Already gone — nothing to do.
    }
  };
  process.on("exit", release);
  process.on("SIGINT", () => process.exit());
  process.on("SIGTERM", () => process.exit());
}
