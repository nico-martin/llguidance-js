import * as esbuild from "esbuild";

const common = {
  bundle: true,
  format: "esm",
  sourcemap: true,
  target: "es2022",
  logLevel: "info",
  minify: process.argv.includes("--minify"),
};

const entries = [
  ["", "src/llguidance.ts", "src/llguidance.node.ts"],
  ["regex.", "src/regex.ts", "src/regex.ts"],
  ["json-schema.", "src/json-schema.ts", "src/json-schema.ts"],
];
const builds = entries.flatMap(([prefix, browserEntry, nodeEntry]) => [
  {
    ...common,
    entryPoints: [browserEntry],
    outfile: `dist/${prefix}browser.js`,
    platform: "browser",
  },
  {
    ...common,
    entryPoints: [nodeEntry],
    outfile: `dist/${prefix}node.js`,
    platform: "node",
  },
]);

if (process.argv.includes("--watch")) {
  const contexts = await Promise.all(
    builds.map((config) => esbuild.context(config)),
  );
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("Watching TypeScript/JavaScript sources for changes...");
} else {
  await Promise.all(builds.map((config) => esbuild.build(config)));
}
