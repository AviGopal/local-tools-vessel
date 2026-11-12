// shape-inputs — what this vessel tells discovery about the shapes a caller can fill: one line on what each produces,
// and the pointer fields its handler reads (JSON Schema). A producer that has to build a pointer (the walk's request)
// reads these through discovery's shapeDescriptions at use time; a shape without them can be named but not filled.
//
// Each schema is taken from its handler in index.ts, and shape-inputs.test.ts calls every handler with exactly the
// required fields declared here, so a handler that comes to need another field turns that test red.
//
// Declared only for fields a handler reads from the POINTER. Some handlers also read the request body's top level
// (bounded_shell's timeout, git_diff's staged, code_search's limit); a walk's call sends a pointer, so those are not
// offered. Not declared at all: shell and bash (bounded_shell covers them), and code_verify_typecheck's bun_cmd and script: the handler splices both into `<bun_cmd> run <script>`
// and runs it without the shell containment check, so either field would run any command (agf_m40aao3ttwpx).
type Schema = Record<string, unknown>

const PATH = { type: "string", minLength: 1, description: "A file: absolute, repos/<vessel>/…, or relative to the workspace." }
const LINE = { type: "integer", minimum: 1 }
const object = (required: string[], properties: Record<string, unknown>): Schema => ({ type: "object", required, properties })

export const SHAPE_INPUTS: Record<string, Schema> = {
  fs_read: object(["path"], { path: PATH }),
  fs_write: object(["path", "content"], { path: PATH, content: { type: "string" } }),
  fs_edit: object(["path", "old_string", "new_string"], {
    path: PATH,
    old_string: {
      type: "string", minLength: 1,
      description: "Text copied character for character from the file as fs_read returned it (read the file first): the " +
        "lines being replaced, never words about the change.",
    },
    new_string: { type: "string" },
  }),
  code_read_lines: object(["path", "start_line", "end_line"], { path: PATH, start_line: LINE, end_line: LINE }),
  code_replace_lines: object(["path", "start_line", "end_line", "text"], {
    path: PATH, start_line: LINE, end_line: LINE, text: { type: "string", description: "Replaces lines start_line..end_line." },
  }),
  code_insert_after_line: object(["path", "after_line", "text"], {
    path: PATH, after_line: { type: "integer", minimum: 0, description: "0 inserts at the top." }, text: { type: "string" },
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
}

export const SHAPE_DESCRIPTIONS: Record<string, string> = {
  fs_read: "Reads a file and returns its content.",
  fs_write: "Writes content to a file, replacing it.",
  fs_edit: "Replaces one exact substring of a file with new text. old_string is copied from the file as fs_read " +
    "returned it, so read the file first; a refusal quotes the file's closest real lines to copy from.",
  code_read_lines: "Returns lines start_line..end_line of a file, numbered.",
  code_replace_lines: "Replaces lines start_line..end_line of a file with text.",
  code_insert_after_line: "Inserts text after a line of a file.",
  code_search: "Finds the lines of a file that match a regular expression.",
  code_verify_typecheck: "Runs the typecheck script of the package in cwd and reports the exit code and the first type errors.",
  bounded_shell: "Runs a shell command as an unprivileged user with a time limit; returns stdout, stderr and the exit code.",
  git_status: "Lists a repository's changed files (git status --porcelain).",
  git_diff: "Shows a repository's unstaged changes (git diff). For a clone git_worktree made, shows its committed change " +
    "against origin's branch, with repo, base, head and tree: the tree a land_verdict names; and typecheck, whether that " +
    "exact tree typechecks (ran, passed, and what the compiler said).",
  git_commit: "Commits every change in a clone git_worktree made, checked by the super-repo's hooks as of its making; " +
    "answers the sha, tree and changed paths, needs_person (changed paths that judge changes, which only a person may " +
    "approve) and scan (whether the secrets scan ran).",
  git_land: "Pushes a committed change from a clone git_worktree made to its origin's branch, only when a land_verdict " +
    "row approves its exact tree (a person's r 1, or a grader's r 1 from exactly the request and the walk's gitDiff row " +
    "of that tree), the secrets scan is clean and it fast-forwards; answers what landed, or why not.",
  git_worktree: "Gives a clone of a repository for one change, at this node's current copy of it (one nothing has changed yet " +
    "is handed out again); answers cwd (where to read, edit and commit), branch (where a landing goes), base, super_base " +
    "and origin_url.",
  walk_trees_reclaim: "Removes the clones git_worktree made that nothing will use again (landed, or unchanged with no open " +
    "request), keeps the rest, and reports changed clones of closed requests; answers what it removed and reported.",
}

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
  code_search: "codeSearchResult",
  code_insert_after_line: "codeInsertResult",
  code_replace_lines: "codeReplaceResult",
  code_read_lines: "codeReadResult",
  code_verify_typecheck: "codeTypecheckResult",
  bounded_shell: "shellResult",
}
