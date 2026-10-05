import { promises as fs } from "node:fs";
import { z } from "zod";
import { atomicWriteFile, pathExists, resolveSafePath, resolveWritablePath, toRelative } from "../utils/paths.js";
import { isGitRepository, runGit } from "../utils/process.js";

const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_CHARS = 200_000;

/* ------------------------------------------------------------------ */
/* apply_code_fix                                                      */
/* ------------------------------------------------------------------ */

export const applyCodeFixSchema = {
  relative_path: z.string().min(1).max(1024).describe("Archivo a corregir, relativo a la raíz del frontend."),
  new_content: z
    .string()
    .max(MAX_PATCH_BYTES, "El contenido excede el máximo de 2 MB.")
    .describe("Contenido COMPLETO y final del archivo corregido (no un diff)."),
  reason: z.string().min(5).max(2000).describe("Justificación técnica del cambio (causa raíz que corrige)."),
  create_if_missing: z
    .boolean()
    .default(false)
    .describe("Permite crear el archivo si no existe (por defecto false: solo se modifican archivos existentes)."),
};

export async function applyCodeFix(input: { relative_path: string; new_content: string; reason: string; create_if_missing: boolean }) {
  const abs = await resolveWritablePath(input.relative_path);
  const exists = await pathExists(abs);
  if (!exists && !input.create_if_missing) {
    throw new Error(`El archivo no existe: ${input.relative_path}. Use create_if_missing=true para crearlo.`);
  }

  let previous = "";
  if (exists) {
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new Error(`La ruta no es un archivo regular: ${input.relative_path}`);
    previous = await fs.readFile(abs, "utf8");
  }

  // Preserva el estilo de fin de línea original (CRLF vs LF).
  let content = input.new_content;
  if (previous.includes("\r\n") && !content.includes("\r\n")) content = content.replace(/\n/g, "\r\n");

  if (exists && previous === content) {
    return {
      status: "NO_CHANGES" as const,
      file: toRelative(abs),
      reason: input.reason,
      message: "El contenido nuevo es idéntico al actual; no se escribió nada.",
    };
  }

  // Escribe sobre el destino real (si es un symlink interno, se respeta el enlace).
  const target = exists ? await fs.realpath(abs) : abs;
  await atomicWriteFile(target, content);
  console.error(`[frontend-qa] apply_code_fix ${toRelative(abs)} — ${input.reason}`);

  const prevLines = previous === "" ? 0 : previous.split(/\r?\n/).length;
  const newLines = content.split(/\r?\n/).length;

  let diffStat: string | null = null;
  if (await isGitRepository()) {
    const rel = toRelative(abs);
    const r = await runGit(["diff", "--no-color", "--stat", "--", rel]);
    diffStat = r.stdout.trim() || (exists ? null : "(archivo nuevo, sin seguimiento en git)");
  }

  return {
    status: exists ? ("UPDATED" as const) : ("CREATED" as const),
    file: toRelative(abs),
    reason: input.reason,
    lines_before: prevLines,
    lines_after: newLines,
    bytes_written: Buffer.byteLength(content, "utf8"),
    git_diff_stat: diffStat,
    next_steps: "Verifique la corrección con run_typecheck / run_build_audit; si falla, use revert_file_changes.",
  };
}

/* ------------------------------------------------------------------ */
/* git_diff_summary                                                    */
/* ------------------------------------------------------------------ */

export const gitDiffSummarySchema = {
  relative_path: z.string().min(1).max(1024).optional().describe("Limitar el diff a un archivo o carpeta (opcional)."),
  staged: z.boolean().default(false).describe("Mostrar cambios en staging (git diff --cached) en lugar del working tree."),
  context_lines: z.number().int().min(0).max(20).default(3).describe("Líneas de contexto por hunk."),
};

interface FileDiffStat {
  file: string;
  added: number | null;
  removed: number | null;
  binary: boolean;
}

