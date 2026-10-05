import { NextRequest, NextResponse } from "next/server";
import { BACKEND_URL } from "@/lib/server";
import { COOKIE, decodeToken } from "@/lib/session";

// Reenvia cualquier /api/... al backend agregando el token de la cookie.
// Asi el navegador nunca ve el token y no hace falta CORS en el backend.
async function forward(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = `${BACKEND_URL}/api/${path.join("/")}${request.nextUrl.search}`;
  const token = request.cookies.get(COOKIE)?.value;
  const hasBody = !["GET", "HEAD"].includes(request.method);

  let res: Response;
  try {
    res = await fetch(target, {
      method: request.method,
      headers: {
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: hasBody ? await request.text() : undefined,
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ message: "No se pudo conectar con el servidor" }, { status: 502 });
  }

  const text = await res.text();
  const type = res.headers.get("content-type") ?? "application/json";

  // Al cambiar la contrasena el backend entrega un token nuevo (el anterior queda invalido): se reemplaza la cookie
  if (path.join("/") === "auth/change-password" && res.ok) {
    let fresh: string | undefined;
    try {
      fresh = JSON.parse(text)?.accessToken;
    } catch {
      fresh = undefined; // respuesta sin JSON: la contrasena ya cambio, solo no hay token nuevo que guardar
    }
    const session = decodeToken(fresh);
    const response = NextResponse.json({ ok: true });
    if (fresh && session) {
      response.cookies.set(COOKIE, fresh, {
        httpOnly: true,
        sameSite: "lax",
        secure: request.nextUrl.protocol === "https:",
        path: "/",
        expires: new Date(session.exp * 1000),
      });
    }
    return response;
  }

  return new NextResponse(text, { status: res.status, headers: { "Content-Type": type } });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
