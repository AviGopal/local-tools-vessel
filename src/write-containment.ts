// write-containment — the one rule every in-process file WRITER in the fleet applies
// before it touches disk.
//
// THE BREACH THIS CLOSES. A goal walk injected an fs_edit step against
// local-tools-vessel with an LLM-chosen relative path. local-tools anchors relative
// paths at WORKSPACE_ROOT, which on a substrate is the LIVE super-repo clone, so the
// edit landed as an uncommitted change in scripts/substrate/substrate-pull-sync.sh —
// an autonomy-scope excluded path. pull-sync then installed that working-tree file to
// /usr/local/bin and broke the node's deploys. The existing tool-root confinement
// (local-tools tool-roots.ts) passed it: the live clone IS a tool root, because
// reads need it. Confinement answers "may this vessel touch this path at all";
// nothing answered "may THIS caller WRITE here".
//
// THE RULE, by where the write really lands (realpath, symlinks followed; a new
// file's nearest existing ancestor):
//   secrets (/etc, /proc, /workspace/.substrate-secrets) .... refused, always
//   the live super-repo clone .............................. refused, always (no tool
//       write is how anything lands there; landings are commits made by the lane)
//   vessel runtime (/vessels), push clones, compose worktrees  refused UNLESS the
//       request carries a lane write grant (below). With a grant the lane writes
//       there as before — including scope-excluded files, because directed composes
//       on the lane core must work and an AUTONOMOUS compose touching an excluded
//       path is already withheld at landing by the lane's own autonomy-scope floor.
//   everything else (workspace data dirs, tmp) .............. allowed
// Refusal reasons name the autonomy-scope entry the path falls under when there is
// one, read at use time from the COMMITTED scope (git show HEAD:…, never the
// working-tree copy — the working tree is exactly what got written).
//
// THE GRANT. The lane (development-vessel's feature_compose, patch_with_tools and
// perf-canary) is the only sanctioned writer of vessel source through a tool, and
// it reaches the tools over HTTP with the same ApiKey header goal-host's walk
// sends, so no header distinguishes them. A grant is an HMAC over the exact path
// string and a short expiry, keyed with the fleet key the lane already holds. A walk
// cannot produce one: its arguments are LLM-synthesised, and the key is in neither
// the agent shell env (agent-shell-env scrubs it) nor any path a file tool can read
// (/etc and /proc are never tool roots). RESIDUAL: the general shell runs as root
// and can read /etc/substrate/env — but it can equally `sed -i` the file directly,
// so the shell is not contained by any file-tool guard; see the vessel's notes.
//
// ONE COPY, VENDORED. This file is canonical; local-tools-vessel/src/
// write-containment.ts and development-vessel/src/resolvers/write-containment.ts
// are byte-identical copies (validation/scripts/write-containment-copies.test.ts
// asserts it). Vessels cannot import packages/ at runtime (no vessel resolves it,
// and a compose worktree has no ../../packages), and ias-executor-ts is a copied
// file: dependency that changes only on reinstall. Zero dependencies beyond node:.
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type Env = Record<string, string | undefined>;

/** The committed scope, repo-relative. Same file the bootstrap seeder reads. */
export const SCOPE_REL = "scripts/substrate/autonomy-scope.json";
/** The image's copy (the seeder's IMAGE_SCOPE_FILE): the fallback when no clone answers. */
export const IMAGE_SCOPE_FILE = "/usr/local/share/substrate/super-repo/scripts/substrate/autonomy-scope.json";
/** Prefix of every refusal, so callers and logs can recognise the class. */
export const WRITE_CONTAINMENT_ERROR = "write refused by containment";
/** The pointer field a lane write grant travels in. */
export const WRITE_GRANT_FIELD = "write_grant";
/** How long a grant is good for. A grant is minted per call, immediately before it. */
export const WRITE_GRANT_TTL_MS = 120_000;
/** The tool names that write a file at `path`. Grants are minted only for these. */
export const WRITE_TOOLS: readonly string[] = ["fs_write", "fs_edit", "code_replace_lines", "code_insert_after_line", "code_add_import"];
/** Never written through a tool, grant or not. */
export const SECRET_LOCATIONS: readonly string[] = ["/etc", "/proc", "/workspace/.substrate-secrets"];

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Where a path really lives: realpath when it exists, else realpath of the nearest
 * existing ancestor plus the not-yet-existing tail (a new file, possibly in new
 * directories). Null only when nothing on the way up resolves.
 */
export function realLocation(p: string): string | null {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = dirname(cur);
      if (parent === cur) return null;
      tail.push(cur.slice(parent.length).replace(/^\/+/, ""));
      cur = parent;
    }
  }
}

const real = (p: string): string => realLocation(p) ?? resolve(p);
const abs = (p: string | undefined): p is string => typeof p === "string" && p.trim().length > 0 && isAbsolute(p.trim());

export type Zone = "super" | "clone" | "runtime" | "compose";
export interface Zones { supers: string[]; clones: string; runtime: string; compose: string }

