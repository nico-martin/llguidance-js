import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

for (const file of [
  "browser.js",
  "regex.browser.js",
  "json-schema.browser.js",
  "grammar.browser.js",
]) {
  const contents = await readFile(new URL(`../dist/${file}`, import.meta.url));
  console.log(
    `${file}: ${contents.byteLength} bytes raw, ${gzipSync(contents).byteLength} bytes gzip`,
  );
}
