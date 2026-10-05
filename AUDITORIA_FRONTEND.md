# Auditoría de Calidad del Frontend — Gestión Académica

| Campo | Valor |
| --- | --- |
| Proyecto | proyectofrontend1 v0.1.0 |
| Fecha | 2026-10-05 (2026-10-05T17:34:24.351Z) |
| Rama / commit | `qa/frontend-julio` @ `95a2553` (con cambios sin commitear) |
| Herramienta | frontend-qa-mcp v1.0.0 (Model Context Protocol) |

## 1. Resumen ejecutivo

Auditoría del frontend Next.js 16 (App Router) de Gestión Académica. Se revisaron los 69 archivos fuente: análisis estático de hooks por AST (MCP `audit_react_hooks_and_state`) más revisión manual de llamadas a API, formularios, rutas y control de acceso. Se identificaron y corrigieron 34 bugs en 23 archivos (+124/−62 líneas) mediante `apply_code_fix`, y se eliminaron 2 archivos con tokens. Tras los parches, `run_typecheck`, `run_build_audit` y `audit_dependencies` dan PASS. BUG-34 queda en FAIL de forma intencional: los tokens se quitaron del árbol de trabajo, pero siguen en el historial de git y el secreto JWT debe regenerarse en el backend. BUG-23 y BUG-33 compilan y pasan el build, pero su comportamiento final depende de cómo responde el backend (código 401 en `/auth/*` y aceptación de `null` en PATCH). Se recomienda validarlos con el backend levantado.

Los IDs BUG-NN de este reporte equivalen a BUG-FE-NN del desglose de la auditoría.

Se identificaron **34** bugs; **33** quedaron verificados (PASS) y **1** siguen pendientes (FAIL).

| Verificación global | Resultado |
| --- | --- |
| `run_typecheck` (tsc --noEmit) | ✅ PASS |
| `run_build_audit` (build de producción) | ✅ PASS |

### Distribución por capa

| Capa | Bugs | Verificados (PASS) | Pendientes (FAIL) |
| --- | ---: | ---: | ---: |
| Hooks/Estado | 4 | 4 | 0 |
| UI/Renderizado | 11 | 11 | 0 |
| Contrato API | 10 | 10 | 0 |
| Formulario | 5 | 5 | 0 |
| Seguridad/Auth | 4 | 3 | 1 |
| **Total** | **34** | **33** | **1** |

## 2. Índice de bugs

