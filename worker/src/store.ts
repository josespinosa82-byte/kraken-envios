// Estado en Cloudflare D1: envíos por pedido, guías en espera y cola de impresión.
import { Env } from "./config";

export interface RegistroEnvio {
  pedido_id: string;
  shipment_id: string;
  paqueteria?: string | null;
  costo?: number | string | null;
  guia?: string | null;
  rastreo_url?: string | null;
  etiqueta_url?: string | null;
  imprimir: boolean;
  impreso: boolean;
  nota_enviada: boolean;
  creado?: string;
}

export interface TrabajoImpresion {
  id: number;
  etiqueta_url: string;
  pedido_id: string | null;
  guia: string | null;
  creado: string;
  intentos: number;
  ultimo_error: string | null;
  estado: string;
}

function aRegistro(r: any): RegistroEnvio {
  return { ...r, imprimir: !!r.imprimir, impreso: !!r.impreso, nota_enviada: !!r.nota_enviada };
}

export async function guardarEnvio(env: Env, r: RegistroEnvio): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO envios (pedido_id, shipment_id, paqueteria, costo, guia, rastreo_url, etiqueta_url, imprimir, impreso, nota_enviada, creado, actualizado)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'), datetime('now'))
     ON CONFLICT(pedido_id) DO UPDATE SET shipment_id=?2, paqueteria=?3, costo=?4, guia=?5, rastreo_url=?6, etiqueta_url=?7,
       imprimir=?8, impreso=?9, nota_enviada=?10, actualizado=datetime('now')`,
  )
    .bind(
      String(r.pedido_id), String(r.shipment_id), r.paqueteria ?? null, r.costo == null ? null : String(r.costo),
      r.guia ?? null, r.rastreo_url ?? null, r.etiqueta_url ?? null, r.imprimir ? 1 : 0, r.impreso ? 1 : 0, r.nota_enviada ? 1 : 0,
    )
    .run();
}

export async function envioDePedido(env: Env, pedidoId: string | number): Promise<RegistroEnvio | null> {
  const r = await env.DB.prepare("SELECT * FROM envios WHERE pedido_id = ?1").bind(String(pedidoId)).first();
  return r ? aRegistro(r) : null;
}

export async function envioPorShipment(env: Env, shipmentId: string | number): Promise<RegistroEnvio | null> {
  const r = await env.DB.prepare("SELECT * FROM envios WHERE shipment_id = ?1").bind(String(shipmentId)).first();
  return r ? aRegistro(r) : null;
}

/** Envíos pagados cuya guía todavía no llega (Mienvío la genera en un proceso aparte). */
export async function enEspera(env: Env): Promise<RegistroEnvio[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM envios WHERE (etiqueta_url IS NULL OR guia IS NULL OR (nota_enviada = 0))
       AND creado > datetime('now', '-3 days') LIMIT 25`,
  ).all();
  return (results || []).map(aRegistro);
}

export async function encolarImpresion(env: Env, etiquetaUrl: string, pedidoId?: string | null, guia?: string | null): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO impresiones (etiqueta_url, pedido_id, guia, creado, intentos, estado) VALUES (?1, ?2, ?3, datetime('now'), 0, 'pendiente')",
  ).bind(etiquetaUrl, pedidoId ?? null, guia ?? null).run();
  return Number(r.meta.last_row_id);
}

export async function colaImpresion(env: Env): Promise<TrabajoImpresion[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM impresiones WHERE estado = 'pendiente' OR (estado = 'fallo' AND creado > datetime('now','-2 days')) ORDER BY id LIMIT 20",
  ).all();
  return (results || []) as unknown as TrabajoImpresion[];
}

export async function siguienteTrabajo(env: Env): Promise<TrabajoImpresion | null> {
  const r = await env.DB.prepare("SELECT * FROM impresiones WHERE estado = 'pendiente' ORDER BY id LIMIT 1").first();
  return (r as unknown as TrabajoImpresion) || null;
}

export async function terminarTrabajo(env: Env, id: number): Promise<void> {
  const t = await env.DB.prepare("SELECT pedido_id FROM impresiones WHERE id = ?1").bind(id).first<{ pedido_id: string | null }>();
  await env.DB.prepare("UPDATE impresiones SET estado = 'hecho', ultimo_error = NULL WHERE id = ?1").bind(id).run();
  if (t?.pedido_id) await env.DB.prepare("UPDATE envios SET impreso = 1, actualizado = datetime('now') WHERE pedido_id = ?1").bind(t.pedido_id).run();
}

export async function fallarTrabajo(env: Env, id: number, error: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE impresiones SET intentos = intentos + 1, ultimo_error = ?2,
       estado = CASE WHEN intentos + 1 >= 5 THEN 'fallo' ELSE 'pendiente' END WHERE id = ?1`,
  ).bind(id, error.slice(0, 300)).run();
}

export async function latidoAgente(env: Env, info: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO meta (clave, valor) VALUES ('agente', ?1) ON CONFLICT(clave) DO UPDATE SET valor = ?1",
  ).bind(JSON.stringify({ hora: new Date().toISOString(), info: info.slice(0, 200) })).run();
}

export async function ultimoLatido(env: Env): Promise<{ hora: string; info: string } | null> {
  const r = await env.DB.prepare("SELECT valor FROM meta WHERE clave = 'agente'").first<{ valor: string }>();
  return r ? JSON.parse(r.valor) : null;
}
