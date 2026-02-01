import type { NextConfig } from "next";
import webpack from "webpack";

const nextConfig: NextConfig = {
  webpack: (config, { isServer }) => {
    // Handle WebAssembly files
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    };

    // Add WASM file handling
    config.module.rules.push({
      test: /\.wasm$/,
      type: 'webassembly/async',
    });

    // Exclude problematic modules from server-side bundling
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        '@noir-lang/noir_js': 'commonjs @noir-lang/noir_js',
        '@noir-lang/backend_barretenberg': 'commonjs @noir-lang/backend_barretenberg',
        'privacycash': 'commonjs privacycash',
        '@lightprotocol/hasher.rs': 'commonjs @lightprotocol/hasher.rs',
      });
    }

    // Client-side configuration
    if (!isServer) {
      // Fallback for Node.js modules in browser
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
        stream: false,
        buffer: false,
        worker_threads: false,
        'node-localstorage': false,
      };

      // Replace node: protocol imports with empty modules
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^node:/,
          (resource: { request: string }) => {
            // Replace node:path, node:fs, etc. with empty modules
            resource.request = resource.request.replace(/^node:/, '');
          }
        )
      );

      // Ignore unresolved WASM modules - they'll be loaded at runtime by the SDK
      config.plugins.push(
        new webpack.IgnorePlugin({
          resourceRegExp: /light_wasm_hasher_bg\.wasm$|hasher_wasm_simd_bg\.wasm$|dcap-qvl-web_bg\.wasm$/,
        })
      );

      // Handle @phala/dcap-qvl-web WASM module specially
      config.resolve.alias = {
        ...config.resolve.alias,
        // Make the WASM module optional - it's only needed for TEE attestation
        '@phala/dcap-qvl-web': false,
      };
    }

    return config;
  },
};

export default nextConfig;
