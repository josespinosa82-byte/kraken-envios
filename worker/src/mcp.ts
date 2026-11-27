// Servidor MCP mínimo (Streamable HTTP, sin estado, respuestas JSON) para conectores personalizados de Claude.
import { Env } from "./config";
import { HERRAMIENTAS } from "./tools";

const VERSIONES = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INFO = { name: "kraken-envios", title: "Kraken · Envíos", version: "1.0.0" };
const INSTRUCCIONES =
  "Conector de envíos de Kraken: pedidos de kraken-sport.com (WooCommerce), guías de Mienvío e impresión en la Zebra ZD420. " +
  "Flujo: pedidos_pendientes → cotizar_envio → mostrar tarifa al usuario y esperar su sí → generar_guia(confirmado=true) → la etiqueta se imprime sola. " +
  "Generar una guía cobra saldo de la cartera de Mienvío: nunca la generes sin aprobación explícita del usuario en el chat.";

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

function ok(id: any, result: any) { return { jsonrpc: "2.0", id, result }; }
function err(id: any, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function manejar(env: Env, m: Rpc): Promise<any | null> {
  const id = m.id ?? null;
  switch (m.method) {
    case "initialize": {
      const pedida = m.params?.protocolVersion;
      return ok(id, {
        protocolVersion: VERSIONES.includes(pedida) ? pedida : VERSIONES[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: INFO,
        instructions: INSTRUCCIONES,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: HERRAMIENTAS.map(({ run, ...t }) => t),
      });
    case "tools/call": {
      const h = HERRAMIENTAS.find((t) => t.name === m.params?.name);
      if (!h) return err(id, -32602, `Herramienta desconocida: ${m.params?.name}`);
      try {
        const res = await h.run(env, m.params?.arguments || {});
        const isError = !!(res && typeof res === "object" && "error" in res);
        return ok(id, { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], structuredContent: res, isError });
      } catch (e: any) {
        return ok(id, { content: [{ type: "text", text: `Error: ${e?.message || e}` }], isError: true });
      }
    }
    default:
      if (m.id === undefined || m.id === null) return null; // notificación (p. ej. notifications/initialized)
      return err(id, -32601, `Método no soportado: ${m.method}`);
  }
}

export async function servirMcp(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") return new Response("Usa POST (MCP Streamable HTTP).", { status: 405, headers: { Allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response("Método no permitido", { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return Response.json(err(null, -32700, "JSON inválido"), { status: 400 }); }
  const lote = Array.isArray(body) ? body : [body];
  const respuestas = (await Promise.all(lote.map((m) => manejar(env, m)))).filter((r) => r !== null);
  if (respuestas.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? respuestas : respuestas[0]);
}
