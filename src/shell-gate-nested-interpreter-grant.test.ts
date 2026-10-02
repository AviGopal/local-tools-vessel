// Check-first for gap shell-gate-nested-interpreter-check-calls-verifywritegrant-with-arguments-swapped.
//
// containShell's nested-interpreter refusal (autonomous 0e30c60) calls
//   verifyWriteGrant(opts.grant, root, dir ?? root)
// but the signature is verifyWriteGrant(key, path, grant, now): the grant goes in as the key
// and a path string as the grant, so that check can never pass. It was invisible because the
// early return at the top of containShell admits a grant bound to the exact cwd. It shows when
// the command starts in a SUBDIRECTORY of the clone with a grant bound to the clone root: the
// early return does not match (it checks the cwd), and the nested-interpreter check, which is
// meant to admit a grant matching the clone root, refuses it. The fix is to call it the way the
// early return does: verifyWriteGrant(opts.env.METABOB_API_KEY, root, opts.grant, opts.now).
import { beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containShell } from "./shell-containment";
import { signWriteGrant } from "./write-containment";

let superRepo: string;
let sub: string;
let env: Record<string, string>;
beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "shell-gate-grant-")));
  superRepo = join(base, "git", "super-repo");
  sub = join(superRepo, "scripts", "substrate");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(superRepo, ".gitmodules"), "");
  writeFileSync(join(sub, "autonomy-scope.json"), "{}");
  execFileSync("git", ["-C", superRepo, "init", "-q"]);
  env = { WORKSPACE_ROOT: superRepo, MITOSIS_RUNTIME_DIR: join(base, "vessels"), MITOSIS_PUSH_CLONE_DIR: join(base, "git", "vessels"), COMPOSE_WS_DIR: join(base, "git", "compose"), METABOB_API_KEY: "k" };
});

describe("shell gate: nested-interpreter grant check", () => {
  it("admits bash -c in a clone subdirectory when the grant is bound to the clone root", () => {
    const now = Date.now();
    const grant = signWriteGrant("k", superRepo, now);
    const v = containShell("bash -c 'true'", sub, { env, rawCwd: sub, grant, now });
    expect(v).toEqual({ ok: true });
  });

  it("still refuses bash -c in a clone subdirectory with no grant (control)", () => {
    expect(containShell("bash -c 'true'", sub, { env, rawCwd: sub }).ok).toBe(false);
  });

  it("still refuses bash -c when the grant was signed with another key (control)", () => {
    const now = Date.now();
    const grant = signWriteGrant("not-the-key", superRepo, now);
    expect(containShell("bash -c 'true'", sub, { env, rawCwd: sub, grant, now }).ok).toBe(false);
  });

  it("still refuses bash -c when the grant is bound to an unrelated path (control)", () => {
    const now = Date.now();
    const grant = signWriteGrant("k", "/tmp/elsewhere", now);
    expect(containShell("bash -c 'true'", sub, { env, rawCwd: sub, grant, now }).ok).toBe(false);
  });
});
