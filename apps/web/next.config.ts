import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: ['@debtshift/domain', '@debtshift/sdk'],
};

export default nextConfig;
