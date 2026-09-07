import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // apps/redirect is a separate, independently deployed Next.js app with
    // its own package.json/node_modules/eslint setup — not part of this
    // project's lint run.
    "apps/redirect/**",
  ]),
]);

export default eslintConfig;
