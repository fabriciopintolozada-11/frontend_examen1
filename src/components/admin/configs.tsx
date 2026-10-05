"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- cada configuracion lee los campos propios de su recurso */

import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";
import { Modal } from "@/components/ui/modal";
import { ACTIVE_OPTIONS, ActiveBadge, ResourceManager, type Opt, type ResourceConfig } from "./resource-manager";

const text = (v: unknown) => String(v ?? "").trim();
const optional = (v: unknown) => (text(v) === "" ? undefined : text(v));
// Al editar, un campo opcional vaciado se envia como null para borrarlo (undefined desaparece del JSON)
const clearable = (v: unknown, mode: "create" | "edit") => optional(v) ?? (mode === "edit" ? null : undefined);
const id = (ref: any): string => (ref ? String(ref._id ?? ref) : "");

const ROLES: Opt[] = [
  { value: "admin", label: "Administrador" },
  { value: "docente", label: "Docente" },
  { value: "estudiante", label: "Estudiante" },
];
const ROOM_TYPES: Opt[] = [
  { value: "aula", label: "Aula" },
  { value: "laboratorio", label: "Laboratorio" },
  { value: "auditorio", label: "Auditorio" },
  { value: "sala de computo", label: "Sala de cómputo" },
];
const SEMESTERS: Opt[] = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `Semestre ${i + 1}` }));

/* ---------------- Facultades ---------------- */
const faculties: ResourceConfig = {
  endpoint: "/faculties",
  createTitle: "Nueva facultad",
  editTitle: "Editar facultad",
  newLabel: "Nueva facultad",
  empty: "No hay facultades",
  filters: [{ param: "campus", label: "Sede", text: true }],
  columns: [
    { header: "Código", cell: (r) => <span className="font-semibold">{r.code}</span> },
    { header: "Nombre", cell: (r) => r.name },
    { header: "Sede", cell: (r) => r.campus },
    { header: "Correo", cell: (r) => <span className="text-muted">{r.email ?? "—"}</span> },
    { header: "Estado", cell: (r) => <ActiveBadge active={r.active} /> },
  ],
  fields: [
    { name: "code", label: "Código", type: "text", required: true, placeholder: "FAC-BOG-ING" },
    { name: "name", label: "Nombre", type: "text", required: true },
    { name: "campus", label: "Sede", type: "text", required: true, placeholder: "Bogotá" },
    { name: "email", label: "Correo de contacto", type: "email" },
    { name: "active", label: "Facultad activa", type: "checkbox", mode: "edit" },
  ],
  initial: (r) => ({ code: r?.code ?? "", name: r?.name ?? "", campus: r?.campus ?? "", email: r?.email ?? "", active: r?.active ?? true }),
  toBody: (v, mode) => ({ code: text(v.code), name: text(v.name), campus: text(v.campus), email: clearable(v.email, mode), ...(mode === "edit" ? { active: v.active === true } : {}) }),
};

/* ---------------- Programas ---------------- */
const programs: ResourceConfig = {
  endpoint: "/programs",
  createTitle: "Nuevo programa",
  editTitle: "Editar programa",
  newLabel: "Nuevo programa",
  empty: "No hay programas",
  search: { param: "q", label: "Buscar programa", placeholder: "Código o nombre" },
  lookups: { faculty: { endpoint: "/faculties?limit=100", label: (f) => f.name } },
  filters: [
    { param: "faculty", label: "Facultad", lookup: "faculty" },
    { param: "active", label: "Estado", options: ACTIVE_OPTIONS },
  ],
  columns: [
    { header: "Código", cell: (r) => <span className="font-semibold">{r.code}</span> },
    { header: "Nombre", cell: (r) => r.name },
    { header: "Créditos", align: "right", cell: (r) => r.totalCredits },
    { header: "Facultad", cell: (r, lk) => <span className="text-muted">{lk("faculty", r.faculty)}</span> },
    { header: "Estado", cell: (r) => <ActiveBadge active={r.active} /> },
  ],
  fields: [
    { name: "code", label: "Código", type: "text", required: true, placeholder: "ISIS" },
    { name: "name", label: "Nombre", type: "text", required: true },
    { name: "totalCredits", label: "Créditos del programa", type: "number", required: true, min: 1 },
    { name: "faculty", label: "Facultad", type: "select", lookup: "faculty" },
    { name: "active", label: "Programa activo", type: "checkbox", mode: "edit" },
  ],
  initial: (r) => ({ code: r?.code ?? "", name: r?.name ?? "", totalCredits: String(r?.totalCredits ?? ""), faculty: id(r?.faculty), active: r?.active ?? true }),
  toBody: (v, mode) => ({ code: text(v.code), name: text(v.name), totalCredits: Number(v.totalCredits), faculty: optional(v.faculty), ...(mode === "edit" ? { active: v.active === true } : {}) }),
};

