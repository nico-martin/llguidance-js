const MARKER_KEY = "$llguidance_ts_core";
const MARKER_VERSION = 1;
const LARK_UNSUPPORTED =
  "Lark grammars are not supported by the pure TypeScript core backend yet";
const UPSTREAM_UNSUPPORTED =
  "Raw llguidance/guidance serialized grammars are not supported by the pure TypeScript core backend; use a marker produced by this backend";
const MAX_COMPILED_PROGRAMS = 64;
const MAX_SHARED_JSON_MASK_ENTRIES = 64;
const MAX_SHARED_JSON_MASK_WORDS = 262_144;

export interface TokenizerConfig {
  tokens?: Array<Uint8Array | readonly number[]>;
  eosTokenId?: number;
  eos_token_id?: number;
  bosTokenId?: number;
  bos_token_id?: number;
  specialTokenIds?: readonly number[];
  special_token_ids?: readonly number[];
}

export interface GuidanceLimits {
  maxTokens?: number;
  maxOutputBytes?: number;
  maxRegexStates?: number;
  maxRegexRepeat?: number;
  maxSchemaDepth?: number;
  maxJsonDepth?: number;
}

type NormalizedGuidanceLimits = Required<GuidanceLimits>;

const DEFAULT_LIMITS: NormalizedGuidanceLimits = {
  maxTokens: 100_000,
  maxOutputBytes: 1_048_576,
  maxRegexStates: 100_000,
  maxRegexRepeat: 10_000,
  maxSchemaDepth: 128,
  maxJsonDepth: 128,
};

type Marker = {
  [MARKER_KEY]: typeof MARKER_VERSION;
  type: "regex" | "json_schema" | "lark";
  value: unknown;
  cacheKey?: object | string;
};

interface RegexState {}

interface CompiledRegex {
  readonly initialState: RegexState;
  advance(state: RegexState, bytes: Uint8Array): RegexState;
  viable(state: RegexState): boolean;
  accepting(state: RegexState): boolean;
}

export interface GrammarCapture {
  readonly name: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

interface CompiledLark extends CompiledRegex {
  captures(state: RegexState): GrammarCapture[];
}

interface CompiledJsonSchema {
  readonly initialUtf8: JsonEngineState;
  appendUtf8(state: JsonEngineState, bytes: Uint8Array): JsonEngineState;
  viable(state: JsonEngineState): boolean;
  accepting(state: JsonEngineState): boolean;
  /** Returns a conservative semantic key for states with identical token masks. */
  maskEquivalenceKey?(state: JsonEngineState): string | undefined;
}

interface JsonEngineState {}

export type EngineCompilers = {
  compileRegex?: (source: string, limits?: GuidanceLimits) => CompiledRegex;
  compileLark?: (source: string, limits?: GuidanceLimits) => CompiledLark;
  compileJsonSchema?: (
    schema: unknown,
    limits?: GuidanceLimits,
  ) => CompiledJsonSchema;
};

export interface EngineModule {
  LLGuidanceTokenizer: typeof LLGuidanceTokenizer;
  LLGuidanceInterpreter: new (
    tokenizer: LLGuidanceTokenizer,
    config: unknown,
  ) => InterpreterHandle;
  grammarFrom: typeof grammarFrom;
  grammarFromJsonSchema: typeof grammarFromJsonSchema;
  grammarFromLark: typeof grammarFromLark;
  grammarFromRegex: typeof grammarFromRegex;
}

type Engine =
  | { kind: "regex"; compiled: CompiledRegex; state: RegexState }
  | { kind: "json"; compiled: CompiledJsonSchema; state: JsonEngineState };

type TokenTrieNode = {
  children: Map<number, TokenTrieNode> | null;
  readonly childBytes: number[];
  readonly childNodes: TokenTrieNode[];
  readonly terminalTokenIds: number[];
};

type TokenizerData = {
  readonly tokenBytes: readonly Uint8Array[];
  readonly trie: TokenTrieNode;
  readonly eos: number;
  readonly special: ReadonlySet<number>;
  readonly maxNormalTokenBytes: number;
  /** Normal tokens that can always extend an unconstrained open JSON string. */
  readonly openStringSafeMask: Uint32Array;
  readonly openStringSafeCount: number;
  /** Normal tokens that need a parser transition in an open JSON string. */
  readonly openStringExceptionalTokens: readonly number[];
};

export type StopReason = "accepted" | "dead_end";

export type MaskResult =
  { mask: Uint32Array; vocabSize: number } | { stop: true; reason: StopReason };

export interface MaskCacheInstrumentation {
  trieNodesVisited: number;
  sharedJsonMaskCacheHits: number;
  sharedJsonMaskCacheMisses: number;
  sharedJsonMaskCacheEntries: number;
  sharedJsonMaskCacheWords: number;
  sharedJsonMaskCacheEvictions: number;
}

export interface CommitResult {
  stop: boolean;
  backtrack: number;
  ffTokens: number[];
}

export interface TokenizerHandle {
  vocabSize(): number;
  eosToken(): number;
  token(id: number): Uint8Array;
  isSpecial(id: number): boolean;
  free(): void;
  dispose(): void;
}

export interface InterpreterHandle {
  computeMask(): MaskResult;
  computeMaskInto(target: Uint32Array): MaskResult;
  commitToken(token: number): CommitResult;
  clone(): InterpreterHandle;
  rollback(count: number): void;
  computeFastForward(maxTokens?: number): number[];
  getCapture(name: string): GrammarCapture | null;
  getCaptures(name?: string): GrammarCapture[];
  maskInstrumentation(): Readonly<MaskCacheInstrumentation>;
  free(): void;
  dispose(): void;
}

export interface HandleEngineModule<
  TTokenizer extends TokenizerHandle = TokenizerHandle,
  TInterpreter extends InterpreterHandle = InterpreterHandle,
> {
  LLGuidanceTokenizer: new (config?: TokenizerConfig) => TTokenizer;
  LLGuidanceInterpreter: new (
    tokenizer: TTokenizer,
    config: unknown,
  ) => TInterpreter;
}

const tokenizerData = new WeakMap<LLGuidanceTokenizer, TokenizerData>();
const singleBytes = Array.from({ length: 256 }, (_, byte) =>
  Uint8Array.of(byte),
);

export class LLGuidanceTokenizer {
  private freed = false;

