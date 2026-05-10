# Runner Scanner & Redacted Artifact Bundle

Deterministic history scanner and redacted artifact bundle utilities for the A2A Docker Runner.

Parent: [a2a-docker-runner#177](https://github.com/jinwon-int/a2a-docker-runner/issues/177)
Parent: [a2a-plane#197](https://github.com/jinwon-int/a2a-plane/issues/197)

## Safety Gates (Fail-Closed)

All scanner and bundle outputs are fail-closed by construction:

- **No absolute host paths** — the scan profile uses a sanitized `rootLabel`, never leaking
  `/tmp/`, `/home/`, `/root/`, or other host-specific paths.
- **No raw secrets** — every text field and artifact is passed through `redactSecrets`,
  stripping GitHub tokens (`ghp_*`, `github_pat_*`), API key patterns (`sk-*`, `xai-*`),
  bearer tokens, `x-access-token` URLs, and credential key-value pairs.
- **Deterministic timestamps** — all generated manifests use the fixed timestamp
  `1970-01-01T00:00:00.000Z`, making outputs reproducible for identical input data.
- **Deterministic ordering** — runs are sorted by `runToken`; task roots and artifact files
  are sorted lexicographically.
- **Bounded output** — all text fields are truncated at safe bounds (260–300 chars for
  summaries, 200 chars for metadata fields, 8000 chars for artifact content).
- **Null byte stripping** — `\0` bytes in metadata are removed to prevent output corruption.
- **Unsafe URL filtering** — only `https://github.com/...` URLs are included in evidence
  pointers; `javascript:`, `file:`, and malformed URLs are discarded.

## History Scanner (`scanHistory`)

Walks the runner's `rootDir` tree (`rootDir/<safeTaskId>/<runToken>/`) and produces a
deterministic, redacted `ScanProfile`.

```typescript
import { scanHistory } from "@openclaw/a2a-docker-runner/scanner";

const profile = await scanHistory({
  rootDir: "/var/lib/a2a-runner/tasks",
  limit: 50,         // max runs in profile (default 100)
  minAgeMs: 3600000, // only include runs older than 1 hour
});
```

### ScanProfile Schema

```typescript
interface ScanProfile {
  schemaVersion: "a2a.runner.scan-profile.v1";
  generatedAt: "1970-01-01T00:00:00.000Z"; // deterministic
  rootLabel: string;                        // sanitized, no host paths
  totalRunDirs: number;                     // total discovered (before filters)
  runs: ScanRunEntry[];                     // sorted by runToken
}

interface ScanRunEntry {
  taskId: string;           // redacted
  safeTaskId: string;       // filesystem-safe id
  runToken: string;         // unique run token
  createdAt: string;        // ISO timestamp from run.json
  status: string;           // done | failed | timeout | budget_limited | unknown
  outcome?: string;         // from artifact manifest status
  artifactCount: number;
  prUrl?: string;           // only safe GitHub URLs
  issueUrl?: string;        // only safe GitHub URLs
  summary?: string;         // redacted, ≤ 300 chars
  exitCode?: number | null;
  branch?: string;
  timedOut?: boolean;
  budgetLimitKind?: string; // time | token | attempt | command | safety
}
```

## Redacted Artifact Bundle (`createArtifactBundle`)

Creates a self-contained, redacted copy of a single run's artifacts suitable for
external sharing, audit, or evidence chains.

```typescript
import { createArtifactBundle } from "@openclaw/a2a-docker-runner/scanner";

const manifest = await createArtifactBundle({
  workDir: "/var/lib/a2a-runner/tasks/my-task/20250101T000000Z-abc123",
  outputPath: "/tmp/redacted-bundle",
});
```

The bundle:
- Copies every file from `artifacts/` to the output directory
- Applies `redactSecrets` to all text content
- Truncates files at 8,000 characters
- Writes a redacted `manifest.json` matching the `ArtifactManifest` contract
- Never copies binary files through text redaction (falls back to raw copy)

### Bundle Manifest

The output directory contains:
- `manifest.json` — redacted artifact manifest (ArtifactManifest v1)
- All artifact files — redacted copies with original filenames

## Fail-Closed Properties

| Property | Scanner | Bundle |
|---|---|---|
| No absolute host paths | ✅ rootLabel only | ✅ no paths in manifest |
| No raw tokens (ghp_*, github_pat_*) | ✅ redacted | ✅ redacted |
| No API keys (sk-*, xai-*, sm_*) | ✅ redacted | ✅ redacted |
| No x-access-token URLs | ✅ redacted | ✅ redacted |
| No credential key=value pairs | ✅ redacted | ✅ redacted |
| Deterministic timestamps | ✅ 1970-01-01 | ✅ 1970-01-01 |
| Deterministic ordering | ✅ sorted by runToken | ✅ sorted filenames |
| Bounded field sizes | ✅ truncated | ✅ truncated |
| Null byte safety | ✅ stripped | ✅ binary-safe |
| Malformed input handling | ✅ graceful fallback | ✅ graceful fallback |

## Integration

Both modules re-use the runner's existing `redactSecrets`, `redactAndBound`, and
`RESULT_STREAM_LIMIT` exports, keeping redaction logic in a single source of truth.

No new dependencies are required beyond Node.js 22+ standard library.
