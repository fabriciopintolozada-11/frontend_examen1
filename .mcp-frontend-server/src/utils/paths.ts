import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * Este archivo compila a `.mcp-frontend-server/dist/utils/paths.js`.
 * __dirname equivalente -> dist/utils ; dos niveles arriba -> .mcp-frontend-server
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Carpeta raíz del servidor MCP (`.mcp-frontend-server/`). */
export const SERVER_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Raíz del frontend inspeccionado: el directorio padre del servidor.
 * Puede sobreescribirse con FRONTEND_QA_ROOT (útil para pruebas).
 */
export const FRONTEND_ROOT = process.env.FRONTEND_QA_ROOT
  ? path.resolve(process.env.FRONTEND_QA_ROOT)
  : path.resolve(SERVER_ROOT, "..");

/** Directorios que nunca se recorren al escanear código fuente. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".cache",
  ".parcel-cache",
  ".mcp-frontend-server",
  "dist",
  "build",
  "out",
  "coverage",
  "storybook-static",
]);

/** Segmentos de ruta en los que el patcher tiene prohibido escribir. */
const WRITE_PROTECTED_SEGMENTS = new Set([".git", "node_modules", ".mcp-frontend-server"]);

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Convierte una ruta absoluta dentro del frontend a ruta relativa POSIX. */
export function toRelative(absolutePath: string): string {
  return path.relative(FRONTEND_ROOT, absolutePath).split(path.sep).join("/");
}

/**
 * Resuelve una ruta relativa del usuario contra FRONTEND_ROOT bloqueando Path Traversal:
 * - rechaza rutas absolutas, bytes nulos y rutas vacías;
 * - verifica que la ruta léxica quede dentro de la raíz;
 * - si el archivo (o su directorio padre) existe, verifica también su realpath para
 *   impedir escapes mediante enlaces simbólicos.
 */
export async function resolveSafePath(relativePath: string): Promise<string> {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new PathSecurityError("La ruta no puede estar vacía.");
  }
  if (relativePath.includes("\0")) {
    throw new PathSecurityError("La ruta contiene bytes nulos.");
  }
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    throw new PathSecurityError(
      `Se requiere una ruta relativa a la raíz del frontend; se recibió una ruta absoluta: ${relativePath}`,
    );
  }

  const resolved = path.resolve(FRONTEND_ROOT, relativePath);
  if (!isInside(FRONTEND_ROOT, resolved)) {
    throw new PathSecurityError(`Path Traversal bloqueado: "${relativePath}" sale de la raíz del frontend.`);
  }

  const realRoot = await fs.realpath(FRONTEND_ROOT);
  // Comprueba el realpath del ancestro existente más cercano (archivo o directorio).
  let probe = resolved;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (!isInside(realRoot, real)) {
        throw new PathSecurityError(
          `Path Traversal bloqueado: "${relativePath}" apunta (vía enlace simbólico) fuera del frontend.`,
        );
      }
      break;
    } catch (err) {
      if (err instanceof PathSecurityError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return resolved;
}

/** Igual que resolveSafePath pero además impide escribir en zonas protegidas. */
export async function resolveWritablePath(relativePath: string): Promise<string> {
  const resolved = await resolveSafePath(relativePath);
  const segments = toRelative(resolved).split("/");
  const blocked = segments.find((s) => WRITE_PROTECTED_SEGMENTS.has(s));
  if (blocked) {
    throw new PathSecurityError(`Escritura prohibida dentro de "${blocked}/".`);
  }
  if (resolved === FRONTEND_ROOT) {
    throw new PathSecurityError("La ruta debe apuntar a un archivo, no a la raíz del frontend.");
  }
  return resolved;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T = unknown>(absolutePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    return parseLenientJson(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Parser JSON tolerante para tsconfig/jsconfig: elimina comentarios (respetando
 * cadenas) y comas finales antes de llamar a JSON.parse.
 */
export function parseLenientJson(raw: string): unknown {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      quote = ch;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i++;
    } else {
      out += ch;
    }
  }
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}

/**
 * Escritura atómica: escribe en un archivo temporal del mismo directorio, hace fsync
 * y lo renombra sobre el destino (rename es atómico dentro del mismo filesystem).
 * Conserva los permisos del archivo original si existía.
 */
export async function atomicWriteFile(absolutePath: string, content: string): Promise<void> {
  const dir = path.dirname(absolutePath);
  await fs.mkdir(dir, { recursive: true });

  let mode: number | undefined;
  try {
    mode = (await fs.stat(absolutePath)).mode;
  } catch {
    mode = undefined;
  }

  const tmp = path.join(dir, `.${path.basename(absolutePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await fs.open(tmp, "wx", mode ?? 0o644);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, absolutePath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export interface WalkOptions {
  extensions?: string[];
  maxFiles?: number;
  maxFileSizeBytes?: number;
}

/** Recorre recursivamente el frontend devolviendo rutas absolutas de código fuente. */
export async function walkSourceFiles(options: WalkOptions = {}): Promise<string[]> {
  const extensions = new Set(options.extensions ?? SOURCE_EXTENSIONS);
  const maxFiles = options.maxFiles ?? 20000;
  const maxSize = options.maxFileSizeBytes ?? 1.5 * 1024 * 1024;
  const result: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (result.length >= maxFiles) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".d.ts")) continue;
        if (!extensions.has(path.extname(entry.name))) continue;
        try {
          const st = await fs.stat(full);
          if (st.size > maxSize) continue;
        } catch {
          continue;
        }
        result.push(full);
      }
    }
  }

  await walk(FRONTEND_ROOT);
  return result;
}

/** Devuelve el número de línea (1-based) y columna (1-based) de un índice en el texto. */
export function lineColAt(text: string, index: number): { line: number; col: number } {
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, col: index - lastNl };
}

/** Construye un índice de offsets de inicio de línea para búsquedas repetidas O(log n). */
export function buildLineIndex(text: string): (index: number) => { line: number; col: number } {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (index: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: index - starts[lo] + 1 };
  };
}
