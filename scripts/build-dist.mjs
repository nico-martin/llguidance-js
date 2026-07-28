import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const packageRoot = new URL("../", import.meta.url);
const sourcePackagePath = new URL("package.json", packageRoot);
const readmePath = new URL("README.md", packageRoot);
const distDir = new URL("dist/", packageRoot);
const publicDocs = [
  "API_MAPPING.md",
  "ARCHITECTURE.md",
  "COMPATIBILITY.md",
  "DEVELOPMENT.md",
  "JSON_SCHEMA_PROFILE.md",
  "PERFORMANCE.md",
  "REGEX_SUPPORT.md",
  "TOKENIZERS.md",
];

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

const sourcePackage = JSON.parse(await readFile(sourcePackagePath, "utf8"));

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

run("pnpm", ["run", "build:js", "--", "--minify"]);

await writeFile(
  new URL("llguidance.d.ts", distDir),
  `export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type JSONSchema = boolean | { [key: string]: JSONValue };

export type LLGuidanceResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JSONSchema }
  | { type: "regex"; regex: string };

/** "lark" remains in this union for adapter compatibility; the TypeScript core rejects it at interpretation time. */
export type LLGuidanceGrammarFormat = "lark" | "json_schema" | "json" | "json_object" | "regex" | "choice" | "llguidance" | "guidance";

export interface LLGuidanceTokenizerConfig {
  tokens?: Array<Uint8Array | readonly number[]>;
  eosTokenId?: number;
  eos_token_id?: number;
  bosTokenId?: number;
  bos_token_id?: number;
  specialTokenIds?: readonly number[];
  special_token_ids?: readonly number[];
}

export interface TransformersTokenizerLike {
  (...args: unknown[]): unknown;
  _tokenizerJSON?: object | string;
  tokenizerJSON?: object | string;
  tokenizer_json?: object | string;
  json?: object | string | (() => object | string);
  eos_token_id?: number;
  eosTokenId?: number;
  bos_token_id?: number;
  bosTokenId?: number;
  getVocab?(): object | Map<string, number>;
  get_vocab?(): object | Map<string, number>;
}

export interface Disposable {
  free(): void;
  dispose(): void;
}

export interface LLGuidanceTokenizerHandle extends Disposable {
  vocabSize(): number;
  eosToken(): number;
  token(id: number): Uint8Array;
  isSpecial(id: number): boolean;
}

export interface LLTokenizer extends Disposable {
  readonly vocab_size: number;
  readonly eos_token: number;
  readonly eos_tokens: number[];
  readonly is_canonical: boolean;
}

export type LLGuidanceMaskResult =
  | { mask: Uint32Array; vocabSize: number }
  | { stop: true };

export interface LLGuidanceCommitResult {
  stop: boolean;
  backtrack: number;
  ffTokens: number[];
}

export interface LLGuidanceInterpreterHandle extends Disposable {
  computeMask(): LLGuidanceMaskResult;
  commitToken(sampledToken: number): LLGuidanceCommitResult;
}

export interface LLInterpreter extends LLGuidanceInterpreterHandle {
  compute_mask(): [Uint8Array | null, string];
  compute_mask_into(target: Uint8Array): string;
  commit_token(sampledToken: number | null | undefined): [number, number[]];
  is_accepting(): boolean;
  stop_reason(): string;
  has_pending_stop(): boolean;
}

export interface LLMatcher extends Disposable {
  compute_bitmask(): Uint8Array;
  compute_logit_bias(): Uint8Array;
  consume_token(sampledToken: number): boolean;
  consume_tokens(sampledTokens: number[]): boolean;
  try_consume_tokens(sampledTokens: number[]): number;
  validate_tokens(sampledTokens: number[]): number;
  reset(): boolean;
  is_error(): boolean;
  get_error(): string;
  is_accepting(): boolean;
  is_stopped(): boolean;
  stop_reason(): string;
}

export type LLGuidanceTokenizerSource = LLGuidanceTokenizerConfig | TransformersTokenizerLike | LLTokenizer | LLGuidanceTokenizerHandle;

export type LLGuidanceInterpreterConfig = {
  tokenizer: LLGuidanceTokenizerSource;
  response_format?: LLGuidanceResponseFormat;
  responseFormat?: LLGuidanceResponseFormat;
  grammar?: string;
  grammarFormat?: LLGuidanceGrammarFormat;
  grammar_format?: LLGuidanceGrammarFormat;
};

export interface LLGuidanceRuntime {
  LLTokenizer: new (tokenizerOrConfig?: LLGuidanceTokenizerSource, options?: LLGuidanceTokenizerConfig) => LLTokenizer;
  LLInterpreter: new (tokenizer: LLGuidanceTokenizerSource, grammarOrConfig: string | Omit<LLGuidanceInterpreterConfig, "tokenizer">, options?: Record<string, unknown>) => LLInterpreter;
  LLMatcher: {
    new (tokenizer: LLGuidanceTokenizerSource, grammar: string, options?: Record<string, unknown>): LLMatcher;
    grammar_from_json_schema(schema: string | JSONSchema): string;
    grammar_from_lark(lark: string): string;
    grammar_from_regex(regex: string): string;
    validate_grammar(grammar: string, tokenizer?: LLGuidanceTokenizerSource | null): string;
    validate_grammar_with_warnings(grammar: string, tokenizer?: LLGuidanceTokenizerSource | null): [boolean, string[]];
  };
  JsonCompiler: new (options?: Record<string, unknown>) => { compile(schema: string | JSONSchema): string };
  LarkCompiler: new () => { compile(lark: string): string };
  RegexCompiler: new () => { compile(regex: string): string };
  grammar_from(format: LLGuidanceGrammarFormat, text: unknown): string;
  grammarFrom(format: LLGuidanceGrammarFormat, text: unknown): string;
  regex_to_lark(regex: string): string;
  get_version(): string;
  createTokenizer(config?: LLGuidanceTokenizerConfig): LLGuidanceTokenizerHandle;
  createInterpreter(config: LLGuidanceInterpreterConfig): LLGuidanceInterpreterHandle;
}

export function loadBundledLLGuidance(): Promise<LLGuidanceRuntime>;
export const loadLLGuidance: typeof loadBundledLLGuidance;
`,
);

