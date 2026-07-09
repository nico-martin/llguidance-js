import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const mode = process.argv.includes("--dev") ? "--dev" : "--release";
const outDir = "../../src/wasm";
const generatedGluePath = new URL("../src/wasm/llguidance_wasm.js", import.meta.url);

const result = spawnSync(
  "wasm-pack",
  [
    "build",
    "rust/llguidance-wasm",
    "--target",
    "web",
    mode,
    "--out-dir",
    outDir,
    "--out-name",
    "llguidance_wasm",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `/opt/homebrew/opt/rustup/bin:${process.env.PATH}`,
      RUSTUP_TOOLCHAIN: "1.88.0",
    },
  },
);

if (result.status !== 0) {
  process.exit(result.status || 1);
}

const generatedGlue = await readFile(generatedGluePath, "utf8");
const patchedGlue = generatedGlue.replace(
  'import * as import1 from "env"',
  "const import1 = { now: () => globalThis.performance?.now?.() ?? Date.now() }",
);

if (patchedGlue !== generatedGlue) {
  await writeFile(generatedGluePath, patchedGlue);
}
