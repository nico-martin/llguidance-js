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
    `export type LLGuidanceResponseFormat =\n` +
    `  | { type: "json_object" }\n` +
    `  | { type: "json_schema"; json_schema: Record<string, unknown> }\n` +
    `  | { type: "regex"; regex: string };\n\n` +
    `export type LLGuidanceGrammarFormat = "lark" | "json_schema" | "json" | "json_object" | "regex" | "choice" | "llguidance" | "guidance";\n\n` +
    `export interface LLTokenizer {\n` +
    `  readonly vocab_size: number;\n` +
    `  readonly eos_token: number;\n` +
    `  readonly eos_tokens: number[];\n` +
    `  readonly is_canonical: boolean;\n` +
    `}\n\n` +
    `export interface LLInterpreter {\n` +
    `  compute_mask(): [Uint8Array | null, string];\n` +
    `  compute_mask_into(target: Uint8Array): string;\n` +
    `  commit_token(sampledToken: number | null | undefined): [number, number[]];\n` +
    `  is_accepting(): boolean;\n` +
    `  stop_reason(): string;\n` +
    `  has_pending_stop(): boolean;\n` +
    `  computeMask(): unknown;\n` +
    `  commitToken(sampledToken: number): unknown;\n` +
    `}\n\n` +
    `export interface LLMatcher {\n` +
    `  compute_bitmask(): Uint8Array;\n` +
    `  compute_logit_bias(): Uint8Array;\n` +
    `  consume_token(sampledToken: number): boolean;\n` +
    `  consume_tokens(sampledTokens: number[]): boolean;\n` +
    `  try_consume_tokens(sampledTokens: number[]): number;\n` +
    `  validate_tokens(sampledTokens: number[]): number;\n` +
    `  reset(): boolean;\n` +
    `  is_error(): boolean;\n` +
    `  get_error(): string;\n` +
    `  is_accepting(): boolean;\n` +
    `  is_stopped(): boolean;\n` +
    `  stop_reason(): string;\n` +
    `}\n\n` +
    `export interface LLGuidanceRuntime {\n` +
    `  LLTokenizer: new (tokenizerOrConfig?: unknown, options?: Record<string, unknown>) => LLTokenizer;\n` +
    `  LLInterpreter: new (tokenizer: unknown, grammarOrConfig: string | Record<string, unknown>, options?: Record<string, unknown>) => LLInterpreter;\n` +
    `  LLMatcher: {\n` +
    `    new (tokenizer: unknown, grammar: string, options?: Record<string, unknown>): LLMatcher;\n` +
    `    grammar_from_json_schema(schema: string | Record<string, unknown>): string;\n` +
    `    grammar_from_lark(lark: string): string;\n` +
    `    grammar_from_regex(regex: string): string;\n` +
    `    validate_grammar(grammar: string, tokenizer?: unknown): string;\n` +
    `    validate_grammar_with_warnings(grammar: string, tokenizer?: unknown): [boolean, string[]];\n` +
    `  };\n` +
    `  JsonCompiler: new (options?: Record<string, unknown>) => { compile(schema: string | Record<string, unknown>): string };\n` +
    `  LarkCompiler: new () => { compile(lark: string): string };\n` +
    `  RegexCompiler: new () => { compile(regex: string): string };\n` +
    `  grammar_from(format: LLGuidanceGrammarFormat, text: string | unknown): string;\n` +
    `  grammarFrom(format: LLGuidanceGrammarFormat, text: string | unknown): string;\n` +
    `  regex_to_lark(regex: string): string;\n` +
    `  get_version(): string;\n` +
    `  createTokenizer(config?: Record<string, unknown>): unknown;\n` +
    `  createInterpreter(config: { tokenizer: unknown; response_format?: LLGuidanceResponseFormat; grammar?: string; grammarFormat?: LLGuidanceGrammarFormat }): unknown;\n` +
    `}\n\n` +
    `export type LLGuidanceWasmInput = string | URL | Request | Response | BufferSource | WebAssembly.Module;\n\n` +
    `export interface LLGuidanceWasmFactory {\n` +
    `  default(options?: { module_or_path?: LLGuidanceWasmInput }): Promise<unknown>;\n` +
    `  LLGuidanceTokenizer: new (config?: Record<string, unknown>) => unknown;\n` +
    `  LLGuidanceInterpreter: new (tokenizer: unknown, config: Record<string, unknown>) => unknown;\n` +
    `}\n\n` +
    `export interface LoadBundledLLGuidanceOptions {\n` +
    `  wasm?: LLGuidanceWasmInput;\n` +
    `  wasmUrl?: LLGuidanceWasmInput;\n` +
    `  wasmFactory?: LLGuidanceWasmFactory | Promise<LLGuidanceWasmFactory> | (() => LLGuidanceWasmFactory | Promise<LLGuidanceWasmFactory>);\n` +
    `  wasmFactoryUrl?: string | URL;\n` +
    `}\n\n` +
    `export function loadBundledLLGuidance(options?: LoadBundledLLGuidanceOptions): Promise<LLGuidanceRuntime>;\n` +
    `export const loadLLGuidance: typeof loadBundledLLGuidance;\n`,
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
