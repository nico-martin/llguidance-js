import * as esbuild from 'esbuild';

const common = {
  bundle: true,
  format: 'esm',
  sourcemap: true,
  target: 'es2022',
  external: ['./wasm/llguidance_wasm.js'],
  logLevel: 'info',
};

await Promise.all([
  esbuild.build({
    ...common,
    entryPoints: ['src/llguidance.js'],
    outfile: 'dist/browser.js',
    platform: 'browser',
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/llguidance.node.js'],
    outfile: 'dist/node.js',
    platform: 'node',
  }),
]);
