import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import type { RunnerConfig, RunnerEngine } from "./types.js";

export type OpsStatus = "ok" | "warn" | "fail" | "skip";

export interface OpsCheck {
  status: OpsStatus;
  message: string;
  detail?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  engine: RunnerEngine;
  runnerRevision: OpsCheck;
  docker: OpsCheck;
  podman: OpsCheck;
  taskRoot: OpsCheck;
  secretMount: OpsCheck;
  extraMounts: OpsCheck;
  baseImage: OpsCheck;
  githubPatch: OpsCheck;
}

export interface InstallReport {
  ok: boolean;
  created: string[];
  taskRoot: OpsCheck;
  secretMount: OpsCheck;
}

export interface CleanupOptions {
  rootDir: string;
  ttlMs: number;
  dryRun?: boolean;
  nowMs?: number;
}

export interface CleanupReport {
  ok: boolean;
  dryRun: boolean;
  rootDir: string;
  ttlMs: number;
  removed: string[];
  candidates: string[];
  skipped: string[];
}

/**
 * Clean up expired run-token directories under Round 3 nested task roots.
 *
 * Round 3 structure: <rootDir>/<safeTaskId>/<runToken>/...
 * - Each runToken directory contains task.json, run.json, artifacts/, etc.
 * - A run is expired when its age >= ttlMs (preferring run.json.createdAt over mtime).
 * - Individual expired run dirs are removed even when sibling runs are still active.
 * - A task root (safeTaskId) is only removed when all its run dirs have been
 *   removed and no other entries remain.
 * - Non-directory entries at any level are skipped.
 * - Malformed/missing-root conditions are handled gracefully.
 *
 * The function never performs destructive cleanup on paths outside rootDir.
 */
export async function cleanup(options: CleanupOptions): Promise<CleanupReport> {
  const rootDir = resolve(options.rootDir);
  const nowMs = options.nowMs ?? Date.now();
  const dryRun = options.dryRun ?? false;
  const removed: string[] = [];
  const candidates: string[] = [];
  const skipped: string[] = [];

  let taskRoots: string[];
  try {
    taskRoots = await readdir(rootDir);
  } catch {
    return { ok: true, dryRun, rootDir, ttlMs: options.ttlMs, removed, candidates, skipped };
  }

  for (const entry of taskRoots) {
    const taskRoot = join(rootDir, entry);
    const taskRootInfo = await stat(taskRoot).catch(() => undefined);
    if (!taskRootInfo?.isDirectory()) {
      skipped.push(taskRoot);
      continue;
    }

    const { expiredDirs, recentDirs, skippedDirs } = await evaluateTaskRoot(
      taskRoot,
      options.ttlMs,
      nowMs,
    );

    // Report non-run entries (including malformed) as skipped
    for (const skippedDir of skippedDirs) {
      skipped.push(skippedDir);
    }

    // Recent runs are always skipped
    for (const recent of recentDirs) {
      skipped.push(recent);
    }

    // Expired run dirs are candidates for removal
    for (const expired of expiredDirs) {
      candidates.push(expired);
      if (!dryRun) {
        await rm(expired, { recursive: true, force: true });
        removed.push(expired);
      }
    }

    // After removing expired runs, check if task root is empty and can be pruned.
    // Only prune if there were no recent/skipped entries (task root has no
    // active content).
    if (expiredDirs.length > 0 && recentDirs.length === 0 && skippedDirs.length === 0) {
      // In dry-run mode the expired dirs still exist on disk, so we check
      // whether all remaining entries are exactly the expired run dirs.
      if (dryRun) {
        const remaining = await readdir(taskRoot).catch(() => [] as string[]);
        const expiredNames = new Set(expiredDirs.map((d) => d.split("/").pop()!));
        if (remaining.length > 0 && remaining.every((name) => expiredNames.has(name))) {
          candidates.push(taskRoot);
        }
      } else {
        const remaining = await readdir(taskRoot).catch(() => [] as string[]);
        if (remaining.length === 0) {
          candidates.push(taskRoot);
          await rm(taskRoot, { recursive: true, force: true });
          removed.push(taskRoot);
        }
      }
    }
  }

  return { ok: true, dryRun, rootDir, ttlMs: options.ttlMs, removed, candidates, skipped };
}

