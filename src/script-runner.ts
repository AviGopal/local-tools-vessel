// script-runner — run an OPERATOR-ALLOWLISTED repo script with the fleet credential injected server-side.
//
// WHY THIS EXISTS. The general shell (shellResult, bounded_shell) runs agent-issued command lines in a
// credential-free env (agent-shell-env.ts), by design: an LLM-authored command could send a key anywhere.
// That made every script that legitimately needs METABOB_API_KEY unreachable from a walk (observed:
// validation/scripts/run-weekly-harness.sh → "FATAL: METABOB_API_KEY is not set"). The key must never
// enter that shell. Instead this resolver runs ONLY scripts an operator approved, and the walk supplies a
// script id plus arguments that are validated against the approved schema, never a command line.
//
// THE TRUST ROOT. Approvals are `scriptRunnerAllowlist` pool rows, a TRUST-ROOT shape in
// development-vessel's pool store (pool-impulse.ts TRUST_ROOT_POOL_SHAPES): only an operator (admin)
// credential can write one, and the store's one writer stamps `attested: {by:"operator", key_id, at}` on
// the row, outside body. They are read AT USE TIME (law 1), every run, uncached, so a revocation or a
// re-approval takes effect on the next call. A row is accepted only if:
//   - it came from a LOCAL-origin poolImpulse producer (a federated peer's development-vessel stamps
//     attestations for ITS operator, not ours; discovery's origin stamp tells them apart);
//   - it is open, of this shape, and its top-level `attested.by === "operator"` (a body-level `attested`
//     is a caller's forgery the store strips; it is never read here).
// For a script_id held by several attested rows, the newest updated_at wins (the latest approval).
//
// ONE ENTRY (the row body):
//   { script_id, path, blob_sha, args_schema, timeout_s, max_output_bytes }
//   path      repo-relative, under the live super-repo clone; realpath must stay inside it.
//   blob_sha  the git blob hash (sha1, `git rev-parse HEAD:<path>`) of the approved content. The CURRENT
//             file is hashed before every run; a mismatch is refused until an operator re-approves.
//   args_schema  ordered [{name, type: "string"|"integer"|"boolean", enum?, pattern?, min?, max?,
//             max_length?, required?, flag?}]. argv is built in schema order: `flag value` when flag is
//             set, the bare value otherwise; a boolean is its flag when true and nothing when false. A
//             string arg must carry an enum or a pattern (anchored whole-value).
//
// EXECUTION. argv array `["bash", <realpath>, ...argv]` (never a shell string), cwd = the clone root, in a
// new process group; env = PATH (bun's dir prepended), HOME, LANG + METABOB_API_KEY + METABOB_ENDPOINT
// from THIS vessel's env, never from the request. On timeout the group AND every descendant found under
// /proc are killed (GNU `timeout` moves its child into a new group, which a group kill alone misses).
// stdout/stderr are capped at max_output_bytes each (the rest is drained and counted, not kept), and any
// 8-character window of the key is redacted from them and from every log line.
//
// THE DELIBERATE BYPASS. This is the one spawn site in this vessel that is not behind containShell: an
// approved script may write inside the live super-repo clone (run-weekly-harness.sh writes
// validation/results/). The attested row IS the operator's grant for exactly that content; nothing a walk
// sends can change what runs. Residual: the file is hashed, then executed by path (it must run at its real
// path; scripts locate the repo via BASH_SOURCE), so a write landing between the two is possible. The
// clone is write-contained against every tool, and the file is re-hashed after the run:
// `modified_during_run` says if it changed.
//
// TRACE. The returned `run` record (script_id, blob_sha, args, exit_code, timed_out, duration_ms, output
// sizes, truncation, redaction) is the step result the walk's trace carries; one `[script-runner]` log line
// per run or refusal. No env value is ever logged or returned.

import { HttpDiscoveryAdapter, FetchAdapter } from "@avigopal/ias-executor-ts/adapters";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { containmentZones } from "./write-containment.js";

