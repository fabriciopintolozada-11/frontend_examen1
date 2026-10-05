# Bugs corregidos — Frontend

Registro de los **30 bugs del frontend** encontrados y corregidos en `frontend_examen1` (rama `fabri`).
Los bugs del backend y de la base de datos están en `backend_examen1/docs/BUGS.md`.

Cada bug indica **dónde estaba**, **qué se corrigió** y **cómo comprobarlo** en el sistema.

## Cómo levantar el sistema para probar

Primero el backend y la base de datos (ver `backend_examen1/docs/BUGS.md`). Luego:

```powershell
# frontend_examen1
copy .env.example .env.local   # BACKEND_URL=http://localhost:3000
npm install
npm run dev                    # http://localhost:3001
```

Usuarios de prueba (clave `Secret123!`):

| Rol | Email |
|---|---|
| Administrador | `admin@universidad.edu` |
| Docente (Laura) | `laura.lopez89@universidad.edu` |
| Estudiante (Juliana) | `juliana.herrera147@universidad.edu` |

---

## Configuración, sesión y navegación

| # | Archivo corregido | Bug | Corrección | Cómo verlo |
|---|---|---|---|---|
| F1 | [.env.example:2](../.env.example#L2) | `BACKEND_URL` apuntaba al puerto 3005, donde no hay nada | `http://localhost:3000` | El login funciona |
| F2 | [src/proxy.ts:20](../src/proxy.ts#L20) | Solo se protegía la ruta exacta (`/admin`): una estudiante podía abrir `/admin/usuarios` | También se protegen las subrutas (`/admin/…`) | Juliana → escribir `/admin/usuarios` en la URL: vuelve a `/estudiante` |
| F3 | [src/components/app-shell.tsx:83](../src/components/app-shell.tsx#L83) | Enlaces y títulos del menú en `text-white` sobre fondo blanco: el menú era invisible y el botón de **cerrar sesión** quedaba oculto abajo | `text-muted` en enlaces y títulos de sección | Cualquier rol: el menú se ve y "Cerrar sesión" (abajo a la izquierda) lleva al login |
| F4 | `a.txt`, `s.txt` (eliminados) | Archivos con cookies y **tokens JWT reales** subidos al repositorio | Se eliminaron del repo | Ya no aparecen en la raíz del proyecto |

## Panel del administrador

| # | Archivo corregido | Bug | Corrección | Cómo verlo |
|---|---|---|---|---|
| F5 | [src/app/(app)/admin/page.tsx:23](../src/app/(app)/admin/page.tsx#L23) | "Docentes activos" mostraba el número de estudiantes | Usa `d.active.teachers` | Admin → Inicio: Docentes activos 99 (distinto de Estudiantes) |
| F6 | [src/app/(app)/admin/page.tsx:58](../src/app/(app)/admin/page.tsx#L58) | Leía `enrollmentsByStatus[label]` ("Activas") en vez de `[key]` ("activa"): siempre 0 | Usa la clave | Admin → Inicio → Periodo abierto: Activas 48 |
| F23 | [src/components/admin/resource-manager.tsx:115](../src/components/admin/resource-manager.tsx#L115) | Los filtros solo se enviaban en la página 1: al pasar de página se perdían | Se envían en todas las páginas | Admin → Matrículas → filtrar por estado → Siguiente |
| F24 | [src/components/admin/resource-manager.tsx:297](../src/components/admin/resource-manager.tsx#L297) | Comparaba el formulario con la fila cruda: siempre "con cambios", y el modal "Editar usuario" no se podía cerrar | Compara con `config.initial(row)` | Admin → Usuarios → Editar → Cancelar o X cierran el modal |
| F25 | [src/components/admin/operations.tsx:336](../src/components/admin/operations.tsx#L336) | Al matricular enviaba `group` en vez de `groupId`: el backend respondía 400 | Envía `groupId` | Admin → Matrículas → Matricular estudiante |
| F26 | [src/components/admin/operations.tsx:346](../src/components/admin/operations.tsx#L346) | Cancelar una matrícula usaba `PATCH`; el backend espera `POST` (404) | `POST` | Admin → Matrículas → icono de cancelar en una matrícula en curso |
| F27 | [src/components/admin/resource-manager.tsx:187](../src/components/admin/resource-manager.tsx#L187) | Tabla con ancho mínimo de 40rem sin scroll: en pantallas angostas desbordaba la página | Contenedor con `overflow-x-auto` | Admin → cualquier tabla en ventana angosta: se desliza dentro de la tarjeta |

## Docente

| # | Archivo corregido | Bug | Corrección | Cómo verlo |
|---|---|---|---|---|
| F8 | [evaluations-panel.tsx:44](../src/app/(app)/docente/grupos/[id]/evaluations-panel.tsx#L44) | `remaining = total - 100` (invertido): decía "Te pasaste" cuando faltaba porcentaje | `100 - total` | Laura → grupo → Evaluaciones con menos de 100%: "Faltan X%" |
| F9 | [grade-sheet-panel.tsx:19](../src/app/(app)/docente/grupos/[id]/grade-sheet-panel.tsx#L19) | No aceptaba coma decimal (`4,5`), aunque el comentario y la ayuda decían que sí | Convierte la coma en punto antes de validar | Laura → grupo → Notas → escribir `4,5`: se acepta |
| F10 | [src/app/(app)/docente/grupos/page.tsx:52](../src/app/(app)/docente/grupos/page.tsx#L52) | Mostraba `capacidad / inscritos` (invertido) | `inscritos / capacidad` | Laura → Mis grupos: "9 / 32 estudiantes" |
| F30 | [src/app/(app)/docente/grupos/page.tsx:21](../src/app/(app)/docente/grupos/page.tsx#L21) | Sin periodo en la URL, el selector mostraba el periodo abierto pero se listaban los grupos de **todos** los periodos | Filtra por el periodo seleccionado (por defecto, el abierto) | Laura → Mis grupos: 1 grupo (2026-2); con "Todos los periodos", 2 |

## Estudiante

| # | Archivo corregido | Bug | Corrección | Cómo verlo |
|---|---|---|---|---|
| F11 | [cancel-button.tsx:19](../src/app/(app)/estudiante/materias/cancel-button.tsx#L19) | Cancelar usaba `PATCH`; el backend espera `POST` (404) | `POST` | Juliana → Mis materias → Cancelar → Sí, cancelar |
| F12 | [cancel-button.tsx:23](../src/app/(app)/estudiante/materias/cancel-button.tsx#L23) | Después de cancelar no se refrescaba la lista: la materia seguía "En curso" | `router.refresh()` | Al cancelar, la tarjeta pasa a "Cancelada" sin recargar |
| F13 | [enroll-view.tsx:50](../src/app/(app)/estudiante/matricula/enroll-view.tsx#L50) | Enviaba `{ group }` en vez de `{ groupId }`: el backend respondía 400 | Envía `groupId` | Juliana → Matricular → Matricular: "Quedaste matriculado…" |
| F14 | [src/app/(app)/estudiante/materias/page.tsx:22](../src/app/(app)/estudiante/materias/page.tsx#L22) | Periodos ordenados del más viejo al más nuevo (el comentario dice "el más reciente primero") | Orden descendente | Juliana → Mis materias: 2026-2 arriba |
| F15 | [src/app/(app)/estudiante/notas/page.tsx:40](../src/app/(app)/estudiante/notas/page.tsx#L40) | El "Acumulado" era un promedio simple, sin ponderar por el peso de cada evaluación | Suma `nota × peso / 100` (igual que la planilla del docente) | Juliana → Notas → ODON105: Acumulado 2.15 |
| F16 | [src/app/(app)/estudiante/notas/page.tsx:73](../src/app/(app)/estudiante/notas/page.tsx#L73) | `nota <= 3.0` se pintaba en rojo, aunque con 3.0 se aprueba | `< 3.0` | Juliana → Notas: las notas de 3.x en verde |
| F17 | [src/app/(app)/estudiante/page.tsx:22](../src/app/(app)/estudiante/page.tsx#L22) | El saludo usaba `split(" ")[1]` (el apellido) | `[0]` | Juliana → Inicio: "Hola, Juliana" |
| F18 | [src/app/(app)/estudiante/page.tsx:16](../src/app/(app)/estudiante/page.tsx#L16) | "Materias matriculadas" contaba todas las matrículas (incluidas canceladas y de otros periodos) | Filtra `status=activa` | Juliana → Inicio: Materias matriculadas 2 |

## Formato y componentes compartidos

| # | Archivo corregido | Bug | Corrección | Cómo verlo |
|---|---|---|---|---|
| F7 | [src/app/(app)/cuenta/account-forms.tsx:81](../src/app/(app)/cuenta/account-forms.tsx#L81) | `dirty` nunca pasaba a `true`: "Guardar nombre" siempre estaba deshabilitado | Se marca `dirty` al escribir | Mi cuenta → cambiar el nombre: el botón se activa y guarda |
| F19 | [src/lib/format.ts:6](../src/lib/format.ts#L6) | El lunes decía `"Lrrrrunes"` | `"Lunes"` | Horario (estudiante o docente): columna "Lunes" |
| F20 | [src/lib/format.ts:17](../src/lib/format.ts#L17) | `grade()` truncaba con `Math.floor`: 2.96 se mostraba 2.9 (reprobado a la vista) | `Math.round` | Pantallas de notas: 2.96 se muestra 3.0 |
| F21 | [src/lib/format.ts:26](../src/lib/format.ts#L26) | El estado `reprobada` se mostraba como "Aprobada" | `"Reprobada"` | Admin → Matrículas → filtrar Reprobada; Juliana → Historial |
| F22 | [src/components/week-schedule.tsx:15](../src/components/week-schedule.tsx#L15) | Las clases del sábado se mostraban en la columna del viernes | Cada día en su propia columna | Horario de un grupo con clase el sábado |
| F28 | [notification-list.tsx:94](../src/app/(app)/notificaciones/notification-list.tsx#L94) | Una notificación de tipo desconocido rompía toda la página (`TYPE[n.type]` undefined) | Usa el tipo "Aviso" como respaldo | Notificaciones carga aunque llegue un tipo nuevo |
| F29 | [src/lib/format.ts:21](../src/lib/format.ts#L21) | `date()` sin zona horaria: las fechas guardadas a medianoche UTC se mostraban un día antes en Colombia (2 feb → 1 feb) | `timeZone: "UTC"` | Admin → Periodos: 2026-2 inicia el 3 de ago (igual que en la base) |

---

## Verificación realizada

- `npx tsc --noEmit` y `npx eslint src`: sin errores.
- Recorrido en navegador (Chrome) de las 18 pantallas de los tres roles: sin errores de consola ni respuestas 5xx, y el cierre de sesión funciona en los tres.
