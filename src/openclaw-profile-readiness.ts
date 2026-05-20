/**
 * OpenClaw profile CLI mount readiness smoke.
 *
 * Source-level readiness check for the worker OpenClaw CLI/profile mount path.
 * Validates:
 *   - `openclaw` CLI is resolvable (from PATH or explicit binary path)
 *   - CLI can print version/help
 *   - OpenClaw profile/config mount directory is present (location only — no credential values)
 *
 * This is a pure validation module.  It does NOT execute the `openclaw` binary,
 * read mount contents, or expose secrets.  The caller provides structured inputs
 * produced by a shell or Docker probe; this module validates and classifies them.
 *
 * Parent: a2a-docker-runner#297
 * Parent: a2a-broker#829
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Readiness check categories.
 *
 * - `openclaw_cli_resolved`: CLI binary was found on the expected path.
 * - `openclaw_cli_version_ok`: CLI --version or --help produced output.
 * - `openclaw_profile_mount_present`: /run/secrets/openclaw-dir (or equivalent)
 *   mount directory exists in the container.
 */
export type OpenClawReadinessCheckKind =
  | "openclaw_cli_resolved"
  | "openclaw_cli_version_ok"
  | "openclaw_profile_mount_present";

/** Single readiness check result. */
export interface OpenClawReadinessCheckResult {
  kind: OpenClawReadinessCheckKind;
  passed: boolean;
  detail: string;
}

/**
 * Failure classification vocabulary.
 *
 * - `openclaw_cli_unavailable`: CLI binary not found (not on PATH, not at the
 *   expected mount, and install attempt failed).
 * - `openclaw_profile_unavailable`: Profile config mount is missing or
 *   inaccessible inside the container, even though the CLI may be present.
 * - `openclaw_version_failed`: CLI binary exists but cannot report its version.
 * - `ok`: All checks pass.
 */
export type OpenClawReadinessFailureCategory =
  | "ok"
  | "openclaw_cli_unavailable"
  | "openclaw_profile_unavailable"
  | "openclaw_version_failed";

/** Structured readiness probe input provided by the caller (Docker probe or shell script output). */
export interface OpenClawProfileReadinessInput {
  /** Whether the `openclaw` binary was found on PATH. */
  cliOnPath: boolean;
  /** Absolute path where the CLI binary was found, or undefined. */
  cliPath?: string;
  /** Whether `openclaw --version` succeeded and produced output. */
  cliVersionOk: boolean;
  /** Raw version string from `openclaw --version`, up to 100 chars. */
  cliVersion?: string;
  /** Whether the profile config mount directory exists (e.g. /run/secrets/openclaw-dir). */
  profileMountExists: boolean;
  /** Expected mount path for the profile config directory. */
  expectedMountPath: string;
  /** Any error messages collected during the probe (bounded, secret-free). */
  errors: string[];
}