export const SCRIPT_ALLOWLIST_SHAPE = "scriptRunnerAllowlist";
export const SCRIPT_RUN_SHAPE = "scriptRunResult";

const MAX_TIMEOUT_S = 900;
const DEFAULT_TIMEOUT_S = 300;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_STRING_MAX = 256;
const POOL_READ_TIMEOUT_MS = 10_000;
const REDACTED = "[REDACTED]";
const KEY_WINDOW = 8;

/** Pointer fields a caller may NOT supply: what runs, where, and with what env come only from the row. */
const FORBIDDEN_POINTER_FIELDS = ["command", "cmd", "path", "script", "env", "cwd", "blob_sha", "argv", "args_schema", "timeout_s", "max_output_bytes"];

type Env = Record<string, string | undefined>;
export type ArgSpec = {
  name: string; type: "string" | "integer" | "boolean";
  enum?: string[]; pattern?: string; min?: number; max?: number; max_length?: number; required?: boolean; flag?: string;
};
export type AllowlistEntry = { script_id: string; path: string; blob_sha: string; args_schema: ArgSpec[]; timeout_s: number; max_output_bytes: number };
type PoolRow = { id?: unknown; shape?: unknown; status?: unknown; updated_at?: unknown; body?: unknown; attested?: unknown };

export type RefusalCode =
  | "field_not_accepted" | "script_id_required" | "credential_unavailable" | "allowlist_unreadable" | "no_local_pool_producer"
  | "not_allowlisted" | "unattested_entry" | "allowlist_entry_invalid" | "args_invalid" | "no_super_repo_clone"
  | "path_outside_clone" | "script_unreadable" | "blob_mismatch" | "spawn_failed";

export interface ScriptRunDeps {
  /** The vessel env (default process.env): credentials, discovery endpoint, super-repo settings. */
  env?: Env;
  /** Log sink (default console.log). Every line passes through redaction first. */
  log?: (line: string) => void;
}

/** git's blob hash: sha1("blob <len>\0" + bytes), identical to `git hash-object --no-filters`. */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

// ── redaction ────────────────────────────────────────────────────────────────────────────────────────
/** Replace every span of `text` covered by any KEY_WINDOW-char window of any secret with [REDACTED]. */
export function redactSecrets(text: string, secrets: readonly string[]): { text: string; redacted: boolean } {
  const ranges: Array<[number, number]> = [];
  for (const s of secrets) {
    if (!s) continue;
    const n = Math.min(KEY_WINDOW, s.length);
    for (let i = 0; i + n <= s.length; i++) {
      const w = s.slice(i, i + n);
      for (let at = text.indexOf(w); at !== -1; at = text.indexOf(w, at + 1)) ranges.push([at, at + n]);
    }
  }
  if (ranges.length === 0) return { text, redacted: false };
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = 0;
  let cur: [number, number] | null = null;
  for (const r of ranges) {
    if (cur && r[0] <= cur[1]) { cur[1] = Math.max(cur[1], r[1]); continue; }
    if (cur) { out += text.slice(pos, cur[0]) + REDACTED; pos = cur[1]; }
    cur = [r[0], r[1]];
  }
  if (cur) { out += text.slice(pos, cur[0]) + REDACTED; pos = cur[1]; }
  return { text: out + text.slice(pos), redacted: true };
}

// ── the allowlist read (use time, local producers only) ───────────────────────────────────────────────
type AllowlistRead = { ok: true; rows: PoolRow[] } | { ok: false; code: "allowlist_unreadable" | "no_local_pool_producer"; why: string };

