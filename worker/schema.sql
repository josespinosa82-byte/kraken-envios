-- Base de datos D1 del conector de envíos de Kraken.
CREATE TABLE IF NOT EXISTS envios (
  pedido_id     TEXT PRIMARY KEY,
  shipment_id   TEXT NOT NULL,
  paqueteria    TEXT,
  costo         TEXT,
  guia          TEXT,
  rastreo_url   TEXT,
  etiqueta_url  TEXT,
  imprimir      INTEGER NOT NULL DEFAULT 1,
  impreso       INTEGER NOT NULL DEFAULT 0,
  nota_enviada  INTEGER NOT NULL DEFAULT 0,
  creado        TEXT NOT NULL,
  actualizado   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS envios_shipment ON envios (shipment_id);

CREATE TABLE IF NOT EXISTS impresiones (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  etiqueta_url  TEXT NOT NULL,
  pedido_id     TEXT,
  guia          TEXT,
  creado        TEXT NOT NULL,
  intentos      INTEGER NOT NULL DEFAULT 0,
  ultimo_error  TEXT,
  estado        TEXT NOT NULL DEFAULT 'pendiente'
);
CREATE INDEX IF NOT EXISTS impresiones_estado ON impresiones (estado, id);

CREATE TABLE IF NOT EXISTS meta (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
