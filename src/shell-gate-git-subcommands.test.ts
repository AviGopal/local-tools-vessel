// Check-first: mutating git subcommands not on the gate's list still change the live super-repo clone
// (qa review of 7e98d5d4, 10-02). git config core.hooksPath is code execution on the next git command.
import { beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containShell } from "./shell-containment";

let superRepo: string;
let env: Record<string, string>;
beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "shell-gate-")));
  superRepo = join(base, "git", "super-repo");
  mkdirSync(join(superRepo, "scripts", "substrate"), { recursive: true });
  writeFileSync(join(superRepo, ".gitmodules"), "");
  writeFileSync(join(superRepo, "scripts", "substrate", "autonomy-scope.json"), "{}");
  writeFileSync(join(superRepo, "notes.txt"), "b\na\n");
  execFileSync("git", ["-C", superRepo, "init", "-q"]);
  env = { WORKSPACE_ROOT: superRepo, MITOSIS_RUNTIME_DIR: join(base, "vessels"), MITOSIS_PUSH_CLONE_DIR: join(base, "git", "vessels"), COMPOSE_WS_DIR: join(base, "git", "compose"), METABOB_API_KEY: "k" };
});
const refused = (c: string) => expect(containShell(c, superRepo, { env }).ok).toBe(false);
const allowed = (c: string) => expect(containShell(c, superRepo, { env }).ok).toBe(true);

describe("shell gate: mutating git subcommands in the super-repo clone", () => {
  it("refuses git config writes, submodule update, branch -f and remote set-url", () => {
    refused("git config core.hooksPath /tmp/h");
    refused("git submodule update --init");
    refused("git branch -f dev HEAD~1");
    refused("git remote set-url origin x");
  });
  it("still allows their read forms (control)", () => {
    allowed("git config --get user.name");
    allowed("git branch --list");
    allowed("git remote -v");
  });
});
