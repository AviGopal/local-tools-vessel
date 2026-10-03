// The allowlisted script runner (script-runner.ts): the walk names a script id and arguments, never a
// command line; the runner executes ONLY a script an operator approved in an attested
// scriptRunnerAllowlist pool row, pinned to the git blob hash of the approved content, with
// METABOB_API_KEY injected from this vessel's own env. Everything here runs a REAL bash on REAL fixture
// files in a temp git repo (the stand-in for the live super-repo clone); only the pool read is stubbed,
// at the network edge (globalThis.fetch answering discovery and development-vessel's resolve route), so
// the reader under test is the production one.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitBlobSha, runAllowlistedScript, SCRIPT_ALLOWLIST_SHAPE } from "./script-runner";

// A planted credential: random, long, and distinctive, so any 8-char window of it in a log line or a
// result is a leak, never a coincidence.
const FAKE_KEY = "mbk_planted_" + Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
const OTHER_SECRET = "other_secret_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const DISCOVERY = "http://127.0.0.1:59321";
const DEV_RESOLVE = "http://127.0.0.1:59322/v2/impulses/resolve";
const PEER_RESOLVE = "http://10.9.9.9:18090/v2/impulses/resolve";

let ROOT = "";
let OUTSIDE = "";
const rel = (name: string) => `validation/scripts/${name}`;
const abs = (name: string) => join(ROOT, rel(name));
const ranLog = () => join(ROOT, "ran.log");
const ranLines = (): string[] => (existsSync(ranLog()) ? readFileSync(ranLog(), "utf8").split("\n").filter(Boolean) : []);
const git = (...a: string[]) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();

const FIXTURES: Record<string, string> = {
  // Reports whether the key is present (never its value), the names (not values) of its env, and its argv.
  "fixture.sh": [
    "#!/usr/bin/env bash",
    "set -u",
    'echo "fixture $(basename "$0")" >> "$(dirname "$0")/../../ran.log"',
    'if [ -n "${METABOB_API_KEY:-}" ]; then echo "METABOB_API_KEY=set"; else echo "METABOB_API_KEY=unset"; fi',
    'if [ -n "${METABOB_ENDPOINT:-}" ]; then echo "METABOB_ENDPOINT=set"; else echo "METABOB_ENDPOINT=unset"; fi',
    'echo "ENV_NAMES=$(env | cut -d= -f1 | sort | tr "\\n" ",")"',
    'echo "ARGC=$#"',
    'i=0; for a in "$@"; do i=$((i+1)); echo "ARG$i=$a"; done',
    'echo "to-stderr" >&2',
    "exit 0",
  ].join("\n") + "\n",
  // A hostile approved script: prints the key on stdout and stderr, whole and split.
  "leak.sh": [
    "#!/usr/bin/env bash",
    'echo "full=$METABOB_API_KEY"',
    'echo "prefix=${METABOB_API_KEY:0:12}"',
    'echo "err=$METABOB_API_KEY" >&2',
  ].join("\n") + "\n",
  // Backgrounds a plain child and a GNU-timeout child (which leaves the process group), then hangs.
  "slow.sh": [
    "#!/usr/bin/env bash",
    "sleep 300 &",
    'echo "child=$!"',
    "timeout 300 sleep 300 &",
    'echo "tchild=$!"',
    "wait",
  ].join("\n") + "\n",
  "big.sh": ["#!/usr/bin/env bash", "head -c 200000 /dev/zero | tr '\\0' 'x'", 'echo "done" >&2'].join("\n") + "\n",
};

type Row = { id: string; shape: string; status: string; updated_at: string; body: unknown; attested?: unknown };
const ATTESTED = { by: "operator", key_id: "k-admin", at: "2026-10-03T00:00:00.000Z" };
function entry(script_id: string, file: string, extra: Record<string, unknown> = {}) {
  return {
    script_id,
    path: rel(file),
    blob_sha: gitBlobSha(readFileSync(abs(file))),
    args_schema: [
      { name: "mode", type: "string", enum: ["quick", "full"], flag: "--mode" },
      { name: "label", type: "string", pattern: "[a-z0-9_]{1,16}" },
      { name: "count", type: "integer", min: 1, max: 10, flag: "--count" },
      { name: "verbose", type: "boolean", flag: "--verbose" },
    ],
    timeout_s: 20,
    max_output_bytes: 65536,
    ...extra,
  };
}
function row(id: string, body: unknown, opts: { attested?: unknown; updated_at?: string; status?: string; shape?: string } = {}): Row {
  return {
    id, shape: opts.shape ?? SCRIPT_ALLOWLIST_SHAPE, status: opts.status ?? "open", updated_at: opts.updated_at ?? "2026-10-03T01:00:00.000Z", body,
    ...("attested" in opts ? (opts.attested === undefined ? {} : { attested: opts.attested }) : { attested: ATTESTED }),
  };
}

