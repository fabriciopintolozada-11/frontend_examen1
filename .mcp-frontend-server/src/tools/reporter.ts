import path from "node:path";
import { z } from "zod";
import { FRONTEND_ROOT, atomicWriteFile, readJsonFile, toRelative } from "../utils/paths.js";
import { isGitRepository, runGit } from "../utils/process.js";

export const REPORT_FILE_NAME = "AUDITORIA_FRONTEND.md";

export const BUG_LAYERS = [
  "Tipado",
  "Hooks/Estado",
  "Dependencias",
  "UI/Renderizado",
  "Bundler/Build",
  "Contrato API",
  "Formulario",
  "Seguridad/Auth",
] as const;

const bugSchema = z.object({
  id: z.string().regex(/^BUG-\d{2,}$/, "El id debe tener el formato BUG-01, BUG-02, ..."),
  layer: z.enum(BUG_LAYERS).describe("Capa afectada."),
  file: z.string().min(1).max(512).describe("Ruta y línea, ej. src/app/page.tsx:42"),
  description: z.string().min(1).max(4000).describe("Síntoma visible del bug."),
  root_cause: z.string().min(1).max(4000).describe("Causa raíz técnica."),
  solution_applied: z.string().min(1).max(4000).describe("Resumen del parche aplicado."),
  verification_status: z.enum(["PASS", "FAIL"]).describe("Resultado tras re-ejecutar run_typecheck y run_build_audit."),
});

export const generateBugReportSchema = {
  bugs: z
    .array(bugSchema)
    .min(1)
    .max(500)
    .superRefine((bugs, ctx) => {
      const seen = new Set<string>();
      bugs.forEach((b, i) => {
        if (seen.has(b.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `id duplicado: ${b.id}`, path: [i, "id"] });
        seen.add(b.id);
      });
    })
    .describe("Lista estructurada de bugs encontrados y corregidos."),
  title: z.string().min(1).max(200).default("Auditoría de Calidad del Frontend").describe("Título del reporte."),
  author: z.string().max(200).optional().describe("Autor o equipo responsable (opcional)."),
  executive_summary: z.string().max(8000).optional().describe("Resumen ejecutivo libre (opcional)."),
  typecheck_result: z.enum(["PASS", "FAIL", "SKIPPED"]).optional().describe("Resultado final global de run_typecheck."),
  build_result: z.enum(["PASS", "PASS_WITH_WARNINGS", "FAIL", "SKIPPED"]).optional().describe("Resultado final global de run_build_audit."),
};

type Bug = z.infer<typeof bugSchema>;

/** Escapa texto para celdas de tabla Markdown. */
function cell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n+/g, "<br>").trim();
}

/** Bloque de texto multilínea seguro (citas/listas se preservan). */
function block(text: string): string {
  return text.trim().replace(/\r\n/g, "\n");
}

function anchor(id: string): string {
  return id.toLowerCase();
}

async function gitMetadata(): Promise<{ branch: string | null; commit: string | null; dirty: boolean | null }> {
  if (!(await isGitRepository())) return { branch: null, commit: null, dirty: null };
  const [branch, commit, status] = await Promise.all([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(["rev-parse", "--short", "HEAD"]),
    runGit(["status", "--porcelain"]),
  ]);
  return {
    branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
    commit: commit.exitCode === 0 ? commit.stdout.trim() : null,
    dirty: status.exitCode === 0 ? status.stdout.trim() !== "" : null,
  };
}