  constructor(config: TokenizerConfig = {}) {
    if (config === null || typeof config !== "object") {
      throw new TypeError("tokenizer config must be an object");
    }

    if (config.tokens === undefined) {
      const tokens = Array.from({ length: 262 }, (_, id) =>
        id < 256 ? Uint8Array.of(id) : new Uint8Array(0),
      );
      const special = new Set([256, 257, 258, 259, 260, 261]);
      tokenizerData.set(this, {
        tokenBytes: tokens,
        trie: buildTokenTrie(tokens),
        eos: 261,
        special,
        maxNormalTokenBytes: 1,
        ...openStringTokenData(tokens, special),
      });
      return;
    }

    if (!Array.isArray(config.tokens) || config.tokens.length === 0) {
      throw new TypeError(
        "tokens must be a non-empty array of raw byte arrays",
      );
    }
    const tokenBytes = config.tokens.map((token, tokenId) =>
      normalizeTokenBytes(token, tokenId),
    );
    const eos = config.eosTokenId ?? config.eos_token_id;
    if (eos === undefined) {
      throw new TypeError(
        "eosTokenId is required when tokenizer tokens are provided",
      );
    }
    assertTokenId(eos, tokenBytes.length, "eos token id");

    const configuredSpecials =
      config.specialTokenIds ?? config.special_token_ids ?? [];
    if (!Array.isArray(configuredSpecials)) {
      throw new TypeError("special token ids must be an array");
    }
    const special = new Set<number>([eos]);
    for (const id of configuredSpecials) {
      assertTokenId(id, tokenBytes.length, "special token id");
      special.add(id);
    }
    const bos = config.bosTokenId ?? config.bos_token_id;
    if (bos !== undefined) {
      assertTokenId(bos, tokenBytes.length, "bos token id");
      special.add(bos);
    }
    tokenizerData.set(this, {
      tokenBytes,
      trie: buildTokenTrie(tokenBytes),
      eos,
      special,
      maxNormalTokenBytes: maxNormalTokenBytes(tokenBytes, special),
      ...openStringTokenData(tokenBytes, special),
    });
  }

  vocabSize(): number {
    this.assertLive();
    return getTokenizerData(this).tokenBytes.length;
  }

  eosToken(): number {
    this.assertLive();
    return getTokenizerData(this).eos;
  }

  free(): void {
    this.freed = true;
  }

  dispose(): void {
    this.free();
  }

  token(id: number): Uint8Array {
    this.assertLive();
    return getTokenizerData(this).tokenBytes[id].slice();
  }

  isSpecial(id: number): boolean {
    this.assertLive();
    const data = getTokenizerData(this);
    return data.special.has(id) || data.tokenBytes[id].length === 0;
  }

  private assertLive(): void {
    if (this.freed) throw new Error("LLGuidanceTokenizer has been freed");
  }
}

class CoreLLGuidanceInterpreter {
  private tokenizer: LLGuidanceTokenizer;
  private engine: Engine;
  private stopped = false;
  private freed = false;
  private maskCache: MaskResult | null = null;
  private committedTokens: number[] = [];
  private limits: NormalizedGuidanceLimits;
  private generatedTokens = 0;
  private generatedBytes = 0;
  private trieNodes: TokenTrieNode[] = [];
  private trieStates: Array<RegexState | JsonEngineState> = [];
  private pendingToken = -1;
  private pendingState: RegexState | JsonEngineState | null = null;
  private sharedJsonMasks: SharedJsonMaskCache | undefined;