async function readAllowlistRows(env: Env): Promise<AllowlistRead> {
  const apiKey = env.METABOB_API_KEY?.trim() || undefined;
  const discoveryEndpoint = env.DISCOVERY_ENDPOINT?.trim() || "http://127.0.0.1:8100";
  // A fresh adapter per read: no cached producer list, so a run always sees the registry as it is now.
  const discovery = new HttpDiscoveryAdapter(new FetchAdapter(), discoveryEndpoint, { apiKey });
  const r = await discovery.lookup("poolImpulse");
  if (!r.ok) return { ok: false, code: "allowlist_unreadable", why: discovery.describe(r) };
  const local = [...new Set(r.producers.filter((p) => p.origin === "local" && p.resolveEndpoint).map((p) => p.resolveEndpoint))];
  if (local.length === 0) return { ok: false, code: "no_local_pool_producer", why: `no local-origin poolImpulse producer (${r.producers.length} non-local ignored)` };
  const rows: PoolRow[] = [];
  for (const url of local) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
        body: JSON.stringify({ impulse: { type: "poolImpulse", shape: SCRIPT_ALLOWLIST_SHAPE, status: "open" } }),
        signal: AbortSignal.timeout(POOL_READ_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, code: "allowlist_unreadable", why: `pool producer ${url} answered HTTP ${res.status}` };
      const j = (await res.json()) as { body?: { impulses?: unknown } };
      const imps = j?.body?.impulses;
      if (!Array.isArray(imps)) return { ok: false, code: "allowlist_unreadable", why: `pool producer ${url} answered without an impulses array` };
      rows.push(...(imps as PoolRow[]));
    } catch (err) {
      return { ok: false, code: "allowlist_unreadable", why: `pool producer ${url}: ${String((err as Error)?.message ?? err)}` };
    }
  }
  return { ok: true, rows };
}

const isAttested = (r: PoolRow): boolean => {
  const a = r.attested as { by?: unknown } | undefined;
  return typeof a === "object" && a !== null && a.by === "operator";
};
const rowScriptId = (r: PoolRow): string | undefined => {
  const id = (r.body as { script_id?: unknown } | null | undefined)?.script_id;
  return typeof id === "string" ? id : undefined;
};

/** The approved entry for `scriptId`: the newest open, attested row of the shape. */
function pickEntry(rows: PoolRow[], scriptId: string): { ok: true; row: PoolRow } | { ok: false; code: "not_allowlisted" | "unattested_entry" } {
  const mine = rows.filter((r) => r.shape === SCRIPT_ALLOWLIST_SHAPE && r.status === "open" && rowScriptId(r) === scriptId);
  const attested = mine.filter(isAttested);
  if (attested.length === 0) return { ok: false, code: mine.length > 0 ? "unattested_entry" : "not_allowlisted" };
  attested.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  return { ok: true, row: attested[0]! };
}

function parseEntry(body: unknown): { ok: true; entry: AllowlistEntry } | { ok: false; why: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { ok: false, why: "row body is not an object" };
  const { script_id, path, blob_sha, args_schema } = b;
  if (typeof script_id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(script_id)) return { ok: false, why: "script_id must be 1-64 of [A-Za-z0-9._-]" };
  if (typeof path !== "string" || path.trim() === "") return { ok: false, why: "path is required" };
  if (typeof blob_sha !== "string" || !/^[0-9a-f]{40}$/.test(blob_sha)) return { ok: false, why: "blob_sha must be a 40-hex git blob hash" };
  const schema = args_schema ?? [];
  if (!Array.isArray(schema)) return { ok: false, why: "args_schema must be an array" };
  const names = new Set<string>();
  for (const s of schema as ArgSpec[]) {
    if (!s || typeof s.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s.name) || names.has(s.name)) return { ok: false, why: "every arg needs a unique name" };
    names.add(s.name);
    if (s.type !== "string" && s.type !== "integer" && s.type !== "boolean") return { ok: false, why: `arg ${s.name}: type must be string, integer or boolean` };
    if (s.flag !== undefined && (typeof s.flag !== "string" || !/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s.flag))) return { ok: false, why: `arg ${s.name}: flag must look like -x or --name` };
    if (s.type === "boolean" && !s.flag) return { ok: false, why: `arg ${s.name}: a boolean arg needs a flag` };
    if (s.type === "string") {
      const hasEnum = Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every((e) => typeof e === "string");
      const hasPattern = typeof s.pattern === "string" && s.pattern.length > 0;
      if (!hasEnum && !hasPattern) return { ok: false, why: `arg ${s.name}: a string arg must be constrained by enum or pattern` };
      if (hasPattern) { try { new RegExp(`^(?:${s.pattern})$`, "u"); } catch { return { ok: false, why: `arg ${s.name}: pattern does not compile` }; } }
    }
  }
  const num = (v: unknown, dflt: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : dflt);
  return {
    ok: true,
    entry: { script_id, path: path.trim(), blob_sha, args_schema: schema as ArgSpec[], timeout_s: num(b.timeout_s, DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S), max_output_bytes: num(b.max_output_bytes, DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES) },
  };
}

