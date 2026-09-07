import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"],
  experimental: {
    serverActions: {
      // Server Actions default to a 1MB request body cap — plenty for a
      // form post, but a real LinkedIn messages.csv (years of DM history)
      // routinely exceeds it, which surfaces client-side as a bare "Failed
      // to fetch" rather than a helpful error (src/app/import/linkedin).
      bodySizeLimit: "20mb",
    },
  },
};

export default nextConfig;
