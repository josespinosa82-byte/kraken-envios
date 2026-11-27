# Kraken · Envíos

Conector propio de Kraken que une **WooCommerce (kraken-sport.com) → Mienvío → Zebra ZD420**, y que Claude puede usar desde el chat.
Es también la base del módulo de envíos de **Kraken 360**.

```
Pedido en kraken-sport.com
      │  (Claude o Kraken 360 lo consultan)
      ▼
Servidor "kraken-envios" en Cloudflare ──► Mienvío: cotizar / generar guía (cobra la cartera, solo con tu OK)
      │  cola de impresión                       │
      ▼                                          ▼
Agente en tu laptop ◄── etiqueta PDF ──── guía lista ─► nota con rastreo al cliente en WooCommerce
      │  PDF → ZPL 4x6 exacto, térmica directa
      ▼
Zebra ZD420
```

## Qué puede hacer Claude con el conector

| Herramienta | Qué hace | ¿Cobra? |
|---|---|---|
| `pedidos_pendientes` | Lista pedidos pagados por enviar y si ya tienen guía | No |
| `ver_pedido` | Muestra la dirección tal como irá a Mienvío y avisa si falta algo | No |
| `cotizar_envio` | Tarifas de Mienvío de la más barata a la más cara | No |
| `generar_guia` | Crea y paga la guía. **Exige tu aprobación** y no repite guías del mismo pedido | **Sí** |
| `estado_envio` | Número de guía, rastreo y etiqueta | No |
| `imprimir_guia` | Manda (o reimprime) la etiqueta a la Zebra | No |
| `estado_impresion` | Cola de impresión y si el agente de la laptop está en línea | No |

Cada 2 minutos el servidor revisa guías que Mienvío todavía estaba generando, las manda a imprimir y le deja al cliente
una nota en su pedido con la guía y el enlace de rastreo (WooCommerce se la envía por correo).

---

## Instalación (una sola vez)

### 1. Claves que necesitas

| Dato | Dónde se obtiene |
|---|---|
| **Token de Mienvío** | Panel de Mienvío → Integraciones / API |
| **Claves de WooCommerce** | WordPress → WooCommerce → Ajustes → Avanzado → API REST → *Añadir clave*. Permisos: **Lectura/Escritura** (escritura solo para dejar la nota de rastreo) |
| **MCP_SECRET** y **AGENT_TOKEN** | Dos claves al azar. En PowerShell: `[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N')` (córrelo dos veces) |

> Nunca pegues estas claves en un chat ni en el código. Solo van en Cloudflare (secretos) y en `config.json` del agente.

### 2. Servidor en Cloudflare (gratis)

1. Crea una cuenta en <https://dash.cloudflare.com> (plan Free).
2. **Storage & Databases → D1 → Create database** con el nombre `kraken-envios`.
   Abre la base → pestaña **Console** → pega y ejecuta el contenido de `worker/schema.sql`.
   Copia el **Database ID** y pégalo en `worker/wrangler.toml` (`database_id`).
3. Revisa en `worker/wrangler.toml`:
   - `ORIGEN_JSON`: tu dirección de origen y un **email** real.
   - `PAQUETE_JSON`: **medidas de la caja** del Kraken Kit (cm), peso (kg), `fiscal_code` (clave SAT del producto) y `package_type`
     — los dos últimos los pide Mienvío para pagar la guía; búscalos en tu panel de Mienvío al generar una guía manual.
   - Para probar sin cobrar, cambia `MIENVIO_BASE` a `https://dev-sandbox.mienvio.mx/api/v2`.
4. **Workers & Pages → Create → Import a repository** → elige este repositorio, carpeta raíz `worker`.
5. En el Worker → **Settings → Variables and Secrets**, agrega como *Secret*:
   `MIENVIO_TOKEN`, `WOO_URL` (`https://kraken-sport.com`), `WOO_KEY`, `WOO_SECRET`, `MCP_SECRET`, `AGENT_TOKEN`.
6. Abre `https://kraken-envios.<tu-subdominio>.workers.dev` → debe decir *“Kraken · Envíos está funcionando.”*

### 3. Conectar a Claude

claude.ai → **Configuración → Conectores → Agregar conector personalizado**

- Nombre: `Kraken · Envíos`
- URL: `https://kraken-envios.<tu-subdominio>.workers.dev/mcp/<MCP_SECRET>`

La URL incluye el secreto: trátala como una contraseña.

### 4. Agente de impresión en la laptop de la Zebra

1. Instala Python 3 desde <https://www.python.org/downloads/> marcando **“Add python.exe to PATH”**.
2. Copia la carpeta `agente` a la laptop (p. ej. `C:\Kraken\agente`) y da doble clic en **`instalar.bat`**.
3. Abre `config.json` y llena `servidor` y `token` (= `AGENT_TOKEN`).
4. **Prueba la Zebra:** doble clic en `probar_guia.bat` y arrastra un PDF de guía. Debe salir completa, en 4 × 6.
5. Doble clic en **`iniciar_agente.bat`**. Desde ahora arranca solo al prender la laptop. Su bitácora está en `agente.log`.

`config.json`:

| Campo | Valor |
|---|---|
| `impresora` | Nombre exacto en Windows (`python agente_kraken.py --impresoras` los lista). Vacío = autodetecta la ZD420 |
| `tipo_medio` | `D` = **térmica directa** (etiquetas sin ribbon, lo normal en guías). `T` = transferencia térmica con ribbon |
| `oscuridad` | Ajuste fino −30…30 si la impresión sale muy clara u oscura |

---

## Uso diario

En el chat: *“¿Qué pedidos tengo por enviar?”* → *“Cotiza el 1234”* → Claude te muestra paquetería y precio →
tú dices *“sí, la de Estafeta”* → se genera la guía, se imprime sola en la Zebra y el cliente recibe su rastreo.

## Notas técnicas

- API de Mienvío v2: `POST /shipments/rates`, `POST /shipments` (`payment_method: wallet`), `GET /shipments/{id}`.
  El número de guía y la etiqueta se generan en un proceso aparte; el cron los recoge.
- La etiqueta de Mienvío llega en PDF; el agente la renderiza a 203 dpi (812 × 1218 puntos), la ajusta sin márgenes
  y la manda como ZPL (`^MTD`) en modo RAW: no depende de la configuración del driver ni de Chrome.
- Almacenamiento: Cloudflare D1 (`envios`, `impresiones`, `meta`).
- Próximo paso: panel web de Kraken 360 (lista de pedidos + botón **Aprobar guía**) sobre este mismo servidor.
