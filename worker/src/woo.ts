// Cliente mínimo de la API REST de WooCommerce (v3).
import { Env, Direccion, corta, telefono10 } from "./config";

function auth(env: Env): string {
  return "Basic " + btoa(`${env.WOO_KEY}:${env.WOO_SECRET}`);
}

async function woo(env: Env, path: string, init: RequestInit = {}): Promise<any> {
  const base = (env.WOO_URL || "").trim().replace(/\/+$/, "");
  // Nunca mostrar el valor en errores: si alguien pegó una clave aquí por error, no debe filtrarse.
  if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(base)) {
    throw new Error("El secreto WOO_URL no es una dirección válida. Debe ser exactamente https://kraken-sport.com");
  }
  const url = `${base}/wp-json/wc/v3${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: auth(env), "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WooCommerce ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export async function listarPedidos(env: Env, estado: string, limite: number): Promise<any[]> {
  const qs = new URLSearchParams({ status: estado, per_page: String(Math.min(Math.max(limite, 1), 50)), orderby: "date", order: "desc" });
  return woo(env, `/orders?${qs}`);
}

export async function obtenerPedido(env: Env, id: number | string): Promise<any> {
  return woo(env, `/orders/${encodeURIComponent(String(id))}`);
}

export async function agregarNota(env: Env, id: number | string, nota: string, alCliente: boolean): Promise<void> {
  await woo(env, `/orders/${encodeURIComponent(String(id))}/notes`, {
    method: "POST",
    body: JSON.stringify({ note: nota, customer_note: alCliente }),
  });
}

/** Resumen corto de un pedido para mostrar en el chat. */
export function resumenPedido(p: any) {
  const s = p.shipping || {};
  const b = p.billing || {};
  return {
    pedido_id: p.id,
    numero: p.number,
    estado: p.status,
    fecha: p.date_created,
    total: `${p.total} ${p.currency}`,
    cliente: `${s.first_name || b.first_name || ""} ${s.last_name || b.last_name || ""}`.trim(),
    telefono: s.phone || b.phone || "",
    email: b.email || "",
    destino: [s.address_1, s.address_2, s.city, s.state, s.postcode].filter(Boolean).join(", "),
    productos: (p.line_items || []).map((li: any) => `${li.quantity} × ${li.name}`),
    nota_cliente: p.customer_note || "",
  };
}

/** Convierte la dirección de envío de WooCommerce al formato de Mienvío y avisa qué se recortó. */
export function direccionDestino(p: any): { direccion: Direccion; avisos: string[] } {
  const s = p.shipping || {};
  const b = p.billing || {};
  const avisos: string[] = [];
  const nombre = `${s.first_name || b.first_name || ""} ${s.last_name || b.last_name || ""}`.trim();
  const calle = s.address_1 || b.address_1 || "";
  const colonia = s.address_2 || b.address_2 || "";
  // Si la calle pasa de 35 caracteres, se corta en un espacio y el resto se va a "referencias".
  let calleCorta = corta(calle, 35);
  let resto = "";
  const limpia = corta(calle, 200);
  if (limpia.length > 35) {
    const corte = limpia.lastIndexOf(" ", 35);
    calleCorta = limpia.slice(0, corte > 15 ? corte : 35).trim();
    resto = limpia.slice(calleCorta.length).trim();
    avisos.push(`La calle es larga: "${calleCorta}" y el resto ("${resto}") va en referencias.`);
  }
  if (!colonia) avisos.push("El pedido no trae colonia (address_2); revisa la dirección antes de generar la guía.");
  const cp = (s.postcode || b.postcode || "").replace(/\D/g, "");
  if (cp.length !== 5) avisos.push(`Código postal sospechoso: "${s.postcode || b.postcode || ""}"`);
  const tel = telefono10(s.phone || b.phone);
  if (tel.length !== 10) avisos.push("El teléfono no tiene 10 dígitos.");
  return {
    direccion: {
      name: corta(nombre, 35),
      street: calleCorta,
      street2: corta(colonia || "-", 35),
      reference: corta([resto, p.customer_note || s.company || ""].filter(Boolean).join(" · "), 35) || undefined,
      city_municipality: corta(s.city || b.city, 30),
      zipcode: cp.slice(0, 5),
      country: (s.country || b.country || "MX").slice(0, 2),
      phone: tel,
      email: corta(b.email, 50),
    },
    avisos,
  };
}
