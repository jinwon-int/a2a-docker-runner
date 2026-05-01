import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("docs describe broker runtime as HTTP/supervisor-neutral", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const releaseChecklist = await readFile(new URL("../docs/release-rollout-checklist.md", import.meta.url), "utf8");
  const integration = await readFile(new URL("../docs/integration.md", import.meta.url), "utf8");

  assert.match(readme, /HTTP broker endpoint and edge-secret contract/);
  assert.match(readme, /Docker Compose, systemd, or another supervisor/);
  assert.match(releaseChecklist, /runtime-agnostic HTTP dependency/);
  assert.match(releaseChecklist, /Docker Compose restart, a systemd restart/);
  assert.match(integration, /Docker Compose로 실행되는지 systemd로 실행되는지는 runner 설정\/rollback 판단에 영향을 주지 않는다/);

  const combined = [readme, releaseChecklist, integration].join("\n");
  assert.doesNotMatch(combined, /broker (?:is|must be|should be|runs as) (?:a )?systemd/i);
});
