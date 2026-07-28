import * as esbuild from "esbuild";

const common = {
  bundle: true,
  format: "esm",
  sourcemap: true,
  target: "es2022",
  logLevel: "info",
};

const builds = [
  {
    ...common,
    entryPoints: ["src/llguidance.js"],
    outfile: "dist/browser.js",
    platform: "browser",
  },
  {
    ...common,
    entryPoints: ["src/llguidance.node.js"],
    outfile: "dist/node.js",
    platform: "node",
  },
];

if (process.argv.includes("--watch")) {
  const contexts = await Promise.all(
    builds.map((config) => esbuild.context(config)),
  );
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("Watching TypeScript/JavaScript sources for changes...");
} else {
  await Promise.all(builds.map((config) => esbuild.build(config)));
}
