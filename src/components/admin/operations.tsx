"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- cada configuracion lee los campos propios de su recurso */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Ban, Lock, Play, Search, Send, type LucideIcon } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { date, DAY_SHORT, STATUS_LABEL, STATUS_TONE } from "@/lib/format";
import type { Paginated } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";
import { Modal } from "@/components/ui/modal";
import { ACTIVE_OPTIONS, ActiveBadge, ResourceManager, type Opt, type ResourceConfig } from "./resource-manager";

const text = (v: unknown) => String(v ?? "").trim();
const id = (ref: any): string => (ref ? String(ref._id ?? ref) : "");
const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

const DAYS: Opt[] = [
  { value: "lunes", label: "Lunes" },
  { value: "martes", label: "Martes" },
  { value: "miercoles", label: "Miércoles" },
  { value: "jueves", label: "Jueves" },
  { value: "viernes", label: "Viernes" },
  { value: "sabado", label: "Sábado" },
];

// Boton de icono que abre una confirmacion y ejecuta una accion contra la API
function ConfirmAction({ icon: Icon, label, title, description, confirmLabel, danger, run, onDone }: { icon: LucideIcon; label: string; title: string; description: ReactNode; confirmLabel: string; danger?: boolean; run: () => Promise<unknown>; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await run();
      setOpen(false);
      onDone();
    } catch (e) {
      setError(message(e, "No se pudo completar la acción"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button onClick={() => setOpen(true)} aria-label={label} title={label} className={`flex size-9 items-center justify-center rounded-lg text-muted ${danger ? "hover:bg-danger-100 hover:text-danger-600" : "hover:bg-primary-100 hover:text-primary-800"}`}>
        <Icon className="size-4" aria-hidden />
      </button>
      <Modal open={open} title={title} onClose={() => !busy && setOpen(false)}>
        <div className="space-y-4">
          <div className="text-sm text-muted">{description}</div>
          {error && <Alert>{error}</Alert>}
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Volver
            </Button>
            <Button variant={danger ? "danger" : "primary"} loading={busy} onClick={confirm}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/* ---------------- Periodos ---------------- */
interface CloseCheck {
  canClose: boolean;
  pendingEnrollments: number;
  groups: { group: string; subject: { code: string; name: string }; number: number; pending: number }[];
}

function ClosePeriod({ period, onDone }: { period: any; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<CloseCheck | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api<CloseCheck>(`/periods/${period._id}/close-check`)
      .then(setCheck)
      .catch((e) => setError(message(e, "No se pudo revisar el periodo")));
  }, [open, period._id]);

  function close() {
    setOpen(false);
    setCheck(null);
    setCancelPending(false);
    setError(null);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api(`/periods/${period._id}/close${cancelPending ? "?cancelPending=true" : ""}`, { method: "POST" });
      close();
      onDone();
    } catch (e) {
      setError(message(e, "No se pudo cerrar el periodo"));
    } finally {
      setBusy(false);
    }
  }

  const pending = check?.pendingEnrollments ?? 0;

  return (
    <>
      <button onClick={() => setOpen(true)} aria-label={`Cerrar periodo ${period.code}`} title="Cerrar periodo" className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-danger-100 hover:text-danger-600">
        <Lock className="size-4" aria-hidden />
      </button>
      <Modal open={open} title={`Cerrar el periodo ${period.code}`} onClose={() => !busy && close()}>
        <div className="space-y-4">
          <Alert>El cierre es irreversible: el periodo no se podrá reabrir ni se podrá matricular en él.</Alert>
          {!check && !error && <p className="text-sm text-muted">Revisando matrículas pendientes…</p>}
          {check && pending === 0 && <Alert tone="success">No hay matrículas activas sin finalizar. Puedes cerrar el periodo.</Alert>}
          {check && pending > 0 && (
            <>
              <p className="text-sm">
                Hay <strong>{pending}</strong> matrículas activas sin nota final en {check.groups.length} grupos. Finalízalas desde la planilla de cada grupo, o cancélalas al cerrar.
              </p>
              <ul className="max-h-40 divide-y divide-line overflow-y-auto rounded-xl border border-line text-sm">
                {check.groups.map((g) => (
                  <li key={g.group} className="flex justify-between gap-3 px-3 py-2">
                    <span>
                      {g.subject.code} · Grupo {g.number}
                    </span>
                    <span className="font-semibold">{g.pending} pendientes</span>
                  </li>
                ))}
              </ul>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-danger-100 p-3 text-sm font-semibold text-danger-600">
                <input type="checkbox" checked={cancelPending} onChange={(e) => setCancelPending(e.target.checked)} className="mt-0.5 size-4 accent-danger-600" />
                Cancelar las {pending} matrículas pendientes y cerrar de todos modos
              </label>
            </>
          )}
          {error && <Alert>{error}</Alert>}
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={close} disabled={busy}>
              Volver
            </Button>
            <Button variant="danger" loading={busy} disabled={!check || (pending > 0 && !cancelPending)} onClick={confirm}>
              Cerrar periodo
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

const PERIOD_TONE = { planificado: "warning", abierto: "success", cerrado: "neutral" } as const;

const periods: ResourceConfig = {
  endpoint: "/periods",
  createTitle: "Nuevo periodo",
  editTitle: "Editar periodo",
  newLabel: "Nuevo periodo",
  empty: "No hay periodos",
  filters: [
    {
      param: "status",
      label: "Estado",
      options: [
        { value: "planificado", label: "Planificado" },
        { value: "abierto", label: "Abierto" },
        { value: "cerrado", label: "Cerrado" },
      ],
    },
  ],
  columns: [
    { header: "Código", cell: (r) => <span className="font-semibold">{r.code}</span> },
    { header: "Inicio", cell: (r) => date(r.startDate) },
    { header: "Fin", cell: (r) => date(r.endDate) },
    { header: "Estado", cell: (r) => <Badge tone={PERIOD_TONE[r.status as keyof typeof PERIOD_TONE]}>{r.status.charAt(0).toUpperCase() + r.status.slice(1)}</Badge> },
  ],
  fields: [
    { name: "code", label: "Código", type: "text", required: true, placeholder: "2027-1" },
    { name: "startDate", label: "Fecha de inicio", type: "date", required: true },
    { name: "endDate", label: "Fecha de fin", type: "date", required: true },
  ],
  initial: (r) => ({ code: r?.code ?? "", startDate: r ? String(r.startDate).slice(0, 10) : "", endDate: r ? String(r.endDate).slice(0, 10) : "" }),
  toBody: (v) => ({ code: text(v.code), startDate: text(v.startDate), endDate: text(v.endDate) }),
  rowActions: (r, reload) =>
    r.status === "planificado" ? (
      <ConfirmAction
        icon={Play}
        label={`Abrir periodo ${r.code}`}
        title={`Abrir el periodo ${r.code}`}
        description="Los estudiantes podrán matricularse en sus grupos. Solo puede haber un periodo abierto a la vez."
        confirmLabel="Abrir periodo"
        run={() => api(`/periods/${r._id}`, { method: "PATCH", body: { status: "abierto" } })}
        onDone={reload}
      />
    ) : r.status === "abierto" ? (
      <ClosePeriod period={r} onDone={reload} />
    ) : null,
};

/* ---------------- Grupos ---------------- */
const groups: ResourceConfig = {
  endpoint: "/groups",
  createTitle: "Nuevo grupo",
  editTitle: "Editar grupo",
  newLabel: "Nuevo grupo",
  empty: "No hay grupos",
  lookups: {
    subject: { endpoint: "/subjects?active=true&limit=100", label: (s) => `${s.code} · ${s.name}` },
    teacher: { endpoint: "/teachers?active=true&limit=100", label: (t) => `${t.code} · ${t.user?.name}` },
    period: { endpoint: "/periods?limit=100", label: (p) => `${p.code}${p.status === "abierto" ? " (abierto)" : ""}` },
    classroom: { endpoint: "/classrooms?limit=100", label: (c) => `${c.code} · cap. ${c.capacity}` },
  },
  filters: [
    { param: "period", label: "Periodo", lookup: "period" },
    { param: "teacher", label: "Docente", lookup: "teacher" },
    { param: "day", label: "Día", options: DAYS },
    { param: "active", label: "Estado", options: ACTIVE_OPTIONS },
  ],
  columns: [
    {
      header: "Materia",
      cell: (r) => (
        <>
          <span className="font-semibold">{r.subject?.name}</span>
          <span className="ml-2 text-xs text-muted">
            {r.subject?.code} · G{r.number}
          </span>
        </>
      ),
    },
    { header: "Periodo", cell: (r) => r.period?.code },
    { header: "Docente", cell: (r) => <span className="text-muted">{r.teacher?.user?.name}</span> },
    { header: "Cupos", align: "right", cell: (r) => `${r.enrolled} / ${r.capacity}` },
    {
      header: "Horario",
      cell: (r) => (
        <span className="text-xs text-muted">
          {r.schedule.map((s: any) => `${DAY_SHORT[s.day as keyof typeof DAY_SHORT]} ${s.startTime}–${s.endTime}${s.classroom ? ` (${s.classroom.code})` : ""}`).join(" · ")}
        </span>
      ),
    },
    { header: "Estado", cell: (r) => <ActiveBadge active={r.active} /> },
  ],
  fields: [
    { name: "subject", label: "Materia", type: "select", lookup: "subject", required: true, mode: "create" },
    { name: "period", label: "Periodo", type: "select", lookup: "period", required: true, mode: "create", hint: "Solo se puede matricular en un periodo abierto." },
    { name: "teacher", label: "Docente", type: "select", lookup: "teacher", required: true },
    { name: "capacity", label: "Cupo", type: "number", required: true, min: 1, max: 100 },
    { name: "schedule", label: "Horario semanal", type: "schedule", lookup: "classroom", required: true, hint: "El backend avisa si el docente o el salón ya están ocupados en ese horario." },
    { name: "active", label: "Grupo activo", type: "checkbox", mode: "edit" },
  ],
  initial: (r) => ({
    subject: "",
    period: "",
    teacher: id(r?.teacher),
    capacity: String(r?.capacity ?? ""),
    schedule: r ? r.schedule.map((s: any) => ({ day: s.day, startTime: s.startTime, endTime: s.endTime, classroom: id(s.classroom) })) : [{ day: "lunes", startTime: "", endTime: "", classroom: "" }],
    active: r?.active ?? true,
  }),
  toBody: (v, mode) => ({
    ...(mode === "create" ? { subject: text(v.subject), period: text(v.period) } : { active: v.active === true }),
    teacher: text(v.teacher),
    capacity: Number(v.capacity),
    schedule: v.schedule,
  }),
};

/* ---------------- Matriculas ---------------- */
const enrollments: ResourceConfig = {
  endpoint: "/enrollments",
  createTitle: "Matricular estudiante",
  editTitle: "",
  newLabel: "Matricular estudiante",
  empty: "No hay matrículas con estos filtros",
  noEdit: true,
  lookups: {
    student: { endpoint: "/students?active=true&limit=100", label: (s) => `${s.code} · ${s.user?.name}` },
    period: { endpoint: "/periods?limit=100", label: (p) => `${p.code}${p.status === "abierto" ? " (abierto)" : ""}` },
    openGroup: { endpoint: "/groups?available=true&limit=100", label: (g) => `${g.subject?.code} G${g.number} — ${g.subject?.name} (${g.period?.code}, ${g.availableSeats} cupos)` },
  },
  filters: [
    { param: "student", label: "Estudiante", lookup: "student" },
    { param: "period", label: "Periodo", lookup: "period" },
    {
      param: "status",
      label: "Estado",
      options: [
        { value: "activa", label: "En curso" },
        { value: "aprobada", label: "Aprobada" },
        { value: "reprobada", label: "Reprobada" },
        { value: "cancelada", label: "Cancelada" },
      ],
    },
  ],
  columns: [
    {
      header: "Estudiante",
      cell: (r) => (
        <>
          <span className="font-semibold">{r.student?.user?.name}</span>
          <span className="ml-2 text-xs text-muted">{r.student?.code}</span>
        </>
      ),
    },
    {
      header: "Materia",
      cell: (r) => (
        <>
          {r.subject?.name}
          <span className="ml-2 text-xs text-muted">
            {r.subject?.code} · G{r.group?.number}
          </span>
        </>
      ),
    },
    { header: "Periodo", cell: (r) => r.period?.code },
    { header: "Nota final", align: "right", cell: (r) => (r.finalGrade !== undefined ? r.finalGrade.toFixed(1) : "—") },
    { header: "Estado", cell: (r) => <Badge tone={STATUS_TONE[r.status as keyof typeof STATUS_TONE]}>{STATUS_LABEL[r.status as keyof typeof STATUS_LABEL]}</Badge> },
  ],
  fields: [
    { name: "student", label: "Estudiante", type: "select", lookup: "student", required: true },
    { name: "group", label: "Grupo", type: "select", lookup: "openGroup", required: true, hint: "Solo grupos activos con cupo. El backend valida prerrequisitos, cruces de horario y el límite de créditos." },
  ],
  initial: () => ({ student: "", group: "" }),
  toBody: (v) => ({ student: text(v.student), groupId: text(v.group) }),
  rowActions: (r, reload) =>
    r.status === "activa" && r.period?.status === "abierto" ? (
      <ConfirmAction
        icon={Ban}
        danger
        label={`Cancelar matrícula de ${r.student?.user?.name}`}
        title="Cancelar matrícula"
        description={`Se cancelará la matrícula de ${r.student?.user?.name} en ${r.subject?.name} y se liberará el cupo.`}
        confirmLabel="Cancelar matrícula"
        run={() => api(`/enrollments/${r._id}/cancel`, { method: "POST" })}
        onDone={reload}
      />
    ) : null,
};

export const PeriodsManager = () => <ResourceManager config={periods} />;
export const GroupsManager = () => <ResourceManager config={groups} />;
export const EnrollmentsManager = () => <ResourceManager config={enrollments} />;

/* ---------------- Avisos ---------------- */
interface UserHit {
  _id: string;
  name: string;
  email: string;
  role: string;
}

export function SendNotice() {
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<UserHit[]>([]);
  const [target, setTarget] = useState<UserHit | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [notice, setNotice] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const [sending, setSending] = useState(false);

  // Busca usuarios por nombre o correo mientras escribes (con 300 ms de espera)
  useEffect(() => {
    if (search.trim().length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      api<Paginated<UserHit>>(`/users?q=${encodeURIComponent(search.trim())}&active=true&limit=6`)
        .then((r) => setHits(r.data))
        .catch(() => setHits([]));
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    setSending(true);
    setNotice(null);
    try {
      await api("/notifications", { method: "POST", body: { user: target._id, title: title.trim(), message: body.trim() } });
      setNotice({ tone: "success", text: `Aviso enviado a ${target.name}.` });
      setTitle("");
      setBody("");
      setTarget(null);
      setSearch("");
    } catch (e) {
      setNotice({ tone: "danger", text: message(e, "No se pudo enviar el aviso") });
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="mx-auto max-w-2xl">
      <form onSubmit={send} className="space-y-5" noValidate>
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

        {target ? (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-primary-50 px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs text-muted">Destinatario</p>
              <p className="truncate font-bold">
                {target.name} <span className="font-normal text-muted">· {target.email}</span>
              </p>
            </div>
            <Button type="button" variant="ghost" onClick={() => setTarget(null)}>
              Cambiar
            </Button>
          </div>
        ) : (
          <div>
            <Field label="Destinatario" name="to" placeholder="Busca por nombre o correo" value={search} onChange={(e) => setSearch(e.target.value)} icon={<Search className="size-4" aria-hidden />} hint="Escribe al menos 2 letras." />
            {hits.length > 0 && (
              <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line">
                {hits.map((u) => (
                  <li key={u._id}>
                    <button type="button" onClick={() => setTarget(u)} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-primary-50">
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{u.name}</span>
                        <span className="block truncate text-xs text-muted">{u.email}</span>
                      </span>
                      <Badge tone="neutral">{u.role}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Field label="Título" name="title" maxLength={120} placeholder="Cambio de salón" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="space-y-1.5">
          <label htmlFor="message" className="block text-sm font-semibold">
            Mensaje
          </label>
          <textarea
            id="message"
            rows={4}
            maxLength={500}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Tu clase del lunes pasa al salón B-204."
            className="w-full rounded-xl border border-line bg-surface px-4 py-3 text-sm placeholder:text-muted/70 focus:border-primary-500"
          />
          <p className="text-right text-xs text-muted">{body.length} / 500</p>
        </div>
        <Button type="submit" loading={sending} disabled={!target || !title.trim() || !body.trim()}>
          <Send className="size-4" aria-hidden /> Enviar aviso
        </Button>
      </form>
    </Card>
  );
}

