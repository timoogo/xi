import type { NextConfig } from "next";

const nextConfig: NextConfig = {
 // Allow verification builds alongside an existing dev server, in a separate directory.
 distDir: process.env.NEXT_DIST_DIR || ".next",
 images: {
    domains: ["images.unsplash.com"]
  },
};

export default nextConfig;
