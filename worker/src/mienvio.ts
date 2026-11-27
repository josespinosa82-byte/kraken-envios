// Cliente de la API v2 de Mienvío.
// Documentación: https://api.mienvio.mx/reference
import { Env, Direccion, Paquete, mienvioBase } from "./config";

async function me(env: Env, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${mienvioBase(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.MIENVIO_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === "object" && body ? (body.message || JSON.stringify(body)) : String(body);
    throw new Error(`Mienvío ${res.status}: ${String(msg).slice(0, 400)}`);
  }
  return body;
}

export interface Tarifa {
  rate_id: string;
  paqueteria: string;
  servicio: string;
  dias: number | string | null;
  precio: number | null;
  moneda: string;
  ocurre: boolean;
}

function precioDe(r: any): number | null {
  // Mienvío manda el precio en amount.total (la documentación dice pricing.total); se aceptan ambos.
  const p = r?.pricing?.total ?? r?.amount?.total ?? r?.pricing?.amount ?? r?.amount;
  const n = typeof p === "string" ? parseFloat(p) : p;
  return typeof n === "number" && isFinite(n) ? n : null;
}

/** POST /shipments/rates — devuelve las tarifas ordenadas de la más barata a la más cara. */
export async function cotizar(env: Env, from: Direccion, to: Direccion, paquete: Paquete): Promise<Tarifa[]> {
  const { description, fiscal_code, package_type, ...dims } = paquete;
  const body = { packing_mode: "none", from_address: from, to_address: to, package: dims };
  const r = await me(env, "/shipments/rates", { method: "POST", body: JSON.stringify(body) });
  const paquetes: any[] = Array.isArray(r?.data) ? r.data : [];
  const tarifas: Tarifa[] = [];
  for (const pq of paquetes) {
    for (const t of pq.rates || []) {
      tarifas.push({
        rate_id: String(t.rate_id),
        paqueteria: t.provider,
        servicio: t.service_name,
        dias: t.days ?? t.duration_terms ?? null,
        precio: precioDe(t),
        moneda: t.currency || "MXN",
        ocurre: !!t.is_ocurre,
      });
    }
  }
  tarifas.sort((a, b) => (a.precio ?? 1e9) - (b.precio ?? 1e9));
  return tarifas;
}

/** POST /shipments — crea y PAGA la guía con el saldo de la cartera de Mienvío. */
export async function crearYPagar(
  env: Env,
  from: Direccion,
  to: Direccion,
  paquete: Paquete,
  rateId: string,
  opciones: { seguro: boolean; pedidoExterno?: string },
): Promise<any> {
  const pkg: any = { ...paquete };
  if (opciones.pedidoExterno) pkg.external_order_id = opciones.pedidoExterno;
  const body = {
    payment_method: "wallet",
    shipments: [
      {
        packing_mode: "none",
        from_address: from,
        to_address: to,
        package: pkg,
        service: { rate_id: rateId, insurance: opciones.seguro },
      },
    ],
  };
  return me(env, "/shipments", { method: "POST", body: JSON.stringify(body) });
}

/** GET /shipments/{id} — detalles, incluida la etiqueta y el rastreo. */
export async function detalle(env: Env, shipmentId: string | number): Promise<any> {
  const r = await me(env, `/shipments/${encodeURIComponent(String(shipmentId))}`);
  return r?.data ?? r;
}

/** Extrae lo importante de un envío (de la compra o del detalle). */
export function datosEnvio(s: any) {
  const label = s?.label || {};
  return {
    shipment_id: s?.shipment_id ?? null,
    estado: s?.type ?? null,
    paqueteria: s?.rate?.provider ?? null,
    servicio: s?.rate?.service_name ?? s?.rate?.service ?? null,
    costo: precioDe(s),
    guia: label.tracking_number ?? s?.tracking_number ?? null,
    rastreo_url: label.mienvio_tracking_url ?? s?.mienvio_tracking_url ?? null,
    etiqueta_url: label.label_url ?? s?.label_url ?? null,
  };
}