/**
 * Evaluate run-token directories inside a single task root.
 *
 * Returns three lists:
 * - expiredDirs: run dirs whose age >= ttlMs
 * - recentDirs: run dirs whose age < ttlMs
 * - skippedDirs: non-directory entries or malformed entries inside the task root
 */
async function evaluateTaskRoot(
  taskRoot: string,
  ttlMs: number,
  nowMs: number,
): Promise<{
  expiredDirs: string[];
  recentDirs: string[];
  skippedDirs: string[];
}> {
  const expiredDirs: string[] = [];
  const recentDirs: string[] = [];
  const skippedDirs: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(taskRoot);
  } catch {
    return { expiredDirs, recentDirs, skippedDirs };
  }

  for (const entry of entries) {
    const runDir = join(taskRoot, entry);
    const info = await stat(runDir).catch(() => undefined);
    if (!info?.isDirectory()) {
      skippedDirs.push(runDir);
      continue;
    }

    // Prefer run.json.createdAt for age calculation; fall back to mtime.
    const ageMs = await runAgeMs(runDir, nowMs, info.mtimeMs);
    if (ageMs < ttlMs) {
      recentDirs.push(runDir);
    } else {
      expiredDirs.push(runDir);
    }
  }

  return { expiredDirs, recentDirs, skippedDirs };
}

/**
 * Calculate the age of a run directory in milliseconds.
 *
 * Prefers the `createdAt` field from run.json (ISO timestamp) when available.
 * Falls back to directory mtimeMs when run.json is missing or unreadable.
 */
async function runAgeMs(runDir: string, nowMs: number, mtimeMsFallback: number): Promise<number> {
  try {
    const runJsonPath = join(runDir, "run.json");
    const content = await readFile(runJsonPath, "utf8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.createdAt === "string") {
      const createdAtMs = new Date(parsed.createdAt).getTime();
      if (!isNaN(createdAtMs)) {
        return nowMs - createdAtMs;
      }
    }
  } catch {
    // fall through to mtime fallback
  }
  return nowMs - mtimeMsFallback;
}

export async function doctor(config: RunnerConfig): Promise<DoctorReport> {
  const runnerRevision = await checkDeployedRevision();
  const docker = checkEngine("docker");
  const podman = checkEngine("podman");
  const configuredEngine = config.engine;
  const engine = configuredEngine && (configuredEngine === "docker" ? docker : podman).status === "ok"
    ? configuredEngine
    : docker.status === "ok"
      ? "docker"
      : "podman";
  const taskRoot = await checkTaskRoot(config.rootDir);
  const secretMount = await checkSecretMount(config.githubTokenFile);
  const extraMounts = await checkExtraMounts(config);
  const baseImage = (engine === "docker" ? docker : podman).status === "ok"
    ? checkBaseImage(engine, config.image)
    : { status: "fail" as const, message: "no container engine available for base image check", detail: { image: config.image } };
  const githubPatch = checkGitHubPatchReadiness(config);
  const engineReady = docker.status === "ok" || podman.status === "ok";
  return {
    ok: engineReady && [runnerRevision, taskRoot, secretMount, extraMounts, baseImage, githubPatch].every((check) => check.status !== "fail"),
    engine,
    runnerRevision,
    docker,
    podman,
    taskRoot,
    secretMount,
    extraMounts,
    baseImage,
    githubPatch,
  };
}

