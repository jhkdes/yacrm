import type { NextConfig } from "next";

// This Next.js version has no next.config eslint integration (confirmed
// against this repo's own bundled docs — see AGENTS.md on why this isn't
// stock Next.js); `next build` doesn't run ESLint at all here, matching
// the main app's own package.json (its "lint" script calls `eslint`
// directly rather than a `next lint` wrapper). Nothing to configure.
const nextConfig: NextConfig = {
  // Without this, Turbopack finds the monorepo root's package-lock.json
  // one level up and infers *that* as the workspace root, which is wrong —
  // this app is self-contained with its own lockfile and should never
  // resolve modules against the main app's dependency tree.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