/* ---------------- Materias ---------------- */
const subjects: ResourceConfig = {
  endpoint: "/subjects",
  createTitle: "Nueva materia",
  editTitle: "Editar materia",
  newLabel: "Nueva materia",
  empty: "No hay materias",
  search: { param: "q", label: "Buscar materia", placeholder: "Código o nombre" },
  lookups: { program: { endpoint: "/programs?limit=100", label: (p) => `${p.code} · ${p.name}` } },
  filters: [
    { param: "program", label: "Programa", lookup: "program" },
    { param: "semester", label: "Semestre", options: SEMESTERS },
    { param: "active", label: "Estado", options: ACTIVE_OPTIONS },
  ],
  columns: [
    { header: "Código", cell: (r) => <span className="font-semibold">{r.code}</span> },
    { header: "Nombre", cell: (r) => r.name },
    { header: "Créditos", align: "right", cell: (r) => r.credits },
    { header: "Semestre", align: "right", cell: (r) => r.semester ?? "—" },
    { header: "Programa", cell: (r, lk) => <span className="text-muted">{lk("program", r.program)}</span> },
    { header: "Estado", cell: (r) => <ActiveBadge active={r.active} /> },
  ],
  fields: [
    { name: "code", label: "Código", type: "text", required: true, placeholder: "BD101" },
    { name: "name", label: "Nombre", type: "text", required: true },
    { name: "credits", label: "Créditos", type: "number", required: true, min: 1, max: 10 },
    { name: "program", label: "Programa", type: "select", lookup: "program", required: true },
    { name: "semester", label: "Semestre", type: "number", min: 1, max: 12 },
    {
      name: "prerequisites",
      label: "Prerrequisitos",
      type: "multiselect",
      hint: "Materias del mismo programa que se deben aprobar antes.",
      optionsFrom: { endpoint: (v) => (v.program ? `/subjects?program=${v.program}&limit=100` : null), label: (s) => `${s.code} · ${s.name}` },
    },
    { name: "active", label: "Materia activa", type: "checkbox", mode: "edit" },
  ],
  initial: (r) => ({
    code: r?.code ?? "",
    name: r?.name ?? "",
    credits: String(r?.credits ?? ""),
    program: id(r?.program),
    semester: r?.semester ? String(r.semester) : "",
    prerequisites: (r?.prerequisites ?? []).map(id),
    active: r?.active ?? true,
  }),
  toBody: (v, mode) => ({
    code: text(v.code),
    name: text(v.name),
    credits: Number(v.credits),
    program: text(v.program),
    semester: optional(v.semester) ? Number(v.semester) : mode === "edit" ? null : undefined,
    prerequisites: v.prerequisites as string[],
    ...(mode === "edit" ? { active: v.active === true } : {}),
  }),
};

/* ---------------- Salones ---------------- */
const classrooms: ResourceConfig = {
  endpoint: "/classrooms",
  createTitle: "Nuevo salón",
  editTitle: "Editar salón",
  newLabel: "Nuevo salón",
  empty: "No hay salones",
  filters: [
    { param: "building", label: "Edificio", text: true },
    { param: "type", label: "Tipo", options: ROOM_TYPES },
    { param: "minCapacity", label: "Capacidad mínima", text: true },
  ],
  columns: [
    { header: "Código", cell: (r) => <span className="font-semibold">{r.code}</span> },
    { header: "Edificio", cell: (r) => r.building },
    { header: "Piso", align: "right", cell: (r) => r.floor },
    { header: "Capacidad", align: "right", cell: (r) => r.capacity },
    { header: "Tipo", cell: (r) => ROOM_TYPES.find((t) => t.value === r.type)?.label ?? r.type },
    { header: "Proyector", cell: (r) => (r.hasProjector ? "Sí" : "No") },
    { header: "Estado", cell: (r) => <ActiveBadge active={r.active} /> },
  ],
  fields: [
    { name: "code", label: "Código", type: "text", required: true, placeholder: "B-203" },
    { name: "building", label: "Edificio", type: "text", required: true, placeholder: "B" },
    { name: "floor", label: "Piso", type: "number", required: true, min: 1, max: 30 },
    { name: "capacity", label: "Capacidad", type: "number", required: true, min: 5, max: 500 },
    { name: "type", label: "Tipo", type: "select", options: ROOM_TYPES },
    { name: "hasProjector", label: "Tiene proyector", type: "checkbox" },
    { name: "active", label: "Salón activo", type: "checkbox", mode: "edit" },
  ],
  initial: (r) => ({ code: r?.code ?? "", building: r?.building ?? "", floor: String(r?.floor ?? ""), capacity: String(r?.capacity ?? ""), type: r?.type ?? "aula", hasProjector: r?.hasProjector ?? true, active: r?.active ?? true }),
  toBody: (v, mode) => ({
    code: text(v.code),
    building: text(v.building),
    floor: Number(v.floor),
    capacity: Number(v.capacity),
    type: optional(v.type),
    hasProjector: v.hasProjector === true,
    ...(mode === "edit" ? { active: v.active === true } : {}),
  }),
};