// ── the network edge: discovery + development-vessel's resolve route ──────────────────────────────────
let localRows: Row[] = [];
let peerRows: Row[] = [];
let discoveryMode: "local" | "local+peer" | "peer-only" | "down" | "500" = "local";
let producerMode: "ok" | "malformed" = "ok";
const seenAuth: string[] = [];
const seenUrls: string[] = [];
const originalFetch = globalThis.fetch;
function installNetwork(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    seenUrls.push(u);
    seenAuth.push(String((init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""));
    if (u === `${DISCOVERY}/resolve`) {
      if (discoveryMode === "down") throw new TypeError("Unable to connect");
      if (discoveryMode === "500") return new Response("boom", { status: 500 });
      const local = { id: "development-vessel", endpoint: "http://127.0.0.1:59322", resolve_endpoint: "/v2/impulses/resolve", origin: "local" };
      const peer = { id: "development-vessel-peer", endpoint: "http://10.9.9.9:18090", resolve_endpoint: "/v2/impulses/resolve", origin: "peer:http://10.9.9.9:18100" };
      const vessels = discoveryMode === "local" ? [local] : discoveryMode === "local+peer" ? [local, peer] : [peer];
      return Response.json({ content: { vessels } });
    }
    if (u === DEV_RESOLVE || u === PEER_RESOLVE) {
      const ptr = JSON.parse(String(init?.body ?? "{}"))?.impulse;
      expect(ptr?.type).toBe("poolImpulse");
      expect(ptr?.shape).toBe(SCRIPT_ALLOWLIST_SHAPE);
      if (producerMode === "malformed") return Response.json({ shape: "poolImpulse", body: { nope: true } });
      const rows = u === DEV_RESOLVE ? localRows : peerRows;
      return Response.json({ shape: "poolImpulse", body: { impulses: rows, count: rows.length } });
    }
    throw new TypeError("unexpected network call in test: " + u);
  }) as unknown as typeof fetch;
}

const baseEnv = (): Record<string, string | undefined> => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LANG: "C.UTF-8",
  SUPER_REPO_DIR: ROOT,
  DISCOVERY_ENDPOINT: DISCOVERY,
  METABOB_API_KEY: FAKE_KEY,
  METABOB_ENDPOINT: "http://127.0.0.1:18080",
  OTHER_SECRET,
  TERM: "xterm",
});

// Every log line the runner (or anything it calls) emits, captured for the leak assertions.
const logged: string[] = [];
let spies: Array<ReturnType<typeof spyOn>> = [];
const run = (pointer: Record<string, unknown>, env = baseEnv()) =>
  runAllowlistedScript({ type: "scriptRunResult", ...pointer }, { env, log: (l) => logged.push(l) });

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "script-runner-root-"));
  OUTSIDE = mkdtempSync(join(tmpdir(), "script-runner-outside-"));
  mkdirSync(join(ROOT, "validation", "scripts"), { recursive: true });
  for (const [name, text] of Object.entries(FIXTURES)) { writeFileSync(abs(name), text); chmodSync(abs(name), 0o755); }
  writeFileSync(join(OUTSIDE, "evil.sh"), "#!/usr/bin/env bash\necho evil >> \"" + join(ROOT, "ran.log") + "\"\n");
  symlinkSync(join(OUTSIDE, "evil.sh"), abs("link.sh"));
  writeFileSync(join(ROOT, ".gitignore"), "ran.log\n");
  git("init", "-q");
  git("add", "-A");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "fixtures"], { cwd: ROOT });
});
afterAll(() => {
  for (const d of [ROOT, OUTSIDE]) try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
});
beforeEach(() => {
  localRows = [row("r-fixture", entry("fixture", "fixture.sh")), row("r-leak", entry("leak", "leak.sh")), row("r-slow", entry("slow", "slow.sh", { timeout_s: 1 })), row("r-big", entry("big", "big.sh", { max_output_bytes: 1000 }))];
  peerRows = [];
  discoveryMode = "local";
  producerMode = "ok";
  try { rmSync(ranLog()); } catch { /* none */ }
  installNetwork();
  spies = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")].map((s) => s.mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); }));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const s of spies) s.mockRestore();
});

const refusedWith = (r: Record<string, unknown>, code: string) => {
  expect(r.ok).toBe(false);
  expect(r.refused).toBe(code);
  expect(typeof r.error).toBe("string");
  expect(r).not.toHaveProperty("stdout");
};

