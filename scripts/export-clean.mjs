// Makes the copy of Liv that can be published: the files of the current
// commit, in a new repository with ONE commit and no history.
//
//   node scripts/export-clean.mjs [carpeta]      (por defecto ../Liv-publico)
//
// Why: this repository's first commits hold what Liv started from — Coucou's
// character, icons and sounds — which Liv may not distribute (NOTICE.md).
// They were removed long ago, but a repository's history is published with it.
// The copy has none of it: only what is tracked now.
//
// Nothing is pushed anywhere, and this repository is not touched. The copy is
// made from the commit, not from the folder: what is ignored (the reference
// projects, target/, node_modules/) never reaches it, and uncommitted work
// stops the script rather than being left out silently.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(root, "..", "Liv-publico"));

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
const stop = (message) => {
  console.error(`\n${message}`);
  process.exit(1);
};

if (git(root, "status", "--porcelain")) stop("Hay cambios sin confirmar. Confírmalos (o descártalos) y vuelve a ejecutarlo.");
if (out === root || out.startsWith(root + "\\") || out.startsWith(root + "/")) stop("La copia debe quedar fuera de este repositorio.");
if (existsSync(out) && readdirSync(out).length > 0) stop(`${out} ya existe y no está vacía. Bórrala o elige otra carpeta.`);

const commit = git(root, "rev-parse", "--short", "HEAD");
const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
const { version } = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));

// The commit's files, and only those. The tree is clean, so the index is the
// commit: git writes it out itself (no tar, whose Windows builds disagree on
// what "C:" means).
mkdirSync(out, { recursive: true });
git(root, "checkout-index", "--all", "--force", `--prefix=${out.replaceAll("\\", "/")}/`);

// What must never be published, looked for in the copy itself.
const files = readdirSync(out, { recursive: true }).map((file) => String(file).replaceAll("\\", "/"));
const reserved = files.filter((file) => /^(coucou-main|island-main|NusaSetup)\//.test(file) || /mochi/i.test(file));
if (reserved.length > 0) stop(`La copia contiene material que no se puede publicar:\n  ${reserved.slice(0, 10).join("\n  ")}`);

git(out, "init", "--quiet", "--initial-branch=main");
git(out, "add", "--all");
git(out, "commit", "--quiet", "-m", `Liv ${version}`, "-m",
  "Dynamic Island para Windows. Parte del código de Coucou, de Louis Raillé (MIT):\nver LICENSE y NOTICE.md.");

const author = git(out, "log", "-1", "--format=%an <%ae>");
console.log(`Copia lista en ${out}`);
console.log(`  origen:   ${branch} @ ${commit}`);
console.log(`  archivos: ${git(out, "ls-files").split("\n").length}`);
console.log(`  commits:  ${git(out, "rev-list", "--count", "HEAD")}`);
console.log(`  autor:    ${author}`);
console.log("\nEse autor (nombre y correo) será público al subirla. Para cambiarlo antes:");
console.log(`  git -C "${out}" commit --amend --reset-author --no-edit   (tras ajustar user.name y user.email)`);
console.log("No se ha subido nada. Los pasos siguientes están en docs/PUBLICAR.md.");