const featureTypeHeader = `import type {
  JSONSchema,
  LLGuidanceCommitResult,
  LLGuidanceInterpreterHandle,
  LLGuidanceMaskResult,
  LLGuidanceTokenizerConfig,
  LLGuidanceTokenizerHandle,
  LLGuidanceTokenizerSource,
} from "./llguidance.js";

export type {
  JSONSchema,
  LLGuidanceCommitResult,
  LLGuidanceInterpreterHandle,
  LLGuidanceMaskResult,
  LLGuidanceTokenizerConfig,
  LLGuidanceTokenizerHandle,
  LLGuidanceTokenizerSource,
};

`;

const featureRuntimeType = (
  formatType,
  loaderName,
) => `${featureTypeHeader}export type FeatureResponseFormat = ${formatType};

export type FeatureInterpreterConfig =
  | {
      tokenizer: LLGuidanceTokenizerSource;
      response_format: FeatureResponseFormat;
      responseFormat?: never;
    }
  | {
      tokenizer: LLGuidanceTokenizerSource;
      response_format?: never;
      responseFormat: FeatureResponseFormat;
    };

export interface FeatureGuidanceRuntime {
  createTokenizer(config?: LLGuidanceTokenizerConfig): LLGuidanceTokenizerHandle;
  createInterpreter(config: FeatureInterpreterConfig): LLGuidanceInterpreterHandle;
  get_version(): string;
}

export function ${loaderName}(): Promise<FeatureGuidanceRuntime>;
`;

await Promise.all([
  writeFile(
    new URL("regex.d.ts", distDir),
    featureRuntimeType('{ type: "regex"; regex: string }', "loadRegexGuidance"),
  ),
  writeFile(
    new URL("json-schema.d.ts", distDir),
    featureRuntimeType(
      '{ type: "json_object" } | { type: "json_schema"; json_schema: JSONSchema }',
      "loadJsonGuidance",
    ),
  ),
]);

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
      files: [
        "browser.js",
        "browser.js.map",
        "node.js",
        "node.js.map",
        "llguidance.d.ts",
        "regex.browser.js",
        "regex.browser.js.map",
        "regex.node.js",
        "regex.node.js.map",
        "regex.d.ts",
        "json-schema.browser.js",
        "json-schema.browser.js.map",
        "json-schema.node.js",
        "json-schema.node.js.map",
        "json-schema.d.ts",
        "docs",
      ],
      exports: {
        ".": {
          types: "./llguidance.d.ts",
          browser: "./browser.js",
          node: "./node.js",
          import: "./browser.js",
          default: "./browser.js",
        },
        "./regex": {
          types: "./regex.d.ts",
          browser: "./regex.browser.js",
          node: "./regex.node.js",
          import: "./regex.browser.js",
          default: "./regex.browser.js",
        },
        "./json-schema": {
          types: "./json-schema.d.ts",
          browser: "./json-schema.browser.js",
          node: "./json-schema.node.js",
          import: "./json-schema.browser.js",
          default: "./json-schema.browser.js",
        },
      },
      sideEffects: false,
      publishConfig: sourcePackage.publishConfig,
    },
    null,
    2,
  )}\n`,
);

await cp(readmePath, new URL("README.md", distDir));
await mkdir(new URL("docs/", distDir));
await Promise.all(
  publicDocs.map((file) =>
    cp(new URL(`docs/${file}`, packageRoot), new URL(`docs/${file}`, distDir)),
  ),
);

console.log(`Built publishable package in ${distDir.pathname}`);