/** A directory that is a super-repo clone (not merely a workspace): it carries the fleet's .gitmodules or scripts/substrate. */
function looksLikeSuperRepo(dir: string): boolean {
  return existsSync(join(dir, ".gitmodules")) || existsSync(join(dir, "scripts", "substrate"));
}

/**
 * A super-repo candidate counts only when it IS a git checkout (`.git` dir, or the file
 * form a worktree uses). A setting that names a plain directory — an ancestor such as
 * /workspace, or a path that does not exist on this node — is not a clone anything lands
 * in, and treating it as one would swallow every zone beneath it.
 */
function isGitCheckout(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/**
 * The protected locations, from the settings the fleet already uses for them.
 * The super-repo clone has three names across the fleet (SUPER_REPO_DIR in
 * pull-sync, MITOSIS_SUPER_REPO_DIR in development-vessel, and WORKSPACE_ROOT,
 * which on a substrate points AT the clone); all are honoured. WORKSPACE_ROOT
 * counts only when it actually is a super-repo clone, so a /workspace root does
 * not make the whole workspace protected.
 */
export function containmentZones(env: Env): Zones {
  const supers: string[] = [];
  for (const s of [env.SUPER_REPO_DIR, env.MITOSIS_SUPER_REPO_DIR, "/workspace/git/super-repo"]) {
    if (abs(s)) { const r = real(s.trim()); if (isGitCheckout(r) && !supers.includes(r)) supers.push(r); }
  }
  const ws = env.WORKSPACE_ROOT;
  if (abs(ws) && looksLikeSuperRepo(ws.trim())) { const r = real(ws.trim()); if (isGitCheckout(r) && !supers.includes(r)) supers.push(r); }
  return {
    supers,
    clones: real(abs(env.MITOSIS_PUSH_CLONE_DIR) ? env.MITOSIS_PUSH_CLONE_DIR.trim() : "/workspace/git/vessels"),
    runtime: real(abs(env.MITOSIS_RUNTIME_DIR) ? env.MITOSIS_RUNTIME_DIR.trim() : "/vessels"),
    compose: real(abs(env.COMPOSE_WS_DIR) ? env.COMPOSE_WS_DIR.trim() : "/workspace/git/compose"),
  };
}

/**
 * The protected zone a resolved path lies in, and the repo-relative name the scope would use for it.
 * The lane zones (compose worktrees, push clones, runtime) are tested FIRST: they are the more
 * specific roots, and a super-repo setting that is an ancestor of one (or that a deployment nests
 * them under) must not reclassify a granted lane write as a write into the live clone.
 */
export function zoneOf(realPath: string, z: Zones): { zone: Zone; root: string; rel: string } | null {
  if (within(realPath, z.compose)) {
    // <compose>/<compose-id>/<vessel>/<rest>
    const parts = relative(z.compose, realPath).split("/").filter(Boolean);
    return { zone: "compose", root: z.compose, rel: parts.length >= 2 ? `repos/${parts.slice(1).join("/")}` : "" };
  }
  if (within(realPath, z.clones)) return { zone: "clone", root: z.clones, rel: `repos/${relative(z.clones, realPath)}` };
  if (within(realPath, z.runtime)) return { zone: "runtime", root: z.runtime, rel: `repos/${relative(z.runtime, realPath)}` };
  for (const s of z.supers) if (within(realPath, s)) return { zone: "super", root: s, rel: relative(s, realPath) };
  return null;
}

export type ScopeRead = { readable: true; excluded: string[]; source: string } | { readable: false; reason: string };

function parseScope(text: string, source: string): ScopeRead {
  const j = JSON.parse(text) as { autonomyScope?: { excluded_paths?: unknown; unrestricted?: unknown } };
  const body = j?.autonomyScope ?? {};
  const raw = Array.isArray(body.excluded_paths) ? body.excluded_paths : [];
  const excluded = raw.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim().replace(/^\.\//, ""));
  if (excluded.length === 0 && body.unrestricted !== true) return { readable: false, reason: `${source} names no excluded_paths and is not explicitly unrestricted` };
  return { readable: true, excluded, source };
}

/**
 * The COMMITTED autonomy scope: `git show HEAD:scripts/substrate/autonomy-scope.json`
 * in each super-repo clone, then the image copy. Never the working-tree file. A
 * scope nobody can read is reported unreadable, and the caller fails closed.
 */
export function readCommittedScope(supers: string[], imageFile: string = IMAGE_SCOPE_FILE): ScopeRead {
  const why: string[] = [];
  for (const s of supers) {
    try {
      const text = execFileSync("git", ["-C", s, "show", `HEAD:${SCOPE_REL}`], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
      const r = parseScope(text, `${s}@HEAD:${SCOPE_REL}`);
      if (r.readable) return r;
      why.push(r.reason);
    } catch (e) { why.push(`${s}@HEAD: ${(e as Error).message.split("\n")[0]}`); }
  }
  try {
    const r = parseScope(readFileSync(imageFile, "utf8"), imageFile);
    if (r.readable) return r;
    why.push(r.reason);
  } catch (e) { why.push(`${imageFile}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); }
  return { readable: false, reason: why.join("; ") || "no super-repo clone configured" };
}

/** The scope entry a repo-relative path falls under (`dir/` entries match the tree), or null. */
export function scopeEntryFor(rel: string, excluded: readonly string[]): string | null {
  const n = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!n) return null;
  for (const e of excluded) {
    if (e.endsWith("/")) { if (n === e.slice(0, -1) || n.startsWith(e)) return e; }
    else if (n === e) return e;
  }
  return null;
}

// ── lane write grants ─────────────────────────────────────────────────────────

export interface WriteGrant { exp: number; sig: string }

function mac(key: string, path: string, exp: number): string {
  return createHmac("sha256", key).update(`substrate-write-grant/v1\n${path}\n${exp}`).digest("hex");
}

/** Mint a grant for writing exactly `path` (the string as it will be sent). */
export function signWriteGrant(key: string, path: string, now: number = Date.now()): WriteGrant {
  const exp = now + WRITE_GRANT_TTL_MS;
  return { exp, sig: mac(key, path, exp) };
}

/** True when `grant` is a live grant for exactly `path` under `key`. */
export function verifyWriteGrant(key: string | undefined, path: string, grant: unknown, now: number = Date.now()): boolean {
  if (!key || typeof path !== "string" || !grant || typeof grant !== "object") return false;
  const { exp, sig } = grant as Partial<WriteGrant>;
  if (typeof exp !== "number" || !Number.isFinite(exp) || typeof sig !== "string") return false;
  if (exp <= now || exp > now + WRITE_GRANT_TTL_MS + 5_000) return false; // expired, or a far-future forgery attempt
  const want = Buffer.from(mac(key, path, exp), "hex");
  const got = Buffer.from(sig, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The lane's side: attach a grant to a write tool's args (unchanged for any other tool, or without a key). */
export function withWriteGrant<T extends Record<string, unknown>>(tool: string, args: T, key: string | undefined, now: number = Date.now()): T {
  if (!key || !WRITE_TOOLS.includes(tool) || typeof args?.path !== "string") return args;
  return { ...args, [WRITE_GRANT_FIELD]: signWriteGrant(key, args.path as string, now) };
}

// ── the verdict ───────────────────────────────────────────────────────────────

export type WriteVerdict =
  | { ok: true; real: string; zone: Zone | null; granted: boolean }
  | { ok: false; real: string | null; zone: Zone | "secret" | null; reason: string };

export interface ContainOpts {
  env: Env;
  /** The path string exactly as the caller sent it (what a grant signs). Defaults to `path`. */
  raw?: string;
  /** The grant the request carried, if any. */
  grant?: unknown;
  now?: number;
  imageScopeFile?: string;
}

/**
 * May this write proceed? `path` is the absolute path the tool is about to write
 * (after the vessel's own mapping). See the header for the rule.
 */
export function containWrite(path: string, opts: ContainOpts): WriteVerdict {
  const refuse = (r: string | null, zone: Zone | "secret" | null, reason: string): WriteVerdict => ({ ok: false, real: r, zone, reason: `${WRITE_CONTAINMENT_ERROR}: ${reason}` });
  if (typeof path !== "string" || !isAbsolute(path)) return refuse(null, null, `not an absolute path: ${String(path)}`);
  const r = realLocation(path);
  if (!r) return refuse(null, null, `cannot resolve ${path}`);
  for (const s of SECRET_LOCATIONS) if (within(r, s) || within(r, real(s))) return refuse(r, "secret", `${r} is a secret location`);
  const z = containmentZones(opts.env);
  const hit = zoneOf(r, z);
  if (!hit) return { ok: true, real: r, zone: null, granted: false };
  const granted = verifyWriteGrant(opts.env.METABOB_API_KEY, opts.raw ?? path, opts.grant, opts.now);
  if (hit.zone !== "super" && granted) return { ok: true, real: r, zone: hit.zone, granted: true };
  const scope = readCommittedScope(z.supers, opts.imageScopeFile);
  const entry = scope.readable ? scopeEntryFor(hit.rel, scope.excluded) : null;
  const where = hit.zone === "super" ? `the live super-repo clone ${hit.root}`
    : hit.zone === "clone" ? `a vessel push clone under ${hit.root}`
    : hit.zone === "compose" ? `a compose worktree under ${hit.root}`
    : `the vessel runtime ${hit.root}`;
  if (entry) return refuse(r, hit.zone, `autonomy-scope excluded path '${entry}' (${scope.readable ? scope.source : ""}): ${r} is in ${where}`);
  if (!scope.readable) return refuse(r, hit.zone, `autonomy scope unreadable (${scope.reason}); ${r} is in ${where}, which fails closed`);
  if (hit.zone === "super") return refuse(r, hit.zone, `${r} is in ${where}; nothing lands there by a tool write — land a change as a commit through the lane`);
  return refuse(r, hit.zone, `${r} is in ${where} and the request carries no lane write grant; vessel source changes go through feature_compose / patch_with_tools`);
}