export async function gitDiffSummary(input: { relative_path?: string; staged: boolean; context_lines: number }) {
  if (!(await isGitRepository())) throw new Error("El frontend no es un repositorio git.");

  const pathspec: string[] = [];
  if (input.relative_path) {
    const abs = await resolveSafePath(input.relative_path);
    pathspec.push("--", toRelative(abs) || ".");
  }
  const base = ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", ...(input.staged ? ["--cached"] : [])];

  const [numstat, diff, status] = await Promise.all([
    runGit([...base, "--numstat", ...pathspec]),
    runGit([...base, `--unified=${input.context_lines}`, ...pathspec]),
    runGit(["-c", "core.quotepath=off", "status", "--porcelain=v1", "--untracked-files=all", ...pathspec]),
  ]);
  for (const r of [numstat, diff, status]) {
    if (r.exitCode !== 0) throw new Error(`git falló (${r.args.join(" ")}): ${r.stderr.trim() || r.spawnError}`);
  }

  const files: FileDiffStat[] = numstat.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [a, d, ...rest] = line.split("\t");
      const binary = a === "-" && d === "-";
      return { file: rest.join("\t"), added: binary ? null : Number(a), removed: binary ? null : Number(d), binary };
    });

  const untracked = status.stdout
    .split("\n")
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3));

  const totals = files.reduce(
    (acc, f) => ({ added: acc.added + (f.added ?? 0), removed: acc.removed + (f.removed ?? 0) }),
    { added: 0, removed: 0 },
  );

  const fullDiff = diff.stdout;
  const truncated = fullDiff.length > MAX_DIFF_CHARS;

  return {
    scope: input.staged ? "staged" : "working-tree",
    path_filter: input.relative_path ?? null,
    files_changed: files.length,
    lines_added: totals.added,
    lines_removed: totals.removed,
    files,
    untracked_files: untracked,
    diff: truncated ? `${fullDiff.slice(0, MAX_DIFF_CHARS)}\n... [diff truncado: ${fullDiff.length} caracteres en total]` : fullDiff,
    truncated,
  };
}

/* ------------------------------------------------------------------ */
/* revert_file_changes                                                 */
/* ------------------------------------------------------------------ */

export const revertFileChangesSchema = {
  relative_path: z.string().min(1).max(1024).describe("Archivo a restaurar, relativo a la raíz del frontend."),
  include_staged: z
    .boolean()
    .default(false)
    .describe("Si es true restaura desde HEAD (descarta también lo que esté en staging). Por defecto usa `git checkout -- <file>`."),
  delete_untracked: z
    .boolean()
    .default(false)
    .describe("Si el archivo no está versionado (p. ej. creado por apply_code_fix), eliminarlo."),
};

export async function revertFileChanges(input: { relative_path: string; include_staged: boolean; delete_untracked: boolean }) {
  if (!(await isGitRepository())) throw new Error("El frontend no es un repositorio git.");
  const abs = await resolveWritablePath(input.relative_path);
  const rel = toRelative(abs);

  const tracked = await runGit(["ls-files", "--error-unmatch", "--", rel]);
  if (tracked.exitCode !== 0) {
    if (!(await pathExists(abs))) throw new Error(`El archivo no existe ni está versionado: ${rel}`);
    if (!input.delete_untracked) {
      return {
        status: "UNTRACKED" as const,
        file: rel,
        message: "El archivo no está versionado en git; no hay versión a la que volver. Use delete_untracked=true para eliminarlo.",
      };
    }
    const st = await fs.lstat(abs);
    if (!st.isFile() && !st.isSymbolicLink()) throw new Error(`Solo se eliminan archivos individuales: ${rel}`);
    await fs.rm(abs);
    console.error(`[frontend-qa] revert_file_changes: eliminado archivo no versionado ${rel}`);
    return { status: "DELETED" as const, file: rel };
  }

  const before = await runGit(["diff", "--no-color", "--numstat", ...(input.include_staged ? ["HEAD"] : []), "--", rel]);
  if (before.stdout.trim() === "") {
    const staged = !input.include_staged && (await runGit(["diff", "--cached", "--numstat", "--", rel])).stdout.trim() !== "";
    return {
      status: "NO_CHANGES" as const,
      file: rel,
      message: staged
        ? "Sin cambios en el working tree, pero hay cambios en staging; use include_staged=true para restaurar desde HEAD."
        : "El archivo no tiene cambios que revertir.",
    };
  }

  const args = input.include_staged ? ["checkout", "HEAD", "--", rel] : ["checkout", "--", rel];
  const r = await runGit(args);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} falló: ${r.stderr.trim() || r.spawnError}`);
  console.error(`[frontend-qa] revert_file_changes: ${rel} restaurado (${args.join(" ")})`);

  const stagedLeft = (await runGit(["diff", "--cached", "--numstat", "--", rel])).stdout.trim();
  const [added, removed] = before.stdout.trim().split("\t");

  return {
    status: "REVERTED" as const,
    file: rel,
    command: `git ${args.join(" ")}`,
    discarded: { lines_added: Number(added) || 0, lines_removed: Number(removed) || 0 },
    ...(stagedLeft
      ? { warning: "Quedan cambios en staging para este archivo; repita con include_staged=true para restaurar desde HEAD." }
      : {}),
  };
}
