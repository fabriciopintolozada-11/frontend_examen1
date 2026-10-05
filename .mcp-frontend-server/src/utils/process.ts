import { execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { FRONTEND_ROOT, pathExists, readJsonFile } from "./paths.js";

export const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutos

const IS_WINDOWS = process.platform === "win32";

export interface RunResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  bufferExceeded: boolean;
  durationMs: number;
  /** Error al lanzar el proceso (p. ej. ENOENT) — distinto de un código de salida != 0. */
  spawnError?: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Procesos hijos vivos (grupos POSIX) para poder matarlos si el servidor termina. */
const activeChildren = new Set<ChildProcess>();

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (!IS_WINDOWS) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* el proceso ya terminó */
    }
  }
}

export function killAllChildren(): void {
  for (const child of activeChildren) killTree(child);
  activeChildren.clear();
}

/** Entorno no interactivo y sin colores; garantiza que el node actual esté en PATH. */
function buildEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nodeDir = path.dirname(process.execPath);
  const currentPath = process.env.PATH ?? process.env.Path ?? "";
  return {
    ...process.env,
    PATH: [nodeDir, currentPath].filter(Boolean).join(path.delimiter),
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    NO_UPDATE_NOTIFIER: "1",
    npm_config_update_notifier: "false",
    ...extra,
  };
}

/**
 * Ejecuta un binario con argumentos en array mediante execFile (sin shell → sin inyección).
 * Nunca lanza por códigos de salida != 0: devuelve un RunResult completo.
 * En POSIX el hijo se crea en su propio grupo para poder matar el árbol entero en timeout.
 */
export function runFile(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();

  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd ?? FRONTEND_ROOT,
        env: buildEnv(options.env),
        maxBuffer: MAX_BUFFER,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
        shell: false,
        encoding: "utf8",
        // `detached` se propaga a spawn: crea un grupo de procesos propio en POSIX.
        ...(IS_WINDOWS ? {} : { detached: true }),
      } as Parameters<typeof execFile>[2] & { encoding: "utf8" },
      (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        activeChildren.delete(child);

        const err = error as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string }) | null;
        const bufferExceeded = err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        if (bufferExceeded) killTree(child);

        let spawnError: string | undefined;
        if (err && typeof err.code === "string" && !bufferExceeded) {
          spawnError = `${err.code}: ${err.message}`;
        }

        resolve({
          command,
          args,
          exitCode: typeof err?.code === "number" ? err.code : err ? (child.exitCode ?? null) : 0,
          signal: err?.signal ?? child.signalCode ?? null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut,
          bufferExceeded,
          durationMs: Date.now() - started,
          spawnError,
        });
      },
    );

    activeChildren.add(child);
    child.stdin?.end();

    // execFile solo mata al hijo directo; este temporizador garantiza matar el grupo completo
    // (p. ej. npm → sh → next build).
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    timer.unref();
  });
}

/** Ejecuta un script JS (entrypoint de un paquete) con el mismo binario de Node del servidor. */
export function runNodeScript(scriptPath: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runFile(process.execPath, [scriptPath, ...args], options);
}

export interface ResolvedBin {
  /** Ejecutable a lanzar (process.execPath o el binario de .bin). */
  command: string;
  /** Argumentos previos (el entrypoint JS cuando se ejecuta vía node). */
  prefixArgs: string[];
  source: "package-entrypoint" | "node_modules/.bin";
  path: string;
  packageVersion?: string;
}

/**
 * Resolución determinista de una herramienta local del frontend:
 * 1) Lee `node_modules/<pkg>/package.json`, toma su campo `bin` y lo ejecuta con process.execPath.
 * 2) Si no es posible, usa `node_modules/.bin/<bin>` directamente.
 * Devuelve null si la herramienta no está instalada.
 */
export async function resolveLocalBin(packageName: string, binName: string = packageName): Promise<ResolvedBin | null> {
  const pkgDir = path.join(FRONTEND_ROOT, "node_modules", ...packageName.split("/"));
  const pkgJson = await readJsonFile<{ version?: string; bin?: string | Record<string, string> }>(
    path.join(pkgDir, "package.json"),
  );

  if (pkgJson?.bin) {
    const rel = typeof pkgJson.bin === "string" ? pkgJson.bin : pkgJson.bin[binName];
    if (rel) {
      const entry = path.resolve(pkgDir, rel);
      if (await pathExists(entry)) {
        return {
          command: process.execPath,
          prefixArgs: [entry],
          source: "package-entrypoint",
          path: entry,
          packageVersion: pkgJson.version,
        };
      }
    }
  }

  const binPath = path.join(FRONTEND_ROOT, "node_modules", ".bin", IS_WINDOWS ? `${binName}.cmd` : binName);
  if (!IS_WINDOWS && (await pathExists(binPath))) {
    return { command: binPath, prefixArgs: [], source: "node_modules/.bin", path: binPath, packageVersion: pkgJson?.version };
  }
  return null;
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export async function detectPackageManager(): Promise<PackageManager> {
  const checks: Array<[string, PackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
  ];
  for (const [file, pm] of checks) {
    if (await pathExists(path.join(FRONTEND_ROOT, file))) return pm;
  }
  return "npm";
}

/**
 * Localiza el CLI de npm junto al node en ejecución para lanzarlo vía process.execPath
 * (no depende del PATH del cliente MCP, que suele ser mínimo en apps de escritorio).
 */
async function findNpmCli(): Promise<string | null> {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "libexec", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const c of candidates) {
    if (await pathExists(c)) return path.resolve(c);
  }
  return null;
}

/** Ejecuta `<pm> run <script>` en el frontend de forma segura. */
export async function runPackageScript(script: string, options: RunOptions = {}): Promise<RunResult & { packageManager: PackageManager }> {
  const pm = await detectPackageManager();
  if (pm === "npm") {
    const npmCli = await findNpmCli();
    const result = npmCli
      ? await runNodeScript(npmCli, ["run", script], options)
      : await runFile(IS_WINDOWS ? "npm.cmd" : "npm", ["run", script], options);
    return { ...result, packageManager: pm };
  }
  const result = await runFile(IS_WINDOWS ? `${pm}.cmd` : pm, ["run", script], options);
  return { ...result, packageManager: pm };
}

/** Ejecuta git en el frontend. */
export function runGit(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runFile("git", args, { timeoutMs: 30_000, ...options });
}

export async function isGitRepository(): Promise<boolean> {
  const r = await runGit(["rev-parse", "--is-inside-work-tree"]);
  return r.exitCode === 0 && r.stdout.trim() === "true";
}

/** Elimina secuencias de escape ANSI de una salida de consola. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, "");
}

export function tailLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}
