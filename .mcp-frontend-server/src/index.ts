#!/usr/bin/env node
/**
 * frontend-qa-mcp — Servidor MCP (stdio) para auditar, diagnosticar y corregir
 * el frontend que contiene a esta carpeta.
 *
 * REGLA CRÍTICA: stdout está reservado para JSON-RPC. Todo log va a stderr.
 */

// Blindaje de stdout: cualquier console.log/info/debug accidental (propio o de una
// dependencia) se redirige a stderr para no corromper el canal JSON-RPC.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.debug = (...args: unknown[]) => console.error(...args);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { FRONTEND_ROOT, PathSecurityError } from "./utils/paths.js";
import { killAllChildren } from "./utils/process.js";
import {
  auditDependencies,
  auditDependenciesSchema,
  runBuildAudit,
  runBuildAuditSchema,
  runTypecheck,
  runTypecheckSchema,
} from "./tools/diagnostics.js";
import {
  auditReactHooksAndState,
  auditReactHooksSchema,
  readFrontendFile,
  readFrontendFileSchema,
  searchComponentUsage,
  searchComponentUsageSchema,
} from "./tools/code-inspector.js";
import {
  applyCodeFix,
  applyCodeFixSchema,
  gitDiffSummary,
  gitDiffSummarySchema,
  revertFileChanges,
  revertFileChangesSchema,
} from "./tools/patcher.js";
import { generateBugReport, generateBugReportSchema } from "./tools/reporter.js";

const SERVER_NAME = "frontend-qa-server";
const SERVER_VERSION = "1.0.0";

/** Envuelve un handler: serializa el resultado a JSON y convierte excepciones en isError. */
function handler<A>(toolName: string, fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<CallToolResult> => {
    const started = Date.now();
    try {
      const result = await fn(args);
      console.error(`[frontend-qa] ${toolName} OK (${Date.now() - started} ms)`);
      const text =
        result && typeof result === "object" && "content" in result && "header" in result
          ? `${(result as { header: string }).header}\n\n${(result as { content: string }).content}`
          : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const kind = err instanceof PathSecurityError ? "SECURITY" : err instanceof z.ZodError ? "VALIDATION" : "ERROR";
      console.error(`[frontend-qa] ${toolName} ${kind}: ${message}`);
      if (kind === "ERROR" && err instanceof Error && err.stack) console.error(err.stack);
      return { isError: true, content: [{ type: "text", text: `[${kind}] ${toolName}: ${message}` }] };
    }
  };
}

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

/* ---------------------------- Diagnóstico ---------------------------- */

