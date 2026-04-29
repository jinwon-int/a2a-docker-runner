export type RunnerEngine = "docker" | "podman";

export interface RunnerConfig {
  rootDir: string;
  engine?: RunnerEngine;
  image: string;
  githubTokenFile?: string;
  defaultTimeoutMs: number;
  memory?: string;
  cpus?: string;
  /**
   * Escape hatch for github-propose-patch/propose_patch mode.
   * When set, injected as A2A_PATCH_COMMAND env var into containers.
   * Default commands for patch mode reference this to invoke a coding agent.
   */
  commandTemplate?: string;
}

export type RunnerPreset = "openclaw-plugin-a2a-dev";

export interface RunnerRepo {
  /** Logical name used for artifact summaries. */
  name?: string;
  /** Git remote URL or GitHub shorthand such as "jinon86/openclaw-plugin-a2a". */
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
  /** @deprecated Prefer github.prUrl for structured evidence. */
  prUrl?: string;
  error?: string;
  /** Structured GitHub evidence for propose_patch / github-propose-patch mode. */
  github?: GitHubEvidence;
}
