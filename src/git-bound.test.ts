// git as this vessel runs it (git() as the shell user, the same runner for vesselGit and trusted) answers within its
// bound whatever a repository's config makes it run. A clone is the walk's: its .git/config and .gitattributes can name a
// clean filter, its hooks path a hook, and either can start a process that keeps git's stderr. Killing git alone left
// that process holding the read, past the bound and forever if it never ended. Judged by effect: how long the answer
// takes. The config is written into the repository, as a clone's would be.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git-commit.js";

const SLACK_MS = 10_000;
// Same size, new time: git cannot tell the file from its stat, so it hashes it, and the clean filter runs.
const touchSameSize = (f: string) => { writeFileSync(f, "z\n"); const t = new Date(Date.now() + 5_000); utimesSync(f, t, t); };
const sh = (args: string[], cwd: string) => Bun.spawnSync(["git", ...args], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" }, timeout: 30_000 });

// A repository, writable by the shell user (git() runs as that user under root), with one committed file.
const repo = (): string => {
  const d = mkdtempSync(join(tmpdir(), "git-bound-"));
  chmodSync(d, 0o777);
  sh(["init", "-q"], d);
  sh(["config", "user.email", "t@example.invalid"], d);
  sh(["config", "user.name", "t"], d);
  writeFileSync(join(d, "a.txt"), "a\n");
  sh(["add", "a.txt"], d);
  sh(["commit", "-qm", "a"], d);
  Bun.spawnSync(["chmod", "-R", "a+rwX", d], { timeout: 30_000 });
  return d;
};

describe("git answers within its bound, whatever a repository's config runs", () => {
  test("[MUST-FAIL] a clean filter that leaves a process holding git's stderr: status answers once git ends, not when the holder does", async () => {
    const d = repo();
    sh(["config", "filter.x.clean", "sh -c 'sleep 60 >&2 & cat'"], d);
    writeFileSync(join(d, ".gitattributes"), "* filter=x\n");
    touchSameSize(join(d, "a.txt"));
    const t0 = Date.now();
    const r = await git(["-C", d, "status", "--porcelain"], tmpdir(), { timeoutMs: 60_000 });
    expect(Date.now() - t0).toBeLessThan(SLACK_MS);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("a.txt");
  }, 30_000);

  test("[MUST-FAIL] a pre-commit hook that leaves a process holding git's stderr: commit answers once git ends", async () => {
    const d = repo();
    const hooks = join(d, "hooks");
    mkdirSync(hooks, { mode: 0o777 });
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nsleep 60 >&2 &\nexit 0\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    sh(["config", "core.hooksPath", hooks], d);
    writeFileSync(join(d, "b.txt"), "b\n");
    await git(["-C", d, "add", "b.txt"], tmpdir());
    const t0 = Date.now();
    const r = await git(["-C", d, "commit", "-qm", "b"], tmpdir(), { timeoutMs: 60_000 });
    expect(Date.now() - t0).toBeLessThan(SLACK_MS);
    expect(r.exit_code).toBe(0);
  }, 30_000);

  test("a filter that blocks git itself is killed at the bound, and the answer says so (a guard)", async () => {
    const d = repo();
    sh(["config", "filter.y.clean", "sh -c 'sleep 60'"], d);
    writeFileSync(join(d, ".gitattributes"), "* filter=y\n");
    touchSameSize(join(d, "a.txt"));
    const t0 = Date.now();
    const r = await git(["-C", d, "status", "--porcelain"], tmpdir(), { timeoutMs: 1_500 });
    expect(Date.now() - t0).toBeLessThan(1_500 + SLACK_MS);
    expect(r.exit_code).not.toBe(0);
    expect(r.stderr).toContain("killed at the step bound");
  }, 30_000);
});