  constructor(
    tokenizer: LLGuidanceTokenizer,
    config: unknown,
    programs: CompiledProgramCache,
  ) {
    if (!(tokenizer instanceof LLGuidanceTokenizer)) {
      throw new TypeError("tokenizer must be an LLGuidanceTokenizer");
    }
    this.tokenizer = tokenizer;
    const marker = markerFromInterpreterConfig(config);
    this.limits = limitsFromInterpreterConfig(config);
    if (marker.type === "lark") {
      if (programs.compilers.compileLark === undefined)
        throw new Error(LARK_UNSUPPORTED);
      if (typeof marker.value !== "string") {
        throw new TypeError("Lark grammar must be a string");
      }
      const compiled = programs.regex("lark", marker.value, this.limits);
      this.engine = { kind: "regex", compiled, state: compiled.initialState };
    } else if (marker.type === "regex") {
      if (programs.compilers.compileRegex === undefined) {
        throw featureUnavailable("regex");
      }
      if (typeof marker.value !== "string") {
        throw new TypeError("regex grammar must be a string");
      }
      const compiled = programs.regex("regex", marker.value, this.limits);
      this.engine = { kind: "regex", compiled, state: compiled.initialState };
    } else {
      if (programs.compilers.compileJsonSchema === undefined) {
        throw featureUnavailable("JSON Schema");
      }
      const compiled = programs.json(marker, this.limits);
      this.engine = { kind: "json", compiled, state: compiled.initialUtf8 };
      this.sharedJsonMasks = programs.jsonMasks(tokenizer, compiled);
    }
  }

  computeMask(): MaskResult {
    this.assertLive();
    const vocabSize = this.tokenizer.vocabSize();
    return cloneMaskResult(this.computeMaskCached(vocabSize));
  }

  computeMaskInto(target: Uint32Array): MaskResult {
    this.assertLive();
    if (!(target instanceof Uint32Array)) {
      throw new TypeError("mask target must be a Uint32Array");
    }
    const vocabSize = this.tokenizer.vocabSize();
    const words = Math.ceil(vocabSize / 32);
    if (target.length < words) {
      throw new RangeError(
        `mask target needs at least ${words} words for vocabulary size ${vocabSize}`,
      );
    }
    const result = this.computeMaskCached(vocabSize);
    target.fill(0);
    if ("mask" in result) {
      target.set(result.mask);
      return { mask: target, vocabSize };
    }
    return { stop: true, reason: result.reason };
  }

  commitToken(token: number): { stop: boolean; backtrack: 0; ffTokens: [] } {
    this.assertLive();
    const vocabSize = this.tokenizer.vocabSize();
    if (!Number.isInteger(token) || token < 0 || token >= vocabSize) {
      throw new RangeError(
        `token ${String(token)} is out of range for vocabulary size ${vocabSize}`,
      );
    }
    if (this.stopped || !this.tokenAllowed(token)) {
      throw new Error(`token ${token} doesn't satisfy the grammar`);
    }

    if (token === this.tokenizer.eosToken()) {
      this.committedTokens.push(token);
      this.stopped = true;
      this.maskCache = null;
      this.clearPendingTransition();
      return { stop: true, backtrack: 0, ffTokens: [] };
    }

    const bytes = getTokenizerData(this.tokenizer).tokenBytes[token];
    if (this.nonEosTokenCount() >= this.limits.maxTokens) {
      throw new Error(
        `generation exceeds maxTokens (${this.limits.maxTokens})`,
      );
    }
    if (this.outputByteLength() + bytes.length > this.limits.maxOutputBytes) {
      throw new Error(
        `generation exceeds maxOutputBytes (${this.limits.maxOutputBytes})`,
      );
    }
    if (this.engine.kind === "regex") {
      if (this.pendingToken !== token)
        throw new Error("missing regex transition");
      this.engine.state = this.pendingState as RegexState;
    } else {
      if (this.pendingToken !== token)
        throw new Error("missing JSON transition");
      this.engine.state = this.pendingState as JsonEngineState;
    }
    this.committedTokens.push(token);
    this.generatedTokens += 1;
    this.generatedBytes += bytes.length;
    this.maskCache = null;
    this.clearPendingTransition();
    return { stop: false, backtrack: 0, ffTokens: [] };
  }

  clone(): this {
    this.assertLive();
    const copy = Object.create(Object.getPrototypeOf(this)) as this;
    copy.tokenizer = this.tokenizer;
    copy.engine =
      this.engine.kind === "regex" ? { ...this.engine } : { ...this.engine };
    copy.stopped = this.stopped;
    copy.freed = false;
    copy.maskCache =
      this.maskCache === null ? null : cloneMaskResult(this.maskCache);
    copy.committedTokens = [...this.committedTokens];
    copy.limits = { ...this.limits };
    copy.generatedTokens = this.generatedTokens;
    copy.generatedBytes = this.generatedBytes;
    copy.trieNodes = [];
    copy.trieStates = [];
    copy.pendingToken = -1;
    copy.pendingState = null;
    copy.sharedJsonMasks = this.sharedJsonMasks;
    return copy;
  }

  rollback(count: number): void {
    this.assertLive();
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count > this.committedTokens.length
    ) {
      throw new RangeError(
        `rollback count ${String(count)} is out of range for ${this.committedTokens.length} committed tokens`,
      );
    }
    if (count === 0) return;
    this.committedTokens.length -= count;
    this.resetFromHistory();
  }

  computeFastForward(maxTokens = 32): number[] {
    this.assertLive();
    if (!Number.isInteger(maxTokens) || maxTokens < 0) {
      throw new RangeError("maxTokens must be a non-negative integer");
    }
    const branch = this.clone();
    const result: number[] = [];
    for (let index = 0; index < maxTokens; index += 1) {
      const next = branch.computeMask();
      if (!("mask" in next)) break;
      const token = singleAllowedToken(
        next.mask,
        next.vocabSize,
        this.tokenizer.eosToken(),
      );
      if (token === null) break;
      result.push(token);
      branch.commitToken(token);
    }
    branch.free();
    return result;
  }

