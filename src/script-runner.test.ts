// The allowlisted script runner (script-runner.ts): the walk names a script id and arguments, never a
// command line; the runner executes ONLY a script an operator approved in an attested
// scriptRunnerAllowlist pool row, pinned to a COMMIT of the clone (the script and the tree it runs from,
// exported from the object store into a private snapshot), with
// METABOB_API_KEY injected from this vessel's own env. Everything here runs a REAL bash on REAL fixture
// files in a temp git repo (the stand-in for the live super-repo clone); only the pool read is stubbed,
// at the network edge (globalThis.fetch answering discovery and development-vessel's resolve route), so
// the reader under test is the production one.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as scriptRunner from "./script-runner";
import { gitBlobSha, runAllowlistedScript, SCRIPT_ALLOWLIST_SHAPE } from "./script-runner";
// Looked up at call time so this file still loads where the async mode is absent (each async test then
// fails on its own, not the whole file at import).
const __setScriptRunTtlMsForTests = (ms: number | null): void => {
  const f = (scriptRunner as Record<string, unknown>)["__setScriptRunTtlMsForTests"];
  if (typeof f !== "function") throw new Error("__setScriptRunTtlMsForTests is not exported");
  (f as (ms: number | null) => void)(ms);
};

// A planted credential: random, long, and distinctive, so any 8-char window of it in a log line or a
// result is a leak, never a coincidence.
const FAKE_KEY = "mbk_planted_" + Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
const OTHER_SECRET = "other_secret_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const DISCOVERY = "http://127.0.0.1:59321";
const DEV_RESOLVE = "http://127.0.0.1:59322/v2/impulses/resolve";
const PEER_RESOLVE = "http://10.9.9.9:18090/v2/impulses/resolve";

let ROOT = "";
let HEAD_SHA = "";
let SIDE_SHA = ""; // a commit in the store that is NOT an ancestor of origin/dev
let GHOST_SHA = ""; // on origin/dev; adds a gitlink (repos/ghost) to a commit the clone does not hold
let SUBREPO = "";
let OUTSIDE = "";
const rel = (name: string) => `validation/scripts/${name}`;
const abs = (name: string) => join(ROOT, rel(name));
// Fixtures report through validation/out, the rows' declared WRITABLE dir: in the snapshot it is a link
// into the clone, so these files land (and stay) in the clone, as the harness's results do.
const OUT = () => join(ROOT, "validation", "out");
const ranLog = () => join(OUT(), "ran.log");
const ranLines = (): string[] => (existsSync(ranLog()) ? readFileSync(ranLog(), "utf8").split("\n").filter(Boolean) : []);
const git = (...a: string[]) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();

const FIXTURES: Record<string, string> = {
  // Reports whether the key is present (never its value), the names (not values) of its env, and its argv.
  "fixture.sh": [
    "#!/usr/bin/env bash",
    "set -u",
    'D="${SUBSTRATE_SCRIPT_DIR:-$(dirname "$0")}"',
    'echo "fixture fixture.sh" >> "$D/../out/ran.log"',
    'echo "PWD_NOW=$PWD"',
    'echo "ROOTMODE=$(stat -c %a "$D/../..")"',
    'echo "SELF=$0"',
    'echo "SDIR=${SUBSTRATE_SCRIPT_DIR:-unset}"',
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
    'echo "SELF=$0"',
    "sleep 300 &",
    'echo "child=$!"',
    "timeout 300 sleep 300 &",
    'echo "tchild=$!"',
    "wait",
  ].join("\n") + "\n",
  // Takes ~2 s, then records that it finished and prints the key (redaction must hold on the async path).
  "wait.sh": [
    "#!/usr/bin/env bash",
    "sleep 2",
    'echo "wait wait.sh" >> "$SUBSTRATE_SCRIPT_DIR/../out/ran.log"',
    'echo "late=$METABOB_API_KEY"',
    'echo "done-waiting"',
  ].join("\n") + "\n",
  // Prints (1000 - $1) filler bytes, then the key, on stdout and on stderr: the key straddles a 1000-byte cap.
  "straddle.sh": [
    "#!/usr/bin/env bash",
    'n=$((1000 - $1)); head -c "$n" /dev/zero | tr "\\0" "x"; printf "%s" "$METABOB_API_KEY"',
    'head -c "$n" /dev/zero | tr "\\0" "y" >&2; printf "%s" "$METABOB_API_KEY" >&2',
  ].join("\n") + "\n",
  // Prints, sleeps, prints: bash reads a script incrementally, so a line appended to the file at its
  // path while this sleeps would be executed by a run that reads the path.
  "midrun.sh": [
    "#!/usr/bin/env bash",
    'echo "phase1"',
    "sleep 1.5",
    'echo "phase2"',
  ].join("\n") + "\n",
  "fail.sh": ["#!/usr/bin/env bash", 'echo "SELF=$0"', "exit 3"].join("\n") + "\n",
  // DOUBLE FORK: a subshell starts a setsid'd sleeper (own session, own group) and exits, so the sleeper is
  // orphaned and reparented away from the script's tree. dfork-hang.sh then hangs (timeout path);
  // dfork-exit.sh exits at once while the orphan still holds stdout (the hang-forever path).
  "dfork-hang.sh": [
    "#!/usr/bin/env bash",
    '( setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $! > "$SUBSTRATE_SCRIPT_DIR/../out/orphan-hang.pid" )',
    'o=$(cat "$SUBSTRATE_SCRIPT_DIR/../out/orphan-hang.pid"); for i in $(seq 50); do read -r l < "/proc/$o/stat" && r=${l##*) } && set -- $r && [ "$4" = "$o" ] && break; sleep 0.05; done',
    "sleep 300",
  ].join("\n") + "\n",
  "dfork-exit.sh": [
    "#!/usr/bin/env bash",
    '( setsid sleep 300 & echo $! > "$SUBSTRATE_SCRIPT_DIR/../out/orphan-exit.pid" )',
    // wait until the sleeper has left this process group (its own session), so the escape is certain and
    // not a race the post-exit group kill could win by killing it before setsid() ran
    'o=$(cat "$SUBSTRATE_SCRIPT_DIR/../out/orphan-exit.pid"); for i in $(seq 50); do read -r l < "/proc/$o/stat" && r=${l##*) } && set -- $r && [ "$4" = "$o" ] && break; sleep 0.05; done',
    'echo "parent-done"',
    "exit 0",
  ].join("\n") + "\n",
  "big.sh": ["#!/usr/bin/env bash", "head -c 200000 /dev/zero | tr '\\0' 'x'", 'echo "done" >&2'].join("\n") + "\n",
  // THE TREE: main.sh runs a sibling in its own directory and a file from a submodule, the way
  // run-weekly-harness.sh runs reuse-harness.ts and (through _forge-via-ias-executor.ts) ias-executor-ts/src.
  // It sleeps first, so a test can change either file while it runs. It writes a result through the
  // writable dir.
  "main.sh": [
    "#!/usr/bin/env bash",
    'D="$SUBSTRATE_SCRIPT_DIR"',
    'sleep "${1:-0}"',
    'bash "$D/sib.sh"',
    'bash "$D/../../repos/sub/src/hello.sh"',
    'echo "result-from-main" > "$D/../out/result.txt"',
  ].join("\n") + "\n",
  "sib.sh": ["#!/usr/bin/env bash", 'echo "SIB=committed"'].join("\n") + "\n",
};

