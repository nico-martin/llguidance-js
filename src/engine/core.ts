const MARKER_KEY = "$llguidance_ts_core";
const MARKER_VERSION = 1;
const LARK_UNSUPPORTED =
  "Lark grammars are not supported by the pure TypeScript core backend yet";
const UPSTREAM_UNSUPPORTED =
  "Raw llguidance/guidance serialized grammars are not supported by the pure TypeScript core backend; use a marker produced by this backend";

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
  readonly children: Map<number, TokenTrieNode>;
  readonly terminalTokenIds: number[];
};

type TokenizerData = {
  readonly tokenBytes: readonly Uint8Array[];
  readonly trie: TokenTrieNode;
  readonly eos: number;
  readonly special: ReadonlySet<number>;
};

export type StopReason = "accepted" | "dead_end";

export type MaskResult =
  { mask: Uint32Array; vocabSize: number } | { stop: true; reason: StopReason };

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
  commitToken(token: number): CommitResult;
  clone(): InterpreterHandle;
  rollback(count: number): void;
  computeFastForward(maxTokens?: number): number[];
  getCapture(name: string): GrammarCapture | null;
  getCaptures(name?: string): GrammarCapture[];
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
      tokenizerData.set(this, {
        tokenBytes: tokens,
        trie: buildTokenTrie(tokens),
        eos: 261,
        special: new Set([256, 257, 258, 259, 260, 261]),
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
  private jsonCandidates = new Map<number, JsonEngineState>();

  constructor(
    tokenizer: LLGuidanceTokenizer,
    config: unknown,
    compilers: EngineCompilers,
  ) {
    if (!(tokenizer instanceof LLGuidanceTokenizer)) {
      throw new TypeError("tokenizer must be an LLGuidanceTokenizer");
    }
    this.tokenizer = tokenizer;
    const marker = markerFromInterpreterConfig(config);
    this.limits = limitsFromInterpreterConfig(config);
    if (marker.type === "lark") {
      if (compilers.compileLark === undefined)
        throw new Error(LARK_UNSUPPORTED);
      if (typeof marker.value !== "string") {
        throw new TypeError("Lark grammar must be a string");
      }
      const compiled = compilers.compileLark(marker.value, this.limits);
      this.engine = { kind: "regex", compiled, state: compiled.initialState };
    } else if (marker.type === "regex") {
      if (compilers.compileRegex === undefined) {
        throw featureUnavailable("regex");
      }
      if (typeof marker.value !== "string") {
        throw new TypeError("regex grammar must be a string");
      }
      const compiled = compilers.compileRegex(marker.value, this.limits);
      this.engine = { kind: "regex", compiled, state: compiled.initialState };
    } else {
      if (compilers.compileJsonSchema === undefined) {
        throw featureUnavailable("JSON Schema");
      }
      const compiled = compilers.compileJsonSchema(marker.value, this.limits);
      this.engine = { kind: "json", compiled, state: compiled.initialUtf8 };
    }
  }

  computeMask(): MaskResult {
    this.assertLive();
    if (this.stopped) return { stop: true, reason: "accepted" };
    const vocabSize = this.tokenizer.vocabSize();
    if (this.maskCache !== null) return cloneMaskResult(this.maskCache);

    this.jsonCandidates.clear();
    const mask = new Uint32Array(Math.ceil(vocabSize / 32));
    const eligible =
      this.engine.kind === "regex"
        ? this.computeRegexMask(mask)
        : this.computeJsonMask(mask);
    this.maskCache =
      eligible === 0 ? { stop: true, reason: "dead_end" } : { mask, vocabSize };
    return cloneMaskResult(this.maskCache);
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
      this.engine.state = this.engine.compiled.advance(
        this.engine.state,
        bytes,
      );
    } else {
      this.engine.state =
        this.jsonCandidates.get(token) ??
        this.engine.compiled.appendUtf8(this.engine.state, bytes);
    }
    this.committedTokens.push(token);
    this.generatedTokens += 1;
    this.generatedBytes += bytes.length;
    this.maskCache = null;
    this.jsonCandidates.clear();
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
    copy.jsonCandidates = new Map();
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

  free(): void {
    this.maskCache = null;
    this.jsonCandidates.clear();
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
    this.jsonCandidates.clear();
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

    const stack: Array<{ node: TokenTrieNode; state: RegexState }> = [
      { node: data.trie, state },
    ];
    while (stack.length !== 0) {
      const current = stack.pop()!;
      for (const token of current.node.terminalTokenIds) {
        if (token === data.eos || isSpecialToken(data, token)) continue;
        if (!this.withinGenerationLimits(data.tokenBytes[token].length))
          continue;
        setMaskBit(mask, token);
        eligible += 1;
      }
      for (const [byte, child] of current.node.children) {
        const candidate = compiled.advance(current.state, singleBytes[byte]);
        if (compiled.viable(candidate))
          stack.push({ node: child, state: candidate });
      }
    }
    return eligible;
  }

  private computeJsonMask(mask: Uint32Array): number {
    if (this.engine.kind !== "json") throw new Error("invalid JSON engine");
    const data = getTokenizerData(this.tokenizer);
    let eligible = 0;
    if (this.engine.compiled.accepting(this.engine.state)) {
      setMaskBit(mask, data.eos);
      eligible += 1;
    }

    const stack = [data.trie];
    while (stack.length !== 0) {
      const node = stack.pop()!;
      const firstNormal = node.terminalTokenIds.find(
        (token) => token !== data.eos && !isSpecialToken(data, token),
      );
      if (firstNormal !== undefined) {
        const bytes = data.tokenBytes[firstNormal];
        if (this.withinGenerationLimits(bytes.length)) {
          const candidate = this.engine.compiled.appendUtf8(
            this.engine.state,
            bytes,
          );
          if (!this.engine.compiled.viable(candidate)) continue;
          for (const token of node.terminalTokenIds) {
            if (token === data.eos || isSpecialToken(data, token)) continue;
            setMaskBit(mask, token);
            this.jsonCandidates.set(token, candidate);
            eligible += 1;
          }
        }
      }
      for (const child of node.children.values()) stack.push(child);
    }
    return eligible;
  }

  private tokenAllowed(token: number): boolean {
    if (token === this.tokenizer.eosToken()) return this.accepting();
    if (this.tokenizer.isSpecial(token)) return false;

    const bytes = getTokenizerData(this.tokenizer).tokenBytes[token];
    if (this.nonEosTokenCount() >= this.limits.maxTokens) return false;
    if (this.outputByteLength() + bytes.length > this.limits.maxOutputBytes) {
      return false;
    }
    if (this.engine.kind === "regex") {
      const candidate = this.engine.compiled.advance(this.engine.state, bytes);
      return this.engine.compiled.viable(candidate);
    }
    return this.engine.compiled.viable(
      this.engine.compiled.appendUtf8(this.engine.state, bytes),
    );
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
  class LLGuidanceInterpreter extends CoreLLGuidanceInterpreter {
    constructor(tokenizer: LLGuidanceTokenizer, config: unknown) {
      super(tokenizer, config, compilers);
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
      return makeMarker("json_schema", value.json_schema);
    case "json_object":
      return makeMarker("json_schema", { type: "object" });
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
  return parsed as Marker;
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
  const root: TokenTrieNode = { children: new Map(), terminalTokenIds: [] };
  tokens.forEach((bytes, tokenId) => {
    let node = root;
    for (const byte of bytes) {
      let child = node.children.get(byte);
      if (child === undefined) {
        child = { children: new Map(), terminalTokenIds: [] };
        node.children.set(byte, child);
      }
      node = child;
    }
    node.terminalTokenIds.push(tokenId);
  });
  return root;
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
