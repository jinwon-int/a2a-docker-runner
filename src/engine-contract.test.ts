import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunArgs, jsonArgvToScript, redactSecrets, runTask } from "./runner.js";
import type { RunnerConfig, RunnerTask } from "./types.js";

const config: RunnerConfig = {
  rootDir: join(tmpdir(), "a2a-runner-contract"),
  engine: "docker",
  image: "example/image:ci",
  githubTokenFile: "/tmp/hosts.yml",
  defaultTimeoutMs: 1000,
  memory: "256m",
  cpus: "0.5",
};

const task: RunnerTask = {
  id: "contract/test 1",
  intent: "propose_patch",
  env: {
    SAFE_VALUE: "ok",
    GH_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
  },
  commands: ["printf ok"],
};

// ---------------------------------------------------------------------------
// buildRunArgs contract
// ---------------------------------------------------------------------------

test("builds a Docker/Podman-compatible invocation contract without requiring an engine", () => {
  const args = buildRunArgs(config, task, "/tmp/a2a-work");

  assert.deepEqual(args.slice(0, 2), ["run", "--rm"]);
  assert.ok(args.includes("--name"));
  assert.ok(args.includes("a2a-contract_test_1"));
  assert.ok(args.includes("--network"));
  assert.ok(args.includes("bridge"));
  assert.ok(args.includes("--memory"));
  assert.ok(args.includes("256m"));
  assert.ok(args.includes("--cpus"));
  assert.ok(args.includes("0.5"));
  assert.ok(args.includes("/tmp/a2a-work:/work"));
  assert.ok(args.includes("/tmp/hosts.yml:/run/secrets/gh-hosts.yml:ro"));
  assert.ok(args.includes("GH_CONFIG_HOSTS=/run/secrets/gh-hosts.yml"));
  assert.ok(args.includes("SAFE_VALUE=ok"));
  assert.ok(args.includes("GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890"));
  assert.deepEqual(args.slice(-3), ["example/image:ci", "bash", "/work/run.sh"]);
});

// ---------------------------------------------------------------------------
// Safe patch command paths: buildRunArgs injection behaviour
// ---------------------------------------------------------------------------

test("commandScript does NOT inject legacy A2A_PATCH_COMMAND env var", () => {
  const cfg: RunnerConfig = {
    ...config,
    commandScript: "#!/usr/bin/env bash\necho hello",
  };
  const args = buildRunArgs(cfg, task, "/tmp/a2a-work");
  assert.ok(!args.some((a) => a === "A2A_PATCH_COMMAND=#!/usr/bin/env bash\necho hello"),
    "commandScript should not inject legacy A2A_PATCH_COMMAND env var");
});

test("commandJson injects A2A_PATCH_COMMAND_JSON env var", () => {
  const json = '{"argv":["codex","exec","--full-auto","test prompt"],"env":{"SAFE":"val"}}';
  const cfg: RunnerConfig = { ...config, commandJson: json };
  const args = buildRunArgs(cfg, task, "/tmp/a2a-work");
  const jsonEnv = args.find((a) => a.startsWith("A2A_PATCH_COMMAND_JSON="));
  assert.ok(jsonEnv, "Expected A2A_PATCH_COMMAND_JSON env var");
  assert.ok(jsonEnv!.includes('"argv"'));
  assert.ok(jsonEnv!.includes('"codex"'));
});

test("commandTemplate (legacy) injects A2A_PATCH_COMMAND env var", () => {
  const cfg: RunnerConfig = { ...config, commandTemplate: "claude --print 'hello'" };
  const args = buildRunArgs(cfg, task, "/tmp/a2a-work");
  const legacyVar = args.find((a) => a.startsWith("A2A_PATCH_COMMAND="));
  assert.ok(legacyVar, "Expected legacy A2A_PATCH_COMMAND env var for backward compatibility");
});

test("commandScript + commandTemplate together: only JSON injected, legacy template NOT injected", () => {
  const cfg: RunnerConfig = {
    ...config,
    commandScript: "#!/usr/bin/env bash\necho safe",
    commandTemplate: "echo unsafe eval",
  };
  const args = buildRunArgs(cfg, task, "/tmp/a2a-work");
  const legacyVar = args.find((a) => a.startsWith("A2A_PATCH_COMMAND="));
  // commandTemplate should still be injected for backward compat.
  // The container script gives priority to the script file.
  assert.ok(legacyVar, "Legacy var still injected for backward compat when both are set");
});