  getCapture(name: string): GrammarCapture | null {
    if (typeof name !== "string")
      throw new TypeError("capture name must be a string");
    const captures = this.getCaptures(name);
    return captures.at(-1) ?? null;
  }

  getCaptures(name?: string): GrammarCapture[] {
    this.assertLive();
    if (name !== undefined && typeof name !== "string") {
      throw new TypeError("capture name must be a string");
    }
    if (this.engine.kind !== "regex" || !("captures" in this.engine.compiled)) {
      return [];
    }
    const captures = (this.engine.compiled as CompiledLark).captures(
      this.engine.state,
    );
    return name === undefined
      ? captures.map((capture) => ({ ...capture }))
      : captures
          .filter((capture) => capture.name === name)
          .map((capture) => ({ ...capture }));
  }

  maskInstrumentation(): Readonly<MaskCacheInstrumentation> {
    return (
      this.sharedJsonMasks?.instrumentation() ?? EMPTY_MASK_INSTRUMENTATION
    );
  }

  free(): void {
    this.maskCache = null;
    this.trieNodes.length = 0;
    this.trieStates.length = 0;
    this.clearPendingTransition();
    this.freed = true;
  }

  dispose(): void {
    this.free();
  }

  private resetFromHistory(): void {
    if (this.engine.kind === "regex") {
      this.engine.state = this.engine.compiled.initialState;
    } else {
      this.engine.state = this.engine.compiled.initialUtf8;
    }
    this.stopped = false;
    this.generatedTokens = 0;
    this.generatedBytes = 0;
    for (const token of this.committedTokens) {
      if (token === this.tokenizer.eosToken()) {
        this.stopped = true;
        continue;
      }
      const bytes = getTokenizerData(this.tokenizer).tokenBytes[token];
      this.generatedTokens += 1;
      this.generatedBytes += bytes.length;
      if (this.engine.kind === "regex") {
        this.engine.state = this.engine.compiled.advance(
          this.engine.state,
          bytes,
        );
      } else {
        this.engine.state = this.engine.compiled.appendUtf8(
          this.engine.state,
          bytes,
        );
      }
    }
    this.maskCache = null;
    this.clearPendingTransition();
  }

  private computeRegexMask(mask: Uint32Array): number {
    if (this.engine.kind !== "regex") throw new Error("invalid regex engine");
    const data = getTokenizerData(this.tokenizer);
    const { compiled, state } = this.engine;
    let eligible = 0;
    if (compiled.accepting(state)) {
      setMaskBit(mask, data.eos);
      eligible += 1;
    }

    const nodes = this.trieNodes;
    const states = this.trieStates;
    let stackLength = 1;
    nodes[0] = data.trie;
    states[0] = state;
    while (stackLength !== 0) {
      stackLength -= 1;
      const node = nodes[stackLength];
      const currentState = states[stackLength] as RegexState;
      for (const token of node.terminalTokenIds) {
        if (token === data.eos || isSpecialToken(data, token)) continue;
        if (!this.withinGenerationLimits(data.tokenBytes[token].length))
          continue;
        setMaskBit(mask, token);
        eligible += 1;
      }
      for (let index = 0; index < node.childNodes.length; index += 1) {
        const child = node.childNodes[index];
        const byte = node.childBytes[index];
        const candidate = compiled.advance(currentState, singleBytes[byte]);
        if (!compiled.viable(candidate)) continue;
        nodes[stackLength] = child;
        states[stackLength] = candidate;
        stackLength += 1;
      }
    }
    nodes.length = 0;
    states.length = 0;
    return eligible;
  }

  private computeJsonMask(mask: Uint32Array): number {
    if (this.engine.kind !== "json") throw new Error("invalid JSON engine");
    const data = getTokenizerData(this.tokenizer);
    const { compiled, state } = this.engine;
    if (this.canUseOpenStringFastPath(data, compiled, state)) {
      mask.set(data.openStringSafeMask);
      let eligible = data.openStringSafeCount;
      for (const token of data.openStringExceptionalTokens) {
        const candidate = compiled.appendUtf8(state, data.tokenBytes[token]);
        if (!compiled.viable(candidate)) continue;
        setMaskBit(mask, token);
        eligible += 1;
      }
      return eligible;
    }
    let eligible = 0;
    if (compiled.accepting(state)) {
      setMaskBit(mask, data.eos);
      eligible += 1;
    }

    const nodes = this.trieNodes;
    const states = this.trieStates;
    let stackLength = 1;
    nodes[0] = data.trie;
    states[0] = state;
    while (stackLength !== 0) {
      stackLength -= 1;
      const node = nodes[stackLength];
      this.sharedJsonMasks?.recordTrieNode();
      const currentState = states[stackLength] as JsonEngineState;
      for (const token of node.terminalTokenIds) {
        if (token === data.eos || isSpecialToken(data, token)) continue;
        if (!this.withinGenerationLimits(data.tokenBytes[token].length))
          continue;
        setMaskBit(mask, token);
        eligible += 1;
      }
      for (let index = 0; index < node.childNodes.length; index += 1) {
        const child = node.childNodes[index];
        const byte = node.childBytes[index];
        const candidate = compiled.appendUtf8(currentState, singleBytes[byte]);
        if (!compiled.viable(candidate)) continue;
        nodes[stackLength] = child;
        states[stackLength] = candidate;
        stackLength += 1;
      }
    }
    nodes.length = 0;
    states.length = 0;
    return eligible;
  }

