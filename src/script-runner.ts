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
// EXECUTION. The current file at `path` must hash to blob_sha (the approval gate); what runs is the blob
// itself, read from the clone's object store by hash (`git cat-file blob`, re-hashed) into a private copy
// (a fresh mkdtemp dir 0700, file 0700, removed after the run), as argv `["bash", <copy>, ...argv]` (never
// a shell string), cwd = the clone root, in a new process group. bash reads a script as it goes, so
// running the path would execute whatever the file held at each read for the whole run (up to 3 h). Since
// $0 / BASH_SOURCE name the copy, the env carries SUBSTRATE_SCRIPT_DIR = the original's real directory,
// and a script locates its siblings through it. env = PATH (bun's dir prepended), HOME, LANG,
// METABOB_API_KEY, METABOB_ENDPOINT from THIS vessel's env (never from the request), SUBSTRATE_SCRIPT_DIR.
// On timeout the group AND every descendant found under /proc are killed (GNU `timeout` moves its child
// into a new group, which a group kill alone misses). Each stream is kept to max_output_bytes plus one key
// length, redacted (any 8-character window of the key), and only then cut to max_output_bytes.
//
// THE DELIBERATE BYPASS. This is the one spawn site in this vessel that is not behind containShell: an
// approved script may write inside the live super-repo clone (run-weekly-harness.sh writes
// validation/results/). The attested row IS the operator's grant for exactly that content; nothing a walk
// sends can change what runs. LIMIT: only the top-level script's bytes are verified. Whatever it runs in
// turn (run-weekly-harness.sh `bun run`s reuse-harness.ts, compare-reports.ts, ... from its directory)
// comes from the working tree, unverified, and can change mid-run; trusting those is trusting the clone.
// `modified_during_run` (the path file re-hashed after the run) is informational only.
//
// MODES. Sync (default) holds the request until the script ends, with timeout_s clamped to 900 s.
// mode:"async" answers {run_id, status:"running"} at once and is read back with {run_id}; its timeout_s
// clamp is 3 h. Either way one script_id has at most one run in flight (see the run registry below).
//
// TRACE. The returned `run` record (script_id, blob_sha, args, exit_code, timed_out, duration_ms, output
// sizes, truncation, redaction) is the step result the walk's trace carries; one `[script-runner]` log line
// per run or refusal. No env value is ever logged or returned.

import { HttpDiscoveryAdapter, FetchAdapter } from "@avigopal/ias-executor-ts/adapters";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { containmentZones } from "./write-containment.js";
import { killTree } from "./proc-tree.js";

export const SCRIPT_ALLOWLIST_SHAPE = "scriptRunnerAllowlist";
export const SCRIPT_RUN_SHAPE = "scriptRunResult";

/** Sync runs hold the caller's request open, so their clamp stays at the shell's 900 s. */
const MAX_TIMEOUT_S = 900;
/** Async runs answer at once and are polled, so an entry may ask for up to 3 h. */
const MAX_ASYNC_TIMEOUT_S = 3 * 60 * 60;
/** How long a finished async result stays readable by its run_id. */
const DEFAULT_RESULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_S = 300;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_STRING_MAX = 256;
const POOL_READ_TIMEOUT_MS = 10_000;
/** Every pool status, read so a retirement or consumption of an approval is seen. */
const ROW_STATUSES = ["open", "retired", "consumed"] as const;
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
  | "not_allowlisted" | "unattested_entry" | "attestation_unverified" | "allowlist_entry_invalid" | "args_invalid" | "no_super_repo_clone"
  | "path_outside_clone" | "script_unreadable" | "blob_mismatch" | "spawn_failed"
  | "mode_invalid" | "unknown_run" | "already_running" | "blob_unavailable";

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
  // Every state an approval can be in, not only "open": a retirement must be SEEN to win over a replayed
  // older "open" copy of the same id (development-vessel's read answers one status per request).
  for (const url of local) for (const status of ROW_STATUSES) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
        body: JSON.stringify({ impulse: { type: "poolImpulse", shape: SCRIPT_ALLOWLIST_SHAPE, status } }),
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

/** Key-sorted JSON. TWIN: development-vessel src/resolvers/pool-impulse.ts canonicalJson; change both. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

/** THE ORIGIN LINK IS NOT TRUSTED. Discovery stamps ANY authenticated plain registration "local"
 *  (discovery-vessel src/resolvers.ts localOrigin), so a producer listed as local may be a rogue one,
 *  and attested.key_id is a public identifier anyone can copy. What proves an approval is the stamp's
 *  signature: HMAC-SHA256 under this node's METABOB_API_KEY, computed by development-vessel's pool writer
 *  only after identity accepted an admin credential. A peer node's writer signs with its own key; a rogue
 *  producer has none. TWIN: development-vessel src/resolvers/pool-impulse.ts attestationSig. */
