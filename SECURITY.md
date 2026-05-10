# Security Policy

## Supported Versions

The current `main` branch is the only supported version. The runner is deployed
directly from the repository; there are no separately versioned release artifacts,
npm packages, or container images distributed beyond the operator's own build.

| Version | Supported |
|---------|-----------|
| main    | ✅        |

## Reporting a Vulnerability

**Do not report security vulnerabilities through public GitHub issues.**

Instead, report them directly to the repository owner via email or private
channel. Please include:

- A description of the vulnerability
- Steps to reproduce or a proof-of-concept
- The affected component(s)
- Any potential impact or exploit scenario

The maintainer will acknowledge receipt within 72 hours and provide a timeline
for assessment and remediation.

### Scope

This repository is an internal A2A worker execution sandbox. Security reports
should focus on:

- Container escape or sandbox bypass vectors
- Secret/token leakage in artifact output, logs, or evidence files
- Command injection through task payloads or environment variables
- Container privilege escalation
- Unsafe filesystem mounts or path traversal
- Evidence forgery or PR/commit spoofing

### Out of Scope

- The broker's HTTP endpoint and claim/heartbeat protocol (owned by
  `jinwon-int/a2a-broker`)
- OpenClaw Gateway configuration and authentication (owned by
  `jinwon-int/openclaw`)
- Worker host OS, Docker/Podman daemon, and network security (operator
  responsibility)
- Coding agent (OpenClaw/Codex) vulnerabilities exploited through task prompts

## Security Model

See the **Security model** section in [README.md](README.md) and the
**OpenClaw session-store guard** section for the current threat model.

Key principles:

- One container per task; no shared mutable state between tasks
- Read-only secret/config mounts; no full host workspace mounts
- Token and secret redaction in all output channels (stdout, stderr, artifacts,
  summary, manifest)
- Command injection prevention via script-based (not eval-based) command
  execution and shell metacharacter quoting
- Pre-PR bootstrap guard fails closed if OpenClaw workspace files leak into the
  branch
- Public-demo safety audit rejects secret-shaped values, private paths, live
  targets, and unsafe flags in fixtures
