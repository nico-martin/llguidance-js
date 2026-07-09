import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const packageRoot = new URL("../", import.meta.url);
const sourcePackagePath = new URL("package.json", packageRoot);
const readmePath = new URL("README.md", packageRoot);
const wasmDir = new URL("src/wasm/", packageRoot);
const distDir = new URL("dist/", packageRoot);
const distWasmDir = new URL("wasm/", distDir);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: packageRoot,
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
};

const requiredWasmFiles = [
  "llguidance_wasm.js",
  "llguidance_wasm_bg.wasm",
  "llguidance_wasm.d.ts",
  "llguidance_wasm_bg.wasm.d.ts",
];

run("pnpm", ["run", "build:llguidance-wasm"]);

const sourcePackage = JSON.parse(await readFile(sourcePackagePath, "utf8"));

await rm(distDir, { recursive: true, force: true });
await mkdir(distWasmDir, { recursive: true });

for (const file of requiredWasmFiles) {
  await cp(new URL(file, wasmDir), new URL(file, distWasmDir));
}

run("pnpm", ["run", "build:js"]);

await writeFile(
  new URL("llguidance.d.ts", distDir),
    `export interface LLGuidanceRuntime {\n` +
    `  createTokenizer(config?: Record<string, unknown>): unknown;\n` +
    `  createInterpreter(config: { tokenizer: unknown; response_format: Record<string, unknown> }): unknown;\n` +
    `}\n\n` +
    `export function loadBundledLLGuidance(): Promise<LLGuidanceRuntime>;\n`,
);

await writeFile(
  new URL("package.json", distDir),
  `${JSON.stringify(
    {
      name: sourcePackage.name,
      version: sourcePackage.version,
      description: sourcePackage.description,
      type: "module",
      license: sourcePackage.license,
      keywords: sourcePackage.keywords,
      main: "./node.js",
      module: "./browser.js",
      browser: "./browser.js",
      types: "./llguidance.d.ts",
      files: ["browser.js", "browser.js.map", "node.js", "node.js.map", "llguidance.d.ts", "wasm/"],
      exports: {
        ".": {
          types: "./llguidance.d.ts",
          browser: "./browser.js",
          node: "./node.js",
          import: "./browser.js",
          default: "./browser.js",
        },
        "./wasm/llguidance_wasm.js": {
          types: "./wasm/llguidance_wasm.d.ts",
          import: "./wasm/llguidance_wasm.js",
        },
        "./wasm/llguidance_wasm_bg.wasm": "./wasm/llguidance_wasm_bg.wasm",
      },
      sideEffects: ["./wasm/llguidance_wasm.js"],
      publishConfig: sourcePackage.publishConfig,
    },
    null,
    2,
  )}\n`,
);

await cp(readmePath, new URL("README.md", distDir));

console.log(`Built publishable package in ${distDir.pathname}`);