| ID | Capa | Archivo | Síntoma | Estado |
| --- | --- | --- | --- | --- |
| [BUG-01](#bug-01) | Formulario | `src/app/(app)/cuenta/account-forms.tsx:19,81` | El botón "Guardar nombre" está siempre deshabilitado: ningún usuario puede cambiar su nombre. | ✅ PASS |
| [BUG-02](#bug-02) | Hooks/Estado | `src/app/(app)/estudiante/materias/cancel-button.tsx:17-19` | Tras cancelar una materia, la lista la sigue mostrando "En curso" con su botón Cancelar. | ✅ PASS |
| [BUG-03](#bug-03) | Formulario | `src/app/(app)/docente/grupos/[id]/grade-sheet-panel.tsx:18-20` | Una nota escrita con coma ("4,5") se marca inválida y bloquea el guardado. | ✅ PASS |
| [BUG-04](#bug-04) | UI/Renderizado | `src/app/(app)/docente/grupos/[id]/evaluations-panel.tsx:44` | Con un plan al 60 % muestra "Te pasaste 40%"; con uno al 120 % muestra "Faltan 20%". | ✅ PASS |
| [BUG-05](#bug-05) | Contrato API | `src/components/admin/resource-manager.tsx:115` | En todas las pantallas de administración, la página 2 o siguientes ignoran los filtros activos. | ✅ PASS |
| [BUG-06](#bug-06) | Contrato API | `src/app/(app)/docente/grupos/page.tsx:20-21` | Sin `?period=` en la URL, el selector muestra el periodo actual pero se listan grupos de todos los periodos. | ✅ PASS |
| [BUG-07](#bug-07) | Seguridad/Auth | `src/proxy.ts:20` | Un estudiante puede abrir páginas como `/admin/usuarios` o `/docente/grupos/x` sin ser redirigido. | ✅ PASS |
| [BUG-08](#bug-08) | Contrato API | `src/app/(app)/estudiante/notas/page.tsx:39-41` | El "Acumulado" del estudiante no coincide con el de la planilla del docente. | ✅ PASS |
| [BUG-09](#bug-09) | UI/Renderizado | `src/app/(app)/estudiante/notas/page.tsx:73` | Un 3.0 (nota aprobatoria) se pinta en rojo como reprobado. | ✅ PASS |
| [BUG-10](#bug-10) | UI/Renderizado | `src/lib/format.ts:25` | Las materias reprobadas aparecen como "Aprobada" en historial, notas y planilla. | ✅ PASS |
| [BUG-11](#bug-11) | UI/Renderizado | `src/app/(app)/admin/page.tsx:23` | "Docentes activos" muestra la cantidad de estudiantes. | ✅ PASS |
| [BUG-12](#bug-12) | Contrato API | `src/app/(app)/admin/page.tsx:58` | Los contadores de matrículas por estado salen siempre en 0. | ✅ PASS |
| [BUG-13](#bug-13) | UI/Renderizado | `src/app/(app)/docente/grupos/page.tsx:52` | Las tarjetas muestran "30 / 12 estudiantes" (cupo y matriculados invertidos). | ✅ PASS |
| [BUG-14](#bug-14) | UI/Renderizado | `src/app/(app)/estudiante/page.tsx:22` | El saludo dice "Hola, undefined" con nombres de una sola palabra, o saluda por el apellido. | ✅ PASS |
| [BUG-15](#bug-15) | Contrato API | `src/app/(app)/estudiante/page.tsx:16,31` | "Materias matriculadas — activas este periodo" cuenta las matrículas históricas y las canceladas. | ✅ PASS |
| [BUG-16](#bug-16) | UI/Renderizado | `src/app/(app)/estudiante/materias/page.tsx:22` | Los periodos se listan del más antiguo al más reciente. | ✅ PASS |
| [BUG-17](#bug-17) | UI/Renderizado | `src/components/week-schedule.tsx:13-15` | Las clases del sábado aparecen en la columna del viernes y la del sábado queda vacía. | ✅ PASS |
| [BUG-18](#bug-18) | UI/Renderizado | `src/lib/format.ts:6` | La columna del lunes dice "Lrrrrunes". | ✅ PASS |
| [BUG-19](#bug-19) | Contrato API | `src/app/api/auth/login/route.ts:20-21` | Si el backend responde 2xx sin token, el login "tiene éxito" y navega a una ruta indefinida. | ✅ PASS |
| [BUG-20](#bug-20) | Contrato API | `src/app/api/[...path]/route.ts:33` | Al cambiar la contraseña, si la respuesta no es JSON, el usuario ve un error 500 aunque el cambio se haya a... | ✅ PASS |
| [BUG-21](#bug-21) | Hooks/Estado | `src/components/admin/resource-manager.tsx:85,297` | Al editar un usuario, Cancelar y la X no cierran el modal aunque no se haya cambiado nada. | ✅ PASS |
| [BUG-22](#bug-22) | UI/Renderizado | `src/components/app-shell.tsx:83,106,112` | Los enlaces no activos del menú y los títulos de sección no se ven. | ✅ PASS |
| [BUG-23](#bug-23) | Seguridad/Auth | `src/lib/api.ts:31` | Con una contraseña incorrecta en el login aparece "Tu sesión venció"; equivocarse en la contraseña actual a... | ✅ PASS |
| [BUG-24](#bug-24) | UI/Renderizado | `src/lib/format.ts:19-20` | Las fechas de inicio y fin de los periodos se muestran un día antes. | ✅ PASS |
| [BUG-25](#bug-25) | Contrato API | `src/components/admin/operations.tsx:328` | La tabla de Matrículas puede romperse si `finalGrade` llega como `null`. | ✅ PASS |
| [BUG-26](#bug-26) | Contrato API | `.env.example:2` | Siguiendo el ejemplo, el frontend apunta a un puerto del backend distinto del documentado. | ✅ PASS |
| [BUG-27](#bug-27) | Seguridad/Auth | `src/lib/session.ts:32` | Los datos del token con tildes se corrompen ("josé" se lee como "josÃ©"). | ✅ PASS |
| [BUG-28](#bug-28) | Contrato API | `src/components/admin/resource-manager.tsx:103,309` | A partir del registro 101 (estudiantes, materias, usuarios) no se pueden elegir en los selectores. | ✅ PASS |
| [BUG-29](#bug-29) | Formulario | `src/components/admin/resource-manager.tsx:448-451` | Con varias franjas de horario, la etiqueta "Inicio" de la franja 2 enfoca la franja 1; los ids se repiten. | ✅ PASS |
| [BUG-30](#bug-30) | Hooks/Estado | `src/app/(app)/notificaciones/notification-list.tsx:47-55; src/components/app-shell.tsx:50-62` | El contador del menú no se actualiza al marcar notificaciones como leídas (hasta 60 s) y los errores se ign... | ✅ PASS |
| [BUG-31](#bug-31) | Hooks/Estado | `src/components/admin/operations.tsx:380-384` | Al buscar destinatario de un aviso, pueden aparecer los resultados de una búsqueda anterior. | ✅ PASS |
| [BUG-32](#bug-32) | Formulario | `src/app/(app)/docente/grupos/[id]/grade-sheet-panel.tsx:57` | Si el docente borra una nota ya guardada, el cambio se ignora sin avisar. | ✅ PASS |
| [BUG-33](#bug-33) | Formulario | `src/components/admin/configs.tsx:54,139` | No se puede dejar en blanco el correo de una facultad ni el semestre de una materia. | ✅ PASS |
| [BUG-34](#bug-34) | Seguridad/Auth | `a.txt, s.txt` | Hay cookies con tokens JWT válidos (admin y estudiante) versionadas en el repositorio. | ❌ FAIL |

## 3. Detalle de bugs

### BUG-01

- **Capa:** Formulario
- **Archivo:** `src/app/(app)/cuenta/account-forms.tsx:19,81`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

El botón "Guardar nombre" está siempre deshabilitado: ningún usuario puede cambiar su nombre.

**Causa raíz**

El botón exige `dirty === true`, pero `setDirty` nunca se invoca, así que la condición jamás se cumple.

**Solución aplicada**

Se eliminó el estado `dirty`; el botón se habilita cuando el nombre recortado no está vacío y difiere del actual.

---

### BUG-02

- **Capa:** Hooks/Estado
- **Archivo:** `src/app/(app)/estudiante/materias/cancel-button.tsx:17-19`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Tras cancelar una materia, la lista la sigue mostrando "En curso" con su botón Cancelar.

**Causa raíz**

La lista es un Server Component y, tras el PATCH exitoso, no se solicita una nueva renderización.

**Solución aplicada**

Se añadió `useRouter` y `router.refresh()` después de cancelar con éxito.

---

### BUG-03

- **Capa:** Formulario
- **Archivo:** `src/app/(app)/docente/grupos/[id]/grade-sheet-panel.tsx:18-20`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Una nota escrita con coma ("4,5") se marca inválida y bloquea el guardado.

**Causa raíz**

La expresión regular solo admite punto decimal, aunque el comentario y el uso local (es-CO) exigen aceptar la coma.

**Solución aplicada**

Se normaliza la coma a punto antes de validar.

---

### BUG-04

- **Capa:** UI/Renderizado
- **Archivo:** `src/app/(app)/docente/grupos/[id]/evaluations-panel.tsx:44`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Con un plan al 60 % muestra "Te pasaste 40%"; con uno al 120 % muestra "Faltan 20%".

**Causa raíz**

`remaining = total - 100` está invertido respecto a cómo se interpreta en el texto.

**Solución aplicada**

`remaining = 100 - total`.

---

### BUG-05

- **Capa:** Contrato API
- **Archivo:** `src/components/admin/resource-manager.tsx:115`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

En todas las pantallas de administración, la página 2 o siguientes ignoran los filtros activos.

**Causa raíz**

Los filtros solo se añaden a la consulta cuando `page === 1`.

**Solución aplicada**

Los filtros se envían en todas las páginas.

---

### BUG-06

- **Capa:** Contrato API
- **Archivo:** `src/app/(app)/docente/grupos/page.tsx:20-21`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Sin `?period=` en la URL, el selector muestra el periodo actual pero se listan grupos de todos los periodos.

**Causa raíz**

El filtro `&period=` solo se añadía si el parámetro venía en la URL; el valor por defecto `selected` no se usaba.

**Solución aplicada**

La consulta se construye a partir de `selected` (excluyendo "todos").

---

### BUG-07

- **Capa:** Seguridad/Auth
- **Archivo:** `src/proxy.ts:20`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Un estudiante puede abrir páginas como `/admin/usuarios` o `/docente/grupos/x` sin ser redirigido.

**Causa raíz**

El control de rol solo compara la ruta exacta (`pathname === p`) e ignora las subrutas.

**Solución aplicada**

Se compara también `pathname.startsWith(`${p}/`)`.

---

### BUG-08

- **Capa:** Contrato API
- **Archivo:** `src/app/(app)/estudiante/notas/page.tsx:39-41`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

El "Acumulado" del estudiante no coincide con el de la planilla del docente.

**Causa raíz**

Se calculaba un promedio aritmético simple que ignora el peso de cada evaluación.

**Solución aplicada**

Promedio ponderado: Σ(nota × peso) / Σpeso de las evaluaciones calificadas.

---

### BUG-09

- **Capa:** UI/Renderizado
- **Archivo:** `src/app/(app)/estudiante/notas/page.tsx:73`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Un 3.0 (nota aprobatoria) se pinta en rojo como reprobado.

**Causa raíz**

Usa `value <= PASSING`, inconsistente con la nota final (`<`).

**Solución aplicada**

Se cambió a `value < PASSING`.

---

### BUG-10

- **Capa:** UI/Renderizado
- **Archivo:** `src/lib/format.ts:25`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Las materias reprobadas aparecen como "Aprobada" en historial, notas y planilla.

**Causa raíz**

`STATUS_LABEL.reprobada` tenía el valor "Aprobada".

**Solución aplicada**

`reprobada: "Reprobada"`.

---

### BUG-11

- **Capa:** UI/Renderizado
- **Archivo:** `src/app/(app)/admin/page.tsx:23`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

"Docentes activos" muestra la cantidad de estudiantes.

**Causa raíz**

Error de copia y pega: usa `d.active.students`.

**Solución aplicada**

Se usa `d.active.teachers`.

---

### BUG-12

- **Capa:** Contrato API
- **Archivo:** `src/app/(app)/admin/page.tsx:58`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Los contadores de matrículas por estado salen siempre en 0.

**Causa raíz**

Se buscaba `enrollmentsByStatus` por la etiqueta ("Activas") y no por la clave del backend ("activa").

**Solución aplicada**

Se busca por `key`.

---

### BUG-13

- **Capa:** UI/Renderizado
- **Archivo:** `src/app/(app)/docente/grupos/page.tsx:52`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Las tarjetas muestran "30 / 12 estudiantes" (cupo y matriculados invertidos).

**Causa raíz**

El orden era `capacity / enrolled`, contrario a la vista de detalle.

**Solución aplicada**

`enrolled / capacity`.

---

### BUG-14

- **Capa:** UI/Renderizado
- **Archivo:** `src/app/(app)/estudiante/page.tsx:22`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

El saludo dice "Hola, undefined" con nombres de una sola palabra, o saluda por el apellido.

**Causa raíz**

`me.name.split(" ")[1]` toma la segunda palabra.

**Solución aplicada**

Se usa `[0]`, igual que en el inicio del docente.

---

### BUG-15

- **Capa:** Contrato API
- **Archivo:** `src/app/(app)/estudiante/page.tsx:16,31`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

"Materias matriculadas — activas este periodo" cuenta las matrículas históricas y las canceladas.

**Causa raíz**

Se usaba `meta.total` de `/enrollments/mine` sin filtrar por estado ni periodo.

**Solución aplicada**

Se cuentan solo las matrículas `activa` en periodos `abierto`.

---

### BUG-16

- **Capa:** UI/Renderizado
- **Archivo:** `src/app/(app)/estudiante/materias/page.tsx:22`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Los periodos se listan del más antiguo al más reciente.

**Causa raíz**

El orden era ascendente, aunque la especificación es "el más reciente primero".

**Solución aplicada**

Orden descendente (`b.localeCompare(a)`).

---

### BUG-17

- **Capa:** UI/Renderizado
- **Archivo:** `src/components/week-schedule.tsx:13-15`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Las clases del sábado aparecen en la columna del viernes y la del sábado queda vacía.

**Causa raíz**

`Math.min(DAYS.indexOf(d), 4)` forzaba el índice del sábado (5) al del viernes (4).

**Solución aplicada**

Cada columna usa directamente `byDay[day]`.

---

### BUG-18

- **Capa:** UI/Renderizado
- **Archivo:** `src/lib/format.ts:6`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

La columna del lunes dice "Lrrrrunes".

**Causa raíz**

Error tipográfico en `DAY_LABEL`.

**Solución aplicada**

`lunes: "Lunes"`.

---

### BUG-19

- **Capa:** Contrato API
- **Archivo:** `src/app/api/auth/login/route.ts:20-21`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Si el backend responde 2xx sin token, el login "tiene éxito" y navega a una ruta indefinida.

**Causa raíz**

Se reenviaba el estado 2xx del backend junto con un mensaje de error.

**Solución aplicada**

Responde 502 cuando `res.ok` llega sin `accessToken`.

---

### BUG-20

- **Capa:** Contrato API
- **Archivo:** `src/app/api/[...path]/route.ts:33`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Al cambiar la contraseña, si la respuesta no es JSON, el usuario ve un error 500 aunque el cambio se haya aplicado.

**Causa raíz**

`JSON.parse(text)` no tenía manejo de errores.

**Solución aplicada**

Se envolvió en try/catch: sin token nuevo, se responde `{ ok: true }`.

---

### BUG-21

- **Capa:** Hooks/Estado
- **Archivo:** `src/components/admin/resource-manager.tsx:85,297`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Al editar un usuario, Cancelar y la X no cierran el modal aunque no se haya cambiado nada.

**Causa raíz**

El indicador de cambios comparaba los valores del formulario con la fila cruda del backend (con `_id`, `createdAt`…), así que siempre detectaba cambios; además no había forma de descartar.

**Solución aplicada**

Se compara con `config.initial(row)` y, si de verdad hay cambios, se pide confirmación para descartarlos.

---

### BUG-22

- **Capa:** UI/Renderizado
- **Archivo:** `src/components/app-shell.tsx:83,106,112`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Los enlaces no activos del menú y los títulos de sección no se ven.

**Causa raíz**

Clases `text-white` sobre la barra lateral `bg-surface` (blanca).

**Solución aplicada**

Se usa `text-muted` (con `hover:text-ink`).

---

### BUG-23

- **Capa:** Seguridad/Auth
- **Archivo:** `src/lib/api.ts:31`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Con una contraseña incorrecta en el login aparece "Tu sesión venció"; equivocarse en la contraseña actual al cambiarla cierra la sesión.

**Causa raíz**

Todo 401 se trataba como sesión vencida, incluso en `/auth/*`, donde significa credenciales inválidas.

**Solución aplicada**

No se redirige ante un 401 de rutas `/auth/*`; se muestra el mensaje del backend. (El comportamiento exacto depende de que el backend responda 401.)

---

### BUG-24

- **Capa:** UI/Renderizado
- **Archivo:** `src/lib/format.ts:19-20`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Las fechas de inicio y fin de los periodos se muestran un día antes.

**Causa raíz**

`toLocaleDateString` sin `timeZone` convierte la medianoche UTC a la hora de Colombia (UTC-5) y cae en el día anterior.

**Solución aplicada**

Se añadió `timeZone: "UTC"`.

---

### BUG-25

- **Capa:** Contrato API
- **Archivo:** `src/components/admin/operations.tsx:328`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

La tabla de Matrículas puede romperse si `finalGrade` llega como `null`.

**Causa raíz**

Solo se comprobaba `!== undefined` antes de `.toFixed(1)`.

**Solución aplicada**

Se usa `grade()`, que acepta `null`/`undefined` y unifica el formato.

---

### BUG-26

- **Capa:** Contrato API
- **Archivo:** `.env.example:2`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Siguiendo el ejemplo, el frontend apunta a un puerto del backend distinto del documentado.

**Causa raíz**

`.env.example` indicaba 3005, mientras que el README y el valor por defecto del código usan 3000.

**Solución aplicada**

Se alineó a `http://localhost:3000`.

---

### BUG-27

- **Capa:** Seguridad/Auth
- **Archivo:** `src/lib/session.ts:32`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Los datos del token con tildes se corrompen ("josé" se lee como "josÃ©").

**Causa raíz**

`atob` devuelve bytes en latin-1 y no se decodificaban como UTF-8.

**Solución aplicada**

Se decodifican los bytes con `TextDecoder` (UTF-8).

---

### BUG-28

- **Capa:** Contrato API
- **Archivo:** `src/components/admin/resource-manager.tsx:103,309`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

A partir del registro 101 (estudiantes, materias, usuarios) no se pueden elegir en los selectores.

**Causa raíz**

Las listas de opciones solo pedían la primera página (`limit=100`).

**Solución aplicada**

Nueva función `fetchAll()` que recorre todas las páginas, usada por los selectores y las opciones dependientes.

---

### BUG-29

- **Capa:** Formulario
- **Archivo:** `src/components/admin/resource-manager.tsx:448-451`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Con varias franjas de horario, la etiqueta "Inicio" de la franja 2 enfoca la franja 1; los ids se repiten.

**Causa raíz**

Sin `id` explícito, `Field`/`Select` derivan el id de la etiqueta, lo que genera duplicados.

**Solución aplicada**

Ids únicos por franja (`slot-{i}-day/start/end/classroom`).

---

### BUG-30

- **Capa:** Hooks/Estado
- **Archivo:** `src/app/(app)/notificaciones/notification-list.tsx:47-55; src/components/app-shell.tsx:50-62`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

El contador del menú no se actualiza al marcar notificaciones como leídas (hasta 60 s) y los errores se ignoran en silencio.

**Causa raíz**

El contador vive en `AppShell` sin canal de actualización y había un `.catch(() => undefined)`.

**Solución aplicada**

Evento `NOTIFICATIONS_CHANGED` que recarga el contador, más un aviso de error visible.

---

### BUG-31

- **Capa:** Hooks/Estado
- **Archivo:** `src/components/admin/operations.tsx:380-384`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Al buscar destinatario de un aviso, pueden aparecer los resultados de una búsqueda anterior.

**Causa raíz**

Carrera entre peticiones: una respuesta vieja que llega tarde pisa a la actual.

**Solución aplicada**

Bandera `alive` en el efecto, que descarta respuestas obsoletas.

---

### BUG-32

- **Capa:** Formulario
- **Archivo:** `src/app/(app)/docente/grupos/[id]/grade-sheet-panel.tsx:57`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

Si el docente borra una nota ya guardada, el cambio se ignora sin avisar.

**Causa raíz**

Las celdas vacías se excluían de los cambios, así que no había validación ni mensaje.

**Solución aplicada**

Vaciar una nota guardada marca la celda como inválida y muestra un mensaje explicativo.

---

### BUG-33

- **Capa:** Formulario
- **Archivo:** `src/components/admin/configs.tsx:54,139`
- **Verificación:** ✅ PASS

**Descripción (síntoma visible)**

No se puede dejar en blanco el correo de una facultad ni el semestre de una materia.

**Causa raíz**

En edición, el vacío se enviaba como `undefined`, que desaparece del JSON, y el PATCH conservaba el valor anterior.

**Solución aplicada**

En modo edición se envía `null` (helper `clearable`). Pendiente confirmar contra el backend que acepta `null`.

---

### BUG-34

- **Capa:** Seguridad/Auth
- **Archivo:** `a.txt, s.txt`
- **Verificación:** ❌ FAIL

**Descripción (síntoma visible)**

Hay cookies con tokens JWT válidos (admin y estudiante) versionadas en el repositorio.

**Causa raíz**

Archivos cookie-jar de curl subidos por error al repositorio.

**Solución aplicada**

Se eliminaron con `git rm` y se añadieron patrones a `.gitignore`. PENDIENTE: siguen en el historial de git; hay que regenerar el secreto con el que se firman los JWT del backend y, si el repo es compartido, reescribir el historial.

---

## 4. Metodología

1. **Diagnóstico:** `run_typecheck` (TypeScript `tsc --noEmit`), `run_build_audit` (build de producción del bundler detectado) y `audit_dependencies` (imports vs. `package.json`).
2. **Inspección:** `read_frontend_file`, `search_component_usage` (contratos de props) y `audit_react_hooks_and_state` (análisis AST de Reglas de Hooks, dependencias de efectos y mutaciones de estado).
3. **Corrección:** `apply_code_fix` (escritura atómica), revisada con `git_diff_summary`; los parches fallidos se descartan con `revert_file_changes`.
4. **Verificación:** cada corrección se valida re-ejecutando `run_typecheck` y `run_build_audit`; el estado PASS/FAIL refleja ese resultado.

_Reporte generado automáticamente el 2026-10-05T17:34:24.351Z._
