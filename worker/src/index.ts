// Punto de entrada del Worker "kraken-envios".
//  /mcp/<MCP_SECRET>      → conector MCP para Claude
//  /agente/*              → API del agente de impresión de la laptop (header X-Agente-Token)
//  cron cada 2 minutos    → revisa guías en espera, las encola para imprimir y avisa al cliente
import { Env } from "./config";
import { servirMcp } from "./mcp";
import { sincronizarEnvio } from "./tools";
import * as db from "./store";

function igualSeguro(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

async function agente(req: Request, env: Env, ruta: string): Promise<Response> {
  if (!igualSeguro(req.headers.get("X-Agente-Token") || "", env.AGENT_TOKEN || "")) {
    return new Response("No autorizado", { status: 401 });
  }
  if (ruta === "/agente/siguiente" && req.method === "GET") {
    await db.latidoAgente(env, req.headers.get("X-Agente-Info") || "");
    const t = await db.siguienteTrabajo(env);
    return t ? Response.json(t) : new Response(null, { status: 204 });
  }
  const m = ruta.match(/^\/agente\/(hecho|fallo)\/(\d+)$/);
  if (m && req.method === "POST") {
    const id = Number(m[2]);
    if (m[1] === "hecho") await db.terminarTrabajo(env, id);
    else {
      const b: any = await req.json().catch(() => ({}));
      await db.fallarTrabajo(env, id, String(b?.error || "error desconocido"));
    }
    return Response.json({ ok: true });
  }
  return new Response("No encontrado", { status: 404 });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const ruta = url.pathname.replace(/\/+$/, "") || "/";
    if (ruta.startsWith("/mcp/")) {
      if (!env.MCP_SECRET || env.MCP_SECRET.length < 24 || !igualSeguro(ruta.slice(5), env.MCP_SECRET)) {
        return new Response("No encontrado", { status: 404 });
      }
      return servirMcp(req, env);
    }
    if (ruta.startsWith("/agente/")) return agente(req, env, ruta);
    if (ruta === "/") return new Response("Kraken · Envíos está funcionando.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return new Response("No encontrado", { status: 404 });
  },

  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      for (const r of await db.enEspera(env)) {
        try { await sincronizarEnvio(env, r); } catch (e) { console.log("sync", r.shipment_id, String(e)); }
      }
    })());
  },
};