  private canUseOpenStringFastPath(
    data: TokenizerData,
    compiled: CompiledJsonSchema,
    state: JsonEngineState,
  ): boolean {
    // The parser signal excludes property names, escapes, partial UTF-8, and
    // schemas whose string content affects future validity.
    if (
      !compiled.viable(state) ||
      compiled.maskEquivalenceKey?.(state) === undefined
    )
      return false;
    return (
      this.generatedTokens < this.limits.maxTokens &&
      this.generatedBytes + data.maxNormalTokenBytes <=
        this.limits.maxOutputBytes
    );
  }

  private tokenAllowed(token: number): boolean {
    this.clearPendingTransition();
    if (token === this.tokenizer.eosToken()) return this.accepting();
    if (this.tokenizer.isSpecial(token)) return false;

    const bytes = getTokenizerData(this.tokenizer).tokenBytes[token];
    if (this.nonEosTokenCount() >= this.limits.maxTokens) return false;
    if (this.outputByteLength() + bytes.length > this.limits.maxOutputBytes) {
      return false;
    }
    if (this.engine.kind === "regex") {
      const candidate = this.engine.compiled.advance(this.engine.state, bytes);
      if (!this.engine.compiled.viable(candidate)) return false;
      this.pendingToken = token;
      this.pendingState = candidate;
      return true;
    }
    const candidate = this.engine.compiled.appendUtf8(this.engine.state, bytes);
    if (!this.engine.compiled.viable(candidate)) return false;
    this.pendingToken = token;
    this.pendingState = candidate;
    return true;
  }

  private computeMaskCached(vocabSize: number): MaskResult {
    if (this.stopped) return { stop: true, reason: "accepted" };
    if (this.maskCache !== null) return this.maskCache;
    const sharedKey = this.jsonMaskCacheKey();
    if (sharedKey !== undefined) {
      const shared = this.sharedJsonMasks!.get(sharedKey);
      if (shared !== undefined) {
        this.maskCache = shared;
        return shared;
      }
    }
    const mask = new Uint32Array(Math.ceil(vocabSize / 32));
    const eligible =
      this.engine.kind === "regex"
        ? this.computeRegexMask(mask)
        : this.computeJsonMask(mask);
    this.maskCache =
      eligible === 0 ? { stop: true, reason: "dead_end" } : { mask, vocabSize };
    if (sharedKey !== undefined && "mask" in this.maskCache)
      this.sharedJsonMasks!.set(sharedKey, this.maskCache);
    return this.maskCache;
  }

  private jsonMaskCacheKey(): string | undefined {
    if (this.engine.kind !== "json" || this.sharedJsonMasks === undefined)
      return undefined;
    const semantic = this.engine.compiled.maskEquivalenceKey?.(
      this.engine.state,
    );
    if (semantic === undefined) return undefined;
    const data = getTokenizerData(this.tokenizer);
    // Only the immediate next-token budget affects a mask. Exact remaining
    // budgets would turn every generation step into a cache miss even while
    // every normal vocabulary token remains eligible.
    const tokenBudget =
      this.generatedTokens < this.limits.maxTokens ? "open" : "closed";
    const remainingBytes = this.limits.maxOutputBytes - this.generatedBytes;
    const byteBudget =
      remainingBytes >= data.maxNormalTokenBytes
        ? "open"
        : String(remainingBytes);
    return `${semantic}\u0000${tokenBudget}\u0000${byteBudget}`;
  }

  private clearPendingTransition(): void {
    this.pendingToken = -1;
    this.pendingState = null;
  }

  private accepting(): boolean {
    return this.engine.kind === "regex"
      ? this.engine.compiled.accepting(this.engine.state)
      : this.engine.compiled.accepting(this.engine.state);
  }

  private nonEosTokenCount(): number {
    return this.generatedTokens;
  }

  private withinGenerationLimits(additionalBytes: number): boolean {
    return (
      this.generatedTokens < this.limits.maxTokens &&
      this.generatedBytes + additionalBytes <= this.limits.maxOutputBytes
    );
  }

  private outputByteLength(): number {
    return this.generatedBytes;
  }

  private assertLive(): void {
    if (this.freed) throw new Error("LLGuidanceInterpreter has been freed");
  }
}

export function createEngine(compilers: EngineCompilers): EngineModule {
  const programs = new CompiledProgramCache(compilers);
  class LLGuidanceInterpreter extends CoreLLGuidanceInterpreter {
    constructor(tokenizer: LLGuidanceTokenizer, config: unknown) {
      super(tokenizer, config, programs);
    }
  }

  return {
    LLGuidanceTokenizer,
    LLGuidanceInterpreter,
    grammarFrom,
    grammarFromJsonSchema,
    grammarFromLark,
    grammarFromRegex,
  };
}

class BoundedCache<K, V> {
  private readonly values = new Map<K, V>();

  get(key: K): V | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.values.size >= MAX_COMPILED_PROGRAMS) {
      this.values.delete(this.values.keys().next().value!);
    }
    this.values.set(key, value);
  }
}

