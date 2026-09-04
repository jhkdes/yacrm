import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquirePgliteLock } from "./process-lock";

describe("acquirePgliteLock", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yacrm-lock-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the directory and writes a lock file with the current pid", () => {
    acquirePgliteLock(tmpDir);

    const lockFile = path.join(tmpDir, "holder.pid");
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(fs.readFileSync(lockFile, "utf-8").trim()).toBe(
      String(process.pid),
    );
  });

  it("throws a clear error when the lock is held by a still-running process", () => {
    // Stand-in for "another process holds it": our own pid is guaranteed to
    // be running, so writing it as the holder simulates a live conflicting
    // process from acquirePgliteLock's point of view.
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "holder.pid"), String(process.pid));

    expect(() => acquirePgliteLock(tmpDir)).toThrow(/already running/);
  });

  it("reclaims a stale lock left by a process that no longer exists", () => {
    // A pid essentially guaranteed not to exist on any real system.
    const deadPid = 999999999;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "holder.pid"), String(deadPid));

    expect(() => acquirePgliteLock(tmpDir)).not.toThrow();

    const lockFile = path.join(tmpDir, "holder.pid");
    expect(fs.readFileSync(lockFile, "utf-8").trim()).toBe(
      String(process.pid),
    );
  });
});
