import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

interface PackageJson {
  bin?: Record<string, string>;
}

test("package exposes the built CLI as a runnable bin", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;
  const binPath = packageJson.bin?.["a2a-docker-runner"];

  assert.equal(binPath, "./dist/cli.js");

  const cliSource = await readFile("src/cli.ts", "utf8");
  assert.equal(cliSource.startsWith("#!/usr/bin/env node"), true);
});
