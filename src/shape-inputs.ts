// shape-inputs — what this vessel tells discovery about the shapes a caller can fill: one line on what each produces,
// and the pointer fields its handler reads (JSON Schema). A producer that has to build a pointer (the walk's request)
// reads these through discovery's shapeDescriptions at use time; a shape without them can be named but not filled.
//
// Each schema is taken from its handler in index.ts, and shape-inputs.test.ts calls every handler with exactly the
// required fields declared here, so a handler that comes to need another field turns that test red.
//
// Declared only for fields a handler reads from the POINTER (the USER ruled that the tools a vessel already serves are
// declared, so the walk's request producer can see them; no new tool). Some handlers also read the request body's top level
// (bounded_shell's timeout, git_diff's staged, code_search's limit); a walk's call sends a pointer, so those are not
// offered. Not declared at all: web_search (held until the USER rules: its answers are untrusted web text that would reach
// producers as context, and each call is paid; it needs an untrusted mark and a spend bound on an owner row first), shell and bash (bounded_shell covers them), and code_verify_typecheck's bun_cmd and script: the handler splices both into `<bun_cmd> run <script>`
// and runs it without the shell containment check, so either field would run any command (agf_m40aao3ttwpx).
import type { ShapeConsume } from "@avigopal/ias-executor-ts"
import { WRITE_TOOLS } from "./write-containment.js"

type Schema = Record<string, unknown>

const PATH = { type: "string", minLength: 1, description: "A file: absolute, repos/<vessel>/…, or relative to the workspace. To " +
  "read a file you are changing, name it by its path in the clone git_worktree made for the change." }
// A change is written only in the clone git_worktree made: the workspace is the live checkout and repos/<vessel>/… the
// running vessels, which no tool writes, so a writer's path is declared as the one spelling a change can be written at.
export const WRITE_IN_CLONE = "write in the clone git_worktree made for this change: an absolute path under the cwd its " +
  "answer gave, never a path relative to the workspace or a repos/<vessel>/… path"
const WRITE_PATH = { type: "string", minLength: 1, description: `The file to change. ${WRITE_IN_CLONE[0].toUpperCase()}${WRITE_IN_CLONE.slice(1)}.` }
const LINE = { type: "integer", minimum: 1 }
const object = (required: string[], properties: Record<string, unknown>): Schema => ({ type: "object", required, properties })

export const SHAPE_INPUTS: Record<string, Schema> = {
  fs_read: object(["path"], { path: PATH }),
  fs_write: object(["path", "content"], { path: WRITE_PATH, content: { type: "string" } }),
  fs_edit: object(["path", "old_string", "new_string"], {
    path: WRITE_PATH,
    old_string: {
      type: "string", minLength: 1,
      description: "Text copied character for character from the file as fs_read returned it (read the file first): the " +
        "lines being replaced, never words about the change.",
    },
    new_string: { type: "string" },
  }),
  code_read_lines: object(["path", "start_line", "end_line"], { path: PATH, start_line: LINE, end_line: LINE }),
  code_replace_lines: object(["path", "start_line", "end_line", "text"], {
    path: WRITE_PATH, start_line: LINE, end_line: LINE, text: { type: "string", description: "Replaces lines start_line..end_line." },
  }),
  code_insert_after_line: object(["path", "after_line", "text"], {
    path: WRITE_PATH, after_line: { type: "integer", minimum: 0, description: "0 inserts at the top." }, text: { type: "string" },
  }),
  code_add_import: object(["path", "module", "specifier"], {
    path: WRITE_PATH,
    module: { type: "string", minLength: 1, description: "The module to import from, as written in the statement, e.g. \"./calls\"." },
    specifier: { type: "string", minLength: 1, description: "What to import, e.g. \"{ call }\"; merged into an existing { … } import of the module." },
  }),
  code_search: object(["path", "pattern"], {
    path: PATH, pattern: { type: "string", minLength: 1, description: "A regular expression." }, flags: { type: "string" },
  }),
  code_verify_typecheck: object(["cwd"], { cwd: { type: "string", minLength: 1, description: "The package directory." } }),
  bounded_shell: object(["command"], {
    command: { type: "string", minLength: 1 },
    cwd: { type: "string", description: "Default: a scratch directory the command may write." },
  }),
  git_status: object([], { cwd: { type: "string", description: "The repository; default the workspace." } }),
  git_diff: object([], { cwd: { type: "string", description: "The repository, or a clone git_worktree made; default the workspace." } }),
  git_commit: object(["cwd", "message"], {
    cwd: { type: "string", minLength: 1, description: "The clone git_worktree made for the change (its answer's cwd)." },
    message: { type: "string", minLength: 1, description: "The commit message: a subject line, a blank line, then why." },
  }),
  git_land: object(["cwd"], {
    cwd: { type: "string", minLength: 1, description: "The clone git_worktree made, with its change committed." },
  }),
  git_worktree: object(["repo"], {
    repo: { type: "string", minLength: 1, description: "\"super\" for the super-repo, or a vessel's name, e.g. walk-vessel." },
  }),
  walk_trees_reclaim: object([], {}),
  walk_failure_detect: object([], {}),
  code_find_function: object(["path", "name"], { path: PATH, name: { type: "string", minLength: 1, description: "The function's name." } }),
  code_find_import: object(["path", "module"], {
    path: PATH, module: { type: "string", minLength: 1, description: "The module specifier as imported, e.g. \"./calls\"." },
  }),
}

