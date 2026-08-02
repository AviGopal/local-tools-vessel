/**
 * NOTE: All resolvers in this vessel are deterministic.
 * Health endpoint: GET /health returns service status.
 * local-tools-vessel — deterministic shell/file/git resolver vessel.
 * Maintained by the substrate loop.

 *
 * Spec: openspec/changes/2026-05-23-substrate-explicit-vessels Phase 1, task 1.1.
 * Port: 8230  |  Discovery: http://127.0.0.1:8100
 * Shapes: shellResult, fileContent, fileWriteResult, fileEditResult,
 *         gitStatus, gitDiff, gitCommitResult
 * Runtime: Bun.
 */

import { ActivityExecutor, ExecutionRuntime, VesselDaemon } from "@avigopal/ias-executor-ts";
import type { ResolverHandler } from "@avigopal/ias-executor-ts";

const PORT = Number(process.env.PORT ?? 8230);
const VESSEL_ID = "local-tools-vessel";
const DISCOVERY = process.env.DISCOVERY_ENDPOINT ?? "http://127.0.0.1:8100";
const API_KEY = process.env.METABOB_API_KEY ?? "";
const DEFAULT_CWD = process.env.WORKSPACE_ROOT ?? "/workspace";
const RUNTIME_ROOT = process.env.MITOSIS_RUNTIME_DIR ?? "/vessels";
// Walk resolvers pass repo-relative "repos/<vessel>/..." paths; map them to the live runtime
// tree so an edit hits the CANONICAL file, not a shadow tree created under cwd. feature_compose
// passes absolute /vessels/... paths (already mapped) which pass through unchanged. PREFIX-keyed
// (never existsSync) so a stray shadow stub can never shadow the canonical file. Without this,
// every walk-routed vessel edit ENOENTs (or silently corrupts a /vessels/local-tools-vessel/repos
// shadow tree), flooring the entire "walk edits a vessel" class.
function mapPath(p: string | undefined): string | undefined {
  if (!p) return p;
  if (p.startsWith("repos/")) return `${RUNTIME_ROOT}/${p.slice("repos/".length)}`;
  return p;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function str(o: unknown, ...keys: string[]): string | undefined {
  let v: unknown = o;
  for (const k of keys) { v = (typeof v === "object" && v !== null) ? (v as Record<string,unknown>)[k] : undefined; }
  return typeof v === "string" ? v : undefined;
}

async function sh(cmd: string, cwd = DEFAULT_CWD) {
  // The shell resolver spawns bash WITHOUT inheriting an env, so `bun` (only at
  // /root/.bun/bin/bun) wasn't on PATH → `bun run typecheck` exited 127 →
  // every code-class feature_compose returned UNFAVORABLE and nothing landed.
  // Pass an explicit env that prepends bun's dir to PATH (robust to either set).
  const bunDir = `${process.env.HOME ?? "/root"}/.bun/bin`;
  const env = { ...process.env, PATH: `${bunDir}:${process.env.PATH ?? ""}` };
  const p = Bun.spawn(["bash", "-c", cmd], { cwd, env, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(30000) });
  const [stdout, stderr, exit_code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { stdout, stderr, exit_code };
}

// ── resolvers ─────────────────────────────────────────────────────────────────

const dispatch_id: ResolverHandler = async (ctx) => {
  return { shape: "dispatch_id", dispatch_id: str(ctx.body, "dispatch_id") ?? str(ctx.body, "impulse", "pointer", "dispatch_id") };
};

const shell: ResolverHandler = async (ctx) => {
  const command = str(ctx.body, "impulse", "pointer", "command") ?? str(ctx.body, "command");
  if (!command) return { error: "command is required" };
  return sh(command, str(ctx.body, "impulse", "pointer", "cwd") ?? str(ctx.body, "cwd")).then(r => ({ shape: "shellResult", ...r }))
    .catch(e => ({ error: (e as Error).message }));
};

const fsRead: ResolverHandler = async (ctx) => {
  const path = mapPath(str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path"));
  if (!path) return { error: "path is required" };
  for (let attempt = 0; ; attempt++) {
    try { const content = await Bun.file(path).text(); return { shape: "fileContent", path, content }; }
    catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (attempt < 5 && /ENOENT|no such file/i.test(msg)) { await new Promise((r) => setTimeout(r, 80)); continue; }
      return { error: msg };
    }
  }
};

const fsWrite: ResolverHandler = async (ctx) => {
  // Read from impulse.pointer too — callers (patch_with_tools authoring a
  // NET-NEW file) dispatch via the impulse envelope, so top-level-only reads
  // made every such call fail with "required". Mirrors fsEdit / fsRead.
  const path = mapPath(str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path"));
  const content = str(ctx.body, "impulse", "pointer", "content") ?? str(ctx.body, "content");
  if (!path || content === undefined) return { error: "path and content are required" };
  // CATASTROPHIC-TRUNCATION GUARD. fs_write is a whole-file writer exposed
  // directly to the drafter LLM, and it writes RUNNING vessel source (callers
  // apply against /vessels). Unguarded, a single malformed tool call replaces a
  // 190KB resolver with a placeholder sentence: observed twice today, when
  // feature-compose.ts (190,111 bytes) became 38 bytes reading "updated content
  // to close substrate gap". That also destroys the file's own guards, and
  // patch_with_tools then snapshots the CORRUPT file as its rollback baseline,
  // so every later run "restores" the corruption — the damage is self-sustaining.
  // Refuse only a catastrophic shrink of an already-substantial file, so
  // net-new authoring (the documented caller above) and same-size whole-file
  // repairs are unaffected. Corpus-checked: fs_write was called 2 times in 24h
  // of live journal, both in the window that produced the corruption above.
  try {
    const existing = Bun.file(path);
    if (await existing.exists()) {
      const prevSize = existing.size;
      if (prevSize > 1000 && content.length * 10 < prevSize) {
        const detail = `fs_write refused: ${path} exists at ${prevSize} bytes and the write would truncate it to ${content.length}. A whole-file write that discards >90% of a substantial file is corruption, not authoring — use fs_edit with a verbatim anchor.`;
        console.error(`[local-tools] ${detail}`);
        return { error: detail, path };
      }
    }
  } catch { /* existence probe is advisory — never block a legitimate write on a stat failure */ }
  return Bun.write(path, content).then(() => ({ shape: "fileWriteResult", path, ok: true }))
    .catch(e => ({ error: (e as Error).message }));
};

const fsEdit: ResolverHandler = async (ctx) => {
  // Read from impulse.pointer too — callers (patch_with_tools) dispatch via the
  // impulse envelope, so top-level-only reads (the prior bug) made every call
  // fail with "required". Mirrors code_replace_lines' fix.
  const path = mapPath(str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path"));
  const old_string = str(ctx.body, "impulse", "pointer", "old_string") ?? str(ctx.body, "old_string");
  const new_string = str(ctx.body, "impulse", "pointer", "new_string") ?? str(ctx.body, "new_string");
  if (!path || old_string === undefined || new_string === undefined)
    return { error: "path, old_string, and new_string are required" };
  // EMPTY ANCHOR IS FILE CORRUPTION, NOT AN EDIT. `"".includes("")` is true for
  // EVERY string and `text.replace("", x)` PREPENDS x at byte 0 — so an edit op
  // carrying an empty old_string silently injects its new_string in front of the
  // whole file and reports ok:true. That is the byte-0 corruption signature that
  // crash-looped development-vessel on both substrates (an unrendered
  // `{{source_code.content}}` placeholder landed at byte 0 of its own source), and
  // the drafter emits this malformed op ~44 times/day. The normalized fallback
  // below already guards `nOld.length > 0`; the exact path did not.
  // Corpus-checked before landing: ZERO callers in the fleet pass an empty
  // old_string deliberately (no `old_string: ""` construction site exists), so
  // this rejects only malformed ops.
  if (old_string.length === 0)
    return { error: "old_string must be a non-empty verbatim anchor — an empty anchor prepends to byte 0 rather than editing", path };
  try {
    const text = await Bun.file(path).text();
    if (text.includes(old_string)) { await Bun.write(path, text.replace(old_string, new_string)); return { shape: "fileEditResult", path, ok: true }; }
    // NORMALIZED FALLBACK (task #18): the drafter often reproduces ambiguous unicode
    // (em/en-dash, curly quotes, NBSP) imperfectly, so an otherwise-correct edit fails
    // exact-match. Normalize both sides length-preservingly (char-for-char) and, if the
    // normalized old_string occurs EXACTLY ONCE, replace the corresponding ORIGINAL slice.
    const normU = (s: string): string => s.replace(/[\u2012\u2013\u2014\u2015\u2212]/g, "-").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\u00a0/g, " ");
    const nText = normU(text), nOld = normU(old_string);
    const oi = nText.indexOf(nOld);
    if (oi !== -1 && nOld.length > 0 && nText.indexOf(nOld, oi + 1) === -1) {
      await Bun.write(path, text.slice(0, oi) + new_string + text.slice(oi + nOld.length));
      return { shape: "fileEditResult", path, ok: true, normalized_match: true };
    }
    return { error: "old_string not found in file", path };
  } catch (e) { return { error: (e as Error).message }; }
};

const boundedShellResolver: ResolverHandler = async (ctx) => {
  const command = str(ctx.body, "impulse", "pointer", "command") ?? str(ctx.body, "command");
  if (!command) return { error: "command is required" };
  const timeoutSec = Number((ctx.body as Record<string, unknown>)?.timeout ?? 10);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) return { error: "timeout must be a positive number" };
  const cwd = str(ctx.body, "impulse", "pointer", "cwd") ?? str(ctx.body, "cwd") ?? DEFAULT_CWD;
  const bunDir = `${process.env.HOME ?? "/root"}/.bun/bin`;
  const env = { ...process.env, PATH: `${bunDir}:${process.env.PATH ?? ""}` };
  const p = Bun.spawn(["bash", "-c", command], { cwd, env, stdout: "pipe", stderr: "pipe", timeout: timeoutSec * 1000 });
  const [stdout, stderr, exit_code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { shape: "boundedShellResult", stdout, stderr, exit_code };
};

const gitStatus: ResolverHandler = async (ctx) =>
  sh("git status --porcelain", str(ctx.body, "impulse", "pointer", "cwd") ?? str(ctx.body, "cwd")).then(r => ({ shape: "gitStatus", ...r }))
    .catch(e => ({ error: (e as Error).message }));

const gitDiff: ResolverHandler = async (ctx) => {
  const staged = (ctx.body as Record<string,unknown>)?.staged === true;
  return sh(staged ? "git diff --staged" : "git diff", str(ctx.body, "impulse", "pointer", "cwd") ?? str(ctx.body, "cwd"))
    .then(r => ({ shape: "gitDiff", ...r })).catch(e => ({ error: (e as Error).message }));
};

const gitCommit: ResolverHandler = async (ctx) => {
  const message = str(ctx.body, "message");
  if (!message) return { error: "message is required" };
  return sh(`git commit -m ${JSON.stringify(message)}`, str(ctx.body, "impulse", "pointer", "cwd") ?? str(ctx.body, "cwd"))
    .then(r => ({ shape: "gitCommitResult", ...r })).catch(e => ({ error: (e as Error).message }));
};

// ── code-tool primitives (2026-06-10) ─────────────────────────────────────────
//
// Fine-grained code introspection + mutation. The substrate's patcher (in
// development-vessel) composes these instead of asking an LLM to free-hand
// search/replace ops against a hallucinated copy of the source. Each tool:
//   - reads/writes the live file in place
//   - returns a deterministic shape with line numbers
//   - is independently verifiable
// Learning generalises on which tool sequences close which gap shapes.

function lineNumber(text: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

const codeSearch: ResolverHandler = async (ctx) => {
  const path = mapPath(str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path"));
  const pattern = str(ctx.body, "impulse", "pointer", "pattern") ?? str(ctx.body, "pattern");
  const flags = str(ctx.body, "impulse", "pointer", "flags") ?? str(ctx.body, "flags") ?? "g";
  const limit = Number((ctx.body as Record<string, unknown>)?.limit ?? 50);
  if (!path || !pattern) return { error: "path and pattern are required" };
  try {
    const text = await Bun.file(path).text();
    const lines = text.split("\n");
    // A SEARCH inherently means "find ALL matches". Force the global flag: the
    // patch_with_tools LLM routinely calls this with flags:"" or flags:"m" (no
    // "g") to inspect a file, and the old `if (!flags.includes("g")) break;`
    // then returned only the FIRST match (match_count:1) — blinding the patcher
    // so it could never locate edits and exhausted every attempt on real files
    // (the systematic cause of zero verified patches → flat landing throughput).
    // `flags` still controls i/m/s; callers wanting one hit use limit:1.
    const gFlags = flags.includes("g") ? flags : flags + "g";
    const re = new RegExp(pattern, gFlags);
    const matches: Array<{ line: number; col: number; capture: string; line_text: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && matches.length < limit) {
      const ln = lineNumber(text, m.index);
      matches.push({ line: ln, col: m.index - text.lastIndexOf("\n", m.index - 1), capture: m[0], line_text: lines[ln - 1] ?? "" });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return { shape: "codeSearchResult", path, pattern, total_lines: lines.length, match_count: matches.length, matches };
  } catch (e) { return { error: (e as Error).message }; }
};

const codeFindFunction: ResolverHandler = async (ctx) => {
  const path = mapPath(str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path"));
  const name = str(ctx.body, "impulse", "pointer", "name") ?? str(ctx.body, "name");
  if (!path || !name) return { error: "path and name are required" };
  try {
    const text = await Bun.file(path).text();
    const lines = text.split("\n");
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // function NAME, NAME = function, NAME = (, NAME: function, async NAME, export ... NAME
    const re = new RegExp(`(?:function|=\\s*function|=\\s*\\(|=\\s*async\\s*\\(|async\\s+function)\\s*\\*?\\s*${esc}\\b|\\b${esc}\\s*\\(|\\b${esc}\\s*[:=]`);
    const directRe = new RegExp(`(?:^|\\s)(?:function|async\\s+function|const|let|var|export\\s+(?:async\\s+)?function|export\\s+const|export\\s+default\\s+(?:async\\s+)?function)\\s+${esc}\\b`);
    let startLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]!;
      if (directRe.test(ln) || re.test(ln)) { startLine = i + 1; break; }
    }
    if (startLine === -1) return { shape: "codeFindFunctionResult", path, name, found: false };
    // Brace-walk to estimate end_line
    let depth = 0; let endLine = startLine; let started = false;
    for (let i = startLine - 1; i < lines.length; i++) {
      const ln = lines[i]!;
      for (const ch of ln) {
        if (ch === "{") { depth++; started = true; }
        else if (ch === "}") { depth--; if (started && depth === 0) { endLine = i + 1; break; } }
      }
      if (started && depth === 0) { endLine = i + 1; break; }
    }
    return {
      shape: "codeFindFunctionResult",
      path, name, found: true,
      start_line: startLine, end_line: endLine,
      signature: (lines[startLine - 1] ?? "").trim(),
    };
  } catch (e) { return { error: (e as Error).message }; }
};

const codeFindImport: ResolverHandler = async (ctx) => {
  const path = mapPath(str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path"));
  const moduleName = str(ctx.body, "impulse", "pointer", "module") ?? str(ctx.body, "module");
  if (!path || !moduleName) return { error: "path and module are required" };
  try {
    const text = await Bun.file(path).text();
    const lines = text.split("\n");
    const esc = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reImport = new RegExp(`^\\s*import\\s+(?:type\\s+)?(.+?)\\s+from\\s+["']${esc}["']`);
    const reSideEffect = new RegExp(`^\\s*import\\s+["']${esc}["']`);
    const reRequire = new RegExp(`require\\(\\s*["']${esc}["']\\s*\\)`);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]!;
      const mi = ln.match(reImport);
      if (mi) return { shape: "codeFindImportResult", path, module: moduleName, found: true, line: i + 1, statement: ln, specifiers: mi[1]?.trim() };
      if (reSideEffect.test(ln)) return { shape: "codeFindImportResult", path, module: moduleName, found: true, line: i + 1, statement: ln, specifiers: null };
      if (reRequire.test(ln)) return { shape: "codeFindImportResult", path, module: moduleName, found: true, line: i + 1, statement: ln, specifiers: null };
    }
    return { shape: "codeFindImportResult", path, module: moduleName, found: false };
  } catch (e) { return { error: (e as Error).message }; }
};

const codeInsertAfterLine: ResolverHandler = async (ctx) => {
  const path = mapPath(str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path"));
  const ptr = ((ctx.body as Record<string, unknown>)?.impulse as Record<string, unknown> | undefined)?.pointer as Record<string, unknown> | undefined;
  const afterLine = Number((ctx.body as Record<string, unknown>)?.after_line ?? ptr?.after_line ?? 0);
  const text = str(ctx.body, "impulse", "pointer", "text") ?? str(ctx.body, "text");
  if (!path || text === undefined || !Number.isFinite(afterLine) || afterLine < 0) return { error: "path, after_line, and text are required" };
  try {
    const src = await Bun.file(path).text();
    const lines = src.split("\n");
    if (afterLine > lines.length) return { error: `after_line ${afterLine} exceeds file length ${lines.length}` };
    const insertIdx = afterLine; // 0 means insert at top
    lines.splice(insertIdx, 0, text);
    await Bun.write(path, lines.join("\n"));
    return { shape: "codeInsertResult", path, after_line: afterLine, lines_added: 1, new_total_lines: lines.length };
  } catch (e) { return { error: (e as Error).message }; }
};

const codeReplaceLines: ResolverHandler = async (ctx) => {
  const path = mapPath(str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path"));
  // BUG FIX (2026-06-14): start_line/end_line were read ONLY from top-level
  // ctx.body, but patch_with_tools (and any impulse-envelope caller) nests args
  // under impulse.pointer — so they arrived undefined → Number(undefined)=0 →
  // startLine<1 → EVERY call rejected with "…are required". This silently broke
  // the substrate's code-self-fix loop: patch_with_tools could never apply an
  // edit and always hit its iteration cap. Mirror code_insert's dual read.
  const ptr = ((ctx.body as Record<string, unknown>)?.["impulse"] as Record<string, unknown> | undefined)?.["pointer"] as Record<string, unknown> | undefined;
  const startLine = Number((ctx.body as Record<string, unknown>)?.start_line ?? ptr?.["start_line"] ?? 0);
  const endLine = Number((ctx.body as Record<string, unknown>)?.end_line ?? ptr?.["end_line"] ?? 0);
  const text = str(ctx.body, "impulse", "pointer", "text") ?? str(ctx.body, "text");
  if (!path || text === undefined || startLine < 1 || endLine < startLine) return { error: "path, start_line, end_line, and text are required (1-indexed, end >= start)" };
  try {
    const src = await Bun.file(path).text();
    const lines = src.split("\n");
    if (endLine > lines.length) return { error: `end_line ${endLine} exceeds file length ${lines.length}` };
    const removed = lines.splice(startLine - 1, endLine - startLine + 1, text);
    await Bun.write(path, lines.join("\n"));
    return { shape: "codeReplaceResult", path, start_line: startLine, end_line: endLine, lines_removed: removed.length, new_total_lines: lines.length };
  } catch (e) { return { error: (e as Error).message }; }
};

const codeAddImport: ResolverHandler = async (ctx) => {
  const path = mapPath(str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path"));
  const moduleName = str(ctx.body, "impulse", "pointer", "module") ?? str(ctx.body, "module");
  const specifier = str(ctx.body, "impulse", "pointer", "specifier") ?? str(ctx.body, "specifier");
  if (!path || !moduleName || !specifier) return { error: "path, module, and specifier are required" };
  try {
    const text = await Bun.file(path).text();
    const lines = text.split("\n");
    const esc = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const importRe = new RegExp(`^\\s*import\\s+(.+?)\\s+from\\s+["']${esc}["']`);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(importRe);
      if (m) {
        const existing = (m[1] ?? "").trim();
        if (existing.includes(specifier.replace(/[{}\s]/g, ""))) {
          return { shape: "codeAddImportResult", path, module: moduleName, action: "already_present", line: i + 1 };
        }
        // Merge into braces if both forms are { ... }
        if (existing.startsWith("{") && existing.endsWith("}") && specifier.startsWith("{") && specifier.endsWith("}")) {
          const merged = "{ " + existing.slice(1, -1).trim().replace(/,?\s*$/, "") + ", " + specifier.slice(1, -1).trim() + " }";
          lines[i] = lines[i]!.replace(existing, merged);
          await Bun.write(path, lines.join("\n"));
          return { shape: "codeAddImportResult", path, module: moduleName, action: "merged_specifier", line: i + 1 };
        }
      }
    }
    // Find last existing import to insert after; else top of file (after any leading comments/shebang)
    let lastImport = -1;
    for (let i = 0; i < lines.length; i++) if (/^\s*import\s/.test(lines[i] ?? "")) lastImport = i;
    const stmt = `import ${specifier} from "${moduleName}";`;
    if (lastImport === -1) {
      let insertAt = 0;
      while (insertAt < lines.length && (lines[insertAt]?.startsWith("//") || lines[insertAt]?.startsWith("#!") || lines[insertAt]?.trim() === "")) insertAt++;
      lines.splice(insertAt, 0, stmt);
    } else {
      lines.splice(lastImport + 1, 0, stmt);
    }
    await Bun.write(path, lines.join("\n"));
    return { shape: "codeAddImportResult", path, module: moduleName, action: "added", line: lastImport + 2 };
  } catch (e) { return { error: (e as Error).message }; }
};

const codeVerifyTypecheck: ResolverHandler = async (ctx) => {
  const cwd = str(ctx.body, "impulse", "pointer", "cwd") ?? str(ctx.body, "cwd");
  const script = str(ctx.body, "impulse", "pointer", "script") ?? str(ctx.body, "script") ?? "typecheck";
  const bunCmd = str(ctx.body, "impulse", "pointer", "bun_cmd") ?? str(ctx.body, "bun_cmd") ?? "/root/.bun/bin/bun";
  if (!cwd) return { error: "cwd is required" };
  try {
    const r = await sh(`${bunCmd} run ${script}`, cwd);
    // tsc (`bun run typecheck`) writes diagnostics to STDOUT, not stderr — the
    // old code scanned only stderr, so error_count was ALWAYS 0 even on failure
    // (the false-FAVORABLE root cause). Scan BOTH streams. exit_code is the
    // authoritative pass/fail (tsc exits non-zero on any error); error_count +
    // error_lines are diagnostics. ok REQUIRES a zero exit (fail-closed: a
    // missing/failing typecheck script exits non-zero → ok=false).
    const combined = `${r.stdout}\n${r.stderr}`;
    const tail = combined.length > 8192 ? combined.slice(-8192) : combined;
    const errorLines = tail.split("\n").filter((l) => /error TS\d+:/.test(l)).slice(0, 20);
    return {
      shape: "codeTypecheckResult",
      cwd, script, exit_code: r.exit_code, ok: r.exit_code === 0,
      error_count: errorLines.length,
      error_lines: errorLines,
      output_tail: tail.slice(-1500),
    };
  } catch (e) { return { error: (e as Error).message }; }
};

// ── daemon ────────────────────────────────────────────────────────────────────

// code_read_lines (2026-06-18): return the EXACT current content of a line range,
// with line numbers. The patcher previously had to RECONSTRUCT a region's content
// from (truncated) code_search matches to build a code_replace_lines call — it got
// multi-line regions wrong, the replacement broke typecheck, and it exhausted the
// turn budget on complex edits. With an exact read, the flow becomes:
// code_read_lines(start,end) -> code_replace_lines(start,end, <edited copy of that
// exact text>). This is the capability lever for non-trivial surgical edits.
const codeReadLines: ResolverHandler = async (ctx) => {
  const path = mapPath(str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path"));
  const ptr = ((ctx.body as Record<string, unknown>)?.["impulse"] as Record<string, unknown> | undefined)?.["pointer"] as Record<string, unknown> | undefined;
  const startLine = Number((ctx.body as Record<string, unknown>)?.start_line ?? ptr?.["start_line"] ?? 0);
  const endLineRaw = Number((ctx.body as Record<string, unknown>)?.end_line ?? ptr?.["end_line"] ?? 0);
  if (!path || startLine < 1 || endLineRaw < startLine) return { error: "path, start_line, end_line are required (1-indexed, end >= start)" };
  try {
    const src = await Bun.file(path).text();
    const lines = src.split("\n");
    if (startLine > lines.length) return { error: `start_line ${startLine} exceeds file length ${lines.length}` };
    const endLine = Math.min(endLineRaw, lines.length);
    const slice = lines.slice(startLine - 1, endLine);
    const numbered = slice.map((l, i) => `${startLine + i}: ${l}`).join("\n");
    return { shape: "codeReadResult", path, start_line: startLine, end_line: endLine, total_lines: lines.length, content: slice.join("\n"), numbered };
  } catch (e) { return { error: (e as Error).message }; }
};

// web_search (2026-07-04): webSearchResult — EXTERNAL-UNTRUSTED web snippets.
// Mediation rules (structural): snippets only (title/url/snippet), never full
// page bodies; every result carries provenance (url, retrieved_at, provider).
// Distillation to concept-db must go through class-grain concept writes with
// provenance tags; NOT wired into any compose/decompose prompt path.
const webSearch: ResolverHandler = async (ctx) => {
  const query = str(ctx.body, "impulse", "pointer", "query") ?? str(ctx.body, "query")
    ?? str(ctx.body, "impulse", "pointer", "q") ?? str(ctx.body, "impulse", "pointer", "search_query")
    ?? str(ctx.body, "impulse", "pointer", "search") ?? str(ctx.body, "impulse", "pointer", "text")
    ?? str(ctx.body, "impulse", "pointer", "question") ?? str(ctx.body, "impulse", "pointer", "goal");
  if (!query) return { error: "query is required" };
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { error: "OPENROUTER_API_KEY not configured" };
  const ptr = ((ctx.body as Record<string, unknown>)?.impulse as Record<string, unknown> | undefined)?.pointer as Record<string, unknown> | undefined;
  const maxResults = Math.min(Number((ctx.body as Record<string, unknown>)?.max_results ?? ptr?.max_results ?? 5) || 5, 10);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.WEB_SEARCH_MODEL ?? "openai/gpt-4o-mini",
        plugins: [{ id: "web", max_results: maxResults }],
        messages: [{ role: "user", content: query }],
        max_tokens: 100,
      }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await res.json() as { choices?: Array<{ message?: { annotations?: Array<{ url_citation?: { title?: string; url?: string; content?: string } }> } }>; error?: { message?: string } };
    if (data.error) return { error: `openrouter: ${data.error.message ?? "unknown"}` };
    const anns = data.choices?.[0]?.message?.annotations ?? [];
    let budget = 8192;
    const results = anns.slice(0, maxResults).map((a) => {
      const snippet = (a.url_citation?.content ?? "").replace(/<[^>]*>/g, "").slice(0, Math.max(0, Math.min(500, budget)));
      budget -= snippet.length;
      return { title: a.url_citation?.title ?? "", url: a.url_citation?.url ?? "", snippet };
    });
    return { shape: "webSearchResult", query, results, retrieved_at: new Date().toISOString(), provider: "openrouter-web-plugin" };
  } catch (e) { return { error: (e as Error).message }; }
};

const resolvers = new Map<string, ResolverHandler>([
  ["dispatch_id", dispatch_id],
  ["shell", shell], ["bash", shell],
  ["fs_read", fsRead], ["fs_write", fsWrite], ["fs_edit", fsEdit],
  ["bounded_shell", boundedShellResolver],
  ["git_status", gitStatus], ["git_diff", gitDiff], ["git_commit", gitCommit],
  ["code_search", codeSearch],
  ["code_find_function", codeFindFunction],
  ["code_find_import", codeFindImport],
  ["code_insert_after_line", codeInsertAfterLine],
  ["code_replace_lines", codeReplaceLines],
  ["code_read_lines", codeReadLines],
  ["code_add_import", codeAddImport],
  ["code_verify_typecheck", codeVerifyTypecheck],
  ["web_search", webSearch],
  ["webSearchResult", webSearch],
  // Advertised OUTPUT shapes double as pointer-type aliases so discovery-routed
  // resolves (pointer.type = advertised shape) reach the same handlers.
  ["shellResult", shell], ["fileContent", fsRead], ["fileWriteResult", fsWrite],
  ["fileEditResult", fsEdit], ["gitStatus", gitStatus], ["gitDiff", gitDiff],
  ["gitCommitResult", gitCommit], ["codeSearchResult", codeSearch],
  ["codeFindFunctionResult", codeFindFunction], ["codeFindImportResult", codeFindImport],
  ["codeInsertResult", codeInsertAfterLine], ["codeReplaceResult", codeReplaceLines],
  ["codeReadResult", codeReadLines], ["codeAddImportResult", codeAddImport],
  ["codeTypecheckResult", codeVerifyTypecheck],
]);

const runtime = new ExecutionRuntime({
  attachedVessels: [{ id: VESSEL_ID, kind: "local-tools" as never, resolverIds: Array.from(resolvers.keys()) }],
});

await new VesselDaemon({
  port: PORT,
  vesselId: VESSEL_ID,
  vesselName: "Local Tools Vessel",
  shapes: [
    "shellResult", "fileContent", "fileWriteResult", "fileEditResult",
    "gitStatus", "gitDiff", "gitCommitResult",
    "codeSearchResult", "codeFindFunctionResult", "codeFindImportResult",
    "codeInsertResult", "codeReplaceResult", "codeReadResult", "codeAddImportResult", "codeTypecheckResult", "webSearchResult",
    // TOOL-NAME aliases. patch_with_tools drives the tool names directly
    // (code_search, code_read_lines, ...), and every one of these is already a key
    // in the `resolvers` Map above — but they were never ADVERTISED, so discovery
    // answered "unknown shape: code_search — no local or remote producer" and the
    // byte-anchored edit route burned its whole turn budget on tools it could not
    // reach. Advertising them costs nothing; they already resolve.
    "shell", "bash", "bounded_shell",
    "fs_read", "fs_write", "fs_edit",
    "git_status", "git_diff", "git_commit",
    "code_search", "code_find_function", "code_find_import",
    "code_insert_after_line", "code_replace_lines", "code_read_lines",
    "code_add_import", "code_verify_typecheck", "web_search",
  ],
  executor: new ActivityExecutor(runtime),
  resolvers,
  discoveryEndpoint: DISCOVERY,
  apiKey: API_KEY || undefined,
  version: "0.1.0",
  enforceCompositionChain: false,
  systemVessel: true,
}).start();

console.log(`[local-tools-vessel] listening on http://127.0.0.1:${PORT}`);

// ─────────────────────────────────────────────────────────────────────────────
// Iteration 9 of the cross-vessel OOM hunt — periodic Bun.gc(true) workaround.
// See: concept_T-CTTOEl97IM (description), concept_s9ye5GKLw2L8 (signature),
//      concept_9ldsmRgqSTd5 (iter-6 derivation in goal-host-vessel).
//
// Hypothesis: Bun 1.3.14 retains heap-arena pages after free; affected vessels
// show RSS growth disconnected from heapUsed. goal-host hit OOM first because
// of its event volume; per iter-9 we apply the same workaround substrate-wide.
// A periodic forced full GC bounds RSS without changing semantics.
//
// .unref() so the timer doesn't prevent process exit.
// ─────────────────────────────────────────────────────────────────────────────
const GC_INTERVAL_MS = parseInt(process.env.LOCAL_TOOLS_GC_INTERVAL_MS ?? "30000", 10);
interface BunGlobal { Bun?: { gc?: (force: boolean) => number } }
const bunGlobal = globalThis as unknown as BunGlobal;
setInterval(() => {
  const gc = bunGlobal.Bun?.gc;
  if (typeof gc === "function") {
    try {
      const freed = gc(true);
      const rssMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      console.log(`[gc-tick] vessel=local-tools-vessel freed=${freed}B rss_after=${rssMB}MB`);
    } catch (err) {
      console.warn(`[gc-tick] Bun.gc failed: ${(err as Error).message}`);
    }
  }
}, GC_INTERVAL_MS).unref();
