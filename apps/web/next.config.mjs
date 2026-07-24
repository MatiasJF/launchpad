/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Compile the workspace packages from source (they ship raw TS).
  transpilePackages: ['@launchpad/core', '@launchpad/bsv', '@launchpad/db'],
  // Keep the heavy Node-oriented STAS libs external (required at runtime, not bundled).
  serverExternalPackages: ['bsv', 'stas-js'],
};

export default nextConfig;
