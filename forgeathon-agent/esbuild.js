// Bundles the extension into dist/extension.js. `vscode` is provided by the host, everything else is bundled.
const esbuild = require('esbuild');
const watch = process.argv.includes('--watch');
const opts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
};
(async () => {
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
  } else {
    await esbuild.build(opts);
  }
})().catch(() => process.exit(1));
