// PIN: the general shell (shellResult / bounded_shell) never hands the fleet credential to an
// agent-issued command. The allowlisted script runner (script-runner.ts) is the ONE spawn site that
// injects METABOB_API_KEY, and only into an operator-approved, hash-pinned script; that design is safe
// only while the LLM-driven shell stays credential-free. This pins it at the spawn, through the real
// `sh` the shellResult handler calls, with a planted key in this process's env.
import { afterAll, describe, expect, it } from "bun:test";

// index.ts starts a real HTTP server at import (see group-bounded.test.ts): scratch port first.
process.env["PORT"] = String(20000 + Math.floor(Math.random() * 10000));
const PLANTED = "mbk_shellpin_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const prior = process.env["METABOB_API_KEY"];
process.env["METABOB_API_KEY"] = PLANTED;
const { sh } = await import("./index");
const { agentShellEnv } = await import("./agent-shell-env");

afterAll(() => {
  if (prior === undefined) delete process.env["METABOB_API_KEY"];
  else process.env["METABOB_API_KEY"] = prior;
});

describe("MUST-FAIL (6): the shellResult child env carries no METABOB_API_KEY", () => {
  it("a shell command that dumps its env sees neither the name nor the value", async () => {
    expect(process.env["METABOB_API_KEY"]).toBe(PLANTED); // the vessel env DOES carry it
    const r = await sh("env; echo \"K=${METABOB_API_KEY:-unset}\"", "/tmp");
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("K=unset");
    expect(r.stdout).not.toContain("METABOB_API_KEY=");
    expect(r.stdout).not.toContain(PLANTED.slice(0, 12));
  });
  it("the env builder drops it even when a caller passes it as an extra", () => {
    const env = agentShellEnv(process.env, { METABOB_API_KEY: PLANTED, METABOB_ENDPOINT: "http://x" });
    expect(env).not.toHaveProperty("METABOB_API_KEY");
    expect(env).not.toHaveProperty("METABOB_ENDPOINT");
  });
});
