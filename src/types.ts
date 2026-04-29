export type RunnerEngine = "docker" | "podman";

export interface RunnerConfig {
  rootDir: string;
  engine?: RunnerEngine;
  image: string;
  githubTokenFile?: string;
  defaultTimeoutMs: number;
  memory?: string;
  cpus?: string;
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

export interface RunnerTask {
  id: string;
  intent: string;
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
  prUrl?: string;
  error?: string;
}
