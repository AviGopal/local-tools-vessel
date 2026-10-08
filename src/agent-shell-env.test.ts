// Pins the rule that an agent-issued shell command sees no secrets: the child env
// is an explicit allowlist, and both Bun.spawn sites in index.ts build it through
// agentShellEnv rather than spreading the vessel's own env.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  agentShellEnv,
  AGENT_SHELL_ENV_ALLOWLIST,
  AGENT_SHELL_ENV_ALLOWED_PREFIXES,
} from "./agent-shell-env";

// PATH is the one allowlisted name the pattern catches (it contains "PAT").
const SECRETISH = /KEY|SECRET|TOKEN|PASS|PAT|CREDENTIAL|AUTH/i;
const secretish = (name: string) => name !== "PATH" && SECRETISH.test(name);

// A vessel env shaped like the live one: secret names, endpoints, systemd noise.
const VESSEL_ENV: Record<string, string> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/root",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  JWT_SECRET: "x",
  API_KEY_SECRET: "x",
  API_KEY_SECRET_PREVIOUS: "x",
  SURREAL_PASS: "x",
  SURREALDB_PASSWORD: "x",
  METABOB_API_KEY: "x",
  SUBSTRATE_ADMIN_KEY: "x",
  OPENROUTER_API_KEY: "x",
  SUBSTRATE_GIT_PAT: "x",
  GITHUB_TOKEN: "x",
  FEDERATION_SIGNING_SECRET: "x",
  FEDERATION_PEER_AUTH_MODE: "x",
  PRIVATE_CREDENTIALS_FILE: "x",
  REDIS_URL: "redis://u:p@h:6379",
  SURREALDB_URL: "http://127.0.0.1:8000",
  DISCOVERY_ENDPOINT: "http://127.0.0.1:8100",
  WORKSPACE_ROOT: "/workspace",
  INVOCATION_ID: "abc",
  FOO: "bar",
};

describe("agentShellEnv", () => {
  it("(i) drops every secret-named key", () => {
    const env = agentShellEnv(VESSEL_ENV);
    const leaked = Object.keys(env).filter(secretish);
    expect(leaked).toEqual([]);
  });

  it("(i) drops keys not on the allowlist even when innocuously named", () => {
    const env = agentShellEnv(VESSEL_ENV);
    for (const k of ["FOO", "DISCOVERY_ENDPOINT", "WORKSPACE_ROOT", "SURREALDB_URL", "REDIS_URL", "INVOCATION_ID"]) {
      expect(env[k]).toBeUndefined();
    }
  });

  it("(i) the allowlist itself carries no secret-named entry", () => {
    expect([...AGENT_SHELL_ENV_ALLOWLIST].filter(secretish)).toEqual([]);
    expect([...AGENT_SHELL_ENV_ALLOWED_PREFIXES].filter(secretish)).toEqual([]);
  });

  it("(i) extra cannot smuggle in a name the allowlist does not carry", () => {
    const env = agentShellEnv(VESSEL_ENV, { METABOB_API_KEY: "x", FOO: "y" });
    expect(env.METABOB_API_KEY).toBeUndefined();
    expect(env.FOO).toBeUndefined();
  });

  it("MUST-FAIL neither fleet-key name reaches the agent shell from the vessel env or the extra env", () => {
    const env = agentShellEnv({ ...VESSEL_ENV, SUBSTRATE_API_KEY: "x" }, { METABOB_API_KEY: "y", SUBSTRATE_API_KEY: "z" });
    expect(env.SUBSTRATE_API_KEY).toBeUndefined();
    expect(env.METABOB_API_KEY).toBeUndefined();
  });

  it("returns exactly the allowlisted names present, nothing else", () => {
    expect(Object.keys(agentShellEnv(VESSEL_ENV)).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH"]);
  });

  it("passes LC_* locale categories through by prefix", () => {
    const env = agentShellEnv({ ...VESSEL_ENV, LC_CTYPE: "C.UTF-8" });
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.LC_CTYPE).toBe("C.UTF-8");
  });

  it("(ii) PATH carries the bun dir ahead of the inherited PATH", () => {
    const env = agentShellEnv(VESSEL_ENV);
    expect(env.PATH).toBe("/root/.bun/bin:/usr/local/bin:/usr/bin:/bin");
    expect(agentShellEnv({ PATH: "/bin", HOME: "/home/x" }).PATH).toBe("/home/x/.bun/bin:/bin");
    expect(agentShellEnv({ PATH: "/bin" }).PATH).toBe("/root/.bun/bin:/bin");
  });

  it("(iii) SUBSTRATE_EXECUTION_ID passes through from extra", () => {
    const env = agentShellEnv(VESSEL_ENV, { SUBSTRATE_EXECUTION_ID: "exec_123" });
    expect(env.SUBSTRATE_EXECUTION_ID).toBe("exec_123");
  });
});

describe("(iv) both shell spawn sites use agentShellEnv", () => {
  const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

  it("no spawn env spreads the vessel env", () => {
    expect(src.includes("...process.env")).toBe(false);
  });

  it("each Bun.spawn of bash passes an env built by agentShellEnv", () => {
    const spawns = src.split("\n").filter((l) => /Bun\.spawn\(\s*\[\s*"bash"/.test(l));
    expect(spawns.length).toBe(2);
    for (const l of spawns) expect(l).toMatch(/env:\s*agentShellEnv\(process\.env/);
  });
});