describe("hash: the runner's blob hash is git's", () => {
  it("equals `git hash-object` and the committed blob at HEAD", () => {
    const mine = gitBlobSha(readFileSync(abs("fixture.sh")));
    expect(mine).toBe(git("hash-object", "--", rel("fixture.sh")));
    expect(mine).toBe(git("rev-parse", `HEAD:${rel("fixture.sh")}`));
  });
});

describe("MUST-FAIL (1): an allowlisted script runs with the key present and its output returned", () => {
  it("runs bash on the approved file with validated argv; the key and endpoint are set, nothing else leaks in", async () => {
    const r = await run({ script_id: "fixture", args: { mode: "quick", label: "wk_40", count: 3, verbose: true } });
    expect(r.ok).toBe(true);
    expect(r.exit_code).toBe(0);
    const out = String(r.stdout);
    expect(out).toContain("METABOB_API_KEY=set");
    expect(out).toContain("METABOB_ENDPOINT=set");
    // argv in SCHEMA order: --mode quick, label (positional), --count 3, --verbose
    expect(out).toContain("ARGC=6");
    expect(out).toMatch(/ARG1=--mode\nARG2=quick\nARG3=wk_40\nARG4=--count\nARG5=3\nARG6=--verbose\n/);
    expect(String(r.stderr)).toContain("to-stderr");
    // the child env: a minimal base plus the two injected names; never another vessel secret or TERM
    const names = (out.match(/ENV_NAMES=(.*)/)?.[1] ?? "").split(",").filter(Boolean);
    expect(names).toContain("METABOB_API_KEY");
    expect(names).not.toContain("OTHER_SECRET");
    expect(names).not.toContain("TERM");
    expect(names).not.toContain("SUPER_REPO_DIR");
    for (const n of names) expect(["PATH", "HOME", "LANG", "METABOB_API_KEY", "METABOB_ENDPOINT", "PWD", "SHLVL", "_", "OLDPWD"]).toContain(n);
    expect(ranLines()).toEqual(["fixture fixture.sh"]);
    // the run record (what the walk's step trace carries)
    const runRec = r.run as Record<string, unknown>;
    expect(runRec.script_id).toBe("fixture");
    expect(runRec.blob_sha).toBe(git("rev-parse", `HEAD:${rel("fixture.sh")}`));
    expect(runRec.args).toEqual({ mode: "quick", label: "wk_40", count: 3, verbose: true });
    expect(runRec.exit_code).toBe(0);
    expect(typeof runRec.duration_ms).toBe("number");
    expect(runRec.stdout_bytes).toBe(Buffer.byteLength(out));
    expect(runRec.stderr_bytes).toBeGreaterThan(0);
    expect(runRec.timed_out).toBe(false);
    // the pool read went to the LOCAL producer, with this vessel's own credential
    expect(seenUrls).toContain(DEV_RESOLVE);
  });

  it("a run with no args (schema args are optional unless required) passes no argv", async () => {
    const r = await run({ script_id: "fixture" });
    expect(r.ok).toBe(true);
    expect(String(r.stdout)).toContain("ARGC=0");
  });

  it("the key is missing from the vessel env → refused (credential_unavailable), nothing runs", async () => {
    const env = baseEnv();
    delete env.METABOB_API_KEY;
    refusedWith(await run({ script_id: "fixture" }, env), "credential_unavailable");
    expect(ranLines()).toEqual([]);
  });
});

describe("MUST-FAIL (2): a script id that is not allowlisted is refused", () => {
  it("unknown script_id → not_allowlisted, nothing runs", async () => {
    refusedWith(await run({ script_id: "rm-rf" }), "not_allowlisted");
    expect(ranLines()).toEqual([]);
  });
  it("a caller cannot supply the command, path, env or cwd itself", async () => {
    for (const k of ["command", "path", "env", "cwd", "blob_sha"]) {
      refusedWith(await run({ script_id: "fixture", [k]: k === "env" ? { METABOB_API_KEY: "x" } : "validation/scripts/leak.sh" }), "field_not_accepted");
    }
    expect(ranLines()).toEqual([]);
  });
  it("a retired row is not an approval", async () => {
    localRows = [row("r-fixture", entry("fixture", "fixture.sh"), { status: "retired" })];
    refusedWith(await run({ script_id: "fixture" }), "not_allowlisted");
  });
});

