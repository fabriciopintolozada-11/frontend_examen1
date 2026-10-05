import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import type * as TS from "typescript";
import {
  FRONTEND_ROOT,
  buildLineIndex,
  pathExists,
  resolveSafePath,
  toRelative,
  walkSourceFiles,
} from "../utils/paths.js";

const MAX_READ_BYTES = 2 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* read_frontend_file                                                  */
/* ------------------------------------------------------------------ */

export const readFrontendFileSchema = {
  relative_path: z.string().min(1).max(1024).describe("Ruta del archivo relativa a la raíz del frontend (ej. src/app/page.tsx)."),
  start_line: z.number().int().min(1).optional().describe("Primera línea a devolver (1-based, opcional)."),
  end_line: z.number().int().min(1).optional().describe("Última línea a devolver (inclusive, opcional)."),
};

export async function readFrontendFile(input: { relative_path: string; start_line?: number; end_line?: number }) {
  const abs = await resolveSafePath(input.relative_path);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new Error(`El archivo no existe: ${input.relative_path}`);
  }
  if (!stat.isFile()) throw new Error(`La ruta no es un archivo regular: ${input.relative_path}`);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`Archivo demasiado grande (${stat.size} bytes; máximo ${MAX_READ_BYTES}).`);
  }

  const buffer = await fs.readFile(abs);
  if (buffer.subarray(0, 8000).includes(0)) {
    throw new Error("El archivo parece binario; solo se admiten archivos de texto.");
  }
  const lines = buffer.toString("utf8").split(/\r?\n/);
  const start = Math.max(1, input.start_line ?? 1);
  const end = Math.min(lines.length, input.end_line ?? lines.length);
  if (start > end) throw new Error(`Rango inválido: start_line (${start}) > end_line (${end}).`);

  const width = String(end).length;
  const numbered = lines
    .slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(width, " ")} | ${l}`)
    .join("\n");

  return {
    header: `${toRelative(abs)} — líneas ${start}-${end} de ${lines.length} (${stat.size} bytes)`,
    content: numbered,
  };
}

/* ------------------------------------------------------------------ */
/* search_component_usage                                              */
/* ------------------------------------------------------------------ */

export const searchComponentUsageSchema = {
  component_name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_$][\w$]*$/, "Debe ser un identificador válido de JavaScript (ej. Button, UserCard).")
    .describe("Nombre del componente React a rastrear (ej. Button)."),
  max_results: z.number().int().min(1).max(1000).default(300).describe("Máximo de sitios de renderizado a devolver."),
};

interface PropMember {
  name: string;
  optional: boolean;
  type: string;
}

interface PropsContract {
  type_name: string | null;
  file: string;
  line: number;
  members: PropMember[];
  /** true si el tipo extiende/intersecta otros tipos o tiene index signature → no se puede afirmar que una prop sea desconocida. */
  open: boolean;
  extends: string | null;
}

interface JsxAttr {
  name: string;
  value: string | null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Devuelve el índice del cierre que balancea la apertura en `openIdx` (respetando cadenas). */
function findMatching(text: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Parsea los miembros de primer nivel de un cuerpo de tipo `{ ... }`. */
function parseTypeMembers(body: string): { members: PropMember[]; hasIndexSignature: boolean } {
  const members: PropMember[] = [];
  let hasIndexSignature = false;
  body = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === "\\") current += body[++i] ?? "";
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    if ("{([<".includes(ch)) depth++;
    if ("})]>".includes(ch) && !(ch === ">" && body[i - 1] === "=")) depth--;
    if (depth === 0 && (ch === ";" || ch === "," || ch === "\n")) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);

  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (part.startsWith("[")) {
      hasIndexSignature = true;
      continue;
    }
    const m = /^(?:readonly\s+)?(["']?)([\w$-]+)\1(\?)?\s*(:|\()([\s\S]*)$/.exec(part);
    if (!m) continue;
    members.push({
      name: m[2],
      optional: Boolean(m[3]),
      type: (m[4] === "(" ? `(${m[5]}` : m[5]).trim().replace(/\s+/g, " ").slice(0, 120),
    });
  }
  return { members, hasIndexSignature };
}

/** Busca la declaración `interface X` / `type X =` en un texto y extrae su contrato. */
function extractNamedType(text: string, typeName: string): Omit<PropsContract, "file"> | null {
  const iface = new RegExp(`\\binterface\\s+${escapeRe(typeName)}\\b(?:\\s*<[^>{]*>)?\\s*(extends\\s+([^{]+))?\\{`).exec(text);
  const pos = buildLineIndex(text);
  if (iface) {
    const open = iface.index + iface[0].length - 1;
    const close = findMatching(text, open, "{", "}");
    if (close < 0) return null;
    const { members, hasIndexSignature } = parseTypeMembers(text.slice(open + 1, close));
    const ext = iface[2]?.trim() ?? null;
    return { type_name: typeName, line: pos(iface.index).line, members, open: Boolean(ext) || hasIndexSignature, extends: ext };
  }
  const alias = new RegExp(`\\btype\\s+${escapeRe(typeName)}\\b(?:\\s*<[^>=]*>)?\\s*=\\s*`).exec(text);
  if (alias) {
    const startIdx = alias.index + alias[0].length;
    const rest = text.slice(startIdx);
    const braceAt = rest.indexOf("{");
    const prefix = braceAt >= 0 ? rest.slice(0, braceAt) : rest;
    if (braceAt < 0 || prefix.trim() !== "" && !/&\s*$/.test(prefix)) {
      return { type_name: typeName, line: pos(alias.index).line, members: [], open: true, extends: rest.split(/[;\n]/)[0].trim().slice(0, 160) };
    }
    const open = startIdx + braceAt;
    const close = findMatching(text, open, "{", "}");
    if (close < 0) return null;
    const { members, hasIndexSignature } = parseTypeMembers(text.slice(open + 1, close));
    const after = text.slice(close + 1, close + 200);
    const intersects = /^\s*&/.test(after) || prefix.includes("&");
    return {
      type_name: typeName,
      line: pos(alias.index).line,
      members,
      open: intersects || hasIndexSignature,
      extends: intersects ? (prefix.replace(/&\s*$/, "").trim() || after.split(/[;\n]/)[0].replace(/^\s*&/, "").trim()) : null,
    };
  }
  return null;
}

interface Definition {
  file: string;
  line: number;
  kind: "function" | "variable" | "class" | "lazy";
  exported: boolean;
  index: number;
  text: string;
}

function findDefinitions(text: string, name: string, file: string): Definition[] {
  const pos = buildLineIndex(text);
  const n = escapeRe(name);
  const patterns: Array<{ re: RegExp; kind: Definition["kind"] }> = [
    { re: new RegExp(`(^|\\n)\\s*(export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s*\\*?\\s*${n}\\b`, "g"), kind: "function" },
    { re: new RegExp(`(^|\\n)\\s*(export\\s+)?(?:const|let|var)\\s+${n}\\b\\s*(?::[^=\\n]+)?=`, "g"), kind: "variable" },
    { re: new RegExp(`(^|\\n)\\s*(export\\s+(?:default\\s+)?)?(?:abstract\\s+)?class\\s+${n}\\b`, "g"), kind: "class" },
  ];
  const defs: Definition[] = [];
  for (const { re, kind } of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const idx = m.index + m[1].length;
      let k = kind;
      if (kind === "variable" && /^\s*(?:React\.)?(?:lazy|dynamic|loadable)\s*\(/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 60))) {
        k = "lazy";
      }
      const exported =
        Boolean(m[2]) ||
        new RegExp(`export\\s+default\\s+${n}\\b|export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`).test(text);
      defs.push({ file, line: pos(idx).line, kind: k, exported, index: idx, text });
    }
  }
  return defs;
}

/** Determina el tipo de props a partir de la firma del componente. */
function findPropsContract(def: Definition, name: string): Omit<PropsContract, "file"> | null {
  const window = def.text.slice(def.index, def.index + 1500);
  // Se toma la coincidencia más temprana para no confundir el tipo de retorno con el de props.
  const named =
    [
      /(?:FC|FunctionComponent|VFC|forwardRef|memo)\s*<\s*(?:[\w.]+\s*,\s*)?(?:Readonly<\s*)?([A-Z][\w$]*)/.exec(window),
      /\}\s*:\s*(?:Readonly<\s*)?([A-Z][\w$]*)/.exec(window),
      /\(\s*\w+\s*:\s*(?:Readonly<\s*)?([A-Z][\w$]*)/.exec(window),
    ]
      .filter((m): m is RegExpExecArray => m !== null)
      .sort((a, b) => a.index - b.index)[0] ?? null;

  // Tipo inline: ({ a, b }: { a: string; b?: number })
  const inline = /\}\s*:\s*\{/.exec(window);
  if (inline && (!named || inline.index < named.index)) {
    const open = def.index + inline.index + inline[0].length - 1;
    const close = findMatching(def.text, open, "{", "}");
    if (close > 0) {
      const { members, hasIndexSignature } = parseTypeMembers(def.text.slice(open + 1, close));
      return { type_name: null, line: def.line, members, open: hasIndexSignature, extends: null };
    }
  }
  const typeName = named?.[1] ?? `${name}Props`;
  return extractNamedType(def.text, typeName);
}

/** Parsea los atributos de una etiqueta JSX de apertura a partir de `start` (justo después del nombre). */
function parseJsxOpening(text: string, start: number): { attrs: JsxAttr[]; spreads: string[]; selfClosing: boolean; end: number } | null {
  const attrs: JsxAttr[] = [];
  const spreads: string[] = [];
  let i = start;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === ">") return { attrs, spreads, selfClosing: true, end: i + 2 };
    if (ch === ">") return { attrs, spreads, selfClosing: false, end: i + 1 };
    if (ch === "<") {
      // Argumentos genéricos <Comp<T> ...> — se omiten.
      const close = findMatching(text, i, "<", ">");
      if (close < 0) return null;
      i = close + 1;
      continue;
    }
    if (ch === "{") {
      const close = findMatching(text, i, "{", "}");
      if (close < 0) return null;
      const inner = text.slice(i + 1, close).trim();
      if (inner.startsWith("...")) spreads.push(inner.slice(3).trim());
      i = close + 1;
      continue;
    }
    const nameMatch = /^[\w$:.-]+/.exec(text.slice(i, i + 200));
    if (!nameMatch) return null;
    const attrName = nameMatch[0];
    i += attrName.length;
    while (i < len && /\s/.test(text[i])) i++;
    if (text[i] !== "=") {
      attrs.push({ name: attrName, value: "true" });
      continue;
    }
    i++;
    while (i < len && /\s/.test(text[i])) i++;
    const vch = text[i];
    if (vch === '"' || vch === "'") {
      const endQ = text.indexOf(vch, i + 1);
      if (endQ < 0) return null;
      attrs.push({ name: attrName, value: text.slice(i, endQ + 1) });
      i = endQ + 1;
    } else if (vch === "{") {
      const close = findMatching(text, i, "{", "}");
      if (close < 0) return null;
      const v = text.slice(i, close + 1).replace(/\s+/g, " ");
      attrs.push({ name: attrName, value: v.length > 100 ? `${v.slice(0, 97)}...}` : v });
      i = close + 1;
    } else if (vch === "<") {
      const close = findMatching(text, i, "<", ">");
      if (close < 0) return null;
      attrs.push({ name: attrName, value: "<JSX>" });
      i = close + 1;
    } else return null;
  }
  return null;
}

interface ImportSite {
  file: string;
  line: number;
  statement: string;
  source: string;
  local_name: string;
  kind: "named" | "default" | "namespace" | "re-export";
}

function findImports(text: string, name: string, file: string): ImportSite[] {
  const pos = buildLineIndex(text);
  const sites: ImportSite[] = [];
  const re = /\b(import|export)\s+(?:type\s+)?([\w$*{}\s,]+?)\s+from\s*['"]([^'"\n]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [statement, keyword, clause, source] = m;
    const line = pos(m.index).line;
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) {
      for (const spec of named[1].split(",")) {
        const parts = spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
        if (parts[0] === name) {
          sites.push({
            file,
            line,
            statement: statement.replace(/\s+/g, " "),
            source,
            local_name: parts[1]?.trim() ?? name,
            kind: keyword === "export" ? "re-export" : "named",
          });
        }
      }
    }
    if (keyword === "import") {
      const def = /^\s*([\w$]+)\s*(?:,|$)/.exec(clause);
      if (def && def[1] === name) {
        sites.push({ file, line, statement: statement.replace(/\s+/g, " "), source, local_name: name, kind: "default" });
      }
      const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
      if (ns && new RegExp(`<${escapeRe(ns[1])}\\.${escapeRe(name)}\\b`).test(text)) {
        sites.push({ file, line, statement: statement.replace(/\s+/g, " "), source, local_name: `${ns[1]}.${name}`, kind: "namespace" });
      }
    }
  }
  return sites;
}

const JSX_EXTS = new Set([".tsx", ".jsx", ".js", ".mjs"]);

export async function searchComponentUsage(input: { component_name: string; max_results: number }) {
  const name = input.component_name;
  const files = await walkSourceFiles();
  const definitions: Array<Omit<Definition, "text" | "index">> = [];
  const imports: ImportSite[] = [];
  const renders: Array<{
    file: string;
    line: number;
    col: number;
    tag: string;
    props: JsxAttr[];
    spreads: string[];
    self_closing: boolean;
    issues: string[];
  }> = [];
  let contract: PropsContract | null = null;
  const fileTexts = new Map<string, string>();

  for (const abs of files) {
    const text = await fs.readFile(abs, "utf8");
    if (!text.includes(name)) continue;
    const rel = toRelative(abs);
    fileTexts.set(rel, text);

    for (const def of findDefinitions(text, name, rel)) {
      definitions.push({ file: def.file, line: def.line, kind: def.kind, exported: def.exported });
      if (!contract && def.kind !== "lazy") {
        const c = findPropsContract(def, name);
        if (c) contract = { ...c, file: rel };
      }
    }
    imports.push(...findImports(text, name, rel));
  }

  // Si el tipo de props se declaró en otro archivo (p. ej. types.ts), búscalo globalmente.
  if (!contract && definitions.length > 0) {
    const fallbackName = `${name}Props`;
    for (const abs of files) {
      const text = fileTexts.get(toRelative(abs)) ?? (await fs.readFile(abs, "utf8"));
      if (!text.includes(fallbackName)) continue;
      const c = extractNamedType(text, fallbackName);
      if (c) {
        contract = { ...c, file: toRelative(abs) };
        break;
      }
    }
  }

  const declared = new Map((contract?.members ?? []).map((m) => [m.name, m]));
  const builtinAttrs = new Set(["key", "ref"]);

  for (const [rel, text] of fileTexts) {
    if (!JSX_EXTS.has(path.extname(rel))) continue;
    const localNames = new Set<string>([name]);
    for (const imp of imports) if (imp.file === rel) localNames.add(imp.local_name);

    const pos = buildLineIndex(text);
    for (const local of localNames) {
      const re = new RegExp(`<${escapeRe(local)}(?=[\\s/>])`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const prev = text[m.index - 1];
        if (prev && /[\w$.)\]]/.test(prev)) continue; // genérico TS: useState<Name>, Array<Name>
        const parsed = parseJsxOpening(text, m.index + m[0].length);
        if (!parsed) continue;
        const { line, col } = pos(m.index);
        const issues: string[] = [];
        if (contract && contract.members.length > 0) {
          const passed = new Set(parsed.attrs.map((a) => a.name));
          const hasChildren = !parsed.selfClosing;
          if (!contract.open) {
            for (const a of parsed.attrs) {
              if (builtinAttrs.has(a.name) || a.name.includes("-") || a.name.includes(":")) continue;
              if (!declared.has(a.name)) issues.push(`Prop desconocida "${a.name}": no está declarada en ${contract.type_name ?? "el tipo de props"}.`);
            }
            if (hasChildren && !declared.has("children")) {
              issues.push(`Se pasan children pero ${contract.type_name ?? "el tipo de props"} no declara "children".`);
            }
          }
          if (parsed.spreads.length === 0) {
            for (const member of contract.members) {
              if (member.optional || passed.has(member.name)) continue;
              if (member.name === "children" && hasChildren) continue;
              issues.push(`Falta la prop requerida "${member.name}" (${member.type}).`);
            }
          }
        }
        renders.push({
          file: rel,
          line,
          col,
          tag: local,
          props: parsed.attrs,
          spreads: parsed.spreads,
          self_closing: parsed.selfClosing,
          issues,
        });
        if (renders.length >= input.max_results) break;
      }
    }
  }

  const renderFiles = new Set(renders.map((r) => r.file));
  const importOnly = [...new Set(imports.filter((i) => i.kind !== "re-export").map((i) => i.file))].filter((f) => !renderFiles.has(f));
  const findings: string[] = [];
  if (definitions.length === 0) findings.push(`No se encontró la definición de "${name}" dentro del frontend (¿proviene de una librería externa?).`);
  if (definitions.length > 1) findings.push(`"${name}" está definido ${definitions.length} veces: riesgo de importar la versión equivocada.`);
  for (const f of importOnly) findings.push(`${f} importa "${name}" pero no lo renderiza (import sin uso o uso no-JSX).`);
  if (definitions.length > 0 && definitions.every((d) => !d.exported) && imports.length > 0) {
    findings.push(`"${name}" se importa pero ninguna definición encontrada está exportada.`);
  }
  if (contract?.open) {
    findings.push(
      `El contrato de props es abierto (${contract.extends ?? "index signature"}); solo se validan props requeridas, no props desconocidas.`,
    );
  }

  return {
    component: name,
    summary: {
      definitions: definitions.length,
      import_sites: imports.length,
      render_sites: renders.length,
      render_sites_with_issues: renders.filter((r) => r.issues.length > 0).length,
      truncated: renders.length >= input.max_results,
    },
    definitions,
    props_contract: contract,
    imports: imports.map(({ file, line, statement, source, local_name, kind }) => ({ file, line, statement, source, local_name, kind })),
    renders,
    findings,
  };
}

/* ------------------------------------------------------------------ */
/* audit_react_hooks_and_state  (análisis AST con el compilador de TS) */
/* ------------------------------------------------------------------ */

export const auditReactHooksSchema = {
  relative_path: z.string().min(1).max(1024).describe("Archivo .tsx/.jsx/.ts/.js a analizar, relativo a la raíz del frontend."),
};

type TSModule = typeof TS;
let tsModule: TSModule | null = null;

/**
 * Carga el compilador de TypeScript: primero el del servidor MCP y, si no existe
 * (instalación con --omit=dev), el del propio frontend.
 */
function loadTypeScript(): TSModule {
  if (tsModule) return tsModule;
  const errors: string[] = [];
  for (const base of [import.meta.url, path.join(FRONTEND_ROOT, "package.json")]) {
    try {
      const req = createRequire(base);
      tsModule = req("typescript") as TSModule;
      return tsModule;
    } catch (err) {
      errors.push(String(err));
    }
  }
  throw new Error(
    `No se pudo cargar el compilador de TypeScript para el análisis AST. Ejecute npm install en .mcp-frontend-server/. Detalle: ${errors.join(" | ")}`,
  );
}

type Severity = "error" | "warning" | "info";

interface HookFinding {
  rule: string;
  severity: Severity;
  line: number;
  col: number;
  message: string;
  snippet: string;
  suggestion?: string;
}

const EFFECT_LIKE = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect", "useCallback", "useMemo", "useImperativeHandle"]);
const EFFECTS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const MUTATING_METHODS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "set", "add", "delete", "clear"]);

type BindingKind = "state" | "setter" | "ref" | "stable" | "prop" | "value" | "unstable" | "constant";

interface Binding {
  kind: BindingKind;
  /** Para setters: nombre de la variable de estado asociada. Para estados: nombre del setter. */
  pair?: string;
}

export async function auditReactHooksAndState(input: { relative_path: string }) {
  const abs = await resolveSafePath(input.relative_path);
  if (!(await pathExists(abs))) throw new Error(`El archivo no existe: ${input.relative_path}`);
  const ext = path.extname(abs);
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) {
    throw new Error(`Extensión no soportada para análisis de hooks: ${ext}`);
  }
  const code = await fs.readFile(abs, "utf8");
  const ts = loadTypeScript();
  const scriptKind =
    ext === ".tsx" ? ts.ScriptKind.TSX : ext === ".jsx" || ext === ".js" || ext === ".mjs" || ext === ".cjs" ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(abs, code, ts.ScriptTarget.Latest, true, scriptKind);

  const findings: HookFinding[] = [];
  const components: Array<{ name: string; kind: "component" | "hook"; line: number; hooks: string[] }> = [];

  const loc = (node: TS.Node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: line + 1, col: character + 1 };
  };
  const snippet = (node: TS.Node) => {
    const t = node.getText(sf).replace(/\s+/g, " ");
    return t.length > 140 ? `${t.slice(0, 137)}...` : t;
  };
  const report = (node: TS.Node, rule: string, severity: Severity, message: string, suggestion?: string) => {
    findings.push({ rule, severity, ...loc(node), message, snippet: snippet(node), ...(suggestion ? { suggestion } : {}) });
  };

  const isFunctionLike = (n: TS.Node): n is TS.FunctionLikeDeclaration =>
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) ||
    ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isConstructorDeclaration(n);

  const rootIdentifier = (expr: TS.Expression): string | null => {
    let e: TS.Expression = expr;
    while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    return ts.isIdentifier(e) ? e.text : null;
  };

  const isAssignment = (n: TS.Node): boolean =>
    ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment;

  const hookNameOf = (call: TS.CallExpression): string | null => {
    const callee = call.expression;
    if (ts.isIdentifier(callee) && /^use[A-Z0-9]/.test(callee.text)) return callee.text;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && /^use[A-Z0-9]/.test(callee.name.text)) {
      return /^[A-Z]/.test(callee.expression.text) ? callee.name.text : null; // React.useState
    }
    return null;
  };

  /** Nombre lógico de una función: declaración, variable asignada o envoltura memo/forwardRef. */
  const functionName = (fn: TS.FunctionLikeDeclaration): string | null => {
    if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
    let p: TS.Node = fn.parent;
    while (p && ts.isCallExpression(p) && /^(?:React\.)?(memo|forwardRef|observer)$/.test(p.expression.getText(sf))) p = p.parent;
    if (p && ts.isParenthesizedExpression(p)) p = p.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (p && ts.isExportAssignment(p)) return "default";
    return null;
  };

  const classify = (fn: TS.FunctionLikeDeclaration): "component" | "hook" | null => {
    const name = functionName(fn);
    if (!name) return null;
    if (/^use[A-Z0-9]/.test(name)) return "hook";
    if (/^[A-Z]/.test(name) || name === "default") return "component";
    return null;
  };

  const bindingNames = (name: TS.BindingName, out: string[] = []): string[] => {
    if (ts.isIdentifier(name)) out.push(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
    return out;
  };

  /** Recorre un subárbol sin entrar en funciones anidadas. */
  const walkShallow = (node: TS.Node, cb: (n: TS.Node) => void) => {
    const visit = (n: TS.Node) => {
      cb(n);
      if (n !== node && isFunctionLike(n)) return;
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
  };

  const containsReturn = (node: TS.Node): boolean => {
    let found = false;
    const visit = (n: TS.Node) => {
      if (found || isFunctionLike(n)) return;
      if (ts.isReturnStatement(n)) found = true;
      else ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };

  /** Analiza un componente o hook personalizado. */
  const analyzeComponent = (fn: TS.FunctionLikeDeclaration, kind: "component" | "hook") => {
    const name = functionName(fn) ?? "(anónimo)";
    const hooksUsed: string[] = [];
    const scope = new Map<string, Binding>();

    // Props / parámetros
    for (const p of fn.parameters) for (const n of bindingNames(p.name)) scope.set(n, { kind: "prop" });

    // Declaraciones del cuerpo (sin funciones anidadas)
    if (fn.body) {
      walkShallow(fn.body, (n) => {
        if (ts.isFunctionDeclaration(n) && n.name) scope.set(n.name.text, { kind: "unstable" });
        if (!ts.isVariableDeclaration(n)) return;
        const init = n.initializer;
        const names = bindingNames(n.name);
        const call = init && ts.isCallExpression(init) ? init : null;
        const hook = call ? hookNameOf(call) : null;
        if (hook && (hook === "useState" || hook === "useReducer") && ts.isArrayBindingPattern(n.name)) {
          const [stateEl, setterEl] = n.name.elements;
          const stateName = stateEl && !ts.isOmittedExpression(stateEl) && ts.isIdentifier(stateEl.name) ? stateEl.name.text : undefined;
          const setterName = setterEl && !ts.isOmittedExpression(setterEl) && ts.isIdentifier(setterEl.name) ? setterEl.name.text : undefined;
          if (stateName) scope.set(stateName, { kind: "state", pair: setterName });
          if (setterName) scope.set(setterName, { kind: "setter", pair: stateName });
          return;
        }
        if (hook === "useRef" || hook === "createRef") {
          names.forEach((x) => scope.set(x, { kind: "ref" }));
          return;
        }
        if (hook === "useTransition" && ts.isArrayBindingPattern(n.name)) {
          const els = n.name.elements;
          if (els[0] && !ts.isOmittedExpression(els[0])) bindingNames(els[0].name).forEach((x) => scope.set(x, { kind: "value" }));
          if (els[1] && !ts.isOmittedExpression(els[1])) bindingNames(els[1].name).forEach((x) => scope.set(x, { kind: "stable" }));
          return;
        }
        if (hook === "useEffectEvent") {
          names.forEach((x) => scope.set(x, { kind: "stable" }));
          return;
        }
        let kindB: BindingKind = "value";
        if (init) {
          const inner = ts.isAsExpression(init) || ts.isSatisfiesExpression(init) ? init.expression : init;
          if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner) || ts.isArrowFunction(inner) || ts.isFunctionExpression(inner) || ts.isNewExpression(inner)) {
            kindB = "unstable";
          } else if (ts.isStringLiteral(inner) || ts.isNumericLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) || inner.kind === ts.SyntaxKind.TrueKeyword || inner.kind === ts.SyntaxKind.FalseKeyword) {
            kindB = "constant";
          }
        }
        names.forEach((x) => scope.set(x, { kind: kindB }));
      });
    }

    const body = fn.body;
    if (!body) return;

    // --- Reglas de Hooks: condicionales, bucles, tras return temprano --------------------
    const checkHookPlacement = (call: TS.CallExpression, hook: string) => {
      let n: TS.Node = call.parent;
      let child: TS.Node = call;
      while (n && n !== body) {
        if (ts.isIfStatement(n) && child !== n.expression) {
          return report(call, "HOOK_CONDITIONAL", "error", `${hook} se llama dentro de un if; viola las Reglas de los Hooks (orden de llamadas inestable).`, "Mueva la llamada al nivel superior del componente y coloque la condición dentro del hook.");
        }
        if (ts.isConditionalExpression(n) && child !== n.condition) {
          return report(call, "HOOK_CONDITIONAL", "error", `${hook} se llama dentro de un operador ternario.`, "Llame al hook incondicionalmente y elija el valor después.");
        }
        if (ts.isBinaryExpression(n) && child === n.right && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)) {
          return report(call, "HOOK_CONDITIONAL", "error", `${hook} se evalúa en cortocircuito (&&, || o ??): llamada condicional.`, "Llame al hook incondicionalmente.");
        }
        if (ts.isSwitchStatement(n) || ts.isCaseClause(n)) {
          return report(call, "HOOK_CONDITIONAL", "error", `${hook} se llama dentro de un switch.`);
        }
        if (ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) {
          return report(call, "HOOK_IN_LOOP", "error", `${hook} se llama dentro de un bucle; el número de hooks variará entre renders.`);
        }
        if (ts.isTryStatement(n) || ts.isCatchClause(n)) {
          return report(call, "HOOK_IN_TRY", "warning", `${hook} se llama dentro de try/catch; si se lanza antes, el orden de hooks cambia.`);
        }
        child = n;
        n = n.parent;
      }
    };

    // Hooks tras un return temprano (sentencias de primer nivel del cuerpo).
    if (ts.isBlock(body)) {
      let earlyReturnSeen: TS.Node | null = null;
      for (const stmt of body.statements) {
        if (earlyReturnSeen) {
          walkShallow(stmt, (n) => {
            if (ts.isCallExpression(n)) {
              const h = hookNameOf(n);
              if (h) report(n, "HOOK_AFTER_EARLY_RETURN", "error", `${h} se ejecuta después de un return temprano (línea ${loc(earlyReturnSeen!).line}); en algunos renders no se llamará.`, "Mueva todos los hooks antes de cualquier return condicional.");
            }
          });
        }
        if (!earlyReturnSeen && !ts.isReturnStatement(stmt) && containsReturn(stmt)) earlyReturnSeen = stmt;
        if (!earlyReturnSeen && ts.isReturnStatement(stmt)) break;
      }
    }

    // --- Recorrido principal del cuerpo -----------------------------------------------
    const visit = (n: TS.Node, nested: TS.FunctionLikeDeclaration | null) => {
      if (n !== fn && isFunctionLike(n)) {
        const k = classify(n);
        if (k) return; // componente/hook anidado: se analiza por separado
        ts.forEachChild(n, (c) => visit(c, n));
        return;
      }
      if (ts.isCallExpression(n)) {
        const hook = hookNameOf(n);
        if (hook) {
          hooksUsed.push(hook);
          if (nested) {
            report(n, "HOOK_IN_NESTED_FUNCTION", "error", `${hook} se llama dentro de una función anidada (callback/handler), no en el nivel superior de ${name}.`, "Los hooks solo pueden llamarse en el cuerpo del componente o de un hook personalizado.");
          } else {
            checkHookPlacement(n, hook);
          }
          if (EFFECT_LIKE.has(hook)) analyzeDependencies(n, hook);
          if (hook === "useState" && n.arguments[0] && ts.isCallExpression(n.arguments[0]) && !hookNameOf(n.arguments[0])) {
            report(n, "STATE_EAGER_INITIALIZER", "info", `useState(${snippet(n.arguments[0])}) evalúa el inicializador en cada render.`, `Use inicialización perezosa: useState(() => ${snippet(n.arguments[0])}).`);
          }
        }
        analyzeSetterCall(n, nested);
        analyzeMutatingCall(n);
        analyzeListKeys(n);
      }
      analyzeAssignmentMutation(n);
      ts.forEachChild(n, (c) => visit(c, nested));
    };

    // setState durante el render (bucle infinito) y mutación del valor previo en updaters.
    const analyzeSetterCall = (call: TS.CallExpression, nested: TS.FunctionLikeDeclaration | null) => {
      if (!ts.isIdentifier(call.expression)) return;
      const b = scope.get(call.expression.text);
      if (!b || b.kind !== "setter") return;
      if (!nested) {
        let conditional = false;
        for (let p: TS.Node = call.parent; p && p !== body; p = p.parent) {
          if (ts.isIfStatement(p) || ts.isConditionalExpression(p) || (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) conditional = true;
        }
        report(
          call,
          "SETSTATE_IN_RENDER",
          conditional ? "warning" : "error",
          conditional
            ? `${call.expression.text}() se llama durante el render bajo una condición; asegúrese de que la condición deje de cumplirse para evitar renders en bucle.`
            : `${call.expression.text}() se llama incondicionalmente durante el render → "Too many re-renders" (bucle infinito).`,
          "Mueva la actualización a un handler o a un useEffect, o derive el valor sin estado.",
        );
      }
      const arg = call.arguments[0];
      if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && arg.parameters[0] && ts.isIdentifier(arg.parameters[0].name)) {
        const prev = arg.parameters[0].name.text;
        const check = (n: TS.Node) => {
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && MUTATING_METHODS.has(n.expression.name.text) && rootIdentifier(n.expression.expression) === prev) {
            report(n, "PREV_STATE_MUTATION", "error", `El updater de ${call.expression.getText(sf)} muta "${prev}" con .${n.expression.name.text}(); React no detectará el cambio si se devuelve la misma referencia.`, `Devuelva una copia: [...${prev}] / { ...${prev} } o use toSorted()/toReversed()/with().`);
          }
          if (isAssignment(n) && rootIdentifier((n as TS.BinaryExpression).left) === prev && !ts.isIdentifier((n as TS.BinaryExpression).left)) {
            report(n, "PREV_STATE_MUTATION", "error", `El updater de ${call.expression.getText(sf)} asigna directamente sobre "${prev}".`, `Cree un nuevo objeto: { ...${prev}, campo: valor }.`);
          }
          ts.forEachChild(n, check);
        };
        ts.forEachChild(arg.body, check);
      }
    };

    // Mutación directa del estado: state.x = 1, state = 2, state.x++, delete state.x
    const analyzeAssignmentMutation = (n: TS.Node) => {
      let target: TS.Expression | null = null;
      if (isAssignment(n)) target = (n as TS.BinaryExpression).left;
      else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)) target = n.operand;
      else if (ts.isDeleteExpression(n)) target = n.expression;
      if (!target) return;
      const root = rootIdentifier(target);
      const b = root ? scope.get(root) : undefined;
      if (b?.kind === "state") {
        report(n, "DIRECT_STATE_MUTATION", "error", `Mutación directa del estado "${root}"; React no re-renderiza y el estado queda inconsistente.`, b.pair ? `Use ${b.pair}(...) con un valor nuevo (inmutable).` : "Use la función setter con un valor nuevo.");
      } else if (b?.kind === "prop" && !ts.isIdentifier(target)) {
        report(n, "PROP_MUTATION", "error", `Mutación de la prop "${root}"; las props son de solo lectura.`, "Copie el valor a un estado local o notifique al padre mediante un callback.");
      }
    };

    // state.push(x), state.sort(), map.set(...)
    const analyzeMutatingCall = (call: TS.CallExpression) => {
      if (!ts.isPropertyAccessExpression(call.expression)) return;
      const method = call.expression.name.text;
      if (!MUTATING_METHODS.has(method)) return;
      const root = rootIdentifier(call.expression.expression);
      const b = root ? scope.get(root) : undefined;
      if (b?.kind === "state") {
        report(call, "DIRECT_STATE_MUTATION", "error", `"${root}.${method}()" muta el estado en sitio.`, b.pair ? `Use ${b.pair}(prev => ...) devolviendo una copia (spread, toSorted, filter...).` : undefined);
      } else if (b?.kind === "prop") {
        report(call, "PROP_MUTATION", "error", `"${root}.${method}()" muta una prop recibida.`);
      }
    };

    // .map(item => <Elem/>) sin key
    const analyzeListKeys = (call: TS.CallExpression) => {
      if (!ts.isPropertyAccessExpression(call.expression) || !["map", "flatMap"].includes(call.expression.name.text)) return;
      const cb = call.arguments[0];
      if (!cb || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) return;
      const returned: TS.Expression[] = [];
      if (ts.isBlock(cb.body)) {
        walkShallow(cb.body, (n) => {
          if (ts.isReturnStatement(n) && n.expression) returned.push(n.expression);
        });
      } else returned.push(cb.body);
      for (let r of returned) {
        while (ts.isParenthesizedExpression(r)) r = r.expression;
        let attrs: TS.JsxAttributes | null = null;
        if (ts.isJsxElement(r)) attrs = r.openingElement.attributes;
        else if (ts.isJsxSelfClosingElement(r)) attrs = r.attributes;
        else if (ts.isJsxFragment(r)) {
          report(r, "LIST_MISSING_KEY", "warning", "Un fragmento <>...</> devuelto en .map() no puede llevar key.", "Use <Fragment key={...}>.");
          continue;
        }
        if (!attrs) continue;
        const hasKey = attrs.properties.some((p) => (ts.isJsxAttribute(p) && p.name.getText(sf) === "key") || ts.isJsxSpreadAttribute(p));
        if (!hasKey) report(r, "LIST_MISSING_KEY", "warning", "Elemento renderizado en .map() sin prop key: reconciliación incorrecta y estado mezclado entre filas.", "Agregue key={item.id} con un identificador estable (no el índice si la lista se reordena).");
        else {
          const keyAttr = attrs.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "key") as TS.JsxAttribute | undefined;
          const idxParam = cb.parameters[1] && ts.isIdentifier(cb.parameters[1].name) ? cb.parameters[1].name.text : null;
          const init = keyAttr?.initializer;
          if (idxParam && init && ts.isJsxExpression(init) && init.expression && ts.isIdentifier(init.expression) && init.expression.text === idxParam) {
            report(keyAttr!, "LIST_INDEX_AS_KEY", "info", `Se usa el índice "${idxParam}" como key; si la lista se reordena/filtra el estado de las filas se mezcla.`, "Use un identificador estable del elemento.");
          }
        }
      }
    };

    // --- Dependencias de useEffect / useMemo / useCallback ------------------------------
    const analyzeDependencies = (call: TS.CallExpression, hook: string) => {
      const cbIndex = hook === "useImperativeHandle" ? 1 : 0;
      const cb = call.arguments[cbIndex];
      const depsArg = call.arguments[cbIndex + 1];
      if (!cb) return;

      if (EFFECTS.has(hook) && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        report(cb, "EFFECT_ASYNC_CALLBACK", "error", `El callback de ${hook} es async: devuelve una Promise en lugar de una función de limpieza.`, "Declare una función async dentro del efecto e invóquela: useEffect(() => { const load = async () => {...}; load(); }, [deps]).");
      }

      if (!(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
        return; // callback por referencia: no se pueden inferir dependencias
      }

      // Identificadores declarados dentro del callback (sombrean el scope del componente).
      const localDecls = new Set<string>();
      for (const p of cb.parameters) bindingNames(p.name, []).forEach((x) => localDecls.add(x));
      const collectDecls = (n: TS.Node) => {
        if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) {
          if (ts.isIdentifier(n.name)) localDecls.add(n.name.text);
        }
        if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) localDecls.add(n.name.text);
        ts.forEachChild(n, collectDecls);
      };
      ts.forEachChild(cb.body, collectDecls);

      // Referencias a valores reactivos del componente.
      const referenced = new Map<string, TS.Node>(); // ruta (a.b.c) → nodo
      const settersCalledUnconditionally: string[] = [];
      const collectRefs = (n: TS.Node) => {
        if (ts.isIdentifier(n)) {
          const parent = n.parent;
          const isPropertyName =
            (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
            (ts.isPropertyAssignment(parent) && parent.name === n) ||
            (ts.isJsxAttribute(parent) && parent.name === n) ||
            (ts.isBindingElement(parent) && parent.propertyName === n) ||
            ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent)) && parent.name === n) ||
            ts.isTypeReferenceNode(parent) ||
            ts.isQualifiedName(parent);
          if (!isPropertyName && !localDecls.has(n.text)) {
            const b = scope.get(n.text);
            if (b && !["setter", "ref", "stable", "constant"].includes(b.kind)) {
              // Construye la ruta de miembros a.b.c (sin incluir el método llamado).
              let pathNode: TS.Node = n;
              let pathText = n.text;
              while (ts.isPropertyAccessExpression(pathNode.parent) && pathNode.parent.expression === pathNode) {
                const pa = pathNode.parent;
                if (ts.isCallExpression(pa.parent) && pa.parent.expression === pa) break;
                if (isAssignment(pa.parent) && (pa.parent as TS.BinaryExpression).left === pa) break;
                pathText += `.${pa.name.text}`;
                pathNode = pa;
              }
              if (!referenced.has(pathText)) referenced.set(pathText, n);
            }
          }
        }
        if (EFFECTS.has(hook) && ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
          const b = scope.get(n.expression.text);
          if (b?.kind === "setter") {
            let conditional = false;
            for (let p: TS.Node = n.parent; p && p !== cb.body; p = p.parent) {
              if (ts.isIfStatement(p) || ts.isConditionalExpression(p) || isFunctionLike(p) || ts.isBinaryExpression(p)) {
                conditional = true;
                break;
              }
            }
            if (!conditional && b.pair) settersCalledUnconditionally.push(b.pair);
          }
        }
        ts.forEachChild(n, collectRefs);
      };
      ts.forEachChild(cb.body, collectRefs);

      if (!depsArg) {
        if (EFFECTS.has(hook)) {
          const loop = settersCalledUnconditionally.length > 0;
          report(call, loop ? "EFFECT_INFINITE_LOOP" : "EFFECT_NO_DEPS", loop ? "error" : "warning",
            loop
              ? `${hook} sin array de dependencias actualiza estado (${settersCalledUnconditionally.join(", ")}) incondicionalmente → bucle infinito de renders.`
              : `${hook} sin array de dependencias se ejecuta después de cada render.`,
            "Añada un array de dependencias explícito ([] para ejecutar solo al montar).");
        } else if (hook === "useMemo" || hook === "useCallback") {
          report(call, "MEMO_NO_DEPS", "error", `${hook} sin array de dependencias recalcula en cada render (memoización inútil).`, "Pase el array de dependencias como segundo argumento.");
        }
        return;
      }

      if (!ts.isArrayLiteralExpression(depsArg)) {
        report(depsArg, "DEPS_NOT_ARRAY_LITERAL", "warning", `Las dependencias de ${hook} no son un array literal; React y el linter no pueden verificarlas.`, "Use un array literal [a, b].");
        return;
      }

      const deps = depsArg.elements.map((e) => e.getText(sf).replace(/\?\./g, ".").replace(/\s+/g, ""));
      const covered = (p: string) => deps.some((d) => d === p || p.startsWith(`${d}.`));

      const missing = [...referenced.keys()].filter((p) => !covered(p));
      // Elimina rutas redundantes (si falta "a", no reportar también "a.b").
      const missingReduced = missing.filter((p) => !missing.some((o) => o !== p && p.startsWith(`${o}.`)));
      if (missingReduced.length > 0) {
        const depsLine = sf.getLineAndCharacterOfPosition(depsArg.getStart(sf)).line;
        const lines = sf.text.split(/\r?\n/);
        const suppressed = [depsLine - 1, depsLine].some((l) => l >= 0 && /eslint-disable-(next-)?line\s+react-hooks\/exhaustive-deps/.test(lines[l] ?? ""));
        report(depsArg, "MISSING_DEPENDENCY", suppressed ? "info" : "warning",
          (suppressed ? "[Suprimido con eslint-disable react-hooks/exhaustive-deps; revise que sea intencional] " : "") + `${hook} usa ${missingReduced.map((m) => `"${m}"`).join(", ")} pero no lo declara en sus dependencias → closure obsoleta (stale closure).`, `Dependencias sugeridas: [${[...new Set([...deps, ...missingReduced])].join(", ")}].`);
      }

      for (const el of depsArg.elements) {
        const text = el.getText(sf);
        const rootName = ts.isIdentifier(el) ? el.text : rootIdentifier(el as TS.Expression);
        const b = rootName ? scope.get(rootName) : undefined;
        if (ts.isObjectLiteralExpression(el) || ts.isArrayLiteralExpression(el) || ts.isArrowFunction(el) || ts.isFunctionExpression(el)) {
          report(el, "UNSTABLE_DEPENDENCY", "error", `La dependencia ${snippet(el)} es un literal nuevo en cada render: ${hook} se ejecutará siempre.`);
        } else if (ts.isIdentifier(el) && b?.kind === "unstable") {
          report(el, "UNSTABLE_DEPENDENCY", "warning", `"${text}" se recrea en cada render (objeto/array/función declarado en el componente) → ${hook} se dispara en cada render.`, `Envuélvalo en useMemo/useCallback o muévalo fuera del componente o dentro del ${hook}.`);
        } else if (ts.isIdentifier(el) && b?.kind === "ref") {
          /* refs: estables, permitido */
        } else if (ts.isPropertyAccessExpression(el) && el.name.text === "current" && b?.kind === "ref") {
          report(el, "REF_CURRENT_DEPENDENCY", "warning", `"${text}" como dependencia: mutar .current no provoca re-render, así que ${hook} no reaccionará a sus cambios.`);
        } else if (rootName && !b && !localDecls.has(rootName) && /^[a-z_$]/.test(rootName) && ts.isIdentifier(el)) {
          report(el, "UNNECESSARY_DEPENDENCY", "info", `"${text}" no es un valor reactivo del componente (módulo/global); no hace falta como dependencia.`);
        }
      }

      if (EFFECTS.has(hook)) {
        const loops = settersCalledUnconditionally.filter((stateName) => covered(stateName));
        if (loops.length > 0) {
          report(call, "EFFECT_INFINITE_LOOP", "error", `${hook} depende de ${loops.map((s) => `"${s}"`).join(", ")} y lo actualiza incondicionalmente → bucle infinito de renders.`, "Añada una condición de salida, use un updater funcional o elimine la dependencia derivando el valor.");
        }
      }
    };

    visit(body, null);
    components.push({ name, kind, line: loc(fn).line, hooks: hooksUsed });
  };

  // --- Recorrido del archivo: componentes/hooks y hooks fuera de componentes -----------
  const visitFile = (n: TS.Node, insideComponentLike: boolean) => {
    if (isFunctionLike(n)) {
      const k = classify(n);
      if (k) {
        analyzeComponent(n, k);
        ts.forEachChild(n, (c) => visitFile(c, true));
        return;
      }
      ts.forEachChild(n, (c) => visitFile(c, insideComponentLike));
      return;
    }
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      walkShallowClass(n);
    }
    if (!insideComponentLike && ts.isCallExpression(n)) {
      const hook = hookNameOf(n);
      if (hook) {
        const enclosing = findEnclosingFunction(n);
        report(n, "HOOK_OUTSIDE_COMPONENT", "error",
          enclosing
            ? `${hook} se llama dentro de "${(isFunctionLike(enclosing) && functionName(enclosing)) || "función anónima"}", que no es un componente (PascalCase) ni un hook (use*).`
            : `${hook} se llama a nivel de módulo, fuera de cualquier componente.`,
          "Renombre la función a PascalCase/use* si es un componente/hook, o mueva la llamada a un componente.");
      }
    }
    ts.forEachChild(n, (c) => visitFile(c, insideComponentLike));
  };

  const findEnclosingFunction = (n: TS.Node): TS.Node | null => {
    for (let p: TS.Node | undefined = n.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
    return null;
  };

  // Mutación de this.state en componentes de clase.
  const walkShallowClass = (cls: TS.ClassLikeDeclaration) => {
    const check = (n: TS.Node) => {
      if (isAssignment(n)) {
        const left = (n as TS.BinaryExpression).left.getText(sf);
        const inConstructor = (() => {
          for (let p: TS.Node | undefined = n.parent; p && p !== cls; p = p.parent) if (ts.isConstructorDeclaration(p)) return true;
          return false;
        })();
        if (/^this\.state\b/.test(left) && !(inConstructor && left === "this.state")) {
          report(n, "DIRECT_STATE_MUTATION", "error", `Asignación directa a ${left} en un componente de clase.`, "Use this.setState(...).");
        }
      }
      ts.forEachChild(n, check);
    };
    ts.forEachChild(cls, check);
  };

  visitFile(sf, false);

  // Deduplicación (una llamada puede disparar la misma regla por caminos distintos).
  const unique = new Map<string, HookFinding>();
  for (const f of findings) unique.set(`${f.rule}:${f.line}:${f.col}:${f.message}`, f);
  const ordered = [...unique.values()].sort((a, b) => a.line - b.line || a.col - b.col);
  const bySeverity = { error: 0, warning: 0, info: 0 };
  for (const f of ordered) bySeverity[f.severity]++;

  return {
    file: toRelative(abs),
    status: bySeverity.error > 0 ? "FAIL" : bySeverity.warning > 0 ? "WARN" : "PASS",
    parse_errors: ((sf as unknown as { parseDiagnostics?: TS.Diagnostic[] }).parseDiagnostics ?? [])
      .slice(0, 10)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    components_and_hooks: components,
    summary: bySeverity,
    findings: ordered,
  };
}
