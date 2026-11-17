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

export interface JsonMaskCompiler<State = JsonEngineState> {
  readonly initialUtf8: State;
  appendUtf8(state: State, bytes: Uint8Array): State;
  viable(state: State): boolean;
  accepting(state: State): boolean;
  /** Returns a conservative semantic key for states with identical token masks. */
  maskEquivalenceKey?(state: State): string | undefined;
}

interface JsonEngineState {}

export type EngineCompilers = {
  compileRegex?: (source: string, limits?: GuidanceLimits) => CompiledRegex;
  compileLark?: (source: string, limits?: GuidanceLimits) => CompiledLark;
  compileJsonSchema?: (
    schema: unknown,
    limits?: GuidanceLimits,
  ) => JsonMaskCompiler;
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
  | { kind: "json"; compiled: JsonMaskCompiler; state: JsonEngineState };

/**
 * Byte trie of token byte sequences in flat typed arrays, numbered
 * breadth-first: node 0 is the root and the children of node `n` are nodes
 * `childStart[n]` to `childStart[n + 1] - 1`, in first-appearance order.
 * `nodeByte[n]` is the byte on the edge into node `n`, and the tokens ending at
 * node `n` are `terminalTokenIds[terminalStart[n]]` to
 * `terminalTokenIds[terminalStart[n + 1] - 1]`, in ascending token order.
 */
type TokenTrie = {
  readonly childStart: Uint32Array;
  readonly nodeByte: Uint8Array;
  readonly terminalStart: Uint32Array;
  readonly terminalTokenIds: Uint32Array;
};

/** Every token's bytes in one buffer: token `id` is `bytes[offsets[id]]` to `bytes[offsets[id + 1] - 1]`. */
type TokenBytes = {
  readonly bytes: Uint8Array;
  readonly offsets: Uint32Array;
};

type TokenizerData = {
  readonly tokens: TokenBytes;
  readonly vocabSize: number;
  readonly trie: TokenTrie;
  readonly eos: number;
  readonly special: ReadonlySet<number>;
  readonly maxNormalTokenBytes: number;
  /** Normal tokens that can always extend an unconstrained open JSON string. */
  readonly openStringSafeMask: Uint32Array;
  readonly openStringSafeCount: number;
  /** Prefix-sharing trie for normal tokens that need a parser transition in an open JSON string. */
  readonly openStringExceptionalTrie: TokenTrie;
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
  validateCandidates(
    tokenIds: Uint32Array,
    target?: Uint8Array,
  ): Uint8Array;
  commitToken(token: number): CommitResult;
  clone(): InterpreterHandle;
  rollback(count: number): void;
  computeFastForward(maxTokens?: number): number[];
  getCapture(name: string): GrammarCapture | null;
  getCaptures(name?: string): GrammarCapture[];
  maskInstrumentation?(): Readonly<MaskCacheInstrumentation>;
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
      const tokens = flattenTokens(
        Array.from({ length: 262 }, (_, id) =>
          id < 256 ? Uint8Array.of(id) : new Uint8Array(0),
        ),
      );
      const special = new Set([256, 257, 258, 259, 260, 261]);
      tokenizerData.set(this, {
        tokens,
        vocabSize: 262,
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
    const tokens = flattenTokens(config.tokens);
    const vocabSize = config.tokens.length;
    const eos = config.eosTokenId ?? config.eos_token_id;
    if (eos === undefined) {
      throw new TypeError(
        "eosTokenId is required when tokenizer tokens are provided",
      );
    }
    assertTokenId(eos, vocabSize, "eos token id");

    const configuredSpecials =
      config.specialTokenIds ?? config.special_token_ids ?? [];
    if (!Array.isArray(configuredSpecials)) {
      throw new TypeError("special token ids must be an array");
    }
    const special = new Set<number>([eos]);
    for (const id of configuredSpecials) {
      assertTokenId(id, vocabSize, "special token id");
      special.add(id);
    }
    const bos = config.bosTokenId ?? config.bos_token_id;
    if (bos !== undefined) {
      assertTokenId(bos, vocabSize, "bos token id");
      special.add(bos);
    }
    tokenizerData.set(this, {
      tokens,
      vocabSize,
      trie: buildTokenTrie(tokens),
      eos,
      special,
      maxNormalTokenBytes: maxNormalTokenBytes(tokens, special),
      ...openStringTokenData(tokens, special),
    });
  }

  vocabSize(): number {
    this.assertLive();
    return getTokenizerData(this).vocabSize;
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
    const { tokens, vocabSize } = getTokenizerData(this);
    assertTokenId(id, vocabSize, "token id");
    return tokens.bytes.slice(tokens.offsets[id], tokens.offsets[id + 1]);
  }

  isSpecial(id: number): boolean {
    this.assertLive();
    const data = getTokenizerData(this);
    assertTokenId(id, data.vocabSize, "token id");
    return isSpecialToken(data, id);
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
  private trieNodes: number[] = [];
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

  validateCandidates(
    tokenIds: Uint32Array,
    target = new Uint8Array(tokenIds.length),
  ): Uint8Array {
    this.assertLive();
    if (!(tokenIds instanceof Uint32Array)) {
      throw new TypeError("candidate token IDs must be a Uint32Array");
    }
    if (!(target instanceof Uint8Array)) {
      throw new TypeError("candidate target must be a Uint8Array");
    }
    if (target.length < tokenIds.length) {
      throw new RangeError(
        `candidate target needs at least ${tokenIds.length} bytes`,
      );
    }
    target.fill(0, 0, tokenIds.length);
    if (this.stopped) return target;

    const vocabSize = this.tokenizer.vocabSize();
    if (this.maskCache !== null) {
      if (!("mask" in this.maskCache)) return target;
      for (let index = 0; index < tokenIds.length; index += 1) {
        const token = tokenIds[index];
        if (token < vocabSize) {
          target[index] =
            (this.maskCache.mask[token >>> 5] >>> (token & 31)) & 1;
        }
      }
      return target;
    }

    for (let index = 0; index < tokenIds.length; index += 1) {
      const token = tokenIds[index];
      if (token < vocabSize && this.candidateAllowed(token)) target[index] = 1;
    }
    return target;
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

    const bytes = tokenView(getTokenizerData(this.tokenizer).tokens, token);
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
    if (maxTokens === 0) return [];
    const first = this.computeMaskCached(this.tokenizer.vocabSize());
    if (!("mask" in first)) return [];
    const firstToken = singleAllowedToken(
      first.mask,
      first.vocabSize,
      this.tokenizer.eosToken(),
    );
    if (firstToken === null) return [];

    const branch = this.clone();
    const result: number[] = [];
    try {
      result.push(firstToken);
      branch.commitToken(firstToken);
      for (let index = 1; index < maxTokens; index += 1) {
        const next = branch.computeMaskCached(this.tokenizer.vocabSize());
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
    } finally {
      branch.free();
    }
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
      const bytes = tokenView(getTokenizerData(this.tokenizer).tokens, token);
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

    const { childStart, nodeByte, terminalStart, terminalTokenIds } = data.trie;
    const offsets = data.tokens.offsets;
    const nodes = this.trieNodes;
    const states = this.trieStates;
    let stackLength = 1;
    nodes[0] = 0;
    states[0] = state;
    while (stackLength !== 0) {
      stackLength -= 1;
      const node = nodes[stackLength];
      const currentState = states[stackLength] as RegexState;
      for (
        let index = terminalStart[node], end = terminalStart[node + 1];
        index < end;
        index += 1
      ) {
        const token = terminalTokenIds[index];
        if (token === data.eos || isSpecialToken(data, token)) continue;
        if (!this.withinGenerationLimits(offsets[token + 1] - offsets[token]))
          continue;
        setMaskBit(mask, token);
        eligible += 1;
      }
      for (
        let child = childStart[node], end = childStart[node + 1];
        child < end;
        child += 1
      ) {
        const candidate = compiled.advance(
          currentState,
          singleBytes[nodeByte[child]],
        );
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

  private computeJsonMask(
    mask: Uint32Array,
    semantic: string | undefined,
  ): number {
    if (this.engine.kind !== "json") throw new Error("invalid JSON engine");
    const data = getTokenizerData(this.tokenizer);
    const { compiled, state } = this.engine;
    if (this.canUseOpenStringFastPath(data, compiled, state, semantic))
      return this.computeOpenStringMask(mask, data, compiled, state);
    let eligible = 0;
    if (compiled.accepting(state)) {
      setMaskBit(mask, data.eos);
      eligible += 1;
    }

    const { childStart, nodeByte, terminalStart, terminalTokenIds } = data.trie;
    const offsets = data.tokens.offsets;
    const nodes = this.trieNodes;
    const states = this.trieStates;
    let stackLength = 1;
    nodes[0] = 0;
    states[0] = state;
    while (stackLength !== 0) {
      stackLength -= 1;
      const node = nodes[stackLength];
      this.sharedJsonMasks?.recordTrieNode();
      const currentState = states[stackLength] as JsonEngineState;
      for (
        let index = terminalStart[node], end = terminalStart[node + 1];
        index < end;
        index += 1
      ) {
        const token = terminalTokenIds[index];
        if (token === data.eos || isSpecialToken(data, token)) continue;
        if (!this.withinGenerationLimits(offsets[token + 1] - offsets[token]))
          continue;
        setMaskBit(mask, token);
        eligible += 1;
      }
      for (
        let child = childStart[node], end = childStart[node + 1];
        child < end;
        child += 1
      ) {
        const candidate = compiled.appendUtf8(
          currentState,
          singleBytes[nodeByte[child]],
        );
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

  /** An open JSON string: every safe token, plus the exceptional tokens the parser takes. */
  private computeOpenStringMask(
    mask: Uint32Array,
    data: TokenizerData,
    compiled: JsonMaskCompiler,
    state: JsonEngineState,
  ): number {
    mask.set(data.openStringSafeMask);
    let eligible = data.openStringSafeCount;
    const { childStart, nodeByte, terminalStart, terminalTokenIds } =
      data.openStringExceptionalTrie;
    const nodes = this.trieNodes;
    const states = this.trieStates;
    let stackLength = 1;
    nodes[0] = 0;
    states[0] = state;
    while (stackLength !== 0) {
      stackLength -= 1;
      const node = nodes[stackLength];
      const currentState = states[stackLength] as JsonEngineState;
      for (
        let index = terminalStart[node], end = terminalStart[node + 1];
        index < end;
        index += 1
      ) {
        setMaskBit(mask, terminalTokenIds[index]);
        eligible += 1;
      }
      for (
        let child = childStart[node], end = childStart[node + 1];
        child < end;
        child += 1
      ) {
        const candidate = compiled.appendUtf8(
          currentState,
          singleBytes[nodeByte[child]],
        );
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
    compiled: JsonMaskCompiler,
    state: JsonEngineState,
    semantic: string | undefined,
  ): boolean {
    // The parser signal excludes property names, escapes, partial UTF-8, and
    // schemas whose string content affects future validity.
    if (!compiled.viable(state) || semantic === undefined) return false;
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

    const bytes = tokenView(getTokenizerData(this.tokenizer).tokens, token);
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

  private candidateAllowed(token: number): boolean {
    if (token === this.tokenizer.eosToken()) return this.accepting();
    if (this.tokenizer.isSpecial(token)) return false;
    const bytes = tokenView(getTokenizerData(this.tokenizer).tokens, token);
    if (!this.withinGenerationLimits(bytes.length)) return false;
    if (this.engine.kind === "regex") {
      return this.engine.compiled.viable(
        this.engine.compiled.advance(this.engine.state, bytes),
      );
    }
    return this.engine.compiled.viable(
      this.engine.compiled.appendUtf8(this.engine.state, bytes),
    );
  }

  private computeMaskCached(vocabSize: number): MaskResult {
    if (this.stopped) return { stop: true, reason: "accepted" };
    if (this.maskCache !== null) return this.maskCache;
    const semantic = this.jsonMaskSemanticKey();
    const sharedKey =
      semantic === undefined ? undefined : this.jsonMaskCacheKey(semantic);
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
        : this.computeJsonMask(mask, semantic);
    this.maskCache =
      eligible === 0 ? { stop: true, reason: "dead_end" } : { mask, vocabSize };
    if (sharedKey !== undefined && "mask" in this.maskCache)
      this.sharedJsonMasks!.set(sharedKey, this.maskCache);
    return this.maskCache;
  }

  private jsonMaskSemanticKey(): string | undefined {
    if (this.engine.kind !== "json" || this.sharedJsonMasks === undefined)
      return undefined;
    return this.engine.compiled.maskEquivalenceKey?.(this.engine.state);
  }

  private jsonMaskCacheKey(semantic: string): string {
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
    return JSON.stringify([semantic, tokenBudget, byteBudget]);
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
    if (value.mask.length > MAX_SHARED_JSON_MASK_WORDS) return;
    const existing = this.values.get(key);
    if (existing !== undefined) {
      this.values.delete(key);
      this.words -= existing.mask.length;
    }
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
  private readonly jsonPrograms = new BoundedCache<string, JsonMaskCompiler>();
  private readonly schemaIds = new WeakMap<object, number>();
  private readonly jsonMaskCaches = new WeakMap<
    LLGuidanceTokenizer,
    WeakMap<JsonMaskCompiler, SharedJsonMaskCache>
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

  json(marker: Marker, limits: NormalizedGuidanceLimits): JsonMaskCompiler {
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
    compiled: JsonMaskCompiler,
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

function flattenTokens(
  tokens: ReadonlyArray<Uint8Array | readonly number[]>,
): TokenBytes {
  let total = 0;
  for (let tokenId = 0; tokenId < tokens.length; tokenId += 1) {
    const token = tokens[tokenId];
    if (token instanceof Uint8Array) {
      total += token.length;
      continue;
    }
    if (!Array.isArray(token)) {
      throw new TypeError(`token ${tokenId} must be a raw byte array`);
    }
    for (let index = 0; index < token.length; index += 1) {
      const byte = token[index];
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new RangeError(`token ${tokenId} contains a byte out of range`);
      }
    }
    total += token.length;
  }
  const bytes = new Uint8Array(total);
  const offsets = new Uint32Array(tokens.length + 1);
  let at = 0;
  for (let tokenId = 0; tokenId < tokens.length; tokenId += 1) {
    const token = tokens[tokenId];
    offsets[tokenId] = at;
    bytes.set(token, at);
    at += token.length;
  }
  offsets[tokens.length] = at;
  return { bytes, offsets };
}

function tokenView(tokens: TokenBytes, token: number): Uint8Array {
  return tokens.bytes.subarray(
    tokens.offsets[token],
    tokens.offsets[token + 1],
  );
}

/** Children a trie node collects before lookups use a 256-entry table while building. */
const TRIE_BUILD_TABLE_AT = 16;

function buildTokenTrie(
  tokens: TokenBytes,
  tokenIds?: ArrayLike<number>,
): TokenTrie {
  const { bytes, offsets } = tokens;
  const count = tokenIds === undefined ? offsets.length - 1 : tokenIds.length;
  const idAt = (index: number) =>
    tokenIds === undefined ? index : tokenIds[index];
  let maxNodes = 1;
  for (let index = 0; index < count; index += 1) {
    const tokenId = idAt(index);
    maxNodes += offsets[tokenId + 1] - offsets[tokenId];
  }

  // Build with sibling lists in creation order (node 0 is the root, so 0 also
  // means "none"); nodes with many children also get a byte-indexed table.
  const byteOf = new Uint8Array(maxNodes);
  const firstChild = new Uint32Array(maxNodes);
  const lastChild = new Uint32Array(maxNodes);
  const nextSibling = new Uint32Array(maxNodes);
  const childCount = new Uint16Array(maxNodes);
  const tableOf = new Uint32Array(maxNodes);
  const tables: Uint32Array[] = [];
  const terminalNode = new Uint32Array(count);
  let nodeCount = 1;
  for (let index = 0; index < count; index += 1) {
    const tokenId = idAt(index);
    let node = 0;
    for (let at = offsets[tokenId]; at < offsets[tokenId + 1]; at += 1) {
      const byte = bytes[at];
      const table = tableOf[node];
      let child: number;
      if (table !== 0) {
        child = tables[table - 1][byte];
      } else {
        child = firstChild[node];
        while (child !== 0 && byteOf[child] !== byte)
          child = nextSibling[child];
      }
      if (child === 0) {
        child = nodeCount;
        nodeCount += 1;
        byteOf[child] = byte;
        if (firstChild[node] === 0) firstChild[node] = child;
        else nextSibling[lastChild[node]] = child;
        lastChild[node] = child;
        childCount[node] += 1;
        if (table !== 0) {
          tables[table - 1][byte] = child;
        } else if (childCount[node] === TRIE_BUILD_TABLE_AT) {
          const created = new Uint32Array(256);
          for (
            let item = firstChild[node];
            item !== 0;
            item = nextSibling[item]
          )
            created[byteOf[item]] = item;
          tables.push(created);
          tableOf[node] = tables.length;
        }
      }
      node = child;
    }
    terminalNode[index] = node;
  }

  // Renumber breadth-first so that each node's children are consecutive.
  const order = new Uint32Array(nodeCount);
  const renumbered = new Uint32Array(nodeCount);
  const childStart = new Uint32Array(nodeCount + 1);
  const nodeByte = new Uint8Array(nodeCount);
  let tail = 1;
  for (let head = 0; head < nodeCount; head += 1) {
    const node = order[head];
    renumbered[node] = head;
    nodeByte[head] = byteOf[node];
    childStart[head] = tail;
    for (
      let child = firstChild[node];
      child !== 0;
      child = nextSibling[child]
    ) {
      order[tail] = child;
      tail += 1;
    }
  }
  childStart[nodeCount] = tail;

  const terminalStart = new Uint32Array(nodeCount + 1);
  for (let index = 0; index < count; index += 1)
    terminalStart[renumbered[terminalNode[index]] + 1] += 1;
  for (let node = 0; node < nodeCount; node += 1)
    terminalStart[node + 1] += terminalStart[node];
  const terminalTokenIds = new Uint32Array(count);
  const cursor = order;
  cursor.set(terminalStart.subarray(0, nodeCount));
  for (let index = 0; index < count; index += 1) {
    const node = renumbered[terminalNode[index]];
    terminalTokenIds[cursor[node]] = idAt(index);
    cursor[node] += 1;
  }
  return { childStart, nodeByte, terminalStart, terminalTokenIds };
}

function maxNormalTokenBytes(
  tokens: TokenBytes,
  special: ReadonlySet<number>,
): number {
  const { offsets } = tokens;
  let maximum = 0;
  for (let token = 0; token < offsets.length - 1; token += 1) {
    const length = offsets[token + 1] - offsets[token];
    if (!special.has(token) && length !== 0)
      maximum = Math.max(maximum, length);
  }
  return maximum;
}

function openStringTokenData(
  tokens: TokenBytes,
  special: ReadonlySet<number>,
): Pick<
  TokenizerData,
  "openStringSafeMask" | "openStringSafeCount" | "openStringExceptionalTrie"
> {
  const vocabSize = tokens.offsets.length - 1;
  const openStringSafeMask = new Uint32Array(Math.ceil(vocabSize / 32));
  const openStringExceptionalTokens: number[] = [];
  let openStringSafeCount = 0;
  for (let token = 0; token < vocabSize; token += 1) {
    const bytes = tokenView(tokens, token);
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
    openStringExceptionalTrie: buildTokenTrie(
      tokens,
      openStringExceptionalTokens,
    ),
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
  const offsets = data.tokens.offsets;
  return data.special.has(token) || offsets[token + 1] === offsets[token];
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