describe("MUST-FAIL (3): a script whose content changed after approval is refused", () => {
  it("blob hash mismatch → blob_mismatch, the edited script does not run", async () => {
    const original = readFileSync(abs("fixture.sh"), "utf8");
    try {
      appendFileSync(abs("fixture.sh"), 'echo "INJECTED" >> "$(dirname "$0")/../../ran.log"\n');
      refusedWith(await run({ script_id: "fixture" }), "blob_mismatch");
      expect(ranLines()).toEqual([]);
    } finally {
      writeFileSync(abs("fixture.sh"), original);
    }
    // control: restored content runs again
    expect((await run({ script_id: "fixture" })).ok).toBe(true);
  });
  it("a path that escapes the clone (.., absolute, or a symlink out) is refused", async () => {
    const evilSha = gitBlobSha(readFileSync(join(OUTSIDE, "evil.sh")));
    for (const [id, path] of [["dotdot", "../" + OUTSIDE.split("/").pop() + "/evil.sh"], ["absolute", join(OUTSIDE, "evil.sh")], ["link", rel("link.sh")]] as const) {
      localRows = [row(`r-${id}`, { ...entry(id, "fixture.sh"), path, blob_sha: evilSha })];
      refusedWith(await run({ script_id: id }), "path_outside_clone");
    }
    expect(ranLines()).toEqual([]);
  });
  it("no super-repo clone on this node → refused", async () => {
    const env = baseEnv();
    env.SUPER_REPO_DIR = join(OUTSIDE, "not-a-clone");
    refusedWith(await run({ script_id: "fixture" }, env), "no_super_repo_clone");
  });
});

describe("MUST-FAIL (4): arguments are validated against the approved schema", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["unknown arg name", { mode: "quick", extra: "x" }],
    ["enum violation", { mode: "turbo" }],
    ["pattern violation", { label: "Has Space" }],
    ["pattern is anchored (no partial match)", { label: "ok;rm -rf /" }],
    ["leading dash (option injection)", { label: "-x" }],
    ["newline", { label: "a\nb" }],
    ["integer type", { count: "3" }],
    ["integer range", { count: 99 }],
    ["boolean type", { verbose: "yes" }],
    ["args not an object", ["--mode", "quick"] as unknown as Record<string, unknown>],
  ];
  for (const [what, args] of bad) {
    it(`${what} → args_invalid, nothing runs`, async () => {
      refusedWith(await run({ script_id: "fixture", args }), "args_invalid");
      expect(ranLines()).toEqual([]);
    });
  }
  it("a required arg that is missing → args_invalid", async () => {
    localRows = [row("r-req", entry("req", "fixture.sh", { args_schema: [{ name: "mode", type: "string", enum: ["quick"], required: true }] }))];
    refusedWith(await run({ script_id: "req" }), "args_invalid");
  });
  it("an approved string arg with neither enum nor pattern is an invalid entry, refused before running", async () => {
    localRows = [row("r-open", entry("open", "fixture.sh", { args_schema: [{ name: "anything", type: "string" }] }))];
    refusedWith(await run({ script_id: "open", args: { anything: "x" } }), "allowlist_entry_invalid");
    expect(ranLines()).toEqual([]);
  });
});

describe("MUST-FAIL (5): only an operator-attested row from THIS substrate's pool is an approval", () => {
  it("a row with no attestation → unattested_entry, nothing runs", async () => {
    localRows = [row("r-fixture", entry("fixture", "fixture.sh"), { attested: undefined })];
    refusedWith(await run({ script_id: "fixture" }), "unattested_entry");
    expect(ranLines()).toEqual([]);
  });
  it("an attestation inside body (a caller's forgery the store strips) is not an attestation", async () => {
    localRows = [row("r-fixture", { ...entry("fixture", "fixture.sh"), attested: ATTESTED }, { attested: undefined })];
    refusedWith(await run({ script_id: "fixture" }), "unattested_entry");
  });
  it("an attestation by anyone but the operator is not one", async () => {
    localRows = [row("r-fixture", entry("fixture", "fixture.sh"), { attested: { by: "node", key_id: null, at: "x" } })];
    refusedWith(await run({ script_id: "fixture" }), "unattested_entry");
  });
  it("a row of another shape is not an approval even if attested", async () => {
    localRows = [row("r-fixture", entry("fixture", "fixture.sh"), { shape: "autonomyScope" })];
    refusedWith(await run({ script_id: "fixture" }), "not_allowlisted");
  });
  it("a federated peer's attested row is ignored: only local-origin pool producers are read", async () => {
    localRows = [];
    peerRows = [row("r-fixture", entry("fixture", "fixture.sh"))];
    discoveryMode = "local+peer";
    refusedWith(await run({ script_id: "fixture" }), "not_allowlisted");
    expect(seenUrls).not.toContain(PEER_RESOLVE);
    discoveryMode = "peer-only";
    refusedWith(await run({ script_id: "fixture" }), "no_local_pool_producer");
    expect(ranLines()).toEqual([]);
  });
  it("two attested rows for one script_id: the newest approval wins", async () => {
    const old = entry("fixture", "fixture.sh", { blob_sha: "0".repeat(40) });
    localRows = [row("r-old", old, { updated_at: "2026-10-01T00:00:00.000Z" }), row("r-new", entry("fixture", "fixture.sh"), { updated_at: "2026-10-02T00:00:00.000Z" })];
    expect((await run({ script_id: "fixture" })).ok).toBe(true);
    localRows = [row("r-old", old, { updated_at: "2026-10-03T00:00:00.000Z" }), row("r-new", entry("fixture", "fixture.sh"), { updated_at: "2026-10-02T00:00:00.000Z" })];
    refusedWith(await run({ script_id: "fixture" }), "blob_mismatch");
  });
  it("an unreadable allowlist fails closed with its own reason, never as 'not allowlisted'", async () => {
    discoveryMode = "down";
    refusedWith(await run({ script_id: "fixture" }), "allowlist_unreadable");
    discoveryMode = "500";
    refusedWith(await run({ script_id: "fixture" }), "allowlist_unreadable");
    discoveryMode = "local";
    producerMode = "malformed";
    refusedWith(await run({ script_id: "fixture" }), "allowlist_unreadable");
    expect(ranLines()).toEqual([]);
  });
});

