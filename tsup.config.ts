import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig([
  // Library build (for npm package consumers)
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node18',
    splitting: false,
  },
  // Standalone CLI build (all dependencies bundled, CJS for compatibility)
  {
    entry: ['src/cli.ts'],
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
    clean: false,
    sourcemap: false,
    target: 'node18',
    splitting: false,
    noExternal: [/.*/], // Bundle ALL dependencies
    define: {
      'process.env.npm_package_version': JSON.stringify(pkg.version),
    },
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);