/* ---------------- Usuarios ---------------- */
function ResetPassword({ userId, name }: { userId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  const close = () => {
    setOpen(false);
    setPassword("");
    setError(null);
    setDone(false);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api(`/users/${userId}/reset-password`, { method: "POST", body: { newPassword: password } });
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo restablecer");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button onClick={() => setOpen(true)} aria-label={`Restablecer contraseña de ${name}`} title="Restablecer contraseña" className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-accent-100 hover:text-accent-600">
        <KeyRound className="size-4" aria-hidden />
      </button>
      <Modal open={open} title="Restablecer contraseña" onClose={close}>
        {done ? (
          <div className="space-y-4">
            <Alert tone="success">Contraseña actualizada. Se cerraron las sesiones activas de {name}.</Alert>
            <div className="flex justify-end">
              <Button onClick={close}>Listo</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <p className="text-sm text-muted">Define una contraseña nueva para {name}. Debe tener mínimo 8 caracteres, con letras y números.</p>
            {error && <Alert>{error}</Alert>}
            <Field label="Contraseña nueva" name="reset" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <div className="flex justify-end gap-3">
              <Button type="button" variant="ghost" onClick={close} disabled={saving}>
                Cancelar
              </Button>
              <Button type="submit" loading={saving} disabled={password.length < 8}>
                Restablecer
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

const users: ResourceConfig = {
  endpoint: "/users",
  createTitle: "Nuevo usuario",
  editTitle: "Editar usuario",
  newLabel: "Nuevo usuario",
  keepOpenIfDirty: true,
  empty: "No hay usuarios",
  search: { param: "q", label: "Buscar usuario", placeholder: "Nombre o correo" },
  filters: [
    { param: "role", label: "Rol", options: ROLES },
    { param: "active", label: "Estado", options: ACTIVE_OPTIONS },
  ],
  columns: [
    { header: "Nombre", cell: (r) => <span className="font-semibold">{r.name}</span> },
    { header: "Correo", cell: (r) => <span className="text-muted">{r.email}</span> },
    { header: "Rol", cell: (r) => <Badge tone={r.role === "admin" ? "danger" : r.role === "docente" ? "primary" : "neutral"}>{ROLES.find((o) => o.value === r.role)?.label}</Badge> },
    { header: "Estado", cell: (r) => <ActiveBadge active={r.active} /> },
  ],
  fields: [
    { name: "name", label: "Nombre completo", type: "text", required: true },
    { name: "email", label: "Correo", type: "email", required: true },
    { name: "password", label: "Contraseña", type: "password", required: true, mode: "create", hint: "Mínimo 8 caracteres, con letras y números." },
    { name: "role", label: "Rol", type: "select", options: ROLES, required: true, hint: "Un usuario con perfil de estudiante o docente no puede cambiar de rol." },
    { name: "active", label: "Usuario activo", type: "checkbox", mode: "edit" },
  ],
  initial: (r) => ({ name: r?.name ?? "", email: r?.email ?? "", password: "", role: r?.role ?? "estudiante", active: r?.active ?? true }),
  toBody: (v, mode) =>
    mode === "create"
      ? { name: text(v.name), email: text(v.email), password: String(v.password), role: text(v.role) }
      : { name: text(v.name), email: text(v.email), role: text(v.role), active: v.active === true },
  rowActions: (r) => <ResetPassword userId={r._id} name={r.name} />,
};

/* ---------------- Estudiantes ---------------- */
const students: ResourceConfig = {
  endpoint: "/students",
  createTitle: "Nuevo perfil de estudiante",
  editTitle: "Editar estudiante",
  newLabel: "Nuevo estudiante",
  empty: "No hay estudiantes",
  search: { param: "q", label: "Buscar estudiante", placeholder: "Código, nombre o correo" },
  lookups: {
    program: { endpoint: "/programs?limit=100", label: (p) => `${p.code} · ${p.name}` },
    studentUsers: { endpoint: "/users?role=estudiante&active=true&limit=100", label: (u) => `${u.name} — ${u.email}` },
  },
  filters: [
    { param: "program", label: "Programa", lookup: "program" },
    { param: "active", label: "Estado", options: ACTIVE_OPTIONS },
  ],
  columns: [
    { header: "Código", cell: (r) => <span className="font-semibold">{r.code}</span> },
    { header: "Nombre", cell: (r) => r.user?.name },
    { header: "Correo", cell: (r) => <span className="text-muted">{r.user?.email}</span> },
    { header: "Programa", cell: (r) => r.program?.code },
    { header: "Estado", cell: (r) => <ActiveBadge active={r.active} /> },
  ],
  fields: [
    { name: "user", label: "Usuario (rol estudiante)", type: "select", lookup: "studentUsers", required: true, mode: "create", hint: "Primero crea el usuario en “Usuarios”; aquí le asignas su perfil." },
    { name: "code", label: "Código estudiantil", type: "text", required: true, placeholder: "2026001" },
    { name: "program", label: "Programa", type: "select", lookup: "program", required: true },
    { name: "active", label: "Estudiante activo", type: "checkbox", mode: "edit" },
  ],
  initial: (r) => ({ user: "", code: r?.code ?? "", program: id(r?.program), active: r?.active ?? true }),
  toBody: (v, mode) => (mode === "create" ? { user: text(v.user), code: text(v.code), program: text(v.program) } : { code: text(v.code), program: text(v.program), active: v.active === true }),
};

/* ---------------- Docentes ---------------- */
const teachers: ResourceConfig = {
  endpoint: "/teachers",
  createTitle: "Nuevo perfil de docente",
  editTitle: "Editar docente",
  newLabel: "Nuevo docente",
  empty: "No hay docentes",
  search: { param: "q", label: "Buscar docente", placeholder: "Código, nombre o correo" },
  lookups: {
    faculty: { endpoint: "/faculties?limit=100", label: (f) => f.name },
    teacherUsers: { endpoint: "/users?role=docente&active=true&limit=100", label: (u) => `${u.name} — ${u.email}` },
  },
  filters: [
    { param: "faculty", label: "Facultad", lookup: "faculty" },
    { param: "active", label: "Estado", options: ACTIVE_OPTIONS },
  ],
  columns: [
    { header: "Código", cell: (r) => <span className="font-semibold">{r.code}</span> },
    { header: "Nombre", cell: (r) => r.user?.name },
    { header: "Correo", cell: (r) => <span className="text-muted">{r.user?.email}</span> },
    { header: "Facultad", cell: (r) => r.faculty?.name },
    { header: "Estado", cell: (r) => <ActiveBadge active={r.active} /> },
  ],
  fields: [
    { name: "user", label: "Usuario (rol docente)", type: "select", lookup: "teacherUsers", required: true, mode: "create", hint: "Primero crea el usuario en “Usuarios”; aquí le asignas su perfil." },
    { name: "code", label: "Código docente", type: "text", required: true, placeholder: "DOC-001" },
    { name: "faculty", label: "Facultad", type: "select", lookup: "faculty", required: true },
    { name: "active", label: "Docente activo", type: "checkbox", mode: "edit" },
  ],
  initial: (r) => ({ user: "", code: r?.code ?? "", faculty: id(r?.faculty), active: r?.active ?? true }),
  toBody: (v, mode) => (mode === "create" ? { user: text(v.user), code: text(v.code), faculty: text(v.faculty) } : { code: text(v.code), faculty: text(v.faculty), active: v.active === true }),
};

export const FacultiesManager = () => <ResourceManager config={faculties} />;
export const ProgramsManager = () => <ResourceManager config={programs} />;
export const SubjectsManager = () => <ResourceManager config={subjects} />;
export const ClassroomsManager = () => <ResourceManager config={classrooms} />;
export const UsersManager = () => <ResourceManager config={users} />;
export const StudentsManager = () => <ResourceManager config={students} />;
export const TeachersManager = () => <ResourceManager config={teachers} />;