const EMPTY_MASK_INSTRUMENTATION: Readonly<MaskCacheInstrumentation> =
  Object.freeze({
    trieNodesVisited: 0,
    sharedJsonMaskCacheHits: 0,
    sharedJsonMaskCacheMisses: 0,
    sharedJsonMaskCacheEntries: 0,
    sharedJsonMaskCacheWords: 0,
    sharedJsonMaskCacheEvictions: 0,
  });

class SharedJsonMaskCache {
  private readonly values = new Map<
    string,
    { mask: Uint32Array; vocabSize: number }
  >();
  private words = 0;
  private readonly stats: MaskCacheInstrumentation = {
    ...EMPTY_MASK_INSTRUMENTATION,
  };

  get(key: string): { mask: Uint32Array; vocabSize: number } | undefined {
    const value = this.values.get(key);
    if (value === undefined) {
      this.stats.sharedJsonMaskCacheMisses += 1;
      return undefined;
    }
    this.values.delete(key);
    this.values.set(key, value);
    this.stats.sharedJsonMaskCacheHits += 1;
    return value;
  }

  set(key: string, value: { mask: Uint32Array; vocabSize: number }): void {
    const existing = this.values.get(key);
    if (existing !== undefined) {
      this.values.delete(key);
      this.words -= existing.mask.length;
    }
    if (value.mask.length > MAX_SHARED_JSON_MASK_WORDS) return;
    this.values.set(key, value);
    this.words += value.mask.length;
    while (
      this.values.size > MAX_SHARED_JSON_MASK_ENTRIES ||
      this.words > MAX_SHARED_JSON_MASK_WORDS
    ) {
      const oldestKey = this.values.keys().next().value!;
      const oldest = this.values.get(oldestKey)!;
      this.values.delete(oldestKey);
      this.words -= oldest.mask.length;
      this.stats.sharedJsonMaskCacheEvictions += 1;
    }
    this.stats.sharedJsonMaskCacheEntries = this.values.size;
    this.stats.sharedJsonMaskCacheWords = this.words;
  }

  recordTrieNode(): void {
    this.stats.trieNodesVisited += 1;
  }

  instrumentation(): Readonly<MaskCacheInstrumentation> {
    return { ...this.stats };
  }
}

class CompiledProgramCache {
  readonly compilers: EngineCompilers;
  private readonly regexPrograms = new BoundedCache<string, CompiledRegex>();
  private readonly jsonPrograms = new BoundedCache<
    string,
    CompiledJsonSchema
  >();
  private readonly schemaIds = new WeakMap<object, number>();
  private readonly jsonMaskCaches = new WeakMap<
    LLGuidanceTokenizer,
    WeakMap<CompiledJsonSchema, SharedJsonMaskCache>
  >();
  private nextSchemaId = 0;

  constructor(compilers: EngineCompilers) {
    this.compilers = compilers;
  }

  regex(
    kind: "regex" | "lark",
    source: string,
    limits: NormalizedGuidanceLimits,
  ): CompiledRegex | CompiledLark {
    const key = `${kind}\u0000${limits.maxRegexStates}\u0000${limits.maxRegexRepeat}\u0000${source}`;
    const cached = this.regexPrograms.get(key);
    if (cached !== undefined) return cached;
    const compiled =
      kind === "regex"
        ? this.compilers.compileRegex!(source, limits)
        : this.compilers.compileLark!(source, limits);
    this.regexPrograms.set(key, compiled);
    return compiled;
  }

  json(marker: Marker, limits: NormalizedGuidanceLimits): CompiledJsonSchema {
    const schemaKey = marker.cacheKey ?? serializedSchemaKey(marker.value);
    const identity =
      typeof schemaKey === "string"
        ? `serialized:${schemaKey}`
        : `object:${this.schemaIdentity(schemaKey)}`;
    const key = `${identity}\u0000${limits.maxSchemaDepth}\u0000${limits.maxJsonDepth}`;
    const cached = this.jsonPrograms.get(key);
    if (cached !== undefined) return cached;
    const schema =
      typeof schemaKey === "string"
        ? marker.value
        : snapshotSchema(marker.value);
    const compiled = this.compilers.compileJsonSchema!(schema, limits);
    this.jsonPrograms.set(key, compiled);
    return compiled;
  }

  jsonMasks(
    tokenizer: LLGuidanceTokenizer,
    compiled: CompiledJsonSchema,
  ): SharedJsonMaskCache {
    let byProgram = this.jsonMaskCaches.get(tokenizer);
    if (byProgram === undefined) {
      byProgram = new WeakMap();
      this.jsonMaskCaches.set(tokenizer, byProgram);
    }
    let cache = byProgram.get(compiled);
    if (cache === undefined) {
      cache = new SharedJsonMaskCache();
      byProgram.set(compiled, cache);
    }
    return cache;
  }

  private schemaIdentity(schema: object): number {
    let id = this.schemaIds.get(schema);
    if (id === undefined) {
      id = this.nextSchemaId;
      this.nextSchemaId += 1;
      this.schemaIds.set(schema, id);
    }
    return id;
  }
}

