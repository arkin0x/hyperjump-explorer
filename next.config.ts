import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the dev-mode route indicator badge (the "N" bubble) so it doesn't cover UI.
  // Only affects `next dev`.
  devIndicators: false,
};

export default nextConfig;
