import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { compileJsonSchema } from "../src/engine/json-schema.ts";

const root = resolve(
  process.argv[2] ??
    process.env.JSON_SCHEMA_TEST_SUITE ??
    "vendor/JSON-Schema-Test-Suite/tests/draft2020-12",
);

let files;
try {
  files = await jsonFiles(root);
} catch (error) {
  console.error(
    `Unable to read JSON Schema Test Suite at ${root}. Pass its draft2020-12 directory as the first argument or set JSON_SCHEMA_TEST_SUITE.`,
  );
  throw error;
}

let passed = 0;
let failed = 0;
let unsupported = 0;
for (const file of files) {
  const groups = JSON.parse(await readFile(file, "utf8"));
  for (const group of groups) {
    let compiled;
    try {
      compiled = compileJsonSchema(group.schema);
    } catch (error) {
      if (isUnsupported(error)) {
        unsupported += group.tests.length;
        continue;
      }
      throw new Error(`${file}: ${group.description}: ${String(error)}`);
    }
    for (const entry of group.tests) {
      const actual = compiled.acceptsText(JSON.stringify(entry.data));
      if (actual === entry.valid) {
        passed += 1;
      } else {
        failed += 1;
        console.error(
          `${file}: ${group.description}: ${entry.description}: expected ${entry.valid}, received ${actual}`,
        );
      }
    }
  }
}

console.log(
  `JSON Schema suite: ${passed} passed, ${failed} failed, ${unsupported} unsupported`,
);
if (failed !== 0) process.exitCode = 1;

async function jsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return jsonFiles(path);
      return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

function isUnsupported(error) {
  return (
    error instanceof Error &&
    /unsupported schema keyword|external references|dynamic|IRI/.test(
      error.message,
    )
  );
}
