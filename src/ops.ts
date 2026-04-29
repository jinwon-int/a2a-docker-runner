import { constants } from "node:fs";
import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
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
  docker: OpsCheck;
  podman: OpsCheck;
  taskRoot: OpsCheck;
  secretMount: OpsCheck;
  baseImage: OpsCheck;
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

export async function doctor(config: RunnerConfig): Promise<DoctorReport> {
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
  const baseImage = (engine === "docker" ? docker : podman).status === "ok"
    ? checkBaseImage(engine, config.image)
    : { status: "fail" as const, message: "no container engine available for base image check", detail: { image: config.image } };
  const engineReady = docker.status === "ok" || podman.status === "ok";
  return {
    ok: engineReady && [taskRoot, secretMount, baseImage].every((check) => check.status !== "fail"),
    engine,
    docker,
    podman,
    taskRoot,
    secretMount,
    baseImage,
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

export async function cleanup(options: CleanupOptions): Promise<CleanupReport> {
  const rootDir = resolve(options.rootDir);
  const nowMs = options.nowMs ?? Date.now();
  const dryRun = options.dryRun ?? false;
  const removed: string[] = [];
  const candidates: string[] = [];
  const skipped: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return { ok: true, dryRun, rootDir, ttlMs: options.ttlMs, removed, candidates, skipped };
  }

  for (const entry of entries) {
    const path = join(rootDir, entry);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isDirectory()) {
      skipped.push(path);
      continue;
    }
    const ageMs = nowMs - info.mtimeMs;
    if (ageMs < options.ttlMs) {
      skipped.push(path);
      continue;
    }
    candidates.push(path);
    if (!dryRun) {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    }
  }

  return { ok: true, dryRun, rootDir, ttlMs: options.ttlMs, removed, candidates, skipped };
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