export async function generateBugReport(input: {
  bugs: Bug[];
  title: string;
  author?: string;
  executive_summary?: string;
  typecheck_result?: "PASS" | "FAIL" | "SKIPPED";
  build_result?: "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "SKIPPED";
}) {
  const bugs = [...input.bugs].sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
  const pkg = await readJsonFile<{ name?: string; version?: string }>(path.join(FRONTEND_ROOT, "package.json"));
  const git = await gitMetadata();
  const now = new Date();

  const passed = bugs.filter((b) => b.verification_status === "PASS").length;
  const failed = bugs.length - passed;
  const byLayer = new Map<string, { total: number; pass: number }>();
  for (const layer of BUG_LAYERS) byLayer.set(layer, { total: 0, pass: 0 });
  for (const b of bugs) {
    const s = byLayer.get(b.layer)!;
    s.total++;
    if (b.verification_status === "PASS") s.pass++;
  }

  const badge = (s: string) => (s === "PASS" ? "✅ PASS" : s === "FAIL" ? "❌ FAIL" : s === "PASS_WITH_WARNINGS" ? "⚠️ PASS (con warnings)" : "⏭️ SKIPPED");

  const md: string[] = [];
  md.push(`# ${input.title}`, "");
  md.push("| Campo | Valor |", "| --- | --- |");
  md.push(`| Proyecto | ${cell(pkg?.name ?? path.basename(FRONTEND_ROOT))}${pkg?.version ? ` v${cell(pkg.version)}` : ""} |`);
  md.push(`| Fecha | ${now.toISOString().slice(0, 10)} (${now.toISOString()}) |`);
  if (input.author) md.push(`| Autor | ${cell(input.author)} |`);
  if (git.branch) md.push(`| Rama / commit | \`${git.branch}\` @ \`${git.commit}\`${git.dirty ? " (con cambios sin commitear)" : ""} |`);
  md.push(`| Herramienta | frontend-qa-mcp v1.0.0 (Model Context Protocol) |`, "");

  md.push("## 1. Resumen ejecutivo", "");
  if (input.executive_summary) md.push(block(input.executive_summary), "");
  md.push(
    `Se identificaron **${bugs.length}** bugs; **${passed}** quedaron verificados (PASS) y **${failed}** siguen pendientes (FAIL).`,
    "",
  );
  if (input.typecheck_result || input.build_result) {
    md.push("| Verificación global | Resultado |", "| --- | --- |");
    if (input.typecheck_result) md.push(`| \`run_typecheck\` (tsc --noEmit) | ${badge(input.typecheck_result)} |`);
    if (input.build_result) md.push(`| \`run_build_audit\` (build de producción) | ${badge(input.build_result)} |`);
    md.push("");
  }

  md.push("### Distribución por capa", "", "| Capa | Bugs | Verificados (PASS) | Pendientes (FAIL) |", "| --- | ---: | ---: | ---: |");
  for (const [layer, s] of byLayer) {
    if (s.total === 0) continue;
    md.push(`| ${layer} | ${s.total} | ${s.pass} | ${s.total - s.pass} |`);
  }
  md.push(`| **Total** | **${bugs.length}** | **${passed}** | **${failed}** |`, "");

  md.push("## 2. Índice de bugs", "", "| ID | Capa | Archivo | Síntoma | Estado |", "| --- | --- | --- | --- | --- |");
  for (const b of bugs) {
    const short = b.description.length > 110 ? `${b.description.slice(0, 107)}...` : b.description;
    md.push(`| [${b.id}](#${anchor(b.id)}) | ${b.layer} | \`${cell(b.file)}\` | ${cell(short)} | ${badge(b.verification_status)} |`);
  }
  md.push("");

  md.push("## 3. Detalle de bugs", "");
  for (const b of bugs) {
    md.push(`### ${b.id}`, "");
    md.push(`- **Capa:** ${b.layer}`);
    md.push(`- **Archivo:** \`${b.file}\``);
    md.push(`- **Verificación:** ${badge(b.verification_status)}`, "");
    md.push("**Descripción (síntoma visible)**", "", block(b.description), "");
    md.push("**Causa raíz**", "", block(b.root_cause), "");
    md.push("**Solución aplicada**", "", block(b.solution_applied), "");
    md.push("---", "");
  }

  md.push("## 4. Metodología", "");
  md.push(
    "1. **Diagnóstico:** `run_typecheck` (TypeScript `tsc --noEmit`), `run_build_audit` (build de producción del bundler detectado) y `audit_dependencies` (imports vs. `package.json`).",
    "2. **Inspección:** `read_frontend_file`, `search_component_usage` (contratos de props) y `audit_react_hooks_and_state` (análisis AST de Reglas de Hooks, dependencias de efectos y mutaciones de estado).",
    "3. **Corrección:** `apply_code_fix` (escritura atómica), revisada con `git_diff_summary`; los parches fallidos se descartan con `revert_file_changes`.",
    "4. **Verificación:** cada corrección se valida re-ejecutando `run_typecheck` y `run_build_audit`; el estado PASS/FAIL refleja ese resultado.",
    "",
  );
  md.push(`_Reporte generado automáticamente el ${now.toISOString()}._`, "");

  const outPath = path.join(FRONTEND_ROOT, REPORT_FILE_NAME);
  const content = md.join("\n");
  await atomicWriteFile(outPath, content);
  console.error(`[frontend-qa] generate_bug_report: ${REPORT_FILE_NAME} (${bugs.length} bugs)`);

  return {
    status: "GENERATED" as const,
    file: toRelative(outPath),
    absolute_path: outPath,
    bugs_total: bugs.length,
    verified_pass: passed,
    pending_fail: failed,
    by_layer: Object.fromEntries([...byLayer].filter(([, s]) => s.total > 0)),
    bytes: Buffer.byteLength(content, "utf8"),
  };
}
