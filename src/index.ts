/**
 * local-tools-vessel — deterministic shell/file/git resolver vessel.
 *
 * Spec: openspec/changes/2026-05-23-substrate-explicit-vessels Phase 1, task 1.1.
 * Port: 8230  |  Discovery: http://127.0.0.1:8100
 * Shapes: shellResult, fileContent, fileWriteResult, fileEditResult,
 *         gitStatus, gitDiff, gitCommitResult
 */

import { ActivityExecutor, ExecutionRuntime, VesselDaemon } from "@avigopal/ias-executor-ts";
import type { ResolverHandler } from "@avigopal/ias-executor-ts";

const PORT = Number(process.env.PORT ?? 8230);
const VESSEL_ID = "local-tools-vessel";
const DISCOVERY = process.env.DISCOVERY_ENDPOINT ?? "http://127.0.0.1:8100";
const API_KEY = process.env.METABOB_API_KEY ?? "";
const DEFAULT_CWD = process.env.WORKSPACE_ROOT ?? "/workspace";

// ── helpers ──────────────────────────────────────────────────────────────────

function str(o: unknown, ...keys: string[]): string | undefined {
  let v: unknown = o;
  for (const k of keys) { v = (typeof v === "object" && v !== null) ? (v as Record<string,unknown>)[k] : undefined; }
  return typeof v === "string" ? v : undefined;
}

async function sh(cmd: string, cwd = DEFAULT_CWD) {
  const p = Bun.spawn(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit_code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { stdout, stderr, exit_code };
}

// ── resolvers ─────────────────────────────────────────────────────────────────

const shell: ResolverHandler = async (ctx) => {
  const command = str(ctx.body, "impulse", "pointer", "command") ?? str(ctx.body, "command");
  if (!command) return { error: "command is required" };
  return sh(command, str(ctx.body, "cwd")).then(r => ({ shape: "shellResult", ...r }))
    .catch(e => ({ error: (e as Error).message }));
};

const fsRead: ResolverHandler = async (ctx) => {
  const path = str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path");
  if (!path) return { error: "path is required" };
  return Bun.file(path).text().then(content => ({ shape: "fileContent", path, content }))
    .catch(e => ({ error: (e as Error).message }));
};

const fsWrite: ResolverHandler = async (ctx) => {
  const path = str(ctx.body, "path"), content = str(ctx.body, "content");
  if (!path || content === undefined) return { error: "path and content are required" };
  return Bun.write(path, content).then(() => ({ shape: "fileWriteResult", path, ok: true }))
    .catch(e => ({ error: (e as Error).message }));
};

const fsEdit: ResolverHandler = async (ctx) => {
  // Read from impulse.pointer too — callers (patch_with_tools) dispatch via the
  // impulse envelope, so top-level-only reads (the prior bug) made every call
  // fail with "required". Mirrors code_replace_lines' fix.
  const path = str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path");
  const old_string = str(ctx.body, "impulse", "pointer", "old_string") ?? str(ctx.body, "old_string");
  const new_string = str(ctx.body, "impulse", "pointer", "new_string") ?? str(ctx.body, "new_string");
  if (!path || old_string === undefined || new_string === undefined)
    return { error: "path, old_string, and new_string are required" };
  try {
    const text = await Bun.file(path).text();
    if (!text.includes(old_string)) return { error: "old_string not found in file", path };
    await Bun.write(path, text.replace(old_string, new_string));
    return { shape: "fileEditResult", path, ok: true };
  } catch (e) { return { error: (e as Error).message }; }
};

const gitStatus: ResolverHandler = async (ctx) =>
  sh("git status --porcelain", str(ctx.body, "cwd")).then(r => ({ shape: "gitStatus", ...r }))
    .catch(e => ({ error: (e as Error).message }));

const gitDiff: ResolverHandler = async (ctx) => {
  const staged = (ctx.body as Record<string,unknown>)?.staged === true;
  return sh(staged ? "git diff --staged" : "git diff", str(ctx.body, "cwd"))
    .then(r => ({ shape: "gitDiff", ...r })).catch(e => ({ error: (e as Error).message }));
};

const gitCommit: ResolverHandler = async (ctx) => {
  const message = str(ctx.body, "message");
  if (!message) return { error: "message is required" };
  return sh(`git commit -m ${JSON.stringify(message)}`, str(ctx.body, "cwd"))
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
  const path = str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path");
  const pattern = str(ctx.body, "impulse", "pointer", "pattern") ?? str(ctx.body, "pattern");
  const flags = str(ctx.body, "impulse", "pointer", "flags") ?? str(ctx.body, "flags") ?? "g";
  const limit = Number((ctx.body as Record<string, unknown>)?.limit ?? 50);
  if (!path || !pattern) return { error: "path and pattern are required" };
  try {
    const text = await Bun.file(path).text();
    const lines = text.split("\n");
    const re = new RegExp(pattern, flags);
    const matches: Array<{ line: number; col: number; capture: string; line_text: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && matches.length < limit) {
      const ln = lineNumber(text, m.index);
      matches.push({ line: ln, col: m.index - text.lastIndexOf("\n", m.index - 1), capture: m[0], line_text: lines[ln - 1] ?? "" });
      if (!flags.includes("g")) break;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return { shape: "codeSearchResult", path, pattern, total_lines: lines.length, match_count: matches.length, matches };
  } catch (e) { return { error: (e as Error).message }; }
};

const codeFindFunction: ResolverHandler = async (ctx) => {
  const path = str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path");
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
  const path = str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path");
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
  const path = str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path");
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
  const path = str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path");
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
  const path = str(ctx.body, "impulse", "pointer", "path") ?? str(ctx.body, "path");
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
    const tail = r.stderr.length > 4096 ? r.stderr.slice(-4096) : r.stderr;
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

const resolvers = new Map<string, ResolverHandler>([
  ["shell", shell], ["bash", shell],
  ["fs_read", fsRead], ["fs_write", fsWrite], ["fs_edit", fsEdit],
  ["git_status", gitStatus], ["git_diff", gitDiff], ["git_commit", gitCommit],
  ["code_search", codeSearch],
  ["code_find_function", codeFindFunction],
  ["code_find_import", codeFindImport],
  ["code_insert_after_line", codeInsertAfterLine],
  ["code_replace_lines", codeReplaceLines],
  ["code_add_import", codeAddImport],
  ["code_verify_typecheck", codeVerifyTypecheck],
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
    "codeInsertResult", "codeReplaceResult", "codeAddImportResult", "codeTypecheckResult",
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
