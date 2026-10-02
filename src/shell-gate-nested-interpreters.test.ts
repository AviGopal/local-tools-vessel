// Check-first: a nested interpreter runs arbitrary writes the text gate never sees (qa review of 7e98d5d4, 10-02).
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

describe("shell gate: nested interpreters with cwd in the super-repo clone", () => {
  it("refuses bash -c, sh -c, eval and bun -e", () => {
    refused("bash -c 'echo x > f'");
    refused("sh -c 'touch f'");
    refused("eval 'touch f'");
    refused(`bun -e "require('fs').writeFileSync('f','x')"`);
  });
  it("still allows a plain read (control)", () => {
    allowed("cat notes.txt");
  });
});