export function grammarFrom(format: string, text: string): string {
  if (typeof format !== "string")
    throw new TypeError("grammar format must be a string");
  if (typeof text !== "string")
    throw new TypeError("grammar text must be a string");
  switch (format) {
    case "regex":
      return serializeMarker("regex", text);
    case "json":
    case "json_schema":
      return serializeMarker("json_schema", parseJson(text, "JSON schema"));
    case "json_object":
      return serializeMarker("json_schema", { type: "object" });
    case "choice": {
      const choices = parseJson(text, "choice list");
      if (
        !Array.isArray(choices) ||
        choices.some((choice) => typeof choice !== "string")
      ) {
        throw new TypeError("choice list must be a JSON array of strings");
      }
      const alternatives = choices.map(regexByteLiteral).join("|");
      return serializeMarker("regex", `(?:${alternatives})`);
    }
    case "lark":
      return grammarFromLark(text);
    case "llguidance":
    case "guidance":
      parseMarker(text, UPSTREAM_UNSUPPORTED);
      return text;
    default:
      throw new Error(`unknown grammar format: ${format}`);
  }
}

export function grammarFromJsonSchema(schema: unknown): string {
  return serializeMarker("json_schema", schema);
}

export function grammarFromLark(lark: string): string {
  if (typeof lark !== "string")
    throw new TypeError("Lark grammar must be a string");
  return serializeMarker("lark", lark);
}

export function grammarFromRegex(regex: string): string {
  if (typeof regex !== "string") throw new TypeError("regex must be a string");
  return serializeMarker("regex", regex);
}

function markerFromInterpreterConfig(config: unknown): Marker {
  if (config === null || typeof config !== "object") {
    throw new TypeError("interpreter config must be an object");
  }
  const value = config as Record<string, unknown>;
  if (value.grammar !== undefined) {
    if (typeof value.grammar !== "string") {
      throw new TypeError("interpreter grammar must be a string");
    }
    const format = value.grammarFormat ?? value.grammar_format;
    if (format !== undefined) {
      if (typeof format !== "string")
        throw new TypeError("grammar format must be a string");
      return parseMarker(grammarFrom(format, value.grammar));
    }
    return parseMarker(value.grammar);
  }

  const response = value.response_format ?? value.responseFormat;
  if (response !== undefined) return markerFromResponseFormat(response);
  throw new Error("interpreter config requires grammar or response_format");
}

function limitsFromInterpreterConfig(
  config: unknown,
): NormalizedGuidanceLimits {
  const value = config as Record<string, unknown>;
  const configured = value.limits ?? {};
  if (configured === null || typeof configured !== "object") {
    throw new TypeError("limits must be an object");
  }
  const source = configured as Record<string, unknown>;
  const result = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<
    keyof GuidanceLimits
  >) {
    const raw = source[key];
    if (raw === undefined) continue;
    if (!Number.isSafeInteger(raw) || (raw as number) < 1) {
      throw new RangeError(`limits.${key} must be a positive safe integer`);
    }
    result[key] = raw as number;
  }
  return result;
}

function markerFromResponseFormat(response: unknown): Marker {
  if (response === null || typeof response !== "object") {
    throw new TypeError("response_format must be an object");
  }
  const value = response as Record<string, unknown>;
  switch (value.type) {
    case "regex":
      if (typeof value.regex !== "string")
        throw new TypeError("response_format.regex must be a string");
      return makeMarker("regex", value.regex);
    case "json_schema":
      if (!("json_schema" in value))
        throw new TypeError("response_format.json_schema is required");
      return {
        ...makeMarker("json_schema", value.json_schema),
        cacheKey: schemaIdentityKey(value.json_schema),
      };
    case "json_object":
      return {
        ...makeMarker("json_schema", { type: "object" }),
        cacheKey: '"json_object"',
      };
    default:
      throw new Error(
        `unsupported response_format type: ${String(value.type)}`,
      );
  }
}

function serializeMarker(type: Marker["type"], value: unknown): string {
  const serialized = JSON.stringify(makeMarker(type, value));
  if (serialized === undefined)
    throw new TypeError("grammar value is not JSON serializable");
  return serialized;
}

function makeMarker(type: Marker["type"], value: unknown): Marker {
  return { [MARKER_KEY]: MARKER_VERSION, type, value } as Marker;
}

function parseMarker(
  serialized: string,
  invalidMessage = LARK_UNSUPPORTED,
): Marker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(invalidMessage);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as Record<string, unknown>)[MARKER_KEY] !== MARKER_VERSION ||
    !["regex", "json_schema", "lark"].includes(
      String((parsed as Record<string, unknown>).type),
    ) ||
    !("value" in parsed)
  ) {
    throw new Error(UPSTREAM_UNSUPPORTED);
  }
  const marker = parsed as Marker;
  if (marker.type === "json_schema") {
    marker.cacheKey = serializedSchemaKey(marker.value);
  }
  return marker;
}

function schemaIdentityKey(schema: unknown): object | string {
  return schema !== null && typeof schema === "object"
    ? schema
    : serializedSchemaKey(schema);
}

function serializedSchemaKey(schema: unknown): string {
  const serialized = JSON.stringify(schema);
  if (serialized === undefined) {
    throw new TypeError("JSON schema is not serializable");
  }
  return serialized;
}

function snapshotSchema(schema: unknown): unknown {
  return JSON.parse(serializedSchemaKey(schema)) as unknown;
}

