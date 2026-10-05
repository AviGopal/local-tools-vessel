// Check-first (class): in the super-repo clone the shell gate must fail closed on what it cannot
// evaluate. It refuses a denylist of writers and some interpreters (perl -e, node -e, bun -e), but
// qa's probe found python3 -c, ruby -e, awk BEGIN and a computed command word ($(echo rm)) writing the
// clone. Any interpreter not on the list, or a command word produced by substitution, must be refused
// unless the form is a known read-only one. Generated so a patch cannot special-case a few names.
import { beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containShell } from "./shell-containment";

let superRepo: string;
let env: Record<string, string>;
beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "shell-gate-opaque-")));
  superRepo = join(base, "git", "super-repo");
  mkdirSync(join(superRepo, "scripts", "substrate"), { recursive: true });
  writeFileSync(join(superRepo, ".gitmodules"), "");
  writeFileSync(join(superRepo, "scripts", "substrate", "autonomy-scope.json"), "{}");
  writeFileSync(join(superRepo, "notes.txt"), "b\na\n");
  execFileSync("git", ["-C", superRepo, "init", "-q"]);
  env = { WORKSPACE_ROOT: superRepo, MITOSIS_RUNTIME_DIR: join(base, "vessels"), MITOSIS_PUSH_CLONE_DIR: join(base, "git", "vessels"), COMPOSE_WS_DIR: join(base, "git", "compose"), METABOB_API_KEY: "k" };
});
const ok = (c: string) => containShell(c, superRepo, { env }).ok;
const leaks = (cmds: string[]) => cmds.filter((c) => ok(c));

// Inline programs that write, delete or rename a file in the clone, per interpreter.
const PROGRAMS: Record<string, string[]> = {
  python3: [`python3 -c "open('notes.txt','w').write('x')"`, `python3 -c "import os; os.remove('notes.txt')"`, `python3 -c "import os; os.rename('notes.txt','n2')"`],
  python: [`python -c "open('notes.txt','w').write('x')"`, `python -c "import os; os.remove('notes.txt')"`, `python -c "import os; os.rename('notes.txt','n2')"`],
  ruby: [`ruby -e "File.write('notes.txt','x')"`, `ruby -e "File.delete('notes.txt')"`, `ruby -e "File.rename('notes.txt','n2')"`],
  perl: [`perl -e 'open(F,">notes.txt"); print F "x"'`, `perl -e 'unlink "notes.txt"'`, `perl -e 'rename "notes.txt","n2"'`],
  node: [`node -e "require('fs').writeFileSync('notes.txt','x')"`, `node -e "require('fs').unlinkSync('notes.txt')"`, `node -e "require('fs').renameSync('notes.txt','n2')"`],
  bun: [`bun -e "await Bun.write('notes.txt','x')"`, `bun -e "require('fs').unlinkSync('notes.txt')"`, `bun -e "require('fs').renameSync('notes.txt','n2')"`],
  awk: [`awk 'BEGIN{print 1 > "notes.txt"}'`, `awk 'BEGIN{system("rm notes.txt")}'`, `awk 'BEGIN{system("mv notes.txt n2")}'`],
  gawk: [`gawk 'BEGIN{print 1 > "notes.txt"}'`, `gawk 'BEGIN{system("rm notes.txt")}'`, `gawk 'BEGIN{system("mv notes.txt n2")}'`],
  php: [`php -r "file_put_contents('notes.txt','x');"`, `php -r "unlink('notes.txt');"`, `php -r "rename('notes.txt','n2');"`],
  lua: [`lua -e "io.open('notes.txt','w'):write('x')"`, `lua -e "os.remove('notes.txt')"`, `lua -e "os.rename('notes.txt','n2')"`],
  tclsh: [`echo 'set f [open notes.txt w]; puts $f x' | tclsh`, `echo 'file delete notes.txt' | tclsh`, `echo 'file rename notes.txt n2' | tclsh`],
  Rscript: [`Rscript -e "writeLines('x','notes.txt')"`, `Rscript -e "file.remove('notes.txt')"`, `Rscript -e "file.rename('notes.txt','n2')"`],
};
const VIA = (c: string): string[] => [c, `sh -c '${c.replace(/'/g, `'\\''`)}'`, `echo $(${c})`];

describe("shell gate: opaque programs in the super-repo clone (class)", () => {
  it("refuses an inline program in any interpreter that writes, deletes or renames, directly or wrapped", () => {
    expect(leaks(Object.values(PROGRAMS).flat().flatMap(VIA))).toEqual([]);
  });
  it("refuses a command word produced by substitution", () => {
    expect(leaks([
      "$(echo rm) notes.txt", "`echo rm` notes.txt", "$(printf rm) -f notes.txt", "${X:-rm} notes.txt",
      "$(echo mv) notes.txt n2", "$(echo tee) notes.txt < /dev/null", "$(echo git) remote add evil https://e/",
    ])).toEqual([]);
  });
  it("still allows read-only inline programs and plain reads (control)", () => {
    const blocked = [
      `python3 -c 'print(1)'`, `awk '{print}' notes.txt`, `cat notes.txt`, `wc -l notes.txt`, `ls`, `grep a notes.txt`,
    ].filter((c) => !ok(c));
    expect(blocked).toEqual([]);
  });
});
