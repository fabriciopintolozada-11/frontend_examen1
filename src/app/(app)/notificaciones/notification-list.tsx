"use client";

import { useCallback, useEffect, useState } from "react";
import { Award, BookCheck, BookX, CheckCheck, Megaphone, Presentation, type LucideIcon } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { Notification, Paginated } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, EmptyState } from "@/components/ui/feedback";

type Page = Paginated<Notification> & { unread: number };

const TYPE: Record<Notification["type"], { icon: LucideIcon; label: string }> = {
  matricula_confirmada: { icon: BookCheck, label: "Matrícula" },
  matricula_cancelada: { icon: BookX, label: "Matrícula" },
  nota_final: { icon: Award, label: "Nota final" },
  grupo_asignado: { icon: Presentation, label: "Grupo" },
  aviso: { icon: Megaphone, label: "Aviso" },
};

const LIMIT = 15;

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function NotificationList() {
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [result, setResult] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setResult(await api<Page>(`/notifications/mine?page=${page}&limit=${LIMIT}${unreadOnly ? "&read=false" : ""}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudieron cargar las notificaciones");
    }
  }, [page, unreadOnly]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function markRead(id: string) {
    await api(`/notifications/${id}/read`, { method: "PATCH" }).catch(() => undefined);
    void load();
  }

  async function markAll() {
    await api("/notifications/read-all", { method: "PATCH" }).catch(() => undefined);
    void load();
  }

  if (error) return <Alert>{error}</Alert>;
  if (!result) return <p className="text-sm text-muted">Cargando…</p>;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-line bg-surface p-1" role="group" aria-label="Filtro">
          {[
            { label: "Todas", value: false },
            { label: `Sin leer (${result.unread})`, value: true },
          ].map((o) => (
            <button
              key={o.label}
              onClick={() => {
                setPage(1);
                setUnreadOnly(o.value);
              }}
              aria-pressed={unreadOnly === o.value}
              className={cn(
                "min-h-9 rounded-lg px-4 text-sm font-semibold transition-colors",
                unreadOnly === o.value ? "bg-primary-600 text-white" : "text-muted hover:text-ink",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <Button variant="secondary" onClick={markAll} disabled={result.unread === 0}>
          <CheckCheck className="size-4" aria-hidden /> Marcar todas como leídas
        </Button>
      </div>

      {result.data.length === 0 ? (
        <EmptyState title={unreadOnly ? "No tienes notificaciones sin leer" : "Aún no tienes notificaciones"} />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-(--radius-card) border border-line bg-surface shadow-(--shadow-card)">
          {result.data.map((n) => {
            const { icon: Icon, label } = TYPE[n.type] ?? TYPE.aviso;
            return (
              <li key={n._id} className={cn("flex items-start gap-4 p-4 sm:p-5", !n.read && "bg-primary-50/60")}>
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-100 text-primary-700">
                  <Icon className="size-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-bold">{n.title}</p>
                    <Badge tone="primary">{label}</Badge>
                    {!n.read && <Badge tone="danger">Nueva</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-muted">{n.message}</p>
                  <p className="mt-1.5 text-xs text-muted/80">{when(n.createdAt)}</p>
                </div>
                {!n.read && (
                  <Button variant="ghost" className="min-h-9 px-3" onClick={() => markRead(n._id)}>
                    Marcar leída
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {result.meta.totalPages > 1 && (
        <div className="mt-5 flex items-center justify-between text-sm">
          <span className="text-muted">
            Página {result.meta.page} de {result.meta.totalPages}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Anterior
            </Button>
            <Button variant="secondary" disabled={page >= result.meta.totalPages} onClick={() => setPage(page + 1)}>
              Siguiente
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
