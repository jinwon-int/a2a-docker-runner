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

export interface RunnerTask {
  id: string;
  intent: string;
  repo?: string;
  baseBranch?: string;
  prompt?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
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
