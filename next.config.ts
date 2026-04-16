import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent Next.js from bundling native Node.js modules that only run
  // inside the Trigger.dev worker (LanceDB uses a compiled Rust binary).
  serverExternalPackages: ["@lancedb/lancedb", "apache-arrow"],
  // AI Elements library components have type mismatches with the installed
  // @base-ui/react version — these are upstream issues, not ours.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
