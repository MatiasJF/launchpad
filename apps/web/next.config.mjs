import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the monorepo root — a stray ~/package-lock.json otherwise makes Next
  // infer the home dir as the workspace root (breaks dev asset resolution).
  outputFileTracingRoot: path.join(import.meta.dirname, '..', '..'),
  reactStrictMode: true,
  // Uploaded logo/banner images are submitted to server actions as base64 data
  // URIs; the default 1MB body cap would reject them, so raise it.
  experimental: { serverActions: { bodySizeLimit: '5mb' } },
  // Compile the workspace packages from source (they ship raw TS).
  transpilePackages: ['@launchpad/core', '@launchpad/bsv', '@launchpad/db'],
  // Keep the heavy Node-oriented STAS libs external on the SERVER (issuance path).
  serverExternalPackages: ['bsv', 'stas-js'],
  webpack: (config, { isServer, webpack }) => {
    // Settlement (BSV-003) runs client-side with bsv-js + stas-js, which are
    // Node-oriented — provide the browser polyfills they need.
    if (!isServer) {
      config.resolve.fallback = {
        ...(config.resolve.fallback ?? {}),
        buffer: require.resolve('buffer/'),
        process: require.resolve('process/browser'),
        crypto: false,
        stream: false,
        vm: false,
        os: false,
        path: false,
        fs: false,
        net: false,
        tls: false,
        child_process: false,
        zlib: false,
        http: false,
        https: false,
      };
      config.plugins.push(
        new webpack.ProvidePlugin({ Buffer: ['buffer', 'Buffer'], process: 'process/browser' }),
      );
    }
    return config;
  },
};

export default nextConfig;