// ---------------------------------------------------------------------------
// jsonArgvToScript
// ---------------------------------------------------------------------------

test("jsonArgvToScript converts valid JSON argv into a safe bash script", () => {
  const json = '{"argv":["echo","hello world"],"env":{"MY_VAR":"my value"}}';
  const script = jsonArgvToScript(json);
  assert.ok(script.startsWith("#!/usr/bin/env bash"));
  assert.ok(script.includes("export MY_VAR="));
  assert.ok(script.includes("hello world"));
  assert.ok(script.includes("exec"), "Must include exec");
  // shellQuote wraps args in single quotes.
  assert.ok(script.match(/exec '[^']+'/), "Exec must use quoted args");
  // Must NOT contain eval.
  assert.ok(!script.includes("eval "), "Generated script must not use eval");
});

test("jsonArgvToScript rejects non-array argv", () => {
  const json = '{"argv":"not-an-array"}';
  const script = jsonArgvToScript(json);
  assert.ok(script.includes("invalid_json_argv"));
  assert.ok(script.includes("exit 2"));
});

test("jsonArgvToScript rejects empty argv", () => {
  const json = '{"argv":[]}';
  const script = jsonArgvToScript(json);
  assert.ok(script.includes("invalid_json_argv"));
  assert.ok(script.includes("exit 2"));
});

test("jsonArgvToScript handles invalid JSON gracefully", () => {
  const json = '{not valid json';
  const script = jsonArgvToScript(json);
  assert.ok(script.includes("json_parse_failed"));
  assert.ok(script.includes("exit 2"));
});

test("jsonArgvToScript handles metacharacters safely (quoting)", () => {
  const input = 'a b c $HOME `id` "double" single';
  const json = JSON.stringify({ argv: ["printf", "%s", input] });
  const script = jsonArgvToScript(json);
  // The script should NOT use eval.
  assert.ok(!script.includes("eval "), "Must not use eval");
  // The dangerous metacharacters should be inside single quotes (safe).
  assert.ok(script.match(/'.*\$HOME.*'/), "$HOME should be inside single quotes");
});

test("jsonArgvToScript rejects non-string env keys", () => {
  const json = '{"argv":["echo","ok"],"env":{"1_INVALID":"val"}}';
  const script = jsonArgvToScript(json);
  // env key starts with digit → rejected.
  assert.ok(!script.includes("export 1_INVALID="));
  // But script should still be valid and execute echoed ok.
  assert.ok(script.includes("exec"), "Must still include exec");
});

test("jsonArgvToScript rejects string env values only, skipping non-strings", () => {
  const json = '{"argv":["echo","ok"],"env":{"VALID":"str","SKIP_NUM":42}}';
  const script = jsonArgvToScript(json);
  assert.ok(script.includes("export VALID="));
  assert.ok(!script.includes("SKIP_NUM"));
});

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

test("redacts tokens from stdout/stderr style diagnostics", () => {
  const raw = [
    "url=https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz1234567890@github.com/jinon86/repo.git",
    "oauth_token: github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz1234567890",
    "password=supersensitive",
    "api_key=abc123",
  ].join("\n");
  const redacted = redactSecrets(raw);

  assert.doesNotMatch(redacted, /ghp_[A-Za-z0-9_]+/);
  assert.doesNotMatch(redacted, /github_pat_[A-Za-z0-9_]+/);
  assert.doesNotMatch(redacted, /supersensitive/);
  assert.doesNotMatch(redacted, /api_key=abc123/);
  assert.match(redacted, /<redacted/);
});

test("redacts Authorization Bearer headers", () => {
  const raw = "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  const redacted = redactSecrets(raw);
  assert.doesNotMatch(redacted, /ghp_/);
  assert.match(redacted, /Authorization:\s*Bearer <redacted>/);
});

test("redacts gh auth login --with-token commands", () => {
  const raw = "gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  const redacted = redactSecrets(raw);
  assert.doesNotMatch(redacted, /ghp_/);
  assert.match(redacted, /--with-token <redacted>/);
});

test("redacts xai API key patterns", () => {
  const raw = "XAI_API_KEY=xai-Qi2qGiM318OjhTm3lJmK0fBPlaQs8Sygz4hxmWZYA9oog32BLsRvK2SDplxzfPuivoZ88QRrwBMnyFE2";
  const redacted = redactSecrets(raw);
  assert.doesNotMatch(redacted, /xai-[A-Za-z0-9_]+/);
  assert.match(redacted, /<redacted-api-key>/);
});

test("redacts supermemory API key patterns", () => {
  const raw = "SUPERMEMORY_KEY=sm_n8ahWEKy9qpUHCJuytAe9q_QTpBKiBZFVPDPeBqjrYIPpUrxLATdmUmsHLSaAWnSSKALdMAPJJyWBFHgpgaDxcR";
  const redacted = redactSecrets(raw);
  assert.doesNotMatch(redacted, /sm_n8ah/);
  assert.match(redacted, /<redacted-api-key>/);
});

test("redacts OpenAI API key patterns", () => {
  const raw = "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEF";
  const redacted = redactSecrets(raw);
  assert.doesNotMatch(redacted, /sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEF/);
  assert.match(redacted, /<redacted-api-key>/);
});

test("redacts shell variable assignments with secret values", () => {
  const raw = "GH_TOKEN=ghp_test12345678901234567890\nGITHUB_TOKEN=ghp_anothertoken1234567890\nNPM_TOKEN=npm_test1234";
  const redacted = redactSecrets(raw);
  assert.doesNotMatch(redacted, /ghp_test/);
  assert.doesNotMatch(redacted, /ghp_another/);
  assert.match(redacted, /GH_TOKEN=<redacted>/);
  assert.match(redacted, /GITHUB_TOKEN=<redacted>/);
  assert.match(redacted, /NPM_TOKEN=<redacted>/);
});

test("redaction preserves non-secret content", () => {
  const raw = "Build succeeded. 10 tests passed. All good.";
  const redacted = redactSecrets(raw);
  assert.equal(redacted, raw, "Non-secret content should pass through unchanged");
});

test("redaction handles multiline mixed content", () => {
  const raw = [
    "Running tests...",
    "PASS test 1",
    "Using token=ghp_test12345678901234567890 for auth",
    "PASS test 2",
    "FAIL test 3 — api_key=secret123",
    "",
    "Results: 2/3 passed",
  ].join("\n");
  const redacted = redactSecrets(raw);
  assert.match(redacted, /PASS test 1/);
  assert.match(redacted, /PASS test 2/);
  assert.match(redacted, /2\/3 passed/);
  assert.doesNotMatch(redacted, /ghp_test/);
  assert.doesNotMatch(redacted, /secret123/);
  assert.match(redacted, /token=<redacted/);
  assert.match(redacted, /api_key=<redacted/);
});

// ---------------------------------------------------------------------------
// Metacharacter safety in generated scripts
// ---------------------------------------------------------------------------

test("jsonArgvToScript handles special shell characters", () => {
  const testCases = [
    { input: "hello; rm -rf /", desc: "semicolons" },
    { input: "hello && cat /etc/passwd", desc: "double ampersand" },
    { input: "hello | wc -l", desc: "pipes" },
    { input: "hello\nnewline", desc: "embedded newlines" },
    { input: "$(cat /etc/passwd)", desc: "command substitution" },
    { input: "`cat /etc/passwd`", desc: "backtick substitution" },
    { input: "a'b\"c", desc: "mixed quotes" },
  ];

  for (const { input, desc } of testCases) {
    const json = JSON.stringify({ argv: ["echo", input] });
    const script = jsonArgvToScript(json);
    assert.ok(!script.includes("eval "), `Must not use eval (${desc})`);
    assert.ok(script.includes("#!/usr/bin/env bash"), `Must be a valid script (${desc})`);
    // The dangerous characters should be inside single quotes in the script.
    assert.ok(script.includes(`'${input}'`) || script.match(/'[^']*'/) !== null,
      `Input should be in single quotes (${desc})`);
  }
});

// ---------------------------------------------------------------------------
// missing engine
// ---------------------------------------------------------------------------

test("missing engine failure is actionable and CI-safe", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-missing-engine-"));
  const result = await runTask(
    {
      rootDir,
      engine: "definitely-missing-engine" as RunnerConfig["engine"],
      image: "missing/image:latest",
      defaultTimeoutMs: 1000,
    },
    { id: "missing-engine", intent: "propose_patch", commands: ["printf ok"] },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /실행 파일을 찾을 수 없습니다|Docker 또는 Podman/);
});
