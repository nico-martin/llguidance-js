import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const registry = "https://registry.npmjs.org";
const otp = process.argv[2];
const versionBump = process.argv[3] || "patch";
const allowedVersionBumps = new Set(["patch", "minor", "major"]);
const packageJsonPath = "package.json";
const distPackageJsonPath = "dist/package.json";

if (!otp || !allowedVersionBumps.has(versionBump)) {
  console.error("Usage: pnpm run publish <otp> [patch|minor|major]");
  process.exit(1);
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
};

const bumpVersion = (version, bump) => {
  const parts = version.split(".").map((part) => parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) {
    throw new Error(`Cannot bump invalid version: ${version}`);
  }

  const [major, minor, patch] = parts;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

const bumpPackageVersion = async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const currentVersion = packageJson.version;
  const nextVersion = bumpVersion(currentVersion, versionBump);
  packageJson.version = nextVersion;
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  console.log(`Version bumped ${currentVersion} -> ${nextVersion} (${versionBump})`);
};

run("npm", ["whoami", "--registry", registry]);
await bumpPackageVersion();
run("pnpm", ["run", "build:dist"]);

const packageJson = JSON.parse(await readFile(distPackageJsonPath, "utf8"));

console.log(`Publishing ${packageJson.name}@${packageJson.version}...`);

run("npm", ["publish", "--registry", registry, "--otp", otp, "--access", "public"], {
  cwd: "dist",
});