/** Validate the caller's args against the schema; return argv in schema order, or why not. */
export function buildArgv(schema: ArgSpec[], raw: unknown): { ok: true; argv: string[]; args: Record<string, unknown> } | { ok: false; why: string } {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, why: "args must be an object of name → value" };
  const given = raw as Record<string, unknown>;
  const known = new Set(schema.map((s) => s.name));
  const unknown = Object.keys(given).filter((k) => !known.has(k));
  if (unknown.length > 0) return { ok: false, why: `unknown arg(s): ${unknown.join(", ")}` };
  const argv: string[] = [];
  const args: Record<string, unknown> = {};
  for (const s of schema) {
    const v = given[s.name];
    if (v === undefined || v === null) {
      if (s.required) return { ok: false, why: `arg ${s.name} is required` };
      continue;
    }
    if (s.type === "boolean") {
      if (typeof v !== "boolean") return { ok: false, why: `arg ${s.name} must be a boolean` };
      if (v) argv.push(s.flag!);
      args[s.name] = v;
      continue;
    }
    let value: string;
    if (s.type === "integer") {
      if (typeof v !== "number" || !Number.isSafeInteger(v)) return { ok: false, why: `arg ${s.name} must be an integer` };
      if (typeof s.min === "number" && v < s.min) return { ok: false, why: `arg ${s.name} is below ${s.min}` };
      if (typeof s.max === "number" && v > s.max) return { ok: false, why: `arg ${s.name} is above ${s.max}` };
      value = String(v);
    } else {
      if (typeof v !== "string") return { ok: false, why: `arg ${s.name} must be a string` };
      const maxLen = typeof s.max_length === "number" && s.max_length > 0 ? s.max_length : DEFAULT_STRING_MAX;
      if (v.length === 0 || v.length > maxLen) return { ok: false, why: `arg ${s.name} must be 1-${maxLen} characters` };
      if (/[\0\r\n]/.test(v)) return { ok: false, why: `arg ${s.name} contains a NUL or newline` };
      const inEnum = Array.isArray(s.enum) && s.enum.includes(v);
      if (v.startsWith("-") && !inEnum) return { ok: false, why: `arg ${s.name} may not start with '-'` };
      if (Array.isArray(s.enum) && s.enum.length > 0 && !inEnum) return { ok: false, why: `arg ${s.name} must be one of the approved values` };
      if (typeof s.pattern === "string" && s.pattern.length > 0 && !new RegExp(`^(?:${s.pattern})$`, "u").test(v)) return { ok: false, why: `arg ${s.name} does not match the approved pattern` };
      value = v;
    }
    if (s.flag) argv.push(s.flag);
    argv.push(value);
    args[s.name] = v;
  }
  return { ok: true, argv, args };
}

