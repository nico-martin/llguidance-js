import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { loadJsonGuidance } from "../src/json-schema.ts";
import { loadRegexGuidance } from "../src/regex.ts";

const distPackageUrl = new URL("../dist/package.json", import.meta.url);
const hasStagedFeatureExports =
  existsSync(distPackageUrl) &&
  Boolean(
    JSON.parse(readFileSync(distPackageUrl, "utf8")).exports?.["./regex"],
  );

function allowed(result, token) {
  return Boolean(result.mask?.[token >>> 5] & (1 << (token & 31)));
}

function assertGeneration(runtime, responseFormat, text) {
  const bytes = [...new TextEncoder().encode(text)];
  const tokenizer = runtime.createTokenizer({
    tokens: [bytes, []],
    eosTokenId: 1,
  });
  const interpreter = runtime.createInterpreter({
    tokenizer,
    response_format: responseFormat,
  });
  assert.equal(allowed(interpreter.computeMask(), 0), true);
  interpreter.commitToken(0);
  assert.equal(allowed(interpreter.computeMask(), 1), true);
}

test("source feature loaders are cached lean runtimes", async () => {
  assert.equal(loadRegexGuidance(), loadRegexGuidance());
  assert.equal(loadJsonGuidance(), loadJsonGuidance());

  const regex = await loadRegexGuidance();
  const json = await loadJsonGuidance();
  assert.equal(regex.get_version(), "llguidance-ts-core");
  assert.equal("LLMatcher" in regex, false);
  assert.equal("LLInterpreter" in json, false);

  assertGeneration(regex, { type: "regex", regex: "a" }, "a");
  assertGeneration(json, { type: "json_object" }, "{}");
  assertGeneration(
    json,
    { type: "json_schema", json_schema: { type: "string" } },
    '"x"',
  );
});

test("specialized runtimes reject excluded response formats", async () => {
  const regex = await loadRegexGuidance();
  const json = await loadJsonGuidance();
  const tokenizer = regex.createTokenizer({
    tokens: [[97], []],
    eosTokenId: 1,
  });

  assert.throws(
    () =>
      regex.createInterpreter({
        tokenizer,
        response_format: { type: "json_object" },
      }),
    /JSON Schema support is unavailable in this specialized llguidance bundle/,
  );
  assert.throws(
    () =>
      json.createInterpreter({
        tokenizer: json.createTokenizer({ tokens: [[97], []], eosTokenId: 1 }),
        response_format: { type: "regex", regex: "a" },
      }),
    /regex support is unavailable in this specialized llguidance bundle/,
  );
});

test("feature runtimes cache external tokenizer conversion", async () => {
  const regex = await loadRegexGuidance();
  function tokenizer() {}
  tokenizer._tokenizerJSON = { model: { vocab: { a: 0, "</s>": 1 } } };
  tokenizer.eos_token_id = 1;

  const first = regex.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "a" },
  });
  delete tokenizer._tokenizerJSON;
  delete tokenizer.eos_token_id;
  const second = regex.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "a" },
  });
  assert.equal(allowed(first.computeMask(), 0), true);
  assert.equal(allowed(second.computeMask(), 0), true);
});

test(
  "staged package feature subpaths work and exclude the other engine",
  { skip: !hasStagedFeatureExports },
  async () => {
    const dist = new URL("../dist/", import.meta.url);
    const script = `
      const { loadRegexGuidance } = await import("llguidance/regex");
      const { loadJsonGuidance } = await import("llguidance/json-schema");
      const regex = await loadRegexGuidance();
      const json = await loadJsonGuidance();
      if (regex !== await loadRegexGuidance() || json !== await loadJsonGuidance()) process.exit(2);
      const rt = regex.createTokenizer({ tokens: [[97], []], eosTokenId: 1 });
      const ri = regex.createInterpreter({ tokenizer: rt, response_format: { type: "regex", regex: "a" } });
      if (!("mask" in ri.computeMask())) process.exit(3);
      const jt = json.createTokenizer({ tokens: [[123, 125], []], eosTokenId: 1 });
      const ji = json.createInterpreter({ tokenizer: jt, response_format: { type: "json_object" } });
      if (!("mask" in ji.computeMask())) process.exit(4);
      try { regex.createInterpreter({ tokenizer: rt, response_format: { type: "json_object" } }); process.exit(5); } catch {}
      try { json.createInterpreter({ tokenizer: jt, response_format: { type: "regex", regex: "a" } }); process.exit(6); } catch {}
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: dist,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const typecheck = spawnSync(
      "pnpm",
      [
        "exec",
        "tsc",
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "fixtures/feature-types.fixture.ts",
      ],
      { cwd: new URL("../", import.meta.url), encoding: "utf8" },
    );
    assert.equal(typecheck.status, 0, typecheck.stderr || typecheck.stdout);

    const regexBundle = await readFile(
      new URL("regex.browser.js", dist),
      "utf8",
    );
    const jsonBundle = await readFile(
      new URL("json-schema.browser.js", dist),
      "utf8",
    );
    assert.equal(
      regexBundle.includes("Initial JSON whitespace is not allowed"),
      false,
    );
    assert.equal(
      jsonBundle.includes("state was not created by this compiled regex"),
      false,
    );
  },
);
