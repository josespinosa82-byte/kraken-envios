// Herramientas que Claude ve en el conector "Kraken · Envíos".
import { Env, origen, paqueteEstandar, validarParaCompra } from "./config";
import * as woo from "./woo";
import * as me from "./mienvio";
import * as db from "./store";

export interface Herramienta {
  name: string;
  title: string;
  description: string;
  inputSchema: any;
  annotations?: any;
  run: (env: Env, args: any) => Promise<any>;
}

/** Revisa en Mienvío si la guía de un envío ya está lista; si sí, la guarda, la encola para imprimir y avisa en WooCommerce. */
export async function sincronizarEnvio(env: Env, r: db.RegistroEnvio): Promise<db.RegistroEnvio> {
  if (!r.etiqueta_url || !r.guia) {
    const d = me.datosEnvio(await me.detalle(env, r.shipment_id));
    r.guia = d.guia ?? r.guia;
    r.rastreo_url = d.rastreo_url ?? r.rastreo_url;
    r.etiqueta_url = d.etiqueta_url ?? r.etiqueta_url;
    r.paqueteria = d.paqueteria ?? r.paqueteria;
    r.costo = d.costo ?? r.costo;
  }
  if (r.etiqueta_url && r.imprimir && !r.impreso) {
    await db.encolarImpresion(env, r.etiqueta_url, r.pedido_id, r.guia);
    r.imprimir = false; // ya quedó en la cola; no volver a encolar
  }
  if (r.guia && !r.nota_enviada) {
    const alCliente = (env.NOTA_RASTREO_CLIENTE || "si").toLowerCase() === "si";
    const nota = `Tu pedido va en camino con ${r.paqueteria || "la paquetería"}. Guía: ${r.guia}` +
      (r.rastreo_url ? `\nRastreo: ${r.rastreo_url}` : "");
    try {
      await woo.agregarNota(env, r.pedido_id, nota, alCliente);
      r.nota_enviada = true;
    } catch { /* se reintenta en la siguiente pasada */ }
  }
  await db.guardarEnvio(env, r);
  return r;
}

const pedidoId = { type: "integer", description: "ID del pedido en WooCommerce (kraken-sport.com)" };

