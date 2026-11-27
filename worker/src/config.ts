// Configuración y tipos compartidos del conector de envíos de Kraken.

export interface Env {
  DB: D1Database;
  // Secretos (se configuran en Cloudflare, nunca en el código)
  MIENVIO_TOKEN: string;          // Token Bearer de la API de Mienvío
  WOO_URL: string;                // p. ej. https://kraken-sport.com
  WOO_KEY: string;                // Consumer key de WooCommerce (ck_...)
  WOO_SECRET: string;             // Consumer secret de WooCommerce (cs_...)
  MCP_SECRET: string;             // Parte secreta de la URL del conector: /mcp/<MCP_SECRET>
  AGENT_TOKEN: string;            // Token del agente de impresión de la laptop
  // Variables normales (wrangler.toml)
  MIENVIO_BASE?: string;          // producción o sandbox
  ORIGEN_JSON?: string;           // dirección de origen (JSON)
  PAQUETE_JSON?: string;          // caja estándar del Kraken Kit (JSON)
  NOTA_RASTREO_CLIENTE?: string;  // "si" para mandar el rastreo al cliente como nota del pedido
}

export interface Direccion {
  name: string;
  street: string;
  street2: string;
  reference?: string;
  city_municipality: string;
  zipcode: string;
  country: string;
  phone?: string;
  email?: string;
}

export interface Paquete {
  weight: number;
  length: number;
  width: number;
  height: number;
  declared_value?: number;
  description?: string;
  fiscal_code?: string;
  package_type?: string;
}

export function mienvioBase(env: Env): string {
  return (env.MIENVIO_BASE || "https://production.mienvio.mx/api/v2").replace(/\/+$/, "");
}

export function origen(env: Env): Direccion {
  if (!env.ORIGEN_JSON) throw new Error("Falta el secreto ORIGEN_JSON (dirección de origen) en Cloudflare");
  return JSON.parse(env.ORIGEN_JSON) as Direccion;
}

export function paqueteEstandar(env: Env): Paquete {
  if (!env.PAQUETE_JSON) throw new Error("Falta configurar PAQUETE_JSON (caja estándar) en wrangler.toml");
  const p = JSON.parse(env.PAQUETE_JSON) as Paquete;
  for (const k of ["weight", "length", "width", "height"] as const) {
    if (!(Number(p[k]) >= 1)) throw new Error(`PAQUETE_JSON: falta la medida "${k}" de la caja (mínimo 1).`);
  }
  return p;
}

/** Valida los campos que Mienvío exige solo al pagar la guía. */
export function validarParaCompra(p: Paquete, o: Direccion): void {
  const faltan: string[] = [];
  for (const k of ["description", "package_type"] as const) {
    if (!p[k] || String(p[k]).includes("REVISAR")) faltan.push(`PAQUETE_JSON.${k}`);
  }
  if (!/^\d{8}$/.test(String(p.fiscal_code || ""))) faltan.push("PAQUETE_JSON.fiscal_code (clave SAT de 8 dígitos)");
  if (!o.email) delete o.email;
  if (faltan.length) throw new Error(`Configura antes de generar guías: ${faltan.join(", ")}`);
}

/** Recorta a la longitud máxima que acepta Mienvío. */
export function corta(s: string | undefined | null, max: number): string {
  return (s || "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Deja solo los últimos 10 dígitos del teléfono (formato MX). */
export function telefono10(s: string | undefined | null): string {
  const d = (s || "").replace(/\D/g, "");
  return d.slice(-10);
}