export const SHAPE_DESCRIPTIONS: Record<string, string> = {
  fs_read: "Reads a file and returns its content.",
  fs_write: "Writes content to a file, replacing it.",
  fs_edit: "Replaces one exact substring of a file with new text. old_string is copied from the file as fs_read " +
    "returned it, so read the file first; a refusal quotes the file's closest real lines to copy from.",
  code_read_lines: "Returns lines start_line..end_line of a file, numbered.",
  code_replace_lines: "Replaces lines start_line..end_line of a file with text.",
  code_insert_after_line: "Inserts text after a line of a file.",
  code_add_import: "Adds an import of a module to a file, after its last import, or merges the specifier into an import " +
    "of that module already there; answers action (added, merged_specifier or already_present) and the line.",
  code_search: "Finds the lines of a file that match a regular expression.",
  code_verify_typecheck: "Runs the typecheck script of the package in cwd and reports the exit code and the first type errors; " +
    "on a clone the walk made, also how many errors its base already had (base_error_count) and how many the clone's edits added " +
    "(added_error_count).",
  bounded_shell: "Runs a shell command as an unprivileged user with a time limit; returns stdout, stderr and the exit code. " +
    "It is how to search a repository (grep -rn) or read git history (git log, git show) in a clone.",
  git_status: "Lists a repository's changed files (git status --porcelain).",
  git_diff: "For a clone git_worktree made, shows only its committed change against origin's branch: an edit is not in " +
    "it until git_commit commits it, so to see an edit, commit it first. Answers repo, base, head and tree: the tree a " +
    "land_verdict names; and typecheck, whether that exact tree typechecks (ran, passed, and what the compiler said; " +
    "checked false with ran false and no passed when no project could be compiled on this node, which says nothing of the " +
    "change); and uncommitted, the paths the clone holds changed but not committed, which are not in that change " +
    "(git_commit commits them), and uncommitted_any, true when it holds any such path and false when none (both absent " +
    "when the clone could not be read). For a repository that is not such a clone, shows its unstaged changes (git diff).",
  git_commit: "Commits every change in a clone git_worktree made, checked by the super-repo's hooks as of its making; " +
    "answers the sha, tree and changed paths and scan (whether the secrets scan ran); a change touching a path the " +
    "USER's protected list names is refused, naming them (out_of_reach).",
  git_land: "Pushes a committed change from a clone git_worktree made to its origin's branch, only when a land_verdict " +
    "row approves its exact tree (a person's r 1, or a grader's r 1 from exactly the request and the walk's gitDiff row " +
    "of that tree), the secrets scan is clean and it fast-forwards; answers what landed, or why not.",
  git_worktree: "Gives a new clone of a repository for one change, at this node's current copy of it; every call makes " +
    "another; answers cwd (where to read, edit and commit), branch (where a landing goes), base, super_base " +
    "and origin_url.",
  code_find_function: "Finds where a function is defined in a file: its start and end lines, or found false.",
  code_find_import: "Finds the import of a module in a file: its line and statement, or found false.",
  walk_failure_detect: "Classes the walk's recent failures and files each class that recurs (by the owner's failure_rule " +
    "row) as one gap; closes a class quiet since and called again; answers what it found and wrote (none when the rule is " +
    "a dry run).",
  walk_trees_reclaim: "Removes the clones git_worktree made that nothing will use again (landed, or unchanged with no open " +
    "request), keeps the rest, and reports changed clones of closed requests; answers what it removed and reported.",
}