export async function checkDeployedRevision(cwd = process.cwd(), upstreamRef = "origin/main"): Promise<OpsCheck> {
  const version = await readPackageVersion(cwd);
  const insideWorkTree = git(cwd, ["rev-parse", "--is-inside-work-tree"]);

  if (insideWorkTree.status !== 0 || insideWorkTree.stdout.trim() !== "true") {
    return {
      status: version ? "warn" : "fail",
      message: version
        ? "runner version is available but deployed git revision is not inspectable"
        : "runner deployed revision is not inspectable",
      detail: compactRevisionDetail({ version, summaryStatus: version ? "WARN" : "FAIL", reason: "not a git checkout" }),
    };
  }

  const fullLocalSha = normalizeSha(git(cwd, ["rev-parse", "HEAD"]).stdout.trim());
  const localSha = fullLocalSha?.slice(0, 12);
  const branch = git(cwd, ["branch", "--show-current"]).stdout.trim() || "detached";
  const dirty = git(cwd, ["status", "--porcelain"]).stdout.trim().length > 0;
  const upstreamSha = await resolveUpstreamMainSha(cwd, upstreamRef);

  const reasons: string[] = [];
  if (!localSha) reasons.push("local SHA unavailable");
  if (dirty) reasons.push("dirty worktree");
  if (branch !== "main") reasons.push(`branch is ${branch}`);
  if (upstreamSha && fullLocalSha && upstreamSha.full !== fullLocalSha) reasons.push("local revision differs from upstream main");
  if (!upstreamSha) reasons.push("upstream main unavailable");

  const status: OpsStatus = !localSha ? "fail" : reasons.length ? "warn" : "ok";
  const summaryStatus = status === "ok" ? "PASS" : status === "warn" ? "WARN" : "FAIL";

  return {
    status,
    message: status === "ok"
      ? "runner deployed revision matches upstream main"
      : "runner deployed revision needs operator review",
    detail: compactRevisionDetail({
      version,
      localSha,
      localFullSha: fullLocalSha,
      upstreamMainSha: upstreamSha?.short,
      upstreamMainFullSha: upstreamSha?.full,
      branch,
      dirty,
      summaryStatus,
      reason: reasons.join("; ") || undefined,
    }),
  };
}

export async function install(config: RunnerConfig): Promise<InstallReport> {
  const created: string[] = [];
  const root = resolve(config.rootDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  created.push(root);
  const taskRoot = await checkTaskRoot(root);
  const secretMount = await checkSecretMount(config.githubTokenFile);
  return { ok: taskRoot.status !== "fail" && secretMount.status !== "fail", created, taskRoot, secretMount };
}

function checkEngine(engine: RunnerEngine): OpsCheck {
  const version = spawnSync(engine, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) return { status: "fail", message: `${engine} is not available` };
  return { status: "ok", message: `${engine} is available`, detail: { version: version.stdout.trim() } };
}

async function checkTaskRoot(rootDir: string): Promise<OpsCheck> {
  const root = resolve(rootDir);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
    const info = await stat(root);
    return { status: "ok", message: "task root is accessible", detail: { path: root, mode: `0${(info.mode & 0o777).toString(8)}` } };
  } catch (error) {
    return { status: "fail", message: "task root is not accessible", detail: { path: root, error: errorMessage(error) } };
  }
}

async function checkSecretMount(githubTokenFile?: string): Promise<OpsCheck> {
  if (!githubTokenFile) return { status: "skip", message: "no secret file configured" };
  const path = resolve(githubTokenFile);
  try {
    await access(path, constants.R_OK);
    const info = await stat(path);
    const writableByGroupOrOther = (info.mode & 0o022) !== 0;
    if (writableByGroupOrOther) {
      return { status: "warn", message: "secret file is readable but permissions are broader than recommended", detail: { path, mode: `0${(info.mode & 0o777).toString(8)}`, mount: ":ro" } };
    }
    return { status: "ok", message: "secret file is readable and will be mounted read-only", detail: { path, mode: `0${(info.mode & 0o777).toString(8)}`, mount: ":ro" } };
  } catch (error) {
    return { status: "fail", message: "configured secret file is not readable", detail: { path, error: errorMessage(error) } };
  }
}

async function checkExtraMounts(config: RunnerConfig): Promise<OpsCheck> {
  const mounts = config.extraMounts ?? [];
  if (!mounts.length) return { status: "skip", message: "no extra mounts configured" };

  const checked: Array<Record<string, unknown>> = [];
  for (const mount of mounts) {
    const source = resolve(mount.source);
    try {
      await access(source, constants.R_OK);
      const info = await stat(source);
      checked.push({
        source,
        target: mount.target,
        readOnly: mount.readOnly !== false,
        mode: `0${(info.mode & 0o777).toString(8)}`,
        type: info.isDirectory() ? "directory" : "file",
      });
    } catch (error) {
      return {
        status: "fail",
        message: "configured extra mount is not readable",
        detail: { source, target: mount.target, error: errorMessage(error) },
      };
    }
  }

  return { status: "ok", message: "extra mounts are readable", detail: { mounts: checked } };
}