export function attestationSig(key: string, row: { id?: unknown; shape?: unknown; status?: unknown; body?: unknown }, keyId: string | null, at: string): string {
  return createHmac("sha256", key)
    .update(["substrate-pool-attestation/v1", String(row.id), String(row.shape), String(row.status), canonicalJson(row.body), keyId ?? "", at].join("\n"))
    .digest("hex");
}
function attestationVerified(r: PoolRow, key: string): boolean {
  const a = r.attested as { key_id?: unknown; at?: unknown; sig?: unknown } | undefined;
  if (!a || typeof a.sig !== "string" || !/^[0-9a-f]{64}$/.test(a.sig) || typeof a.at !== "string") return false;
  if (a.key_id !== null && a.key_id !== undefined && typeof a.key_id !== "string") return false;
  const want = Buffer.from(attestationSig(key, r, (a.key_id as string | null | undefined) ?? null, a.at), "hex");
  const got = Buffer.from(a.sig, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The approved entry for `scriptId`. Per POOL ID, the current state is the newest row whose operator stamp
 *  verifies (any status), so a newer signed retirement displaces an older signed "open" that a rogue
 *  producer replays; unverified rows never count, so a forged retirement displaces nothing. Among the ids
 *  whose current state is open and names this script_id, the newest wins. */
function pickEntry(rows: PoolRow[], scriptId: string, key: string): { ok: true; row: PoolRow } | { ok: false; code: "not_allowlisted" | "unattested_entry" | "attestation_unverified" } {
  const newest = (a: PoolRow, b: PoolRow) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""));
  const ofShape = rows.filter((r) => r.shape === SCRIPT_ALLOWLIST_SHAPE);
  const current = new Map<string, PoolRow>();
  for (const r of ofShape.filter((r) => isAttested(r) && attestationVerified(r, key)).sort(newest)) {
    const id = String(r.id ?? "");
    if (!current.has(id)) current.set(id, r);
  }
  const live = [...current.values()].filter((r) => r.status === "open" && rowScriptId(r) === scriptId).sort(newest);
  if (live.length > 0) return { ok: true, row: live[0]! };
  // No approval: say why, from the open rows that name this script_id.
  const mine = ofShape.filter((r) => r.status === "open" && rowScriptId(r) === scriptId);
  if (mine.length === 0) return { ok: false, code: "not_allowlisted" };
  const attested = mine.filter(isAttested);
  if (attested.length === 0) return { ok: false, code: "unattested_entry" };
  if (!attested.some((r) => attestationVerified(r, key))) return { ok: false, code: "attestation_unverified" };
  return { ok: false, code: "not_allowlisted" }; // verified, but superseded by a newer signed state of its id
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
    entry: { script_id, path: path.trim(), blob_sha, args_schema: schema as ArgSpec[], timeout_s: num(b.timeout_s, DEFAULT_TIMEOUT_S, MAX_ASYNC_TIMEOUT_S), max_output_bytes: num(b.max_output_bytes, DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES) },
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

/** The child env: a minimal base plus the two injected names, from the vessel env only, and
 *  SUBSTRATE_SCRIPT_DIR (the approved script's real directory: the script runs from a private copy, so
 *  `dirname "$0"` / BASH_SOURCE name the copy; a script finds its siblings through this instead). */
export function scriptRunnerEnv(base: Env, scriptDir?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const home = base.HOME?.trim() || "/root";
  out.PATH = `${home}/.bun/bin:${base.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;
  out.HOME = home;
  if (base.LANG?.trim()) out.LANG = base.LANG;
  if (base.METABOB_API_KEY?.trim()) out.METABOB_API_KEY = base.METABOB_API_KEY;
  if (base.METABOB_ENDPOINT?.trim()) out.METABOB_ENDPOINT = base.METABOB_ENDPOINT;
  if (scriptDir) out.SUBSTRATE_SCRIPT_DIR = scriptDir;
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

// ── process-tree kill: proc-tree.ts; double-fork containment: script-runner-reaper.ts ─────────────────
/** The containment parent every run goes through (a child subreaper, so double-forked orphans stay in the
 *  tree killTree walks). One extra Bun process per run. */
const REAPER = join(import.meta.dir, "script-runner-reaper.ts");

/** REDACT BEFORE TRUNCATE. A cut made before redaction can split a key so that fewer than KEY_WINDOW of its
 *  characters remain, and no window then matches them. So the stream is kept to `cap + overlap` bytes
 *  (overlap = the longest secret's length, so a key that starts before the cap is held whole), decoded,
 *  redacted, and only THEN cut to `cap` bytes. The cut can split "[REDACTED]" but never a key. */
export function redactThenCap(bytes: Uint8Array, cap: number, secrets: readonly string[]): { text: string; redacted: boolean } {
  const r = redactSecrets(new TextDecoder("utf-8", { fatal: false }).decode(bytes), secrets);
  const enc = new TextEncoder().encode(r.text);
  if (enc.byteLength <= cap) return r;
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(enc.subarray(0, cap)), redacted: r.redacted };
}

export async function drainCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<{ bytes: Uint8Array; total: number; truncated: boolean }> {
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

// ── run registry (in memory only) ────────────────────────────────────────────────────────────────────
// ASYNC MODE. mode:"async" validates exactly as a sync run, starts the script, and answers
// {run_id, status:"running"} at once; {run_id} later answers running or the final result (the sync
// shape plus run_id and status:"finished"). A finished result is kept RESULT_TTL in memory and then
// forgotten; nothing is persisted (the walk's own step trace carries what it read). A vessel restart
// forgets every run: its run_ids answer unknown_run and the scripts die with the process group.
// ONE RUN PER SCRIPT_ID. A second start of a script_id with a run in flight, async or sync, is REFUSED
// (already_running) with the in-flight run_id to poll, never queued and never joined: two copies of a
// harness writing the same results directory would corrupt each other, and a refusal says so plainly.
type RunRecord = { script_id: string; started_at: number; finished_at?: number; result?: Record<string, unknown> };
const runs = new Map<string, RunRecord>();
const inFlight = new Map<string, string>(); // script_id → run_id
let resultTtlMs = DEFAULT_RESULT_TTL_MS;
/** Tests only: shorten the result TTL (null restores the default). */
export function __setScriptRunTtlMsForTests(ms: number | null): void { resultTtlMs = ms ?? DEFAULT_RESULT_TTL_MS; }
function sweepExpired(log: (l: string) => void): void {
  const now = Date.now();
  for (const [id, r] of runs) {
    if (r.finished_at !== undefined && now - r.finished_at > resultTtlMs) {
      runs.delete(id);
      log(`[script-runner] expired run_id=${id} script_id=${r.script_id}`);
    }
  }
}

// ── the resolver ─────────────────────────────────────────────────────────────────────────────────────
type Prepared = { entry: AllowlistEntry; argv: string[]; args: Record<string, unknown>; root: string; real: string; blob: Uint8Array };

/** The approved bytes, from the clone's OBJECT STORE by hash (never the working tree), re-hashed. */
function readVerifiedBlob(root: string, sha: string, env: Env): { ok: true; bytes: Uint8Array } | { ok: false; why: string } {
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    r = Bun.spawnSync(["git", "cat-file", "blob", sha], { cwd: root, env: { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: env.HOME ?? "/root" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) { return { ok: false, why: `git cat-file could not run: ${String((e as Error)?.message ?? e)}` }; }
  if (r.exitCode !== 0 || !r.stdout) return { ok: false, why: `${sha} is not in the clone's object store (an approved hash must be committed or fetched into the clone)` };
  const bytes = new Uint8Array(r.stdout as Uint8Array);
  if (gitBlobSha(bytes) !== sha) return { ok: false, why: `the object store returned bytes that do not hash to ${sha}` };
  return { ok: true, bytes };
}

export async function runAllowlistedScript(pointer: Record<string, unknown>, deps: ScriptRunDeps = {}): Promise<Record<string, unknown>> {
  const env = deps.env ?? process.env;
  const secrets = [env.METABOB_API_KEY ?? ""].filter((s) => s.length > 0);
  const log = (line: string) => (deps.log ?? ((l: string) => console.log(l)))(redactSecrets(line, secrets).text);
  const scriptId = typeof pointer.script_id === "string" ? pointer.script_id : undefined;
  const refuse = (code: RefusalCode, why: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const error = redactSecrets(`${code}: ${why}`, secrets).text;
    log(`[script-runner] REFUSED script_id=${JSON.stringify(scriptId ?? null)} reason=${code} (${why})`);
    return { shape: SCRIPT_RUN_SHAPE, ok: false, refused: code, error, script_id: scriptId ?? null, ...extra };
  };
  sweepExpired(log);

  // A POLL: {run_id} answers the run's state. It needs no credential and starts nothing.
  if (pointer.run_id !== undefined) {
    const runId = typeof pointer.run_id === "string" ? pointer.run_id : "";
    const rec = runs.get(runId);
    if (!rec) return refuse("unknown_run", `no run ${JSON.stringify(runId.slice(0, 80))} is held here (never started, expired, or this vessel restarted)`);
    if (!rec.result) return { shape: SCRIPT_RUN_SHAPE, status: "running", run_id: runId, script_id: rec.script_id, started_at: new Date(rec.started_at).toISOString(), elapsed_ms: Date.now() - rec.started_at };
    return rec.result;
  }

  const mode = pointer.mode ?? "sync";
  if (mode !== "sync" && mode !== "async") return refuse("mode_invalid", `mode must be "sync" or "async"`);
  const forbidden = FORBIDDEN_POINTER_FIELDS.filter((k) => pointer[k] !== undefined);
  if (forbidden.length > 0) return refuse("field_not_accepted", `the caller may send only script_id, args and mode; refused: ${forbidden.join(", ")}`);
  if (!scriptId) return refuse("script_id_required", "script_id is required");
  if (secrets.length === 0) return refuse("credential_unavailable", "this vessel has no METABOB_API_KEY to inject");

  const read = await readAllowlistRows(env).catch((e) => ({ ok: false as const, code: "allowlist_unreadable" as const, why: String((e as Error)?.message ?? e) }));
  if (!read.ok) return refuse(read.code, read.why);
  const picked = pickEntry(read.rows, scriptId, secrets[0]!);
  if (!picked.ok) return refuse(picked.code, picked.code === "unattested_entry" ? "the only rows for this script_id carry no operator attestation"
    : picked.code === "attestation_unverified" ? "no operator stamp for this script_id carries a valid signature under this node's key (unsigned, signed by another node, or altered after signing)"
    : "no open scriptRunnerAllowlist row names this script_id");
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
  // RUN THE VERIFIED BYTES. The hash check above is the APPROVAL GATE (the script as the clone has it now
  // must be the approved one, so an approval for a script the clone dropped or changed does not run). What
  // RUNS is the blob itself, from the object store, through a private copy: bash reads a script as it
  // goes, so running the path would execute whatever the file holds at each read, for the whole run.
  const blob = readVerifiedBlob(root, entry.blob_sha, env);
  if (!blob.ok) return refuse("blob_unavailable", blob.why);

  // Check-and-take the per-script slot with no await in between, so two concurrent starts cannot both pass.
  const holder = inFlight.get(entry.script_id);
  if (holder) return refuse("already_running", `script ${entry.script_id} already has run ${holder} in flight; poll it with {run_id}`, { run_id: holder });
  const runId = crypto.randomUUID();
  inFlight.set(entry.script_id, runId);
  const timeoutS = mode === "async" ? entry.timeout_s : Math.min(entry.timeout_s, MAX_TIMEOUT_S);
  const prepared: Prepared = { entry, argv: argv.argv, args: argv.args, root, real: contained.real, blob: blob.bytes };

  if (mode === "sync") {
    try { return await execute(prepared, timeoutS, env, secrets, log, null); }
    finally { inFlight.delete(entry.script_id); }
  }
  const startedAt = Date.now();
  runs.set(runId, { script_id: entry.script_id, started_at: startedAt });
  log(`[script-runner] started run_id=${runId} script_id=${entry.script_id} blob=${entry.blob_sha.slice(0, 12)} timeout_s=${timeoutS}`);
  void execute(prepared, timeoutS, env, secrets, log, runId)
    .catch((e) => ({ shape: SCRIPT_RUN_SHAPE, ok: false, script_id: entry.script_id, error: `script runner failed: ${(e as Error)?.name ?? "error"}` }) as Record<string, unknown>)
    .then((result) => {
      runs.set(runId, { script_id: entry.script_id, started_at: startedAt, finished_at: Date.now(), result: { ...result, run_id: runId, status: "finished" } });
    })
    .finally(() => { if (inFlight.get(entry.script_id) === runId) inFlight.delete(entry.script_id); });
  return { shape: SCRIPT_RUN_SHAPE, status: "running", run_id: runId, script_id: entry.script_id, timeout_s: timeoutS };
}

async function execute(p: Prepared, timeoutS: number, env: Env, secrets: string[], log: (l: string) => void, runId: string | null): Promise<Record<string, unknown>> {
  // The private copy: a fresh 0700 directory holding a 0700 file of the verified bytes, removed in
  // `finally` after the run ends (normal exit, failure, timeout or a thrown error alike). Removal waits
  // for exit: bash opens the file after spawn returns, so an earlier unlink would race it.
  let copyDir: string;
  try {
    copyDir = mkdtempSync(join(tmpdir(), "script-runner-"));
    chmodSync(copyDir, 0o700);
  } catch (e) {
    const why = redactSecrets(String((e as Error)?.message ?? e), secrets).text;
    log(`[script-runner] REFUSED script_id=${JSON.stringify(p.entry.script_id)} reason=spawn_failed (private copy: ${why})`);
    return { shape: SCRIPT_RUN_SHAPE, ok: false, refused: "spawn_failed", error: `spawn_failed: private copy: ${why}`, script_id: p.entry.script_id };
  }
  try {
    const copy = join(copyDir, "script.sh");
    writeFileSync(copy, p.blob, { mode: 0o700, flag: "wx" });
    return await executeCopy(p, copy, timeoutS, env, secrets, log, runId);
  } finally {
    try { rmSync(copyDir, { recursive: true, force: true }); } catch (e) { log(`[script-runner] could not remove private copy ${copyDir}: ${String((e as Error)?.message ?? e)}`); }
  }
}

async function executeCopy(p: Prepared, copy: string, timeoutS: number, env: Env, secrets: string[], log: (l: string) => void, runId: string | null): Promise<Record<string, unknown>> {
  const { entry } = p;
  const started = Date.now();
  let timedOut = false;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([process.execPath, REAPER, "bash", copy, ...p.argv], {
      cwd: p.root, env: scriptRunnerEnv(env, dirname(p.real)), stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
    });
  } catch (e) {
    const why = redactSecrets(String((e as Error)?.message ?? e), secrets).text;
    log(`[script-runner] REFUSED script_id=${JSON.stringify(entry.script_id)} reason=spawn_failed (${why})`);
    return { shape: SCRIPT_RUN_SHAPE, ok: false, refused: "spawn_failed", error: `spawn_failed: ${why}`, script_id: entry.script_id };
  }
  const timer = setTimeout(() => { timedOut = true; killTree(proc.pid); }, timeoutS * 1000);
  let out: Awaited<ReturnType<typeof drainCapped>>, err: Awaited<ReturnType<typeof drainCapped>>, exitCode: number | null;
  try {
    const exited = proc.exited.then((c) => {
      // The script is done; anything it left running in its group goes with it, which also releases
      // the pipes a lingering background child would otherwise hold open until the timeout.
      try { process.kill(-proc.pid, "SIGKILL"); } catch { /* group empty */ }
      return c;
    });
    const keep = entry.max_output_bytes + Math.max(0, ...secrets.map((k) => Buffer.byteLength(k)));
    [out, err, exitCode] = await Promise.all([
      drainCapped(proc.stdout as ReadableStream<Uint8Array>, keep),
      drainCapped(proc.stderr as ReadableStream<Uint8Array>, keep),
      exited,
    ]);
  } finally {
    clearTimeout(timer);
  }
  const duration_ms = Date.now() - started;
  let after: string | null = null;
  try { after = gitBlobSha(readFileSync(p.real)); } catch { /* removed during the run */ }
  const so = redactThenCap(out.bytes, entry.max_output_bytes, secrets);
  const se = redactThenCap(err.bytes, entry.max_output_bytes, secrets);
  const run = {
    script_id: entry.script_id,
    blob_sha: entry.blob_sha,
    args: p.args,
    exit_code: exitCode,
    timed_out: timedOut,
    timeout_s: timeoutS,
    duration_ms,
    stdout_bytes: out.total,
    stderr_bytes: err.total,
    stdout_truncated: out.total > entry.max_output_bytes,
    stderr_truncated: err.total > entry.max_output_bytes,
    redacted: so.redacted || se.redacted,
    modified_during_run: after !== entry.blob_sha,
  };
  log(`[script-runner] ${runId ? `finished run_id=${runId}` : "ran"} script_id=${entry.script_id} blob=${entry.blob_sha.slice(0, 12)} args=${JSON.stringify(p.args)} exit=${exitCode} timed_out=${timedOut} duration_ms=${duration_ms} stdout=${out.total}B stderr=${err.total}B${run.stdout_truncated || run.stderr_truncated ? " truncated" : ""}${run.redacted ? " redacted" : ""}${run.modified_during_run ? " MODIFIED_DURING_RUN" : ""}`);
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
