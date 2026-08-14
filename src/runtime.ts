import type {
  EngineModule,
  InterpreterHandle,
  MaskCacheInstrumentation,
  MaskResult,
  TokenizerConfig,
  TokenizerHandle,
} from "./engine/core.ts";

import {
  createHandleRuntime,
  normalizeTokenizerConfig,
  type InterpreterConfig,
  type TokenizerSource,
} from "./runtime-core.ts";
import { extractLLGuidanceTokenizerConfig } from "./tokenizer_bridge.ts";

const EMPTY_MASK_INSTRUMENTATION: Readonly<MaskCacheInstrumentation> =
  Object.freeze({
    trieNodesVisited: 0,
    sharedJsonMaskCacheHits: 0,
    sharedJsonMaskCacheMisses: 0,
    sharedJsonMaskCacheEntries: 0,
    sharedJsonMaskCacheWords: 0,
    sharedJsonMaskCacheEvictions: 0,
  });

type Options = Record<string, unknown>;
type GrammarConfig = Options | null | undefined;
export type StopReason = "NotStopped" | "EndOfSentence" | "NoExtension";
type EngineTokenizer = InstanceType<EngineModule["LLGuidanceTokenizer"]>;
type EngineInterpreter = InstanceType<EngineModule["LLGuidanceInterpreter"]>;

export type LLGuidanceResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: unknown }
  | { type: "regex"; regex: string };

export type LLGuidanceGrammarFormat =
  | "lark"
  | "json_schema"
  | "json"
  | "json_object"
  | "regex"
  | "choice"
  | "llguidance"
  | "guidance";

export interface LLGuidanceInterpreterConfig extends InterpreterConfig {
  response_format?: LLGuidanceResponseFormat;
  responseFormat?: LLGuidanceResponseFormat;
  grammar?: string;
  grammarFormat?: LLGuidanceGrammarFormat;
  grammar_format?: LLGuidanceGrammarFormat;
}

export interface LLTokenizerInstance {
  readonly vocab_size: number;
  readonly eos_token: number;
  readonly eos_tokens: number[];
  readonly is_canonical: boolean;
  free(): void;
  dispose(): void;
}

export interface LLInterpreterInstance extends InterpreterHandle {
  compute_mask(): [Uint8Array | null, string];
  compute_mask_into(target: Uint8Array): string;
  commit_token(sampledToken: number | null | undefined): [number, number[]];
  is_accepting(): boolean;
  stop_reason(): StopReason;
  has_pending_stop(): boolean;
  clone(): LLInterpreterInstance;
}

export interface LLMatcherInstance {
  maskInstrumentation(): Readonly<MaskCacheInstrumentation>;
  compute_bitmask(): Uint8Array;
  compute_logit_bias(): Uint8Array;
  consume_token(sampledToken: number): boolean;
  consume_tokens(sampledTokens: readonly number[]): boolean;
  try_consume_tokens(sampledTokens: readonly number[]): number;
  validate_tokens(tokens: readonly number[]): number;
  is_error(): boolean;
  get_error(): string;
  get_grammar_warnings(): string[];
  is_accepting(): boolean;
  is_stopped(): boolean;
  stop_reason(): StopReason;
  compute_ff_tokens(): number[];
  compute_ff_bytes(): Uint8Array;
  reset(): boolean;
  rollback(numTokens: number): void;
  deep_copy(): LLMatcherInstance;
  get_capture(): null;
  get_captures(): never[];
  free(): void;
  dispose(): void;
}

export interface LLMatcherConstructor {
  new (
    tokenizer: TokenizerSource,
    grammar: string,
    options?: Options,
  ): LLMatcherInstance;
  grammar_from_json_schema(schema: unknown): string;
  grammar_from_lark(lark: string): string;
  grammar_from_regex(regex: string): string;
  validate_grammar(grammar: string, tokenizer?: TokenizerSource | null): string;
  validate_grammar_with_warnings(
    grammar: string,
    tokenizer?: TokenizerSource | null,
  ): [boolean, string[]];
}

