import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Build configuration.
 *
 * Two build targets are supported:
 *   - Docker (DEPLOYMENT_MODE=docker or NODE_ENV=production without VERCEL=1):
 *       output: 'standalone' is set so `next build` produces a self-contained
 *       Node server in `.next/standalone/` — the Dockerfile copies this into
 *       the final image and runs `node server.js`.
 *
 *   - Vercel (DEPLOYMENT_MODE=vercel or VERCEL=1):
 *       `output` is NOT set — Vercel uses its own optimised build flow.
 *       Setting `output: 'standalone'` on Vercel produces a broken artifact.
 *
 * The detection logic mirrors `src/lib/deployment.ts` so the build-time
 * decision matches the runtime decision.
 */
function isVercelBuild(): boolean {
  if (process.env.DEPLOYMENT_MODE === 'vercel') return true
  if (process.env.DEPLOYMENT_MODE === 'docker') return false
  return process.env.VERCEL === '1'
}

const nextConfig: NextConfig = {
  // Only enable standalone output for Docker. Vercel must NOT use this.
  ...(isVercelBuild() ? {} : { output: "standalone" }),
  typescript: {
    // NOTE: this is a pre-existing repo setting; do NOT change it in this
    // PR without coordinating with the broader type cleanup work.
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default withNextIntl(nextConfig);
