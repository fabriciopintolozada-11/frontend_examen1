// Sesion del usuario. El token JWT vive en una cookie httpOnly: el JavaScript del navegador nunca lo ve.
// Aqui solo se LEE el contenido del token (rol, correo, vencimiento); quien lo VALIDA de verdad es el backend.

export const COOKIE = "token";

export type Role = "admin" | "docente" | "estudiante";

export interface Session {
  id: string;
  email: string;
  role: Role;
  exp: number;
}

// Pagina de inicio de cada rol
export const HOME: Record<Role, string> = {
  admin: "/admin",
  docente: "/docente",
  estudiante: "/estudiante",
};

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Administrador",
  docente: "Docente",
  estudiante: "Estudiante",
};

export function decodeToken(token?: string | null): Session | null {
  if (!token) return null;
  try {
    const part = token.split(".")[1];
    // atob devuelve bytes sueltos: se decodifican como UTF-8 para no romper tildes y enes
    const bytes = Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const p = JSON.parse(json) as { sub: string; email: string; role: Role; exp: number };
    if (!p.sub || !p.role || p.exp * 1000 < Date.now()) return null;
    return { id: p.sub, email: p.email, role: p.role, exp: p.exp };
  } catch {
    return null;
  }
}
