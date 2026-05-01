export type RunnerEngine = "docker" | "podman";

export interface RunnerConfig {
  rootDir: string;
  engine?: RunnerEngine;
  image: string;
  githubTokenFile?: string;
  defaultTimeoutMs: number;
  memory?: string;
  cpus?: string;
  /** Container network mode. Defaults to bridge; OpenClaw profile uses host to reach the local gateway. */
  network?: string;
  /** Additional host paths to mount into the runner container. */
  extraMounts?: RunnerExtraMount[];
  /**
   * Escape hatch for github-propose-patch/propose_patch mode.
   * When set, injected as A2A_PATCH_COMMAND env var into containers.
   * Default commands for patch mode reference this to invoke a coding agent.
   *
   * @deprecated Prefer commandScript (safer, no eval) or commandArgv.
   *             This path uses eval and will emit a deprecation notice.
   */
  commandTemplate?: string;

  /**
   * Safe script file content for patch command execution.
   * Runner writes this to /work/patch-command.sh in the container.
   * This is the recommended path — no eval, no shell injection risk.
   */
  commandScript?: string;

  /**
   * JSON-encoded argv/env for safe patch command execution.
   * Format: { "argv": ["codex", "exec", "..."], "env": { "KEY": "val" } }
   * Runner serialises this into a safe script, avoiding eval.
   */
  commandJson?: string;
}

export interface RunnerExtraMount {
  /** Absolute host path. */
  source: string;
  /** Absolute container path. */
  target: string;
  /** Defaults to true; set false only for explicitly writable scratch mounts. */
  readOnly?: boolean;
}

export type RunnerPreset = "openclaw-plugin-a2a-dev";

export interface RunnerRepo {
  /** Logical name used for artifact summaries. */
  name?: string;
  /** Git remote URL or GitHub shorthand such as "jinwon-int/openclaw-plugin-a2a". */
  url: string;
  /** Checkout branch/tag/ref. Defaults to main. */
  branch?: string;
  /** Container path under /work. Defaults to repo name. */
  path?: string;
  /** Mark as the task's main repo for default command generation. */
  primary?: boolean;
}

/** GitHub-mode completion evidence produced by the executor contract. */
export interface GitHubEvidence {
  /** PR URL when a patch was successfully proposed (e.g. git push + gh pr create). */
  prUrl?: string;
  /** Block comment URL posted when the task is impossible or unsafe. */
  blockCommentUrl?: string;
  /** Done comment URL for tasks that complete without a PR. */
  doneCommentUrl?: string;
}

export interface RunnerTask {
  id: string;
  intent: string;
  /** Execution mode. "github-propose-patch" activates the GitHub evidence contract. */
  mode?: string;
  /** Optional preset that expands into default repos/commands. */
  preset?: RunnerPreset;
  /** Backward-compatible single repo input. */
  repo?: string;
  baseBranch?: string;
  /** Multi-repo checkouts for plugin/openclaw/broker integration jobs. */
  repos?: RunnerRepo[];
  /** Shell commands executed inside the container after checkout. */
  commands?: string[];
  prompt?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** GitHub issue URL for evidence-mode Block/Done comment posting. */
  issueUrl?: string;
  /** Language hint for comment formatting (e.g. "ko"). */
  reportLanguage?: string;
  /** A2A broker node that requested the task. */
  requestedBy?: string;
}

export interface NormalizedRunnerTask extends RunnerTask {
  repos: RunnerRepo[];
  commands: string[];
}

export interface ArtifactManifestEntry {
  /** Artifact path relative to the task workDir. */
  path: string;
  /** Basename for quick display. */
  name: string;
  /** File size in bytes. */
  sizeBytes: number;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  /** Path to the emitted manifest.json relative to the task workDir. */
  manifestPath: string;
  /** Fixed timestamp keeps manifest content deterministic for identical artifacts. */
  generatedAt: string;
  artifacts: ArtifactManifestEntry[];
}

export interface ResultSummary {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  artifactCount: number;
  manifestPath: string;
}

export interface RunnerResult {
  ok: boolean;
  taskId: string;
  status: "completed" | "failed" | "timeout";
  workDir: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  artifacts: string[];
  /** Structured manifest for artifacts emitted by this execution. */
  artifactManifest?: ArtifactManifest;
  /** Bounded/redacted payload-safe result summary. */
  resultSummary?: ResultSummary;
  /** @deprecated Prefer github.prUrl for structured evidence. */
  prUrl?: string;
  error?: string;
  /** Structured GitHub evidence for propose_patch / github-propose-patch mode. */
  github?: GitHubEvidence;
}
