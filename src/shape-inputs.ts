// shape-inputs — what this vessel tells discovery about the shapes a caller can fill: one line on what each produces,
// and the pointer fields its handler reads (JSON Schema). A producer that has to build a pointer (the walk's request)
// reads these through discovery's shapeDescriptions at use time; a shape without them can be named but not filled.
//
// Each schema is taken from its handler in index.ts, and shape-inputs.test.ts calls every handler with exactly the
// required fields declared here, so a handler that comes to need another field turns that test red.
//
// Declared only for fields a handler reads from the POINTER. Some handlers also read the request body's top level
// (bounded_shell's timeout, git_diff's staged, code_search's limit); a walk's call sends a pointer, so those are not
// offered. Not declared at all: git_commit (its message reaches a shell command line), shell and bash (bounded_shell
// covers them), code_verify_typecheck's bun_cmd (an executable path spliced into a command).
type Schema = Record<string, unknown>

const PATH = { type: "string", minLength: 1, description: "A file: absolute, repos/<vessel>/…, or relative to the workspace." }
const LINE = { type: "integer", minimum: 1 }
const object = (required: string[], properties: Record<string, unknown>): Schema => ({ type: "object", required, properties })

export const SHAPE_INPUTS: Record<string, Schema> = {
  fs_read: object(["path"], { path: PATH }),
  fs_write: object(["path", "content"], { path: PATH, content: { type: "string" } }),
  fs_edit: object(["path", "old_string", "new_string"], {
    path: PATH,
    old_string: { type: "string", minLength: 1, description: "An exact substring of the file, as fs_read returned it." },
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
  code_verify_typecheck: object(["cwd"], {
    cwd: { type: "string", minLength: 1, description: "The package directory." },
    script: { type: "string", description: "The package script to run; default typecheck." },
  }),
  bounded_shell: object(["command"], {
    command: { type: "string", minLength: 1 },
    cwd: { type: "string", description: "Default: a scratch directory the command may write." },
  }),
  git_status: object([], { cwd: { type: "string", description: "The repository; default the workspace." } }),
  git_diff: object([], { cwd: { type: "string", description: "The repository; default the workspace." } }),
}

export const SHAPE_DESCRIPTIONS: Record<string, string> = {
  fs_read: "Reads a file and returns its content.",
  fs_write: "Writes content to a file, replacing it.",
  fs_edit: "Replaces one exact substring of a file with new text.",
  code_read_lines: "Returns lines start_line..end_line of a file, numbered.",
  code_replace_lines: "Replaces lines start_line..end_line of a file with text.",
  code_insert_after_line: "Inserts text after a line of a file.",
  code_search: "Finds the lines of a file that match a regular expression.",
  code_verify_typecheck: "Runs a package's typecheck script and reports the exit code and the first type errors.",
  bounded_shell: "Runs a shell command as an unprivileged user with a time limit; returns stdout, stderr and the exit code.",
  git_status: "Lists a repository's changed files (git status --porcelain).",
  git_diff: "Shows a repository's unstaged changes (git diff).",
}