/** The child env: a minimal base plus the two injected names, from the vessel env only. */
export function scriptRunnerEnv(base: Env): Record<string, string> {
  const out: Record<string, string> = {};
  const home = base.HOME?.trim() || "/root";
  out.PATH = `${home}/.bun/bin:${base.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;
  out.HOME = home;
  if (base.LANG?.trim()) out.LANG = base.LANG;
  if (base.METABOB_API_KEY?.trim()) out.METABOB_API_KEY = base.METABOB_API_KEY;
  if (base.METABOB_ENDPOINT?.trim()) out.METABOB_ENDPOINT = base.METABOB_ENDPOINT;
  return out;
}

/** The repo-relative path resolved inside the clone, or why it is not inside. */
function containPath(root: string, p: string): { ok: true; real: string } | { ok: false; why: string } {
  if (isAbsolute(p)) return { ok: false, why: "path must be repo-relative" };
  if (p.split(/[\\/]+/).includes("..")) return { ok: false, why: "path may not contain '..'" };
  let real: string;
  try { real = realpathSync(join(root, p)); } catch { return { ok: false, why: "path does not exist in the clone" }; }
  const r = relative(root, real);
  if (r === "" || r.startsWith("..") || isAbsolute(r) || r.split(sep)[0] === "..") return { ok: false, why: "path resolves outside the clone" };
  try { if (!statSync(real).isFile()) return { ok: false, why: "path is not a regular file" }; } catch { return { ok: false, why: "path is not a regular file" }; }
  return { ok: true, real };
}

// ── process-tree kill ────────────────────────────────────────────────────────────────────────────────
function descendants(pid: number): number[] {
  const children = new Map<number, number[]>();
  let entries: string[] = [];
  try { entries = readdirSync("/proc"); } catch { return []; }
  for (const d of entries) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const list = children.get(ppid) ?? [];
      list.push(Number(d));
      children.set(ppid, list);
    } catch { /* exited */ }
  }
  const out: number[] = [];
  const stack = [pid];
  while (stack.length) for (const c of children.get(stack.pop()!) ?? []) { out.push(c); stack.push(c); }
  return out;
}
function killTree(pid: number): void {
  const desc = descendants(pid); // collect BEFORE killing: a dead parent's children are reparented
  try { process.kill(-pid, "SIGKILL"); } catch { /* group gone */ }
  for (const d of [pid, ...desc]) { try { process.kill(d, "SIGKILL"); } catch { /* gone */ } }
}

async function drainCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<{ bytes: Uint8Array; total: number; truncated: boolean }> {
  const kept: Uint8Array[] = [];
  let keptLen = 0;
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (keptLen < cap) {
      const take = value.subarray(0, Math.min(value.byteLength, cap - keptLen));
      kept.push(take);
      keptLen += take.byteLength;
    }
  }
  const bytes = new Uint8Array(keptLen);
  let o = 0;
  for (const k of kept) { bytes.set(k, o); o += k.byteLength; }
  return { bytes, total, truncated: total > keptLen };
}

// ── the resolver ─────────────────────────────────────────────────────────────────────────────────────
export async function runAllowlistedScript(pointer: Record<string, unknown>, deps: ScriptRunDeps = {}): Promise<Record<string, unknown>> {
  const env = deps.env ?? process.env;
  const secrets = [env.METABOB_API_KEY ?? ""].filter((s) => s.length > 0);
  const log = (line: string) => (deps.log ?? ((l: string) => console.log(l)))(redactSecrets(line, secrets).text);
  const scriptId = typeof pointer.script_id === "string" ? pointer.script_id : undefined;
  const refuse = (code: RefusalCode, why: string): Record<string, unknown> => {
    const error = redactSecrets(`${code}: ${why}`, secrets).text;
    log(`[script-runner] REFUSED script_id=${JSON.stringify(scriptId ?? null)} reason=${code} (${why})`);
    return { shape: SCRIPT_RUN_SHAPE, ok: false, refused: code, error, script_id: scriptId ?? null };
  };

  const forbidden = FORBIDDEN_POINTER_FIELDS.filter((k) => pointer[k] !== undefined);
  if (forbidden.length > 0) return refuse("field_not_accepted", `the caller may send only script_id and args; refused: ${forbidden.join(", ")}`);
  if (!scriptId) return refuse("script_id_required", "script_id is required");
  if (secrets.length === 0) return refuse("credential_unavailable", "this vessel has no METABOB_API_KEY to inject");

  const read = await readAllowlistRows(env).catch((e) => ({ ok: false as const, code: "allowlist_unreadable" as const, why: String((e as Error)?.message ?? e) }));
  if (!read.ok) return refuse(read.code, read.why);
  const picked = pickEntry(read.rows, scriptId);
  if (!picked.ok) return refuse(picked.code, picked.code === "unattested_entry" ? "the only rows for this script_id carry no operator attestation" : "no open scriptRunnerAllowlist row names this script_id");
  const parsed = parseEntry(picked.row.body);
  if (!parsed.ok) return refuse("allowlist_entry_invalid", parsed.why);
  const entry = parsed.entry;

  const argv = buildArgv(entry.args_schema, pointer.args);
  if (!argv.ok) return refuse("args_invalid", argv.why);

  const root = containmentZones(env).supers[0];
  if (!root) return refuse("no_super_repo_clone", "no live super-repo clone is configured on this node");
  const contained = containPath(root, entry.path);
  if (!contained.ok) return refuse("path_outside_clone", `${entry.path}: ${contained.why}`);
  let before: string;
  try {
    if (lstatSync(contained.real).size > 8 * 1024 * 1024) return refuse("script_unreadable", "script is larger than 8 MiB");
    before = gitBlobSha(readFileSync(contained.real));
  } catch (e) { return refuse("script_unreadable", String((e as Error)?.message ?? e)); }
  if (before !== entry.blob_sha) return refuse("blob_mismatch", `${entry.path} is ${before}, approved ${entry.blob_sha}; an operator must re-approve the changed script`);

  const started = Date.now();
  let timedOut = false;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["bash", contained.real, ...argv.argv], {
      cwd: root, env: scriptRunnerEnv(env), stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
    });
  } catch (e) { return refuse("spawn_failed", String((e as Error)?.message ?? e)); }
  const timer = setTimeout(() => { timedOut = true; killTree(proc.pid); }, entry.timeout_s * 1000);
  let out: Awaited<ReturnType<typeof drainCapped>>, err: Awaited<ReturnType<typeof drainCapped>>, exitCode: number | null;
  try {
    const exited = proc.exited.then((c) => {
      // The script is done; anything it left running in its group goes with it, which also releases
      // the pipes a lingering background child would otherwise hold open until the timeout.
      try { process.kill(-proc.pid, "SIGKILL"); } catch { /* group empty */ }
      return c;
    });
    [out, err, exitCode] = await Promise.all([
      drainCapped(proc.stdout as ReadableStream<Uint8Array>, entry.max_output_bytes),
      drainCapped(proc.stderr as ReadableStream<Uint8Array>, entry.max_output_bytes),
      exited,
    ]);
  } finally {
    clearTimeout(timer);
  }
  const duration_ms = Date.now() - started;
  let after: string | null = null;
  try { after = gitBlobSha(readFileSync(contained.real)); } catch { /* removed during the run */ }
  const dec = new TextDecoder("utf-8", { fatal: false });
  const so = redactSecrets(dec.decode(out.bytes), secrets);
  const se = redactSecrets(dec.decode(err.bytes), secrets);
  const run = {
    script_id: entry.script_id,
    blob_sha: entry.blob_sha,
    args: argv.args,
    exit_code: exitCode,
    timed_out: timedOut,
    duration_ms,
    stdout_bytes: out.total,
    stderr_bytes: err.total,
    stdout_truncated: out.truncated,
    stderr_truncated: err.truncated,
    redacted: so.redacted || se.redacted,
    modified_during_run: after !== entry.blob_sha,
  };
  log(`[script-runner] ran script_id=${entry.script_id} blob=${entry.blob_sha.slice(0, 12)} args=${JSON.stringify(argv.args)} exit=${exitCode} timed_out=${timedOut} duration_ms=${duration_ms} stdout=${out.total}B stderr=${err.total}B${run.stdout_truncated || run.stderr_truncated ? " truncated" : ""}${run.redacted ? " redacted" : ""}${run.modified_during_run ? " MODIFIED_DURING_RUN" : ""}`);
  return {
    shape: SCRIPT_RUN_SHAPE,
    ok: !timedOut && exitCode === 0,
    script_id: entry.script_id,
    exit_code: exitCode,
    stdout: so.text,
    stderr: se.text,
    run,
  };
}
