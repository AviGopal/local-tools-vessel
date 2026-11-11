// A command runs in the workspace's directory when it names a relative one, never in this vessel's own; and a directory
// that does not exist is the request's fault, answered 422 by name. On a running node, git_status in "repos/walk-vessel"
// resolved under this vessel's directory, Bun reported the missing directory as a missing setpriv, the answer was a 200
// with an error, the walk's credit never counted it, and the same call ran five times.
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvers, runDir } from "./index";

const workspace = process.env.WORKSPACE_ROOT ?? "/workspace";

describe("the directory a command runs in", () => {
  it("[MUST-FAIL] a relative directory is the workspace's; one that does not exist is refused 422, by name", async () => {
    let err: { status?: number; message?: string } = {};
    try { runDir("repos/no-such-vessel"); } catch (e) { err = e as typeof err; }
    expect(err.status).toBe(422);
    expect(err.message).toContain("no such directory: repos/no-such-vessel");
    expect(err.message).toContain(join(workspace, "repos/no-such-vessel"));
    let fromHandler: { status?: number; message?: string } = {};
    try {
      await resolvers.get("git_status")!({ body: { impulse: { pointer: { type: "git_status", cwd: "repos/no-such-vessel" } } } } as never);
    } catch (e) { fromHandler = e as typeof fromHandler; }
    expect(fromHandler.status).toBe(422); // thrown through, not turned into a 200 body
  });

  it("an existing directory is used as given", () => {
    const d = mkdtempSync(join(tmpdir(), "run-dir-"));
    expect(runDir(d)).toBe(d);
  });
});