export interface LLGuidanceRuntime {
  LLTokenizer: new (
    tokenizer: TokenizerSource | null | undefined,
    options?: TokenizerConfig,
  ) => LLTokenizerInstance;
  LLInterpreter: new (
    tokenizer: TokenizerSource,
    grammarOrConfig: string | GrammarConfig,
    options?: Options,
  ) => LLInterpreterInstance;
  LLMatcher: LLMatcherConstructor;
  JsonCompiler: new (options?: Options) => {
    readonly options: Options;
    compile(schema: unknown): string;
  };
  LarkCompiler: new () => { compile(lark: string): string };
  RegexCompiler: new () => { compile(regex: string): string };
  grammar_from(format: LLGuidanceGrammarFormat, text: unknown): string;
  grammarFrom(format: LLGuidanceGrammarFormat, text: unknown): string;
  regex_to_lark(regex: unknown): string;
  get_version(): string;
  createTokenizer(config?: TokenizerConfig): TokenizerHandle;
  createInterpreter(config: LLGuidanceInterpreterConfig): InterpreterHandle;
}

export function createLLGuidanceRuntime(mod: EngineModule): LLGuidanceRuntime {
  const { createTokenizer, createInterpreter, resolveTokenizer } =
    createHandleRuntime<
      EngineTokenizer,
      EngineInterpreter,
      LLGuidanceInterpreterConfig
    >(mod);

  class LLTokenizer {
    readonly _tokenizer: EngineTokenizer;
    readonly vocab_size: number;
    readonly eos_token: number;
    readonly eos_tokens: number[];
    readonly is_canonical: boolean;

    constructor(
      tokenizer: TokenizerSource | null | undefined,
      options: TokenizerConfig = {},
    ) {
      const config = normalizeTokenizerConfig(
        isPlainTokenizerConfig(tokenizer)
          ? { ...tokenizer, ...options }
          : { ...extractLLGuidanceTokenizerConfig(tokenizer), ...options },
      );
      this._tokenizer = new mod.LLGuidanceTokenizer(config);
      this.vocab_size = this._tokenizer.vocabSize();
      this.eos_token = this._tokenizer.eosToken();
      this.eos_tokens = [this.eos_token];
      this.is_canonical = false;
    }

    free(): void {
      this._tokenizer.free();
    }

    dispose(): void {
      this.free();
    }
  }

  class LLInterpreter implements InterpreterHandle {
    _tokenizer: EngineTokenizer;
    _interpreter: EngineInterpreter;
    _stopped = false;
    _accepting = false;
    _stopReason: StopReason = "NotStopped";

    constructor(
      tokenizer: TokenizerSource,
      grammarOrConfig: string | GrammarConfig,
      options: Options = {},
    ) {
      this._tokenizer = resolveTokenizer(tokenizer);
      this._interpreter = new mod.LLGuidanceInterpreter(
        this._tokenizer,
        normalizeInterpreterConfig(grammarOrConfig, options),
      );
    }

    compute_mask(): [Uint8Array | null, string] {
      const result = this._interpreter.computeMask();
      this._stopped = "stop" in result && result.stop;
      this._accepting = isAcceptingResult(result, this._tokenizer.eosToken());
      if ("stop" in result) {
        this._stopReason =
          result.reason === "accepted" ? "EndOfSentence" : "NoExtension";
      }
      return [
        "mask" in result ? bitsetToBytes(result.mask) : null,
        JSON.stringify(result),
      ];
    }

    compute_mask_into(target: Uint8Array): string {
      const [mask, info] = this.compute_mask();
      if (mask) target.set(mask.subarray(0, target.length));
      return info;
    }

    commit_token(sampledToken: number | null | undefined): [number, number[]] {
      if (sampledToken == null) return [0, []];
      const result = this._interpreter.commitToken(sampledToken);
      this._stopped = Boolean(result.stop);
      this._accepting = this._stopped;
      if (this._stopped) this._stopReason = "EndOfSentence";
      return [result.backtrack ?? 0, result.ffTokens ?? []];
    }

    is_accepting(): boolean {
      return this._accepting;
    }

    stop_reason(): StopReason {
      return this._stopReason;
    }

    has_pending_stop(): boolean {
      return this._stopped;
    }

    computeMask(): MaskResult {
      return this._interpreter.computeMask();
    }

    computeMaskInto(target: Uint32Array): MaskResult {
      return this._interpreter.computeMaskInto(target);
    }

    validateCandidates(
      tokenIds: Uint32Array,
      target?: Uint8Array,
    ): Uint8Array {
      return this._interpreter.validateCandidates(tokenIds, target);
    }

    commitToken(sampledToken: number) {
      return this._interpreter.commitToken(sampledToken);
    }

    clone(): LLInterpreter {
      const clone = Object.create(LLInterpreter.prototype) as LLInterpreter;
      clone._tokenizer = this._tokenizer;
      clone._interpreter = this._interpreter.clone() as EngineInterpreter;
      clone._stopped = this._stopped;
      clone._accepting = this._accepting;
      clone._stopReason = this._stopReason;
      return clone;
    }

    rollback(count: number): void {
      this._interpreter.rollback(count);
      this._stopped = false;
      this._accepting = false;
      this._stopReason = "NotStopped";
    }

    computeFastForward(maxTokens?: number): number[] {
      return this._interpreter.computeFastForward(maxTokens);
    }

    getCapture(name: string) {
      return this._interpreter.getCapture(name);
    }

    getCaptures(name?: string) {
      return this._interpreter.getCaptures(name);
    }

    maskInstrumentation(): Readonly<MaskCacheInstrumentation> {
      return (
        this._interpreter.maskInstrumentation?.() ?? EMPTY_MASK_INSTRUMENTATION
      );
    }

    free(): void {
      this._interpreter.free();
    }

    dispose(): void {
      this.free();
    }
  }

  class LLMatcher {
    _tokenizer: EngineTokenizer;
    _grammar: string;
    _options: Options;
    _interpreter: EngineInterpreter;
    _error = "";
    _stopped = false;
    _accepting = false;
    _stopReason: StopReason = "NotStopped";

    constructor(
      tokenizer: TokenizerSource,
      grammar: string,
      options: Options = {},
    ) {
      this._tokenizer = resolveTokenizer(tokenizer);
      this._grammar = grammar;
      this._options = options;
      this._interpreter = new mod.LLGuidanceInterpreter(
        this._tokenizer,
        normalizeInterpreterConfig(grammar, options),
      );
    }

    static grammar_from_json_schema(schema: unknown): string {
      return mod.grammarFromJsonSchema(
        typeof schema === "string" ? (JSON.parse(schema) as unknown) : schema,
      );
    }

    static grammar_from_lark(lark: string): string {
      return mod.grammarFromLark(lark);
    }

    static grammar_from_regex(regex: string): string {
      return mod.grammarFromRegex(regex);
    }

    maskInstrumentation(): Readonly<MaskCacheInstrumentation> {
      return (
        this._interpreter.maskInstrumentation?.() ?? EMPTY_MASK_INSTRUMENTATION
      );
    }

    static validate_grammar(
      grammar: string,
      tokenizer: TokenizerSource | null = null,
    ): string {
      if (!tokenizer) return "";
      let matcher: LLMatcher | undefined;
      try {
        matcher = new LLMatcher(tokenizer, grammar);
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        matcher?.free();
      }
    }

    static validate_grammar_with_warnings(
      grammar: string,
      tokenizer: TokenizerSource | null = null,
    ): [boolean, string[]] {
      const message = LLMatcher.validate_grammar(grammar, tokenizer);
      return [Boolean(message), message ? [message] : []];
    }

    compute_bitmask(): Uint8Array {
      const result = this._interpreter.computeMask();
      this._stopped = "stop" in result && result.stop;
      this._accepting = isAcceptingResult(result, this._tokenizer.eosToken());
      if ("stop" in result) {
        this._stopReason =
          result.reason === "accepted" ? "EndOfSentence" : "NoExtension";
      }
      return "mask" in result ? bitsetToBytes(result.mask) : new Uint8Array(0);
    }

    compute_logit_bias(): Uint8Array {
      return bitmaskToLogitBias(
        this.compute_bitmask(),
        this._tokenizer.vocabSize(),
      );
    }

    consume_token(sampledToken: number): boolean {
      try {
        const result = this._interpreter.commitToken(sampledToken);
        this._stopped = Boolean(result.stop);
        this._accepting = this._stopped;
        if (this._stopped) this._stopReason = "EndOfSentence";
        return true;
      } catch (error) {
        this._error = error instanceof Error ? error.message : String(error);
        return false;
      }
    }

    consume_tokens(sampledTokens: readonly number[]): boolean {
      return sampledTokens.every((token) => this.consume_token(token));
    }

    try_consume_tokens(sampledTokens: readonly number[]): number {
      let consumed = 0;
      for (const token of sampledTokens) {
        if (!this.consume_token(token)) break;
        consumed += 1;
      }
      return consumed;
    }

    validate_tokens(tokens: readonly number[]): number {
      const matcher = new LLMatcher(
        { _tokenizer: this._tokenizer },
        this._grammar,
        this._options,
      );
      try {
        return matcher.try_consume_tokens(tokens);
      } finally {
        matcher.free();
      }
    }

    is_error(): boolean {
      return this._error !== "";
    }

    get_error(): string {
      return this._error;
    }

    get_grammar_warnings(): string[] {
      return [];
    }

    is_accepting(): boolean {
      return this._accepting;
    }

    is_stopped(): boolean {
      return this._stopped || this.is_error();
    }

    stop_reason(): StopReason {
      return this._stopReason;
    }

    compute_ff_tokens(): number[] {
      return this._interpreter.computeFastForward();
    }

    compute_ff_bytes(): Uint8Array {
      return new Uint8Array(0);
    }

    reset(): boolean {
      const replacement = new mod.LLGuidanceInterpreter(
        this._tokenizer,
        normalizeInterpreterConfig(this._grammar, this._options),
      );
      this._interpreter.free();
      this._interpreter = replacement;
      this._error = "";
      this._stopped = false;
      this._accepting = false;
      this._stopReason = "NotStopped";
      return true;
    }

    free(): void {
      this._interpreter.free();
    }

    dispose(): void {
      this.free();
    }

    rollback(numTokens: number): void {
      this._interpreter.rollback(numTokens);
      this._error = "";
      this._stopped = false;
      this._accepting = false;
      this._stopReason = "NotStopped";
    }

    deep_copy(): LLMatcher {
      const copy = Object.create(LLMatcher.prototype) as LLMatcher;
      copy._tokenizer = this._tokenizer;
      copy._grammar = this._grammar;
      copy._options = this._options;
      copy._interpreter = this._interpreter.clone() as EngineInterpreter;
      copy._error = this._error;
      copy._stopped = this._stopped;
      copy._accepting = this._accepting;
      copy._stopReason = this._stopReason;
      return copy;
    }

    get_capture(): null {
      return null;
    }

    get_captures(): never[] {
      return [];
    }
  }

  class JsonCompiler {
    readonly options: Options;

    constructor(options: Options = {}) {
      this.options = options;
    }

    compile(schema: unknown): string {
      return LLMatcher.grammar_from_json_schema(schema);
    }
  }

  class LarkCompiler {
    compile(lark: string): string {
      return LLMatcher.grammar_from_lark(lark);
    }
  }

  class RegexCompiler {
    compile(regex: string): string {
      return LLMatcher.grammar_from_regex(regex);
    }
  }

  return {
    LLTokenizer,
    LLInterpreter,
    LLMatcher,
    JsonCompiler,
    LarkCompiler,
    RegexCompiler,
    grammar_from(format: LLGuidanceGrammarFormat, text: unknown): string {
      return mod.grammarFrom(
        format,
        typeof text === "string" ? text : JSON.stringify(text),
      );
    },
    grammarFrom(format: LLGuidanceGrammarFormat, text: unknown): string {
      return mod.grammarFrom(
        format,
        typeof text === "string" ? text : JSON.stringify(text),
      );
    },
    regex_to_lark(regex: unknown): string {
      return String(regex).replaceAll("/", "\\/");
    },
    get_version(): string {
      return "llguidance-ts-core";
    },
    createTokenizer,
    createInterpreter,
  };
}