export const HERRAMIENTAS: Herramienta[] = [
  {
    name: "pedidos_pendientes",
    title: "Pedidos pendientes de envío",
    description:
      "Lista los pedidos de la tienda kraken-sport.com (WooCommerce). Por defecto los que están 'processing' (pagados, por enviar). " +
      "Indica si cada pedido ya tiene guía generada.",
    inputSchema: {
      type: "object",
      properties: {
        estado: { type: "string", description: "Estado de WooCommerce: processing, on-hold, completed, any…", default: "processing" },
        limite: { type: "integer", default: 20, minimum: 1, maximum: 50 },
      },
    },
    annotations: { readOnlyHint: true },
    run: async (env, a) => {
      const pedidos = await woo.listarPedidos(env, a.estado || "processing", a.limite || 20);
      const out = [];
      for (const p of pedidos) {
        const e = await db.envioDePedido(env, p.id);
        out.push({ ...woo.resumenPedido(p), guia_kraken: e ? { guia: e.guia, paqueteria: e.paqueteria, impreso: e.impreso } : null });
      }
      return { total: out.length, pedidos: out };
    },
  },
  {
    name: "ver_pedido",
    title: "Ver pedido",
    description: "Muestra un pedido con su dirección de envío tal como se mandaría a Mienvío, avisos de la dirección y la guía si ya existe.",
    inputSchema: { type: "object", properties: { pedido_id: pedidoId }, required: ["pedido_id"] },
    annotations: { readOnlyHint: true },
    run: async (env, a) => {
      const p = await woo.obtenerPedido(env, a.pedido_id);
      const { direccion, avisos } = woo.direccionDestino(p);
      return { pedido: woo.resumenPedido(p), direccion_mienvio: direccion, avisos, envio: await db.envioDePedido(env, a.pedido_id) };
    },
  },
  {
    name: "cotizar_envio",
    title: "Cotizar envío",
    description:
      "Cotiza en Mienvío el envío de un pedido con la caja estándar del Kraken Kit (configurable). Devuelve las tarifas de la más barata a la más cara, " +
      "con rate_id, paquetería, días y precio. No cobra nada.",
    inputSchema: {
      type: "object",
      properties: {
        pedido_id: pedidoId,
        peso_kg: { type: "number", description: "Opcional: peso distinto al de la caja estándar" },
      },
      required: ["pedido_id"],
    },
    annotations: { readOnlyHint: true },
    run: async (env, a) => {
      const p = await woo.obtenerPedido(env, a.pedido_id);
      const { direccion, avisos } = woo.direccionDestino(p);
      const pkg = paqueteEstandar(env);
      if (a.peso_kg) pkg.weight = a.peso_kg;
      const tarifas = await me.cotizar(env, origen(env), direccion, pkg);
      return { pedido: woo.resumenPedido(p), destino: direccion, avisos, paquete: pkg, tarifas };
    },
  },
  {
    name: "generar_guia",
    title: "Generar guía (cobra saldo de Mienvío)",
    description:
      "CREA Y PAGA una guía en Mienvío con el saldo de la cartera. ANTES de llamarla con confirmado=true, muestra al usuario paquetería, servicio, " +
      "precio y destino (de cotizar_envio) y espera a que diga que sí. Rechaza pedidos que ya tienen guía salvo forzar=true. " +
      "La guía y la etiqueta llegan unos segundos o minutos después; con imprimir=true se mandan solas a la Zebra cuando estén listas.",
    inputSchema: {
      type: "object",
      properties: {
        pedido_id: pedidoId,
        rate_id: { type: "string", description: "rate_id elegido de cotizar_envio" },
        confirmado: { type: "boolean", description: "true solo después de que el usuario aprobó el precio en el chat" },
        seguro: { type: "boolean", default: false },
        imprimir: { type: "boolean", default: true, description: "Mandar la etiqueta a la Zebra automáticamente" },
        peso_kg: { type: "number", description: "Opcional: mismo peso usado al cotizar" },
        forzar: { type: "boolean", default: false, description: "Generar otra guía aunque el pedido ya tenga una" },
      },
      required: ["pedido_id", "rate_id", "confirmado"],
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (env, a) => {
      if (a.confirmado !== true) {
        return { error: "No se generó la guía: falta la aprobación del usuario. Muéstrale la tarifa y vuelve a llamar con confirmado=true." };
      }
      const previa = await db.envioDePedido(env, a.pedido_id);
      if (previa && !a.forzar) {
        return { error: "Este pedido ya tiene una guía. No se cobró nada.", envio: previa };
      }
      const p = await woo.obtenerPedido(env, a.pedido_id);
      const { direccion } = woo.direccionDestino(p);
      const pkg = paqueteEstandar(env);
      if (a.peso_kg) pkg.weight = a.peso_kg;
      const from = origen(env);
      validarParaCompra(pkg, from);
      const compra = await me.crearYPagar(env, from, direccion, pkg, String(a.rate_id), {
        seguro: !!a.seguro,
        pedidoExterno: String(p.number || p.id),
      });
      const s = compra?.data?.shipments?.[0];
      if (!s?.shipment_id) return { error: "Mienvío no devolvió el envío creado", respuesta: compra };
      const d = me.datosEnvio(s);
      let r: db.RegistroEnvio = {
        pedido_id: String(a.pedido_id),
        shipment_id: String(d.shipment_id),
        paqueteria: d.paqueteria,
        costo: d.costo ?? compra?.data?.amount ?? null,
        guia: d.guia,
        rastreo_url: d.rastreo_url,
        etiqueta_url: d.etiqueta_url,
        imprimir: a.imprimir !== false,
        impreso: false,
        nota_enviada: false,
      };
      await db.guardarEnvio(env, r);
      try { r = await sincronizarEnvio(env, r); } catch { /* el cron lo reintenta */ }
      return {
        ok: true,
        mensaje: r.guia
          ? "Guía generada." + (r.etiqueta_url && a.imprimir !== false ? " Ya está en la cola de impresión." : "")
          : "Guía pagada. Mienvío está generando el número de guía; se imprimirá sola en cuanto esté lista (revisa con estado_envio).",
        compra_id: compra?.data?.purchase_id ?? null,
        envio: r,
      };
    },
  },
  {
    name: "estado_envio",
    title: "Estado del envío",
    description: "Consulta en Mienvío la guía de un pedido (número de guía, rastreo, etiqueta) y la actualiza; si la etiqueta ya está lista y faltaba imprimirla, la manda a la Zebra.",
    inputSchema: {
      type: "object",
      properties: { pedido_id: pedidoId, shipment_id: { type: "string", description: "Alternativa: ID de envío de Mienvío" } },
    },
    annotations: { readOnlyHint: false },
    run: async (env, a) => {
      let r = a.pedido_id ? await db.envioDePedido(env, a.pedido_id) : a.shipment_id ? await db.envioPorShipment(env, a.shipment_id) : null;
      if (!r && a.shipment_id) return { envio_mienvio: me.datosEnvio(await me.detalle(env, a.shipment_id)) };
      if (!r) return { error: "Ese pedido no tiene guía generada desde Kraken." };
      r = await sincronizarEnvio(env, r);
      return { envio: r };
    },
  },
  {
    name: "imprimir_guia",
    title: "Imprimir guía en la Zebra",
    description:
      "Manda una etiqueta a la cola de impresión de la laptop (agente Kraken en la Zebra ZD420). Usa la guía de un pedido, o una URL de etiqueta PDF de Mienvío. " +
      "Sirve para reimprimir.",
    inputSchema: {
      type: "object",
      properties: { pedido_id: pedidoId, etiqueta_url: { type: "string", description: "URL https de la etiqueta PDF" } },
    },
    run: async (env, a) => {
      let url: string | null = a.etiqueta_url || null;
      let guia: string | null = null;
      if (!url && a.pedido_id) {
        let r = await db.envioDePedido(env, a.pedido_id);
        if (!r) return { error: "Ese pedido no tiene guía generada desde Kraken." };
        if (!r.etiqueta_url) r = await sincronizarEnvio(env, r);
        url = r.etiqueta_url ?? null;
        guia = r.guia ?? null;
      }
      if (!url) return { error: "La etiqueta todavía no está lista en Mienvío o falta pedido_id/etiqueta_url." };
      if (!/^https:\/\//i.test(url)) return { error: "La URL de la etiqueta debe ser https." };
      const id = await db.encolarImpresion(env, url, a.pedido_id ? String(a.pedido_id) : null, guia);
      const lat = await db.ultimoLatido(env);
      return { ok: true, trabajo: id, agente: lat ? `visto por última vez ${lat.hora}` : "el agente de impresión nunca se ha conectado" };
    },
  },
  {
    name: "estado_impresion",
    title: "Estado de la impresora",
    description: "Muestra la cola de impresión pendiente o con fallos y cuándo se conectó por última vez el agente de la laptop.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: async (env) => {
      const lat = await db.ultimoLatido(env);
      const enLinea = lat ? Date.now() - Date.parse(lat.hora) < 60_000 : false;
      return { agente: lat ? { ...lat, en_linea: enLinea } : null, cola: await db.colaImpresion(env) };
    },
  },
];
