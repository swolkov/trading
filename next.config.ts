import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Trading Room serves its Pine study from the repo file, so the function bundle must carry it.
  outputFileTracingIncludes: { "/api/trade/pine": ["./pine/trading-room-levels.pine"] },
};

export default nextConfig;