describe("MUST-FAIL (7): no trace or log line carries the key", () => {
  const windows = (s: string, n = 8) => Array.from({ length: s.length - n + 1 }, (_, i) => s.slice(i, i + n));
  const assertNoKey = (text: string) => {
    for (const w of windows(FAKE_KEY)) if (text.includes(w)) throw new Error(`key window ${JSON.stringify(w)} found in: ${text.slice(0, 200)}`);
  };
  it("a normal run, a refusal, and a hostile script that prints the key: no 8-char window anywhere", async () => {
    const results: unknown[] = [];
    results.push(await run({ script_id: "fixture", args: { mode: "full" } }));
    results.push(await run({ script_id: "nope" }));
    results.push(await run({ script_id: "fixture", args: { label: "BAD BAD" } }));
    const leak = await run({ script_id: "leak" });
    results.push(leak);
    expect(leak.ok).toBe(true);
    expect(String(leak.stdout)).toContain("full=[REDACTED]");
    expect(String(leak.stdout)).toContain("prefix=[REDACTED]");
    expect(String(leak.stderr)).toContain("err=[REDACTED]");
    expect((leak.run as Record<string, unknown>).redacted).toBe(true);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) assertNoKey(line);
    for (const r of results) assertNoKey(JSON.stringify(r));
    // positive control: the assertion can see the key when it is there
    expect(() => assertNoKey(`x${FAKE_KEY.slice(3, 11)}y`)).toThrow();
  });
});

describe("limits: timeout kills the whole tree; output is capped", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  it("a script past timeout_s is killed with every descendant, including one under GNU timeout", async () => {
    const t0 = Date.now();
    const r = await run({ script_id: "slow" });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((r.run as Record<string, unknown>).timed_out).toBe(true);
    expect(r.ok).toBe(false);
    const child = Number(String(r.stdout).match(/child=(\d+)/)?.[1]);
    const tchild = Number(String(r.stdout).match(/tchild=(\d+)/)?.[1]);
    expect(child).toBeGreaterThan(0);
    expect(tchild).toBeGreaterThan(0);
    await Bun.sleep(200);
    expect(alive(child)).toBe(false);
    expect(alive(tchild)).toBe(false);
  });
  it("stdout past max_output_bytes is truncated and reported, the run still completes", async () => {
    const r = await run({ script_id: "big" });
    expect(r.ok).toBe(true);
    const rec = r.run as Record<string, unknown>;
    expect(String(r.stdout).length).toBeLessThanOrEqual(1000);
    expect(rec.stdout_truncated).toBe(true);
    expect(rec.stdout_bytes).toBe(200000);
    expect(String(r.stderr)).toContain("done");
  });
});

describe("wiring: index.ts serves and advertises scriptRunResult", () => {
  const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  it("the resolvers map routes scriptRunResult to the runner handler", () => {
    expect(src).toMatch(/\["scriptRunResult",\s*scriptRun\]/);
  });
  it("the daemon advertises the shape", () => {
    const shapesBlock = src.slice(src.indexOf("shapes: ["), src.indexOf("executor: new ActivityExecutor"));
    expect(shapesBlock).toContain('"scriptRunResult"');
  });
});