type Row = { id: string; shape: string; status: string; updated_at: string; body: unknown; attested?: unknown };
const ATTESTED = { by: "operator", key_id: "k-admin", at: "2026-10-03T00:00:00.000Z" };
function entry(script_id: string, file: string, extra: Record<string, unknown> = {}) {
  return {
    script_id,
    commit: HEAD_SHA,
    path: rel(file),
    export: ["validation/scripts"],
    writable: ["validation/out"],
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
// The development-vessel stamp's signature, recomputed independently of the runner (its twin is
// pool-impulse.ts attestationSig): HMAC-SHA256(node key, v1 | id | shape | status | canonical(body) | key_id | at).
const canon = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
};
const signRow = (key: string, r: { id: string; shape: string; status: string; body: unknown }, a: { key_id: string | null; at: string }) =>
  createHmac("sha256", key).update(["substrate-pool-attestation/v1", r.id, r.shape, r.status, canon(r.body), a.key_id ?? "", a.at].join("\n")).digest("hex");
function row(id: string, body: unknown, opts: { attested?: unknown; updated_at?: string; status?: string; shape?: string; signKey?: string } = {}): Row {
  const base = { id, shape: opts.shape ?? SCRIPT_ALLOWLIST_SHAPE, status: opts.status ?? "open", updated_at: opts.updated_at ?? "2026-10-03T01:00:00.000Z", body };
  if ("attested" in opts) return { ...base, ...(opts.attested === undefined ? {} : { attested: opts.attested }) };
  return { ...base, attested: { ...ATTESTED, sig: signRow(opts.signKey ?? FAKE_KEY, base, ATTESTED) } };
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
      // as development-vessel's read does: only rows of the requested status (default "open")
      const want = typeof ptr?.status === "string" ? ptr.status : "open";
      const rows = (u === DEV_RESOLVE ? localRows : peerRows).filter((r) => r.status === want);
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

const commitAll = (cwd: string, msg: string) => {
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg], { cwd });
};
beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "script-runner-root-"));
  OUTSIDE = mkdtempSync(join(tmpdir(), "script-runner-outside-"));
  // the submodule's own repo
  SUBREPO = mkdtempSync(join(tmpdir(), "script-runner-sub-"));
  mkdirSync(join(SUBREPO, "src"), { recursive: true });
  writeFileSync(join(SUBREPO, "src", "hello.sh"), '#!/usr/bin/env bash\necho "SUB=committed"\n');
  execFileSync("git", ["init", "-q"], { cwd: SUBREPO });
  commitAll(SUBREPO, "sub");
  // the super-repo stand-in
  mkdirSync(join(ROOT, "validation", "scripts"), { recursive: true });
  mkdirSync(OUT(), { recursive: true });
  writeFileSync(join(OUT(), ".gitkeep"), "");
  for (const [name, text] of Object.entries(FIXTURES)) { writeFileSync(abs(name), text); chmodSync(abs(name), 0o755); }
  writeFileSync(join(OUTSIDE, "evil.sh"), "#!/usr/bin/env bash\necho evil >> \"" + join(ROOT, "validation", "out", "ran.log") + "\"\n");
  // committed symlinks: one harmless (relative, inside the tree), two that point OUT of it
  symlinkSync("fixture.sh", abs("ok-link.sh"));
  mkdirSync(join(ROOT, "validation", "links"), { recursive: true });
  symlinkSync(join(OUTSIDE, "evil.sh"), join(ROOT, "validation", "links", "link.sh"));
  symlinkSync("../../../../../../../../etc/hostname", join(ROOT, "validation", "links", "up.sh"));
  writeFileSync(join(ROOT, ".gitignore"), "validation/out/*.log\nvalidation/out/*.pid\nvalidation/out/*.txt\n");
  git("init", "-q");
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", SUBREPO, "repos/sub"], { cwd: ROOT });
  commitAll(ROOT, "fixtures");
  HEAD_SHA = git("rev-parse", "HEAD");
  // an UNINITIALISED submodule, as a live clone may have one: the commit records a gitlink, the clone has
  // neither its checkout nor its objects
  git("update-index", "--add", "--cacheinfo", `160000,${"ab".repeat(20)},repos/ghost`);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ghost gitlink"], { cwd: ROOT });
  GHOST_SHA = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/dev", GHOST_SHA);
  // a side commit: in the object store, not on origin/dev
  git("checkout", "-q", "-b", "side");
  writeFileSync(join(ROOT, "side.txt"), "side\n");
  commitAll(ROOT, "side");
  SIDE_SHA = git("rev-parse", "HEAD");
  git("checkout", "-q", HEAD_SHA);
});
afterAll(() => {
  for (const d of [ROOT, OUTSIDE, SUBREPO]) try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
});
beforeEach(() => {
  localRows = [row("r-fixture", entry("fixture", "fixture.sh")), row("r-leak", entry("leak", "leak.sh")), row("r-slow", entry("slow", "slow.sh", { timeout_s: 1 })), row("r-big", entry("big", "big.sh", { max_output_bytes: 1000 })), row("r-wait", entry("wait", "wait.sh"))];
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

// RUNNING, not merely present: a killed process stays a zombie (state Z) until its parent reaps it, and
// kill(pid, 0) still succeeds on a zombie. Where the test runner is PID 1 with no init (a bare `podman run`
// of `bun test`), adopted orphans are never reaped, so "kill(pid,0) succeeds" would read a dead process as
// alive. Production runs under systemd, which reaps.
const isRunning = (pid: number): boolean => {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "utf8");
    return st.slice(st.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch { return false; }
};

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
    for (const n of names) expect(["PATH", "HOME", "LANG", "METABOB_API_KEY", "METABOB_ENDPOINT", "SUBSTRATE_SCRIPT_DIR", "PWD", "SHLVL", "_", "OLDPWD"]).toContain(n);
    expect(ranLines()).toEqual(["fixture fixture.sh"]);
    // the run record (what the walk's step trace carries)
    const runRec = r.run as Record<string, unknown>;
    expect(runRec.script_id).toBe("fixture");
    expect(runRec.commit).toBe(HEAD_SHA);
    expect(runRec.path).toBe(rel("fixture.sh"));
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
    for (const k of ["command", "path", "env", "cwd", "blob_sha", "commit", "export", "writable"]) {
      refusedWith(await run({ script_id: "fixture", [k]: k === "env" ? { METABOB_API_KEY: "x" } : "validation/scripts/leak.sh" }), "field_not_accepted");
    }
    expect(ranLines()).toEqual([]);
  });
  it("a retired row is not an approval", async () => {
    localRows = [row("r-fixture", entry("fixture", "fixture.sh"), { status: "retired" })];
    refusedWith(await run({ script_id: "fixture" }), "not_allowlisted");
  });
  // RETIREMENT WINS. One pool id has one current state: the newest VERIFIED row for that id. A rogue
  // producer can replay an approval's older signed "open" state; the legitimate store answers the same id
  // as "retired", newer and also signed, and the retirement must win.
  it("MUST-FAIL: per pool id the newest verified row decides: a newer signed retirement displaces an older signed open (a replay)", async () => {
    localRows = [
      row("r-fixture", entry("fixture", "fixture.sh"), { status: "open", updated_at: "2026-10-01T00:00:00.000Z" }),
      row("r-fixture", entry("fixture", "fixture.sh"), { status: "retired", updated_at: "2026-10-02T00:00:00.000Z" }),
    ];
    refusedWith(await run({ script_id: "fixture" }), "not_allowlisted");
    expect(ranLines()).toEqual([]);
  });
  it("an UNVERIFIED newer retirement does not displace a verified open (a forged retirement is ignored)", async () => {
    localRows = [
      row("r-fixture", entry("fixture", "fixture.sh"), { status: "open", updated_at: "2026-10-01T00:00:00.000Z" }),
      row("r-fixture", entry("fixture", "fixture.sh"), { status: "retired", updated_at: "2026-10-02T00:00:00.000Z", signKey: "peer-key-xxxxxxxxxxxxxxxx" }),
    ];
    expect((await run({ script_id: "fixture" })).ok).toBe(true);
  });
  it("a newer verified open state of the same id (a re-approval after retirement) is an approval", async () => {
    localRows = [
      row("r-fixture", entry("fixture", "fixture.sh", { commit: "0".repeat(40) }), { status: "retired", updated_at: "2026-10-01T00:00:00.000Z" }),
      row("r-fixture", entry("fixture", "fixture.sh"), { status: "open", updated_at: "2026-10-02T00:00:00.000Z" }),
    ];
    expect((await run({ script_id: "fixture" })).ok).toBe(true);
  });
});