export function checkGitHubPatchReadiness(config: RunnerConfig): OpsCheck {
  if (config.commandScript) {
    return {
      status: "ok",
      message: "GitHub patch execution is ready via commandScript",
      detail: { path: "/work/patch-command.sh", safe: true, eval: false },
    };
  }

  if (config.commandJson) {
    try {
      const parsed = JSON.parse(config.commandJson) as { argv?: unknown };
      if (!Array.isArray(parsed.argv) || parsed.argv.length === 0 || !parsed.argv.every((arg) => typeof arg === "string")) {
        return {
          status: "fail",
          message: "GitHub patch commandJson must contain a non-empty string argv array",
          detail: { env: "A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON", safe: false },
        };
      }
      return {
        status: "ok",
        message: "GitHub patch execution is ready via commandJson",
        detail: { path: "/work/patch-command.sh", safe: true, eval: false, argvCount: parsed.argv.length },
      };
    } catch (error) {
      return {
        status: "fail",
        message: "GitHub patch commandJson is not valid JSON",
        detail: { env: "A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON", error: errorMessage(error) },
      };
    }
  }

  if (config.commandTemplate) {
    return {
      status: "fail",
      message: "GitHub patch execution blocks legacy commandTemplate eval path; use OpenClaw or Codex via commandScript or commandJson",
      detail: { env: "A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE", safe: false, eval: true, allowedExecutors: ["openclaw", "codex"] },
    };
  }

  return {
    status: "fail",
    message: "GitHub patch execution is blocked: no patch command configured",
    detail: {
      missing: ["A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT", "A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON"],
      fallback: "missing command yields Block evidence; it must not be reported as Done",
    },
  };
}

function git(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function readPackageVersion(cwd: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

async function resolveUpstreamMainSha(cwd: string, upstreamRef: string): Promise<{ full: string; short: string } | undefined> {
  const remote = upstreamRef.includes("/") ? upstreamRef.slice(0, upstreamRef.indexOf("/")) : "origin";
  const remoteHead = git(cwd, ["ls-remote", "--heads", remote, "main"]);
  const match = /(^|\n)([0-9a-f]{40})\s+refs\/heads\/main(?:\n|$)/i.exec(remoteHead.stdout);
  if (match) {
    const full = match[2].toLowerCase();
    return { full, short: full.slice(0, 12) };
  }

  const localRef = git(cwd, ["rev-parse", upstreamRef]);
  const localRefSha = normalizeSha(localRef.stdout.trim());
  if (localRefSha) return { full: localRefSha, short: localRefSha.slice(0, 12) };
  return undefined;
}

function normalizeSha(value: string): string | undefined {
  return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : undefined;
}

function compactRevisionDetail(input: {
  version?: string;
  localSha?: string;
  localFullSha?: string;
  upstreamMainSha?: string;
  upstreamMainFullSha?: string;
  branch?: string;
  dirty?: boolean;
  summaryStatus: "PASS" | "WARN" | "FAIL";
  reason?: string;
}): Record<string, unknown> {
  const branch = input.branch ?? "unknown";
  const dirty = input.dirty ?? false;
  const summary = [
    input.summaryStatus,
    `runner=${input.version ? `v${input.version}` : "unknown"}`,
    `local=${input.localSha ?? "unknown"}`,
    `upstreamMain=${input.upstreamMainSha ?? "unknown"}`,
    `branch=${branch}`,
    `dirty=${dirty ? "yes" : "no"}`,
  ].join(" ");

  return {
    version: input.version,
    localSha: input.localSha,
    localFullSha: input.localFullSha,
    upstreamMainSha: input.upstreamMainSha,
    upstreamMainFullSha: input.upstreamMainFullSha,
    branch,
    dirty,
    summary,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function checkBaseImage(engine: RunnerEngine, image: string): OpsCheck {
  const inspect = spawnSync(engine, ["image", "inspect", image], { encoding: "utf8" });
  if (inspect.status === 0) return { status: "ok", message: "base image is present locally", detail: { image } };
  const pull = spawnSync(engine, ["pull", "--quiet", image], { encoding: "utf8" });
  if (pull.status === 0) return { status: "ok", message: "base image pull succeeded", detail: { image } };
  return { status: "fail", message: "base image is not ready", detail: { image, stderr: pull.stderr.trim() || inspect.stderr.trim() } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
