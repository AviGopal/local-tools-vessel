// Git as this vessel (vesselGit) runs every program a repository's config names (an fsmonitor, a hook, a filter) with
// this vessel's privilege. The shell user can write a walk's clone, its own workspace, so a repository another user owns
// is one the shell may have set such a program in. Git's own ownership check (safe.directory, which vesselGit's
// environment never widens) refuses it: this pins that, so a later change that routes a walk clone through vesselGit,
// or widens its environment, fails here rather than opening a path from the shell user to this vessel's.
import { beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vesselGit } from "./git-commit";

const asRoot = process.getuid?.() === 0;
const NOBODY = 65534;

let repo: string, marker: string, mon: string;
beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "root-git-foreign-")));
  chmodSync(base, 0o755);
  repo = join(base, "clone");
  marker = join(base, "ran");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", "a.txt"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a"]);
  // the program a shell user would set: it leaves a mark when git runs it
  mon = join(base, "mon.sh");
  writeFileSync(mon, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(mon, 0o755);
  execFileSync("git", ["-C", repo, "config", "core.fsmonitor", mon]);
});

const chownTree = (p: string, uid: number) => execFileSync("chown", ["-R", `${uid}:${uid}`, p]);

describe("git as this vessel, in a repository another user owns", () => {
  it("[GUARD] control: in a repository this vessel owns, git runs the program its config names", async () => {
    if (existsSync(marker)) rmSync(marker);
    const r = await vesselGit(["status", "--porcelain"], repo);
    expect(r.exit_code).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it.skipIf(!asRoot)("[GUARD] once the shell user owns the repository, git as this vessel refuses it and runs nothing it names", async () => {
    if (existsSync(marker)) rmSync(marker);
    chownTree(repo, NOBODY);
    try {
      for (const args of [["status", "--porcelain"], ["rev-parse", "HEAD"], ["show", "HEAD:a.txt"], ["config", "--get", "core.fsmonitor"]]) {
        // refused, or read as no repository at all (config then reads no repo scope): either way nothing of the repo's own
        const r = await vesselGit(args, repo);
        expect([args.join(" "), r.exit_code === 0, r.stdout.includes(mon)]).toEqual([args.join(" "), false, false]);
      }
      expect(existsSync(marker)).toBe(false);
    } finally {
      chownTree(repo, 0);
    }
  });

  it.skipIf(!asRoot)("[GUARD] the same holds when only the repository's .git is the shell user's", async () => {
    if (existsSync(marker)) rmSync(marker);
    chownTree(join(repo, ".git"), NOBODY);
    try {
      const r = await vesselGit(["status", "--porcelain"], repo);
      expect(r.exit_code).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      chownTree(join(repo, ".git"), 0);
    }
  });
});
