import path from "node:path";

import "@/env";

export const PGLITE_DIR = path.join(process.cwd(), ".pglite");
export const PGLITE_HOST = "127.0.0.1";
export const PGLITE_PORT = 54329;
export const PGLITE_CONNECTION_URL = `postgres://postgres@${PGLITE_HOST}:${PGLITE_PORT}/postgres`;