describe("MUST-FAIL (3): what runs is the approved commit, never the working tree", () => {
  // REPLACED GUARD: this used to be "an edited script is refused (blob_mismatch)". With the commit pinned,
  // the working tree no longer matters: an edit there is simply not what runs.
  it("a script edited in the working tree after approval: the COMMITTED version runs, the edit does not", async () => {
    const original = readFileSync(abs("fixture.sh"), "utf8");
    try {
      appendFileSync(abs("fixture.sh"), 'echo "INJECTED" >> "$SUBSTRATE_SCRIPT_DIR/../out/ran.log"\n');
      const r = await run({ script_id: "fixture" });
      expect(r.ok).toBe(true);
      expect(ranLines()).toEqual(["fixture fixture.sh"]);
    } finally {
      writeFileSync(abs("fixture.sh"), original);
    }
  });
  it("a path that is not a plain repo path (.., absolute) is refused", async () => {
    for (const [id, path] of [["dotdot", "../" + OUTSIDE.split("/").pop() + "/evil.sh"], ["absolute", join(OUTSIDE, "evil.sh")]] as const) {
      localRows = [row(`r-${id}`, { ...entry(id, "fixture.sh"), path, export: [path] })];
      refusedWith(await run({ script_id: id }), "allowlist_entry_invalid");
    }
    expect(ranLines()).toEqual([]);
  });
  it("MUST-FAIL: a script that is a SYMLINK in the commit is refused (it would run whatever it points at)", async () => {
    localRows = [row("r-link", { ...entry("link", "fixture.sh"), path: "validation/links/link.sh", export: ["validation/links"] })];
    refusedWith(await run({ script_id: "link" }), "path_not_in_commit");
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
  it("a leading dash is refused even when the approved pattern admits '-' (option injection), unless it is an exact enum value", async () => {
    localRows = [row("r-dash", entry("dash", "fixture.sh", { args_schema: [{ name: "tag", type: "string", pattern: "[a-z-]{1,16}" }, { name: "opt", type: "string", enum: ["-v"] }] }))];
    for (const tag of ["-rf", "--output"]) refusedWith(await run({ script_id: "dash", args: { tag } }), "args_invalid");
    expect(ranLines()).toEqual([]);
    const ok = await run({ script_id: "dash", args: { tag: "a-b", opt: "-v" } });
    expect(ok.ok).toBe(true);
    expect(String(ok.stdout)).toMatch(/ARG1=a-b\nARG2=-v\n/);
  });
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
  it("MUST-FAIL: a row stamped by:'operator' but with NO signature is refused (attestation_unverified), nothing runs", async () => {
    localRows = [row("r-fixture", entry("fixture", "fixture.sh"), { attested: ATTESTED })];
    refusedWith(await run({ script_id: "fixture" }), "attestation_unverified");
    expect(ranLines()).toEqual([]);
  });
  it("MUST-FAIL: a row attested and signed under ANOTHER node's key (a peer operator, or a forged key_id) is refused", async () => {
    localRows = [row("r-fixture", entry("fixture", "fixture.sh"), { signKey: "a-peer-node-key-not-ours-0123456789" })];
    refusedWith(await run({ script_id: "fixture" }), "attestation_unverified");
    const forged = row("r-fixture", entry("fixture", "fixture.sh"));
    (forged.attested as Record<string, unknown>).key_id = "k-some-other-admin"; // key_id is inside the signed string
    localRows = [forged];
    refusedWith(await run({ script_id: "fixture" }), "attestation_unverified");
    expect(ranLines()).toEqual([]);
  });
  it("MUST-FAIL: a validly signed row whose body was altered afterwards (e.g. a different path or hash) is refused", async () => {
    const r = row("r-fixture", entry("fixture", "fixture.sh"));
    (r.body as Record<string, unknown>).path = rel("leak.sh");
    (r.body as Record<string, unknown>).export = ["validation"];
    localRows = [r];
    refusedWith(await run({ script_id: "fixture" }), "attestation_unverified");
    const s2 = row("r-fixture", entry("fixture", "fixture.sh"));
    s2.status = "open "; // a status the signature did not cover
    localRows = [s2];
    refusedWith(await run({ script_id: "fixture" }), "not_allowlisted");
    expect(ranLines()).toEqual([]);
  });
  it("an unverified newer row does not displace a verified older approval", async () => {
    localRows = [
      row("r-old", entry("fixture", "fixture.sh"), { updated_at: "2026-10-01T00:00:00.000Z" }),
      row("r-new", entry("fixture", "fixture.sh", { commit: "0".repeat(40) }), { updated_at: "2026-10-05T00:00:00.000Z", signKey: "peer-key-xxxxxxxxxxxxxxxx" }),
    ];
    expect((await run({ script_id: "fixture" })).ok).toBe(true);
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
    const old = entry("fixture", "fixture.sh", { commit: "f".repeat(40) });
    localRows = [row("r-old", old, { updated_at: "2026-10-01T00:00:00.000Z" }), row("r-new", entry("fixture", "fixture.sh"), { updated_at: "2026-10-02T00:00:00.000Z" })];
    expect((await run({ script_id: "fixture" })).ok).toBe(true);
    localRows = [row("r-old", old, { updated_at: "2026-10-03T00:00:00.000Z" }), row("r-new", entry("fixture", "fixture.sh"), { updated_at: "2026-10-02T00:00:00.000Z" })];
    refusedWith(await run({ script_id: "fixture" }), "commit_unavailable");
  }, 30_000);
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
  }, 30_000);
});

