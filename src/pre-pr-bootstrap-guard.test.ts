import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// pre-pr-bootstrap-guard – standalone script smoke tests
// ---------------------------------------------------------------------------

const GUARD_SCRIPT = join(import.meta.dirname ?? ".", "..", "scripts", "pre-pr-bootstrap-guard.mjs");

test("guard script passes on clean repo dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-clean-"));
  try {
    writeFileSync(join(dir, "README.md"), "# test");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "// code");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.schemaVersion, "a2a.runner.pre-pr-bootstrap-guard.v1");
    assert.equal(output.parent, "a2a-broker#446");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on AGENTS.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-agents-"));
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# agent context");
    writeFileSync(join(dir, "README.md"), "# test");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1, `Expected exit 1, got ${result.status}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("AGENTS.md"), `Expected AGENTS.md in offending paths, got: ${JSON.stringify(output.offendingPaths)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on SOUL.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-soul-"));
  try {
    writeFileSync(join(dir, "SOUL.md"), "# soul");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("SOUL.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on USER.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-user-"));
  try {
    writeFileSync(join(dir, "USER.md"), "# user");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("USER.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on TOOLS.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-tools-"));
  try {
    writeFileSync(join(dir, "TOOLS.md"), "# tools");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("TOOLS.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on HEARTBEAT.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-heartbeat-"));
  try {
    writeFileSync(join(dir, "HEARTBEAT.md"), "# heartbeat");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("HEARTBEAT.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on IDENTITY.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-identity-"));
  try {
    writeFileSync(join(dir, "IDENTITY.md"), "# identity");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("IDENTITY.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on .openclaw directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-openclaw-"));
  try {
    mkdirSync(join(dir, ".openclaw"), { recursive: true });
    writeFileSync(join(dir, ".openclaw", "config.json"), "{}");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.some((p: string) => p.startsWith(".openclaw")), `Expected .openclaw in offending paths, got: ${JSON.stringify(output.offendingPaths)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on MEMORY.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-memory-md-"));
  try {
    writeFileSync(join(dir, "MEMORY.md"), "# memory");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("MEMORY.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on memory directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-memory-dir-"));
  try {
    mkdirSync(join(dir, "memory"), { recursive: true });
    writeFileSync(join(dir, "memory", "2026-01-01.md"), "notes");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.some((p: string) => p.startsWith("memory/")), `Expected memory/ in offending paths, got: ${JSON.stringify(output.offendingPaths)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script reports all banned files at once", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-multi-"));
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# agents");
    writeFileSync(join(dir, "SOUL.md"), "# soul");
    writeFileSync(join(dir, "IDENTITY.md"), "# identity");
    mkdirSync(join(dir, ".openclaw"), { recursive: true });
    writeFileSync(join(dir, ".openclaw", "state.json"), "{}");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("AGENTS.md"));
    assert.ok(output.offendingPaths.includes("SOUL.md"));
    assert.ok(output.offendingPaths.includes("IDENTITY.md"));
    assert.ok(output.offendingPaths.some((p: string) => p.startsWith(".openclaw")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script exits 2 on missing repo-dir", () => {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT], {
    encoding: "utf8",
    timeout: 5000,
  });

  assert.equal(result.status, 2);
});

test("guard script exits 2 on unknown argument", () => {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--unknown"], {
    encoding: "utf8",
    timeout: 5000,
  });

  assert.equal(result.status, 2);
});

test("guard script --help exits 0", () => {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--help"], {
    encoding: "utf8",
    timeout: 5000,
  });

  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("--repo-dir"));
});