// Which calls work in no one walk clone (index.ts wrapped): nothing is said of a clone for them. git_worktree makes
// clones, walk_trees_reclaim removes them, walk_failure_detect reads and writes rows, gap_check runs a test file at a
// commit of origin. Every other call works in the clone its pointer names, and its answer says when that clone is behind
// this node's copy (clone-freshness.ts behind).
export const SHAPE_IN_CLONE: Record<string, "unwrapped"> = {
  git_worktree: "unwrapped",
  walk_trees_reclaim: "unwrapped",
  walk_failure_detect: "unwrapped",
  gap_check: "unwrapped",
}
export const wrapsClone = (name: string): boolean => SHAPE_IN_CLONE[name] !== "unwrapped"

// What a call of each shape answers with: the shape of its answer row. Discovery serves it (shape_answers) beside the
// descriptions and inputs, so a reader that needs a row of some shape can find the call that makes it (the walk's skip
// names it) instead of reading it out of prose. shape-inputs.test.ts holds each to what its handler answers.
export const SHAPE_ANSWERS: Record<string, string> = {
  fs_read: "fileContent",
  fs_write: "fileWriteResult",
  fs_edit: "fileEditResult",
  git_status: "gitStatus",
  git_diff: "gitDiff",
  git_commit: "gitCommitResult",
  git_worktree: "gitWorktree",
  git_land: "gitLand",
  walk_trees_reclaim: "walkTreesReclaim",
  walk_failure_detect: "walkFailureReport",
  code_search: "codeSearchResult",
  code_insert_after_line: "codeInsertResult",
  code_replace_lines: "codeReplaceResult",
  code_add_import: "codeAddImportResult",
  code_read_lines: "codeReadResult",
  code_verify_typecheck: "codeTypecheckResult",
  bounded_shell: "boundedShellResult",
  code_find_function: "codeFindFunctionResult",
  code_find_import: "codeFindImportResult",
}

// The answers of the calls that change a file (WRITE_TOOLS): one list, read by the wrapper to tell which answers name an
// edited clone (clone-freshness.ts editedClone) and by git_commit's consumes below, so a write call added once is both.
export const CHANGES: ReadonlySet<string> = new Set(WRITE_TOOLS.map((tool) => SHAPE_ANSWERS[tool]!))

// The rows each call takes, and the pointer fields each fills (pointer field to row field). Discovery serves them
// (shape_consumes), so a reader holding a row can find the calls that take it and fill them from it, instead of copying a
// path or a cwd out of one answer into the next call by reading prose. Each binds a field the call declares
// (SHAPE_INPUTS) from one the row carries as its producer answers it, through the wrapper (shape-consumes.test.ts).
export const SHAPE_CONSUMES: Record<string, ShapeConsume[]> = {
  fs_edit: [{ shape: "fileContent", binds: { path: "path" } }],
  code_replace_lines: [{ shape: "codeReadResult", binds: { path: "path" } }],
  code_insert_after_line: [{ shape: "codeReadResult", binds: { path: "path" } }],
  // A clone is committed in once git_worktree made it, or once a change there names it (the wrapper's cwd).
  git_commit: ["gitWorktree", ...CHANGES].map((shape) => ({ shape, binds: { cwd: "cwd" } })),
  git_diff: [{ shape: "gitCommitResult", binds: { cwd: "cwd" } }],
  // A landing takes the verdict judging the diff, as its precondition already says, and fills nothing from it: the verdict
  // names no clone. Declared, a step whose frontier is a verdict names the landing as the call that takes it, so the
  // verdict's producer is graded by whether a landing followed.
  git_land: [{ shape: "gitDiff", binds: { cwd: "cwd" } }, { shape: "land_verdict", binds: {} }],
}