describe("limits: timeout kills the whole tree; output is capped", () => {
  const alive = isRunning;
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

// ── ASYNC MODE ──────────────────────────────────────────────────────────────────────────────────────
// The weekly harness runs longer than the sync cap (900 s) and longer than any caller would hold a
// request open. mode:"async" validates and starts the run, answers {run_id, status:"running"} at once,
// and a later {run_id} read answers running or the final result (same shape as a sync run). Results
// live in memory with a TTL; nothing is persisted. One script_id has at most one run in flight: a
// second start (async OR sync) is REFUSED with already_running and the in-flight run_id to poll.
describe("async mode", () => {
  const poll = async (run_id: unknown, maxMs = 15_000) => {
    const t0 = Date.now();
    for (;;) {
      const r = await runAllowlistedScript({ type: "scriptRunResult", run_id }, { env: baseEnv(), log: (l) => logged.push(l) });
      if (r.status !== "running" || Date.now() - t0 > maxMs) return r;
      await Bun.sleep(100);
    }
  };
  const windows = (s: string, n = 8) => Array.from({ length: s.length - n + 1 }, (_, i) => s.slice(i, i + n));
  const noKey = (text: string) => windows(FAKE_KEY).every((w) => !text.includes(w));

  it("MUST-FAIL: async returns {run_id, status:'running'} before the script finishes", async () => {
    const t0 = Date.now();
    const r = await run({ script_id: "wait", mode: "async" });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.status).toBe("running");
    expect(typeof r.run_id).toBe("string");
    expect(r).not.toHaveProperty("stdout");
    expect(ranLines()).toEqual([]); // the script has not reached its end yet
    const fin = await poll(r.run_id);
    expect(fin.status).toBe("finished");
    expect(ranLines()).toEqual(["wait wait.sh"]);
  });

  it("MUST-FAIL: the poll returns the final result, same shape as sync, with the key redacted everywhere", async () => {
    const r = await run({ script_id: "wait", mode: "async" });
    const fin = await poll(r.run_id);
    expect(fin.ok).toBe(true);
    expect(fin.run_id).toBe(r.run_id);
    expect(fin.exit_code).toBe(0);
    expect(String(fin.stdout)).toContain("late=[REDACTED]");
    expect(String(fin.stdout)).toContain("done-waiting");
    const rec = fin.run as Record<string, unknown>;
    expect(rec.script_id).toBe("wait");
    expect(rec.redacted).toBe(true);
    expect(rec.timed_out).toBe(false);
    expect(noKey(JSON.stringify(fin))).toBe(true);
    expect(noKey(JSON.stringify(r))).toBe(true);
    for (const l of logged) expect(noKey(l)).toBe(true);
    // one log line per state change: started, then finished
    expect(logged.filter((l) => l.includes(String(r.run_id)) && /\bstarted\b/.test(l))).toHaveLength(1);
    expect(logged.filter((l) => l.includes(String(r.run_id)) && /\bfinished\b/.test(l))).toHaveLength(1);
  });

  it("MUST-FAIL: an async run past timeout_s is killed (whole tree) and reports timed_out:true", async () => {
    const r = await run({ script_id: "slow", mode: "async" });
    expect(r.status).toBe("running");
    const fin = await poll(r.run_id);
    expect(fin.status).toBe("finished");
    expect(fin.ok).toBe(false);
    expect((fin.run as Record<string, unknown>).timed_out).toBe(true);
    const child = Number(String(fin.stdout).match(/child=(\d+)/)?.[1]);
    const tchild = Number(String(fin.stdout).match(/tchild=(\d+)/)?.[1]);
    await Bun.sleep(200);
    for (const pid of [child, tchild]) expect(isRunning(pid)).toBe(false);
  });

  it("MUST-FAIL: an unknown run_id is refused", async () => {
    const r = await runAllowlistedScript({ type: "scriptRunResult", run_id: "no-such-run" }, { env: baseEnv(), log: (l) => logged.push(l) });
    refusedWith(r, "unknown_run");
  });

  it("MUST-FAIL: one script_id cannot have two concurrent runs: a second start (async or sync) is refused with the in-flight run_id", async () => {
    const first = await run({ script_id: "wait", mode: "async" });
    const second = await run({ script_id: "wait", mode: "async" });
    refusedWith(second, "already_running");
    expect(second.run_id).toBe(first.run_id);
    const sync = await run({ script_id: "wait" });
    refusedWith(sync, "already_running");
    expect(sync.run_id).toBe(first.run_id);
    // another script is not blocked
    expect((await run({ script_id: "fixture" })).ok).toBe(true);
    await poll(first.run_id);
    expect(ranLines().filter((l) => l.startsWith("wait"))).toHaveLength(1);
    // once finished, a new run may start
    const third = await run({ script_id: "wait", mode: "async" });
    expect(third.status).toBe("running");
    await poll(third.run_id);
  }, 30_000);

  it("MUST-FAIL: the sync cap is unchanged (900 s); async lifts the clamp to 3 h only", async () => {
    localRows = [row("r-long", entry("long", "fixture.sh", { timeout_s: 5000 })), row("r-huge", entry("huge", "fixture.sh", { timeout_s: 999999 }))];
    const s = await run({ script_id: "long" });
    expect((s.run as Record<string, unknown>).timeout_s).toBe(900);
    const a = await poll((await run({ script_id: "long", mode: "async" })).run_id);
    expect((a.run as Record<string, unknown>).timeout_s).toBe(5000);
    const h = await poll((await run({ script_id: "huge", mode: "async" })).run_id);
    expect((h.run as Record<string, unknown>).timeout_s).toBe(10800);
  }, 30_000);

  it("an async start refused before spawning answers the refusal at once, with no run_id", async () => {
    const r = await run({ script_id: "fixture", mode: "async", args: { mode: "turbo" } });
    refusedWith(r, "args_invalid");
    expect(r.run_id ?? null).toBeNull();
    refusedWith(await run({ script_id: "fixture", mode: "later" }), "mode_invalid");
  });

  it("a finished result is kept for the TTL, then the run_id is unknown", async () => {
    __setScriptRunTtlMsForTests(300);
    try {
      const r = await run({ script_id: "fixture", mode: "async" });
      const fin = await poll(r.run_id);
      expect(fin.status).toBe("finished");
      expect((await poll(r.run_id)).status).toBe("finished"); // still there inside the TTL
      await Bun.sleep(450);
      refusedWith(await runAllowlistedScript({ type: "scriptRunResult", run_id: r.run_id }, { env: baseEnv(), log: (l) => logged.push(l) }), "unknown_run");
    } finally {
      __setScriptRunTtlMsForTests(null);
    }
  });
});

describe("REDACT BEFORE TRUNCATE: a key straddling max_output_bytes leaks no prefix", () => {
  it("MUST-FAIL: with the key starting 1..12 bytes before the cap, no >=4-char key prefix survives on either stream", async () => {
    const straddle = () => row("r-straddle", entry("straddle", "straddle.sh", { max_output_bytes: 1000, args_schema: [{ name: "offset", type: "integer", min: 1, max: 60 }] }));
    localRows = [straddle()];
    const prefix = FAKE_KEY.slice(0, 4);
    expect("x".repeat(10) + "[REDACTED]").not.toContain(prefix); // the probe cannot match filler or the marker
    const leaks: string[] = [];
    for (let offset = 1; offset <= 12; offset++) {
      const r = await run({ script_id: "straddle", args: { offset } });
      expect(r.ok).toBe(true);
      const rec = r.run as Record<string, unknown>;
      for (const [name, out] of [["stdout", String(r.stdout)], ["stderr", String(r.stderr)]] as const) {
        if (Buffer.byteLength(out) > 1000) leaks.push(`offset ${offset} ${name}: ${Buffer.byteLength(out)} bytes, over the 1000-byte cap`);
        if (out.includes(prefix)) leaks.push(`offset ${offset} ${name}: a key prefix survives the cut`);
      }
      expect(rec.stdout_truncated).toBe(true);
      expect(rec.stdout_bytes).toBe(1000 - offset + FAKE_KEY.length);
      // the whole key was inside the kept window, so it was seen and redacted, at every offset
      if (rec.redacted !== true) leaks.push(`offset ${offset}: not reported as redacted`);
    }
    expect(leaks).toEqual([]);
  }, 30_000);
});

describe("RUN THE VERIFIED BYTES: the approved blob runs from a private copy, never the path", () => {
  const selfOf = (r: Record<string, unknown>) => String(r.stdout).match(/SELF=(.*)/)?.[1] ?? "";
  it("MUST-FAIL: a line appended to the script's path mid-run is NOT executed; the original bytes run", async () => {
    localRows = [row("r-midrun", entry("midrun", "midrun.sh"))];
    const original = readFileSync(abs("midrun.sh"), "utf8");
    try {
      const start = await run({ script_id: "midrun", mode: "async" });
      expect(start.status).toBe("running");
      await Bun.sleep(500);
      appendFileSync(abs("midrun.sh"), 'echo "INJECTED"\n');
      let fin: Record<string, unknown> = start;
      for (let i = 0; i < 100 && fin.status !== "finished"; i++) {
        await Bun.sleep(100);
        fin = await runAllowlistedScript({ type: "scriptRunResult", run_id: start.run_id }, { env: baseEnv(), log: (l) => logged.push(l) });
      }
      expect(fin.status).toBe("finished");
      expect(String(fin.stdout)).toContain("phase1");
      expect(String(fin.stdout)).toContain("phase2");
      expect(String(fin.stdout)).not.toContain("INJECTED");
      expect(fin.run as Record<string, unknown>).not.toHaveProperty("modified_during_run");
    } finally {
      writeFileSync(abs("midrun.sh"), original);
    }
  }, 30_000);

  it("MUST-FAIL: the snapshot is private (its root 0700), $0 and SUBSTRATE_SCRIPT_DIR are inside it, and cwd is its root", async () => {
    const r = await run({ script_id: "fixture" });
    expect(r.ok).toBe(true);
    const self = selfOf(r);
    expect(self).not.toBe(abs("fixture.sh"));
    expect(self).not.toContain(ROOT);
    const snap = dirname(dirname(dirname(self)));
    expect(self).toBe(join(snap, "validation", "scripts", "fixture.sh"));
    expect(String(r.stdout)).toContain("ROOTMODE=700");
    expect(String(r.stdout)).toContain(`SDIR=${join(snap, "validation", "scripts")}`);
    expect(String(r.stdout)).toContain(`PWD_NOW=${snap}`);
  });

  it("MUST-FAIL: the private copy and its directory are removed after a normal, a failed, a timed-out and an async run", async () => {
    localRows = [row("r-fixture", entry("fixture", "fixture.sh")), row("r-fail", entry("fail", "fail.sh")), row("r-slow", entry("slow", "slow.sh", { timeout_s: 1 }))];
    const ok = await run({ script_id: "fixture" });
    const failed = await run({ script_id: "fail" });
    expect(failed.exit_code).toBe(3);
    const timedOut = await run({ script_id: "slow" });
    expect((timedOut.run as Record<string, unknown>).timed_out).toBe(true);
    const a = await run({ script_id: "fixture", mode: "async" });
    let fin: Record<string, unknown> = a;
    for (let i = 0; i < 100 && fin.status !== "finished"; i++) { await Bun.sleep(50); fin = await runAllowlistedScript({ type: "scriptRunResult", run_id: a.run_id }, { env: baseEnv(), log: (l) => logged.push(l) }); }
    for (const r of [ok, failed, timedOut, fin]) {
      const self = selfOf(r);
      expect(self.length).toBeGreaterThan(0);
      expect(self).not.toBe(abs("fixture.sh"));
      expect(existsSync(self)).toBe(false);
      expect(existsSync(dirname(dirname(dirname(self))))).toBe(false); // the whole snapshot
    }
    // cleanup removed the link into the clone, never what it points at
    expect(ranLines().length).toBeGreaterThan(0);
  }, 30_000);

  it("MUST-FAIL: an approved commit that is not in the clone's object store is refused (commit_unavailable), nothing runs", async () => {
    localRows = [row("r-fixture", entry("fixture", "fixture.sh", { commit: "e".repeat(40) }))];
    refusedWith(await run({ script_id: "fixture" }), "commit_unavailable");
    expect(ranLines()).toEqual([]);
  });
});

describe("DOUBLE-FORK CONTAINMENT: an orphan the script detaches is still killed", () => {
  const alive = isRunning;
  const pidFrom = (name: string) => { try { return Number(readFileSync(join(OUT(), name), "utf8").trim()); } catch { return 0; } };
  const reap = (name: string) => { const p = pidFrom(name); if (p > 0) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } } try { rmSync(join(OUT(), name)); } catch { /* none */ } };

  it("MUST-FAIL: a script that double-forks a setsid sleeper and hangs is killed at timeout with no surviving pid", async () => {
    localRows = [row("r-dfh", entry("dfork-hang", "dfork-hang.sh", { timeout_s: 1 }))];
    try {
      const r = await run({ script_id: "dfork-hang" });
      expect((r.run as Record<string, unknown>).timed_out).toBe(true);
      const orphan = pidFrom("orphan-hang.pid");
      expect(orphan).toBeGreaterThan(0);
      await Bun.sleep(300);
      expect(alive(orphan)).toBe(false);
    } finally { reap("orphan-hang.pid"); }
  }, 30_000);

  it("MUST-FAIL: a script that double-forks a sleeper holding stdout and exits completes promptly, and the orphan is dead", async () => {
    localRows = [row("r-dfe", entry("dfork-exit", "dfork-exit.sh", { timeout_s: 4 }))];
    try {
      const t0 = Date.now();
      const r = await Promise.race([run({ script_id: "dfork-exit" }), Bun.sleep(12_000).then(() => ({ hung: true }) as Record<string, unknown>)]);
      expect(r.hung).toBeUndefined(); // before: the orphan held the pipe and the run never returned
      expect(Date.now() - t0).toBeLessThan(3_000); // well before timeout_s: cleanup at the script's exit
      expect(String(r.stdout)).toContain("parent-done");
      expect(r.exit_code).toBe(0);
      const orphan = pidFrom("orphan-exit.pid");
      expect(orphan).toBeGreaterThan(0);
      await Bun.sleep(300);
      expect(alive(orphan)).toBe(false);
    } finally { reap("orphan-exit.pid"); }
  }, 20_000);
});