function normalizeTokenBytes(
  token: Uint8Array | readonly number[],
  tokenId: number,
): Uint8Array {
  if (!(token instanceof Uint8Array) && !Array.isArray(token)) {
    throw new TypeError(`token ${tokenId} must be a raw byte array`);
  }
  const values = Array.from(token);
  if (
    values.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new RangeError(`token ${tokenId} contains a byte out of range`);
  }
  return Uint8Array.from(values);
}

function buildTokenTrie(tokens: readonly Uint8Array[]): TokenTrieNode {
  const makeNode = (): TokenTrieNode => ({
    children: new Map(),
    childBytes: [],
    childNodes: [],
    terminalTokenIds: [],
  });
  const root = makeNode();
  tokens.forEach((bytes, tokenId) => {
    let node = root;
    for (const byte of bytes) {
      let child = node.children!.get(byte);
      if (child === undefined) {
        child = makeNode();
        node.children!.set(byte, child);
      }
      node = child;
    }
    node.terminalTokenIds.push(tokenId);
  });
  const pending = [root];
  while (pending.length !== 0) {
    const node = pending.pop()!;
    for (const [byte, child] of node.children!) {
      node.childBytes.push(byte);
      node.childNodes.push(child);
      pending.push(child);
    }
    node.children = null;
  }
  return root;
}

function maxNormalTokenBytes(
  tokens: readonly Uint8Array[],
  special: ReadonlySet<number>,
): number {
  let maximum = 0;
  for (let token = 0; token < tokens.length; token += 1) {
    if (!special.has(token) && tokens[token].length !== 0)
      maximum = Math.max(maximum, tokens[token].length);
  }
  return maximum;
}

function openStringTokenData(
  tokens: readonly Uint8Array[],
  special: ReadonlySet<number>,
): Pick<
  TokenizerData,
  "openStringSafeMask" | "openStringSafeCount" | "openStringExceptionalTokens"
> {
  const openStringSafeMask = new Uint32Array(Math.ceil(tokens.length / 32));
  const openStringExceptionalTokens: number[] = [];
  let openStringSafeCount = 0;
  for (let token = 0; token < tokens.length; token += 1) {
    const bytes = tokens[token];
    if (special.has(token) || bytes.length === 0) continue;
    if (isSafeOpenJsonStringToken(bytes)) {
      setMaskBit(openStringSafeMask, token);
      openStringSafeCount += 1;
    } else {
      openStringExceptionalTokens.push(token);
    }
  }
  return {
    openStringSafeMask,
    openStringSafeCount,
    openStringExceptionalTokens,
  };
}

function isSafeOpenJsonStringToken(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte < 0x20 || byte === 0x22 || byte === 0x5c) return false;
    if (byte <= 0x7f) continue;
    const length =
      byte >= 0xc2 && byte <= 0xdf
        ? 2
        : byte <= 0xef
          ? 3
          : byte <= 0xf4
            ? 4
            : 0;
    if (length === 0 || index + length > bytes.length) return false;
    const next = bytes[index + 1];
    if (
      next < 0x80 ||
      next > 0xbf ||
      (byte === 0xe0 && next < 0xa0) ||
      (byte === 0xed && next > 0x9f) ||
      (byte === 0xf0 && next < 0x90) ||
      (byte === 0xf4 && next > 0x8f)
    )
      return false;
    for (let offset = 2; offset < length; offset += 1) {
      const continuation = bytes[index + offset];
      if (continuation < 0x80 || continuation > 0xbf) return false;
    }
    index += length - 1;
  }
  return true;
}

function getTokenizerData(tokenizer: LLGuidanceTokenizer): TokenizerData {
  const data = tokenizerData.get(tokenizer);
  if (data === undefined) throw new Error("invalid tokenizer state");
  return data;
}

function isSpecialToken(data: TokenizerData, token: number): boolean {
  return data.special.has(token) || data.tokenBytes[token].length === 0;
}

function setMaskBit(mask: Uint32Array, token: number): void {
  mask[token >>> 5] |= 1 << (token & 31);
}

function cloneMaskResult(result: MaskResult): MaskResult {
  return "mask" in result
    ? { mask: result.mask.slice(), vocabSize: result.vocabSize }
    : { stop: true, reason: result.reason };
}

function singleAllowedToken(
  mask: Uint32Array,
  vocabSize: number,
  eosToken: number,
): number | null {
  let found: number | null = null;
  for (let token = 0; token < vocabSize; token += 1) {
    if ((mask[token >>> 5] & (1 << (token & 31))) === 0) continue;
    if (token === eosToken || found !== null) return null;
    found = token;
  }
  return found;
}

function assertTokenId(id: number, vocabSize: number, name: string): void {
  if (!Number.isInteger(id) || id < 0 || id >= vocabSize) {
    throw new RangeError(
      `${name} is out of range for vocabulary size ${vocabSize}`,
    );
  }
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function parseJson(text: string, name: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SyntaxError(
      `invalid ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function regexByteLiteral(value: string): string {
  return Array.from(
    new TextEncoder().encode(value),
    (byte) => `\\x${byte.toString(16).padStart(2, "0")}`,
  ).join("");
}

function featureUnavailable(feature: string): Error {
  return new Error(
    `${feature} support is unavailable in this specialized llguidance bundle`,
  );
}