function normalizeInterpreterConfig(
  grammarOrConfig: string | GrammarConfig,
  options: Options = {},
): Options {
  if (typeof grammarOrConfig === "string") {
    return { ...options, grammar: grammarOrConfig };
  }
  if (grammarOrConfig?.response_format || grammarOrConfig?.responseFormat) {
    return {
      ...grammarOrConfig,
      response_format:
        grammarOrConfig.response_format ?? grammarOrConfig.responseFormat,
    };
  }
  return { ...options, ...(grammarOrConfig ?? {}) };
}

function isPlainTokenizerConfig(
  value: TokenizerSource | null | undefined,
): value is TokenizerConfig | null | undefined {
  if (value == null) return true;
  if (typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (value.constructor === Object && Object.keys(value).length === 0) ||
    Boolean(
      candidate.tokens ||
      candidate.eos_token_id != null ||
      candidate.eosTokenId != null,
    )
  );
}

function bitsetToBytes(mask: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(mask.byteLength);
  bytes.set(new Uint8Array(mask.buffer, mask.byteOffset, mask.byteLength));
  return bytes;
}

function isAcceptingResult(result: MaskResult, eosToken: number): boolean {
  if ("stop" in result) return result.reason === "accepted";
  return (result.mask[eosToken >>> 5] & (1 << (eosToken & 31))) !== 0;
}

function bitmaskToLogitBias(
  bitmask: Uint8Array,
  vocabSize: number,
): Uint8Array {
  const bias = new Uint8Array(vocabSize);
  for (let token = 0; token < vocabSize; token += 1) {
    const byte = bitmask[token >> 3] ?? 0;
    bias[token] = byte & (1 << (token & 7)) ? 200 : 0;
  }
  return bias;
}
