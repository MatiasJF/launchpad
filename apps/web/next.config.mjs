import path from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the monorepo root — a stray ~/package-lock.json otherwise makes Next
  // infer the home dir as the workspace root (breaks dev asset resolution).
  outputFileTracingRoot: path.join(import.meta.dirname, '..', '..'),
  reactStrictMode: true,
  // Compile the workspace packages from source (they ship raw TS).
  transpilePackages: ['@launchpad/core', '@launchpad/bsv', '@launchpad/db'],
  // Keep the heavy Node-oriented STAS libs external (required at runtime, not bundled).
  serverExternalPackages: ['bsv', 'stas-js'],
};

export default nextConfig;
