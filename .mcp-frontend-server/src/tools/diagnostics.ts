import { promises as fs } from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { z } from "zod";
import {
  FRONTEND_ROOT,
  buildLineIndex,
  pathExists,
  readJsonFile,
  resolveSafePath,
  toRelative,
  walkSourceFiles,
} from "../utils/paths.js";
import {
  DEFAULT_TIMEOUT_MS,
  resolveLocalBin,
  runFile,
  runPackageScript,
  stripAnsi,
  tailLines,
} from "../utils/process.js";

/* ------------------------------------------------------------------ */
/* Tipos compartidos                                                   */
/* ------------------------------------------------------------------ */

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

async function readFrontendPackageJson(): Promise<PackageJson> {
  const pkg = await readJsonFile<PackageJson>(path.join(FRONTEND_ROOT, "package.json"));
  if (!pkg) throw new Error(`No se encontró un package.json válido en ${FRONTEND_ROOT}`);
  return pkg;
}

/* ------------------------------------------------------------------ */
/* run_typecheck                                                       */
/* ------------------------------------------------------------------ */

export const runTypecheckSchema = {
  tsconfig: z
    .string()
    .min(1)
    .max(512)
    .default("tsconfig.json")
    .describe("Ruta relativa al tsconfig del frontend (por defecto: tsconfig.json)."),
  max_errors: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .default(200)
    .describe("Número máximo de errores detallados a devolver."),
};

export interface TscDiagnostic {
  file: string | null;
  line: number | null;
  col: number | null;
  code: string;
  severity: "error" | "warning";
  message: string;
}

/** Parsea la salida de `tsc --pretty false`, incluyendo mensajes multilínea encadenados. */
export function parseTscOutput(output: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = [];
  const located = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
  const global = /^(error|warning) (TS\d+): (.*)$/;
  let current: TscDiagnostic | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    let m = located.exec(line);
    if (m) {
      current = {
        file: m[1].split(path.sep).join("/"),
        line: Number(m[2]),
        col: Number(m[3]),
        severity: m[4] as "error" | "warning",
        code: m[5],
        message: m[6],
      };
      diagnostics.push(current);
      continue;
    }
    m = global.exec(line);
    if (m) {
      current = { file: null, line: null, col: null, severity: m[1] as "error" | "warning", code: m[2], message: m[3] };
      diagnostics.push(current);
      continue;
    }
    if (current && /^\s+\S/.test(line)) {
      current.message += `\n${line.trim()}`;
    } else if (line.trim() !== "") {
      current = null;
    }
  }
  return diagnostics;
}

