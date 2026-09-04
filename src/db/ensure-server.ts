import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

import { PGLITE_HOST, PGLITE_PORT } from "./connection";

function isPortOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: PGLITE_HOST, port: PGLITE_PORT });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnServer(): void {
  const serverScript = path.join(process.cwd(), "scripts", "pglite-server.ts");
  const child = spawn("npx", ["tsx", serverScript], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    shell: process.platform === "win32",
  });
  child.unref();
}

// Makes sure the shared PGlite server is reachable before any consumer (the
// Next.js app or a CLI script) tries to connect to it, spawning it as a
// detached background process on demand. Safe to call from multiple
// processes at once — at most one spawn attempt actually wins the server's
// own port bind; everyone else just finds it already listening.
export async function ensurePgliteServerRunning(): Promise<void> {
  if (await isPortOpen()) return;

  spawnServer();

  const maxAttempts = 100;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(100);
    if (await isPortOpen()) return;
  }

  throw new Error(
    `pglite-server did not start listening on ${PGLITE_HOST}:${PGLITE_PORT} within ${
      (maxAttempts * 100) / 1000
    }s`,
  );
}
