/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Compile the workspace packages from source (they ship raw TS).
  transpilePackages: ['@launchpad/core', '@launchpad/bsv', '@launchpad/db'],
};

export default nextConfig;