server.registerTool(
  "run_typecheck",
  {
    title: "Verificación de tipos (tsc)",
    description:
      "Ejecuta el compilador de TypeScript local del frontend (tsc --noEmit) contra su tsconfig.json y devuelve los errores estructurados { file, line, col, code, message }, agrupados por código y por archivo.",
    inputSchema: runTypecheckSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler("run_typecheck", runTypecheck),
);

server.registerTool(
  "run_build_audit",
  {
    title: "Auditoría del build de producción",
    description:
      "Detecta el bundler/framework (Next.js, Vite, CRA, Webpack, etc.), ejecuta el script de build del package.json y extrae errores, warnings críticos, módulos no resueltos y chunks problemáticos.",
    inputSchema: runBuildAuditSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  handler("run_build_audit", runBuildAudit),
);

server.registerTool(
  "audit_dependencies",
  {
    title: "Auditoría de dependencias",
    description:
      "Escanea imports/require de todo el código fuente y los compara con dependencies/devDependencies del package.json. Excluye módulos nativos de Node y aliases del tsconfig. Reporta paquetes no declarados, declarados pero no instalados y posiblemente no usados.",
    inputSchema: auditDependenciesSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler("audit_dependencies", auditDependencies),
);

/* ---------------------------- Inspección ----------------------------- */

server.registerTool(
  "read_frontend_file",
  {
    title: "Leer archivo del frontend",
    description:
      "Lee un archivo del frontend (ruta relativa a la raíz, protegida contra Path Traversal) y lo devuelve con números de línea. Admite un rango opcional de líneas.",
    inputSchema: readFrontendFileSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler("read_frontend_file", readFrontendFile),
);

server.registerTool(
  "search_component_usage",
  {
    title: "Rastrear uso de un componente",
    description:
      "Localiza la definición, los imports y cada renderizado JSX de un componente React, extrae las props pasadas en cada sitio y las contrasta con el contrato de props declarado (props desconocidas, requeridas faltantes, children no declarados).",
    inputSchema: searchComponentUsageSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler("search_component_usage", searchComponentUsage),
);

server.registerTool(
  "audit_react_hooks_and_state",
  {
    title: "Auditoría de Hooks y estado",
    description:
      "Análisis estático (AST de TypeScript) de un archivo: hooks en condicionales/bucles/callbacks o tras return temprano, dependencias faltantes o inestables en useEffect/useMemo/useCallback, efectos async o en bucle infinito, setState durante el render, mutaciones directas de estado o props y listas sin key.",
    inputSchema: auditReactHooksSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler("audit_react_hooks_and_state", auditReactHooksAndState),
);

/* ------------------------------ Parches ------------------------------ */

server.registerTool(
  "apply_code_fix",
  {
    title: "Aplicar corrección",
    description:
      "Escribe de forma atómica el contenido COMPLETO corregido de un archivo del frontend, registrando la razón técnica. Bloquea rutas fuera del frontend y escrituras en .git, node_modules y el propio servidor MCP.",
    inputSchema: applyCodeFixSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  handler("apply_code_fix", applyCodeFix),
);

server.registerTool(
  "git_diff_summary",
  {
    title: "Resumen de cambios (git diff)",
    description:
      "Ejecuta git diff en el frontend y devuelve las líneas añadidas/eliminadas por archivo, el diff unificado y los archivos no versionados. Puede limitarse a una ruta o al área de staging.",
    inputSchema: gitDiffSummarySchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler("git_diff_summary", gitDiffSummary),
);

server.registerTool(
  "revert_file_changes",
  {
    title: "Revertir cambios de un archivo",
    description:
      "Descarta los cambios locales de un archivo con `git checkout -- <file>` (o desde HEAD si include_staged=true) cuando una corrección no supera la verificación.",
    inputSchema: revertFileChangesSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  handler("revert_file_changes", revertFileChanges),
);

/* ------------------------------ Reporte ------------------------------ */

server.registerTool(
  "generate_bug_report",
  {
    title: "Generar reporte de auditoría",
    description:
      "Genera y guarda AUDITORIA_FRONTEND.md en la raíz del frontend a partir de la lista de bugs (id BUG-NN, capa, archivo, síntoma, causa raíz, solución y estado de verificación PASS/FAIL), con resumen ejecutivo, distribución por capa, índice y detalle.",
    inputSchema: generateBugReportSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  handler("generate_bug_report", generateBugReport),
);

/* ---------------------------- Arranque ------------------------------- */

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[frontend-qa] ${SERVER_NAME} v${SERVER_VERSION} escuchando por stdio. Frontend: ${FRONTEND_ROOT}`);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[frontend-qa] ${signal} recibido, cerrando...`);
  killAllChildren();
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.stdin.on("close", () => void shutdown("stdin cerrado"));
process.on("exit", () => killAllChildren());
process.on("unhandledRejection", (reason) => console.error("[frontend-qa] unhandledRejection:", reason));
process.on("uncaughtException", (err) => {
  console.error("[frontend-qa] uncaughtException:", err);
  killAllChildren();
  process.exit(1);
});

main().catch((err) => {
  console.error("[frontend-qa] Error fatal al iniciar:", err);
  process.exit(1);
});