/** Structured readiness check outcome. */
export interface OpenClawProfileReadinessOutcome {
  /** Overall pass/fail. */
  ok: boolean;
  /** Failure category for evidence classification. */
  failureCategory: OpenClawReadinessFailureCategory;
  /** Individual check results. */
  checks: OpenClawReadinessCheckResult[];
  /** Bounded summary string suitable for artifact manifests. */
  summary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default container path for the OpenClaw profile config mount. */
export const DEFAULT_PROFILE_MOUNT_PATH = "/run/secrets/openclaw-dir";

/** Default CLI binary name. */
export const OPENCLAW_CLI_NAME = "openclaw";

// ─────────────────────────────────────────────────────────────────────────────
// Pure validation logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full readiness validation against structured input.
 *
 * This is a pure function — it does NOT spawn processes, read the filesystem,
 * or expose secrets.  The caller (shell script, Docker probe) must provide the
 * probe data via `OpenClawProfileReadinessInput`.
 */
export function validateOpenClawProfileReadiness(
  input: OpenClawProfileReadinessInput,
): OpenClawProfileReadinessOutcome {
  const checks: OpenClawReadinessCheckResult[] = [];
  const errors: string[] = [];

  // 1. CLI resolution check
  if (input.cliOnPath && input.cliPath) {
    checks.push({
      kind: "openclaw_cli_resolved",
      passed: true,
      detail: `CLI binary resolved at ${input.cliPath}`,
    });
  } else {
    checks.push({
      kind: "openclaw_cli_resolved",
      passed: false,
      detail: `CLI binary "${OPENCLAW_CLI_NAME}" not found on PATH${input.cliPath ? ` (checked: ${input.cliPath})` : ""}`,
    });
    errors.push("CLI binary not resolvable on PATH");
  }

  // 2. CLI version check
  if (input.cliVersionOk && input.cliVersion) {
    checks.push({
      kind: "openclaw_cli_version_ok",
      passed: true,
      detail: `CLI reported version: ${input.cliVersion}`,
    });
  } else if (input.cliOnPath) {
    // CLI binary exists but version check failed
    checks.push({
      kind: "openclaw_cli_version_ok",
      passed: false,
      detail: "CLI binary found but --version did not produce expected output",
    });
    errors.push("CLI version probe failed");
  } else {
    // CLI not available — skip version check with informational detail
    checks.push({
      kind: "openclaw_cli_version_ok",
      passed: false,
      detail: "Skipped: CLI binary not available",
    });
  }

  // 3. Profile mount presence check (location only, not contents)
  if (input.profileMountExists) {
    checks.push({
      kind: "openclaw_profile_mount_present",
      passed: true,
      detail: `Profile config mount present at ${input.expectedMountPath}`,
    });
  } else {
    checks.push({
      kind: "openclaw_profile_mount_present",
      passed: false,
      detail: `Profile config mount directory not found at expected path: ${input.expectedMountPath}`,
    });
    errors.push("Profile config mount missing");
  }

  // ── Classify overall result ──────────────────────────────────────────
  const ok = checks.every((c) => c.passed);
  const failureCategory = classifyReadinessFailure(ok, input);

  const summary = buildReadinessSummary(ok, failureCategory, checks, errors);

  return {
    ok,
    failureCategory,
    checks,
    summary,
  };
}

/**
 * Post-process input to add caller-supplied error strings to the errors list.
 */
export function collectInputErrors(input: OpenClawProfileReadinessInput): string[] {
  return input.errors.filter((e) => e.length > 0 && e.length < 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function classifyReadinessFailure(
  ok: boolean,
  input: OpenClawProfileReadinessInput,
): OpenClawReadinessFailureCategory {
  if (ok) return "ok";

  // Priority: CLI unavailable is the most fundamental failure.
  if (!input.cliOnPath && !input.cliPath) return "openclaw_cli_unavailable";

  // Profile mount missing but CLI is OK.
  if (!input.profileMountExists) return "openclaw_profile_unavailable";

  // CLI binary exists but version check failed.
  if (input.cliOnPath && !input.cliVersionOk) return "openclaw_version_failed";

  // Catch-all — something else is wrong.
  return "openclaw_cli_unavailable";
}

function buildReadinessSummary(
  ok: boolean,
  category: OpenClawReadinessFailureCategory,
  checks: OpenClawReadinessCheckResult[],
  errors: string[],
): string {
  const prefix = ok ? "OK" : "FAIL";
  const checkCount = checks.length;
  const passedCount = checks.filter((c) => c.passed).length;

  const parts: string[] = [
    `OpenClaw profile readiness: ${prefix}`,
    `category=${category}`,
    `checks=${passedCount}/${checkCount}`,
  ];

  if (errors.length > 0) {
    parts.push(`errors=${errors.join("; ")}`);
  }

  return parts.join(", ");
}

/**
 * Build a deterministic example probe input for testing.
 *
 * This is a factory, not a validator — it does not inspect the real
 * filesystem or invoke any process.
 */
export function buildExampleReadinessInput(
  overrides?: Partial<OpenClawProfileReadinessInput>,
): OpenClawProfileReadinessInput {
  return {
    cliOnPath: true,
    cliPath: "/usr/local/bin/openclaw",
    cliVersionOk: true,
    cliVersion: "openclaw 1.0.0",
    profileMountExists: true,
    expectedMountPath: DEFAULT_PROFILE_MOUNT_PATH,
    errors: [],
    ...overrides,
  };
}