export async function runTypecheck(input: { tsconfig: string; max_errors: number }) {
  const tsconfigPath = await resolveSafePath(input.tsconfig);
  if (!(await pathExists(tsconfigPath))) {
    throw new Error(`No existe el tsconfig: ${input.tsconfig}`);
  }

  const tsc = await resolveLocalBin("typescript", "tsc");
  if (!tsc) {
    return {
      status: "SKIPPED" as const,
      reason:
        "TypeScript no está instalado en el frontend (falta node_modules/typescript). Ejecute `npm install` en la raíz del frontend y vuelva a intentarlo.",
    };
  }

  const warnings: string[] = [];
  const pkg = await readFrontendPackageJson().catch(() => ({}) as PackageJson);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next && !(await pathExists(path.join(FRONTEND_ROOT, "next-env.d.ts")))) {
    warnings.push(
      "Proyecto Next.js sin next-env.d.ts: puede haber falsos positivos (imports de CSS/imágenes y tipos globales PageProps/LayoutProps). Ejecute run_build_audit (next build) o `next typegen` una vez para generarlos.",
    );
  }

  // --incremental false evita escribir *.tsbuildinfo en el repositorio.
  const args = [...tsc.prefixArgs, "--noEmit", "--pretty", "false", "--incremental", "false", "-p", tsconfigPath];
  const result = await runFile(tsc.command, args, { timeoutMs: DEFAULT_TIMEOUT_MS });
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const diagnostics = parseTscOutput(output);
  const errors = diagnostics.filter((d) => d.severity === "error");

  const byCode: Record<string, number> = {};
  const byFile: Record<string, number> = {};
  for (const d of errors) {
    byCode[d.code] = (byCode[d.code] ?? 0) + 1;
    const f = d.file ?? "(global)";
    byFile[f] = (byFile[f] ?? 0) + 1;
  }

  let status: "PASS" | "FAIL" | "TIMEOUT" | "ERROR";
  if (result.timedOut) status = "TIMEOUT";
  else if (result.spawnError) status = "ERROR";
  else if (result.exitCode === 0 && errors.length === 0) status = "PASS";
  else status = "FAIL";

  return {
    status,
    compiler: { source: tsc.source, path: toRelative(tsc.path), version: tsc.packageVersion ?? null },
    tsconfig: toRelative(tsconfigPath),
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    error_count: errors.length,
    warning_count: diagnostics.length - errors.length,
    errors_by_code: byCode,
    errors_by_file: byFile,
    errors: errors.slice(0, input.max_errors).map(({ file, line, col, code, message }) => ({ file, line, col, code, message })),
    truncated: errors.length > input.max_errors,
    warnings,
    ...(status !== "PASS" && errors.length === 0 ? { raw_output_tail: tailLines(output.trim(), 60) } : {}),
    ...(result.spawnError ? { spawn_error: result.spawnError } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* run_build_audit                                                     */
/* ------------------------------------------------------------------ */

export const runBuildAuditSchema = {
  script: z
    .string()
    .regex(/^[\w:.-]+$/, "Nombre de script inválido (solo letras, números, ':', '.', '-', '_').")
    .default("build")
    .describe("Script del package.json a ejecutar (por defecto: build)."),
  timeout_ms: z
    .number()
    .int()
    .min(10_000)
    .max(600_000)
    .default(DEFAULT_TIMEOUT_MS)
    .describe("Tiempo máximo de ejecución en milisegundos (por defecto 120000)."),
  max_issues: z.number().int().min(1).max(1000).default(150).describe("Máximo de incidencias a devolver."),
};

interface BundlerInfo {
  id: string;
  name: string;
  version: string | null;
  config_files: string[];
}

const BUNDLER_CANDIDATES: Array<{ id: string; name: string; pkg: string; configs: string[] }> = [
  { id: "nextjs", name: "Next.js", pkg: "next", configs: ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"] },
  { id: "nuxt", name: "Nuxt", pkg: "nuxt", configs: ["nuxt.config.ts", "nuxt.config.js"] },
  { id: "sveltekit", name: "SvelteKit", pkg: "@sveltejs/kit", configs: ["svelte.config.js"] },
  { id: "astro", name: "Astro", pkg: "astro", configs: ["astro.config.mjs", "astro.config.ts"] },
  { id: "remix", name: "Remix", pkg: "@remix-run/dev", configs: ["remix.config.js"] },
  { id: "angular", name: "Angular CLI", pkg: "@angular/cli", configs: ["angular.json"] },
  { id: "cra", name: "Create React App", pkg: "react-scripts", configs: [] },
  { id: "vite", name: "Vite", pkg: "vite", configs: ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"] },
  { id: "webpack", name: "Webpack", pkg: "webpack", configs: ["webpack.config.js", "webpack.config.ts", "webpack.config.cjs"] },
  { id: "parcel", name: "Parcel", pkg: "parcel", configs: [".parcelrc"] },
  { id: "rollup", name: "Rollup", pkg: "rollup", configs: ["rollup.config.js", "rollup.config.mjs", "rollup.config.ts"] },
  { id: "esbuild", name: "esbuild", pkg: "esbuild", configs: [] },
];

async function detectBundlers(pkg: PackageJson): Promise<BundlerInfo[]> {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const found: BundlerInfo[] = [];
  for (const c of BUNDLER_CANDIDATES) {
    const configs: string[] = [];
    for (const cfg of c.configs) if (await pathExists(path.join(FRONTEND_ROOT, cfg))) configs.push(cfg);
    if (deps[c.pkg] || configs.length > 0) {
      found.push({ id: c.id, name: c.name, version: deps[c.pkg] ?? null, config_files: configs });
    }
  }
  return found;
}

type IssueCategory =
  | "module_not_found"
  | "type_error"
  | "syntax_error"
  | "prerender_error"
  | "chunk_size"
  | "lint"
  | "deprecation"
  | "env"
  | "other";

interface BuildIssue {
  severity: "error" | "warning";
  category: IssueCategory;
  message: string;
  file: string | null;
  line: number | null;
  col: number | null;
}

const LOCATION_HEADER_RE = /^\s*(?:\.{0,2}\/)?[\w@()[\]./-]+\.\w+[:(]\d+/;
const LOCATION_RE = /((?:\.{0,2}\/)?[\w@()[\]./-]+\.(?:tsx?|jsx?|mjs|cjs|mts|cts|css|scss|sass|less|vue|svelte|astro|json))(?:[:(](\d+)(?:[:,](\d+))?\)?)?/;

function classify(text: string): IssueCategory {
  const t = text.toLowerCase();
  if (/module not found|can't resolve|cannot find module|failed to resolve import|could not resolve/.test(t)) return "module_not_found";
  if (/type error|ts\d{4}/.test(t)) return "type_error";
  if (/syntaxerror|unexpected token|parsing error|expected .* but found|unterminated/.test(t)) return "syntax_error";
  if (/prerender|generating static pages|export encountered errors/.test(t)) return "prerender_error";
  if (/chunk|larger than|size limit|asset size|entrypoint size/.test(t)) return "chunk_size";
  if (/eslint|lint/.test(t)) return "lint";
  if (/deprecat/.test(t)) return "deprecation";
  if (/environment variable|process\.env|\.env/.test(t)) return "env";
  return "other";
}

const ERROR_LINE_RE =
  /(^|\b)(error|failed to compile|build failed|failed|cannot find|can't resolve|module not found|unexpected token|syntaxerror|type error)\b|^\s*✗|^\s*⨯|^ERROR in/i;
const WARNING_LINE_RE = /(^|\b)(warn(ing)?|deprecated)\b|^\s*⚠|^\(!\)|larger than|size limit|^WARNING in/i;
const BENIGN_RE = /\b0 (errors?|warnings?)\b|no errors|without errors|compiled successfully|✓|errors?:\s*0\b/i;

/** Extrae incidencias estructuradas de la salida de un bundler (Next, Vite, Webpack, CRA…). */
export function parseBuildOutput(output: string, maxIssues: number): BuildIssue[] {
  const lines = output.split(/\r?\n/);
  const issues: BuildIssue[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || BENIGN_RE.test(line)) continue;

    let severity: "error" | "warning" | null = null;
    if (ERROR_LINE_RE.test(line)) severity = "error";
    else if (WARNING_LINE_RE.test(line)) severity = "warning";
    if (!severity) continue;
    // Las líneas de npm ("npm error code 1", "npm ERR! ...") solo repiten el fallo; no aportan.
    if (/^npm (error|ERR!)/i.test(line) && !/missing script/i.test(line)) continue;

    // Ubicación: misma línea o hasta 2 líneas previas (formato Next/Turbopack: "./src/x.tsx:3:1").
    let file: string | null = null;
    let ln: number | null = null;
    let col: number | null = null;
    for (let j = i; j >= Math.max(0, i - 2); j--) {
      // En líneas previas solo cuenta una cabecera de ubicación propia ("./src/x.tsx:3:1").
      if (j !== i && !LOCATION_HEADER_RE.test(lines[j])) continue;
      const m = LOCATION_RE.exec(lines[j]);
      if (m && !/^https?:/.test(m[1])) {
        file = m[1].replace(/^\.\//, "");
        ln = m[2] ? Number(m[2]) : null;
        col = m[3] ? Number(m[3]) : null;
        break;
      }
    }

    // Contexto: añade la(s) línea(s) siguiente(s) indentadas o explicativas.
    let message = line;
    for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) {
      const next = lines[k];
      if (!next.trim() || ERROR_LINE_RE.test(next) || WARNING_LINE_RE.test(next)) break;
      if (/^\s{2,}|^\s*[>|]|^\s*\d+\s*\|/.test(next)) message += `\n${next.trimEnd()}`;
      else break;
    }

    const key = `${severity}|${file}|${ln}|${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ severity, category: classify(message), message: message.slice(0, 2000), file, line: ln, col });
    if (issues.length >= maxIssues) break;
  }
  return issues;
}

export async function runBuildAudit(input: { script: string; timeout_ms: number; max_issues: number }) {
  const pkg = await readFrontendPackageJson();
  const bundlers = await detectBundlers(pkg);
  const scriptCmd = pkg.scripts?.[input.script];

  if (!scriptCmd) {
    return {
      status: "ERROR" as const,
      reason: `El package.json no define el script "${input.script}".`,
      available_scripts: Object.keys(pkg.scripts ?? {}),
      bundlers_detected: bundlers,
    };
  }
  if (!(await pathExists(path.join(FRONTEND_ROOT, "node_modules")))) {
    return {
      status: "SKIPPED" as const,
      reason: "Las dependencias del frontend no están instaladas (no existe node_modules). Ejecute `npm install` en la raíz del frontend.",
      script: { name: input.script, command: scriptCmd },
      bundlers_detected: bundlers,
    };
  }

  const result = await runPackageScript(input.script, { timeoutMs: input.timeout_ms });
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const issues = parseBuildOutput(output, input.max_issues);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  let status: "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "TIMEOUT" | "ERROR";
  if (result.timedOut) status = "TIMEOUT";
  else if (result.spawnError) status = "ERROR";
  else if (result.exitCode !== 0) status = "FAIL";
  else if (warnings.length > 0 || errors.length > 0) status = "PASS_WITH_WARNINGS";
  else status = "PASS";

  const byCategory: Record<string, number> = {};
  for (const i of issues) byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;

  return {
    status,
    package_manager: result.packageManager,
    script: { name: input.script, command: scriptCmd },
    bundlers_detected: bundlers,
    exit_code: result.exitCode,
    signal: result.signal,
    duration_ms: result.durationMs,
    timed_out: result.timedOut,
    output_truncated: result.bufferExceeded,
    error_count: errors.length,
    warning_count: warnings.length,
    issues_by_category: byCategory,
    issues,
    output_tail: tailLines(output.trim(), status === "PASS" ? 25 : 80),
    ...(result.spawnError ? { spawn_error: result.spawnError } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* audit_dependencies                                                  */
/* ------------------------------------------------------------------ */

export const auditDependenciesSchema = {
  include_unused: z
    .boolean()
    .default(true)
    .describe("Incluir dependencias declaradas que no se importan en ningún archivo (informativo)."),
};

const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, "")]));

/** Paquetes que se usan sin import explícito (CLIs, plugins de config, tipos ambientales). */
const IMPLICIT_USAGE_RE =
  /^(@types\/|typescript$|react-dom$|eslint|@eslint\/|prettier|tailwindcss$|@tailwindcss\/|postcss|autoprefixer|@next\/eslint|eslint-config-|eslint-plugin-|@typescript-eslint\/|vite$|webpack|react-scripts$|jest|vitest|@testing-library\/|husky|lint-staged|sass$|babel-|@babel\/)/;

interface ImportOccurrence {
  file: string;
  line: number;
  specifier: string;
  typeOnly: boolean;
}

function stripComments(code: string): string {
  // Elimina comentarios de bloque y de línea completa preservando saltos de línea (para numeración).
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, (m) => " ".repeat(m.length));
}

const IMPORT_PATTERNS: Array<{ re: RegExp; typeGroup?: number; specGroup: number }> = [
  // import x from 'y' | import type { x } from 'y' | export { x } from 'y' | export * from 'y'
  { re: /\b(?:import|export)\s+(type\s+)?(?:[\w*${}\s,]+?)\s+from\s*['"]([^'"\n]+)['"]/g, typeGroup: 1, specGroup: 2 },
  // import 'side-effect'
  { re: /\bimport\s*['"]([^'"\n]+)['"]/g, specGroup: 1 },
  // require('x') | import('x') | require.resolve('x')
  { re: /\b(?:require(?:\.resolve)?|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, specGroup: 1 },
];

export function extractImports(code: string): Array<{ index: number; specifier: string; typeOnly: boolean }> {
  const clean = stripComments(code);
  const found: Array<{ index: number; specifier: string; typeOnly: boolean }> = [];
  for (const { re, typeGroup, specGroup } of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean))) {
      found.push({ index: m.index, specifier: m[specGroup], typeOnly: typeGroup ? Boolean(m[typeGroup]) : false });
    }
  }
  return found;
}

/** 'lodash/fp' → 'lodash' ; '@scope/pkg/sub' → '@scope/pkg' */
export function packageNameFromSpecifier(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

interface AliasMatcher {
  pattern: string;
  matches: (spec: string) => boolean;
}

async function loadAliasMatchers(): Promise<{ aliases: AliasMatcher[]; baseUrl: string | null }> {
  const aliases: AliasMatcher[] = [];
  let baseUrl: string | null = null;
  for (const cfgName of ["tsconfig.json", "jsconfig.json"]) {
    const cfg = await readJsonFile<{ compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } }>(
      path.join(FRONTEND_ROOT, cfgName),
    );
    const opts = cfg?.compilerOptions;
    if (!opts) continue;
    if (opts.baseUrl) baseUrl = path.resolve(FRONTEND_ROOT, opts.baseUrl);
    for (const key of Object.keys(opts.paths ?? {})) {
      if (key.endsWith("*")) {
        const prefix = key.slice(0, -1);
        aliases.push({ pattern: key, matches: (s) => s.startsWith(prefix) });
      } else {
        aliases.push({ pattern: key, matches: (s) => s === key });
      }
    }
  }
  return { aliases, baseUrl };
}

export async function auditDependencies(input: { include_unused: boolean }) {
  const pkg = await readFrontendPackageJson();
  const declared = new Map<string, string>();
  const sections: Array<[keyof PackageJson, Record<string, string> | undefined]> = [
    ["dependencies", pkg.dependencies],
    ["devDependencies", pkg.devDependencies],
    ["peerDependencies", pkg.peerDependencies],
    ["optionalDependencies", pkg.optionalDependencies],
  ];
  for (const [section, deps] of sections) for (const name of Object.keys(deps ?? {})) if (!declared.has(name)) declared.set(name, section);

  const { aliases, baseUrl } = await loadAliasMatchers();
  const files = await walkSourceFiles();
  const usage = new Map<string, ImportOccurrence[]>();
  const excluded = { relative: 0, node_builtin: 0, alias: 0, other: 0 };
  const baseUrlCache = new Map<string, boolean>();

  for (const file of files) {
    const code = await fs.readFile(file, "utf8");
    const pos = buildLineIndex(code);
    for (const imp of extractImports(code)) {
      const spec = imp.specifier.trim();
      if (spec.startsWith(".") || spec.startsWith("/")) {
        excluded.relative++;
        continue;
      }
      if (spec.startsWith("node:") || NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(spec.split("/")[0])) {
        excluded.node_builtin++;
        continue;
      }
      if (aliases.some((a) => a.matches(spec))) {
        excluded.alias++;
        continue;
      }
      if (/^(https?:|data:|virtual:|~|#|\$)/.test(spec) || spec.includes("?")) {
        excluded.other++;
        continue;
      }
      const name = packageNameFromSpecifier(spec);
      if (baseUrl && !declared.has(name)) {
        // Import resuelto vía baseUrl (p. ej. "components/Button" con baseUrl "src").
        const first = spec.split("/")[0];
        if (!baseUrlCache.has(first)) {
          const hit = await Promise.any(
            ["", ".ts", ".tsx", ".js", ".jsx"].map(async (ext) => {
              if (await pathExists(path.join(baseUrl, first + ext))) return true;
              throw new Error("no");
            }),
          ).catch(() => false);
          baseUrlCache.set(first, hit);
        }
        if (baseUrlCache.get(first)) {
          excluded.alias++;
          continue;
        }
      }
      const list = usage.get(name) ?? [];
      list.push({ file: toRelative(file), line: pos(imp.index).line, specifier: spec, typeOnly: imp.typeOnly });
      usage.set(name, list);
    }
  }

  const undeclared: Array<{ package: string; occurrences: number; files: Array<{ file: string; line: number; specifier: string }> }> = [];
  const notInstalled: Array<{ package: string; declared_in: string; imported: boolean }> = [];
  const typeOnlyCoveredByTypes: string[] = [];

  for (const [name, occ] of [...usage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (declared.has(name)) continue;
    const allTypeOnly = occ.every((o) => o.typeOnly);
    const typesPkg = name.startsWith("@") ? `@types/${name.slice(1).replace("/", "__")}` : `@types/${name}`;
    if (allTypeOnly && declared.has(typesPkg)) {
      typeOnlyCoveredByTypes.push(name);
      continue;
    }
    undeclared.push({
      package: name,
      occurrences: occ.length,
      files: occ.slice(0, 15).map(({ file, line, specifier }) => ({ file, line, specifier })),
    });
  }

  const nodeModulesExists = await pathExists(path.join(FRONTEND_ROOT, "node_modules"));
  for (const [name, section] of declared) {
    const installed = await pathExists(path.join(FRONTEND_ROOT, "node_modules", ...name.split("/"), "package.json"));
    if (!installed) notInstalled.push({ package: name, declared_in: section, imported: usage.has(name) });
  }

  const unused = input.include_unused
    ? [...declared.entries()]
        .filter(([name, section]) => section === "dependencies" && !usage.has(name) && !IMPLICIT_USAGE_RE.test(name))
        .map(([name]) => name)
    : [];

  const status = undeclared.length > 0 || notInstalled.some((n) => n.imported) ? "FAIL" : "PASS";

  return {
    status,
    scanned_files: files.length,
    declared_count: declared.size,
    external_packages_imported: [...usage.keys()].sort(),
    undeclared_packages: undeclared,
    declared_but_not_installed: notInstalled,
    ...(nodeModulesExists ? {} : { note: "No existe node_modules en el frontend: todas las dependencias figuran como no instaladas. Ejecute `npm install`." }),
    ...(input.include_unused ? { possibly_unused_dependencies: unused } : {}),
    type_only_imports_covered_by_types: typeOnlyCoveredByTypes,
    excluded_specifiers: excluded,
    alias_patterns: aliases.map((a) => a.pattern),
  };
}