describe("memory bound: the drain keeps at most its cap, whatever the stream sends", () => {
  it("MUST-FAIL: 200 KB through a 1000-byte drain keeps 1000 bytes and counts 200000", async () => {
    const drain = (scriptRunner as Record<string, unknown>)["drainCapped"] as ((s: ReadableStream<Uint8Array>, cap: number) => Promise<{ bytes: Uint8Array; total: number }>) | undefined;
    expect(typeof drain).toBe("function");
    const chunk = new Uint8Array(10_000).fill(120);
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(chunk); c.close(); } });
    const r = await drain!(stream, 1000);
    expect(r.bytes.byteLength).toBe(1000);
    expect(r.total).toBe(200_000);
  });
});

// ── PIN THE TREE ─────────────────────────────────────────────────────────────────────────────────────
// The row pins a COMMIT and the subtrees the script needs (`export`, plus `export_submodules` at the
// commit's gitlinks). The runner archives them from the object store into the private snapshot, so the
// script AND everything it runs (siblings, submodule code) are the approved commit's, before and during
// the run. Data dirs the script writes are declared `writable`: in the snapshot they are links into the
// clone, so results land where they always have.
describe("PIN THE TREE: siblings and submodule code run from the approved commit", () => {
  const mainRow = (extra: Record<string, unknown> = {}) => row("r-main", entry("main", "main.sh", {
    export_submodules: { "repos/sub": ["src"] },
    args_schema: [{ name: "delay", type: "integer", min: 0, max: 5 }],
    ...extra,
  }));
  const pollDone = async (run_id: unknown) => {
    let fin: Record<string, unknown> = { status: "running" };
    for (let i = 0; i < 150 && fin.status !== "finished"; i++) {
      await Bun.sleep(100);
      fin = await runAllowlistedScript({ type: "scriptRunResult", run_id }, { env: baseEnv(), log: (l) => logged.push(l) });
    }
    return fin;
  };
  const SIB = () => abs("sib.sh");
  const HELLO = () => join(ROOT, "repos", "sub", "src", "hello.sh");

  it("MUST-FAIL: a sibling and a submodule file modified in the working tree BEFORE the run: the committed versions run", async () => {
    localRows = [mainRow()];
    const sib = readFileSync(SIB(), "utf8"), hello = readFileSync(HELLO(), "utf8");
    try {
      writeFileSync(SIB(), '#!/usr/bin/env bash\necho "SIB=TAMPERED"\n');
      writeFileSync(HELLO(), '#!/usr/bin/env bash\necho "SUB=TAMPERED"\n');
      const r = await run({ script_id: "main" });
      expect(r.ok).toBe(true);
      expect(String(r.stdout)).toContain("SIB=committed");
      expect(String(r.stdout)).toContain("SUB=committed");
      expect(String(r.stdout)).not.toContain("TAMPERED");
    } finally { writeFileSync(SIB(), sib); writeFileSync(HELLO(), hello); }
  }, 30_000);

  it("MUST-FAIL: a sibling and a submodule file modified DURING the run: the committed versions run", async () => {
    localRows = [mainRow()];
    const sib = readFileSync(SIB(), "utf8"), hello = readFileSync(HELLO(), "utf8");
    try {
      const start = await run({ script_id: "main", mode: "async", args: { delay: 2 } });
      expect(start.status).toBe("running");
      await Bun.sleep(600);
      writeFileSync(SIB(), '#!/usr/bin/env bash\necho "SIB=TAMPERED"\n');
      writeFileSync(HELLO(), '#!/usr/bin/env bash\necho "SUB=TAMPERED"\n');
      const fin = await pollDone(start.run_id);
      expect(fin.ok).toBe(true);
      expect(String(fin.stdout)).toContain("SIB=committed");
      expect(String(fin.stdout)).toContain("SUB=committed");
      expect(String(fin.stdout)).not.toContain("TAMPERED");
    } finally { writeFileSync(SIB(), sib); writeFileSync(HELLO(), hello); }
  }, 30_000);

  it("MUST-FAIL: a commit not in the object store is refused; a commit not on the approved branch is refused", async () => {
    localRows = [mainRow({ commit: "e".repeat(40) })];
    refusedWith(await run({ script_id: "main" }), "commit_unavailable");
    localRows = [mainRow({ commit: SIDE_SHA })];
    refusedWith(await run({ script_id: "main" }), "commit_not_on_branch");
    localRows = [mainRow({ ancestor_of: "refs/remotes/origin/no-such-branch" })];
    refusedWith(await run({ script_id: "main" }), "commit_not_on_branch");
    expect(ranLines()).toEqual([]);
  });

  it("MUST-FAIL: a submodule whose gitlinked commit is not available in the clone is refused (submodule_unavailable)", async () => {
    localRows = [mainRow({ export_submodules: { "repos/nosuch": ["src"] } })];
    refusedWith(await run({ script_id: "main" }), "submodule_unavailable");
    // the live-clone case: the commit has the gitlink, the clone never initialised the submodule
    localRows = [mainRow({ commit: GHOST_SHA, export_submodules: { "repos/ghost": ["src"] } })];
    refusedWith(await run({ script_id: "main" }), "submodule_unavailable");
    expect(ranLines()).toEqual([]);
  });

  it("MUST-FAIL: a writable dir is a link into the clone: the result lands in the clone and survives the snapshot's removal", async () => {
    try { rmSync(join(OUT(), "result.txt")); } catch { /* none */ }
    localRows = [mainRow()];
    const r = await run({ script_id: "main" });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(OUT(), "result.txt"), "utf8").trim()).toBe("result-from-main");
    expect(existsSync(join(OUT(), ".gitkeep"))).toBe(true);
  }, 30_000);

  it("MUST-FAIL: a writable dir that overlaps code (the script's dir, or a submodule export) is an invalid entry", async () => {
    for (const writable of [["validation/scripts"], ["validation"], ["validation/scripts/lib"], ["repos/sub"], ["repos/sub/src"], ["repos"]]) {
      localRows = [mainRow({ writable })];
      refusedWith(await run({ script_id: "main" }), "allowlist_entry_invalid");
    }
    expect(ranLines()).toEqual([]);
  });

  it("an entry must pin a commit, export the script's path, and not carry the retired blob_sha field", async () => {
    localRows = [mainRow({ commit: undefined })];
    refusedWith(await run({ script_id: "main" }), "allowlist_entry_invalid");
    localRows = [mainRow({ export: ["validation/prompts"] })];
    refusedWith(await run({ script_id: "main" }), "allowlist_entry_invalid");
    localRows = [mainRow({ blob_sha: "a".repeat(40) })];
    refusedWith(await run({ script_id: "main" }), "allowlist_entry_invalid");
  });

  it("MUST-FAIL: an export larger than max_export_bytes is refused before anything runs", async () => {
    localRows = [mainRow({ max_export_bytes: 1000 })];
    const r = await run({ script_id: "main" });
    refusedWith(r, "export_too_large");
    expect(ranLines()).toEqual([]);
  });
});

describe("SYMLINKS IN THE SNAPSHOT: a committed link may not point out of it", () => {
  // git archive extracts a committed symlink as a symlink. One that points outside the snapshot (absolute,
  // or relative with enough ..) would let `bash "$D/lib/x.sh"` run working-tree or arbitrary code and
  // defeat the pin, so the snapshot is refused. A relative link that stays inside it is harmless.
  it("MUST-FAIL: an exported subtree with a link pointing out of the snapshot (absolute or ../ escape) is refused before anything runs", async () => {
    localRows = [row("r-fixture", entry("fixture", "fixture.sh", { export: ["validation/scripts", "validation/links"] }))];
    refusedWith(await run({ script_id: "fixture" }), "symlink_escapes_snapshot");
    expect(ranLines()).toEqual([]);
  });
  it("a relative link that stays inside the snapshot is allowed (validation/scripts/ok-link.sh -> fixture.sh)", async () => {
    const r = await run({ script_id: "fixture" });
    expect(r.ok).toBe(true);
  });
});
