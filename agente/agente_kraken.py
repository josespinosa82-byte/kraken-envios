"""
Agente de impresión Kraken · Envíos
-----------------------------------
Corre en la laptop conectada a la Zebra ZD420. Cada pocos segundos pregunta al
servidor "kraken-envios" si hay guías por imprimir; descarga el PDF de Mienvío,
lo convierte a ZPL en tamaño exacto (4 x 6 in a 203 dpi) y lo manda directo a
la impresora, sin ventana de imprimir ni escalas.

Uso:
  pythonw agente_kraken.py                    -> modo normal (en segundo plano)
  python  agente_kraken.py --prueba guia.pdf  -> imprime un PDF local (sin servidor)
  python  agente_kraken.py --zpl guia.pdf     -> solo convierte y guarda guia.zpl + vista previa .png
  python  agente_kraken.py --impresoras       -> lista las impresoras instaladas
"""
from __future__ import annotations

import argparse
import io
import json
import logging
import math
import os
import platform
import socket
import sys
import time
from pathlib import Path

import pypdfium2 as pdfium
import requests
from PIL import Image, ImageOps

AQUI = Path(__file__).resolve().parent
CONFIG = AQUI / "config.json"
VERSION = "1.0.0"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler(AQUI / "agente.log", encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("kraken")


# ---------------------------------------------------------------- configuración
def cargar_config() -> dict:
    base = {
        "servidor": "",              # https://kraken-envios.<tu-cuenta>.workers.dev
        "token": "",                 # mismo valor que AGENT_TOKEN en Cloudflare
        "impresora": "",             # vacío = la primera que diga ZD420 o ZDesigner
        "dpi": 203,
        "ancho_in": 4.0,
        "alto_in": 6.0,
        "tipo_medio": "D",           # D = térmica directa (sin ribbon), T = transferencia térmica (con ribbon)
        "oscuridad": 0,              # ajuste relativo -30..30 (0 = como esté la impresora)
        "segundos": 5,
    }
    if CONFIG.exists():
        base.update(json.loads(CONFIG.read_text(encoding="utf-8")))
    return base


# ---------------------------------------------------------------- PDF -> ZPL
def _recortar_blanco(img: Image.Image, margen: int = 8) -> Image.Image:
    caja = ImageOps.invert(img.convert("L")).point(lambda v: 255 if v > 40 else 0).getbbox()
    if not caja:
        return img
    x0, y0, x1, y1 = caja
    return img.crop((max(0, x0 - margen), max(0, y0 - margen), min(img.width, x1 + margen), min(img.height, y1 + margen)))


def pdf_a_imagen(pdf: bytes, cfg: dict, pagina: int = 0) -> Image.Image:
    """Renderiza una página y la ajusta exactamente a la etiqueta (812 x 1218 puntos a 203 dpi)."""
    dpi = int(cfg["dpi"])
    ancho, alto = round(cfg["ancho_in"] * dpi), round(cfg["alto_in"] * dpi)
    doc = pdfium.PdfDocument(pdf)
    pag = doc[pagina]
    w_pt, h_pt = pag.get_size()
    # Render a mayor resolución y luego se reduce: mejores bordes en códigos de barras.
    escala = (dpi * 2) / 72
    img = pag.render(scale=escala, grayscale=True).to_pil().convert("L")
    doc.close()

    es_4x6 = abs(w_pt / 72 - cfg["ancho_in"]) < 0.3 and abs(h_pt / 72 - cfg["alto_in"]) < 0.3
    es_4x6_horizontal = abs(w_pt / 72 - cfg["alto_in"]) < 0.3 and abs(h_pt / 72 - cfg["ancho_in"]) < 0.3
    if not (es_4x6 or es_4x6_horizontal):
        img = _recortar_blanco(img)          # p. ej. guía 4x6 dentro de una hoja carta
    if img.width > img.height:
        img = img.rotate(90, expand=True)     # etiqueta horizontal -> vertical

    r = min(ancho / img.width, alto / img.height)
    nuevo = (max(1, round(img.width * r)), max(1, round(img.height * r)))
    img = img.resize(nuevo, Image.LANCZOS)
    lienzo = Image.new("L", (ancho, alto), 255)
    lienzo.paste(img, ((ancho - nuevo[0]) // 2, (alto - nuevo[1]) // 2))
    # Blanco y negro puro, sin tramado: códigos de barras nítidos.
    return lienzo.point(lambda v: 0 if v < 140 else 255, mode="1")


def imagen_a_zpl(img: Image.Image, cfg: dict) -> bytes:
    ancho, alto = img.size
    bpr = math.ceil(ancho / 8)
    # En PIL modo "1": bit 1 = blanco. En ZPL ^GF: bit 1 = negro. Se invierte.
    crudo = ImageOps.invert(img.convert("L")).convert("1").tobytes()
    total = bpr * alto
    datos = crudo.hex().upper()
    partes = ["^XA", f"^MT{cfg.get('tipo_medio', 'D')}", f"^PW{ancho}", f"^LL{alto}", "^LH0,0", "^PON"]
    osc = int(cfg.get("oscuridad") or 0)
    if osc:
        partes.append(f"^MD{max(-30, min(30, osc))}")
    partes.append(f"^FO0,0^GFA,{total},{total},{bpr},{datos}^FS")
    partes.append("^PQ1^XZ")
    return "".join(partes).encode("ascii")


def pdf_a_zpl(pdf: bytes, cfg: dict) -> tuple[bytes, Image.Image]:
    img = pdf_a_imagen(pdf, cfg)
    return imagen_a_zpl(img, cfg), img


# ---------------------------------------------------------------- impresora
def listar_impresoras() -> list[str]:
    import win32print  # type: ignore
    flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
    return [p[2] for p in win32print.EnumPrinters(flags)]


def elegir_impresora(cfg: dict) -> str:
    if cfg.get("impresora"):
        return cfg["impresora"]
    for nombre in listar_impresoras():
        if "ZD420" in nombre.upper() or "ZDESIGNER" in nombre.upper():
            return nombre
    raise RuntimeError("No encontré la Zebra. Escribe su nombre exacto en config.json → \"impresora\".")


def imprimir_raw(datos: bytes, impresora: str, titulo: str = "Guia Kraken") -> None:
    import win32print  # type: ignore
    h = win32print.OpenPrinter(impresora)
    try:
        win32print.StartDocPrinter(h, 1, (titulo, None, "RAW"))
        try:
            win32print.StartPagePrinter(h)
            win32print.WritePrinter(h, datos)
            win32print.EndPagePrinter(h)
        finally:
            win32print.EndDocPrinter(h)
    finally:
        win32print.ClosePrinter(h)


# ---------------------------------------------------------------- servidor
class Servidor:
    def __init__(self, cfg: dict):
        if not cfg.get("servidor") or not cfg.get("token"):
            raise RuntimeError("Falta \"servidor\" o \"token\" en config.json")
        self.base = cfg["servidor"].rstrip("/")
        self.s = requests.Session()
        self.s.headers.update({
            "X-Agente-Token": cfg["token"],
            "X-Agente-Info": f"{socket.gethostname()} · agente {VERSION} · {platform.system()}",
        })

    def siguiente(self) -> dict | None:
        r = self.s.get(f"{self.base}/agente/siguiente", timeout=20)
        if r.status_code == 204:
            return None
        r.raise_for_status()
        return r.json()

    def hecho(self, trabajo_id: int) -> None:
        self.s.post(f"{self.base}/agente/hecho/{trabajo_id}", timeout=20).raise_for_status()

    def fallo(self, trabajo_id: int, error: str) -> None:
        self.s.post(f"{self.base}/agente/fallo/{trabajo_id}", json={"error": error[:300]}, timeout=20)


def descargar(url: str) -> bytes:
    if not url.lower().startswith("https://"):
        raise RuntimeError("La etiqueta debe venir por https")
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    if not r.content.startswith(b"%PDF"):
        raise RuntimeError("La etiqueta descargada no es un PDF")
    return r.content


def ciclo(cfg: dict) -> None:
    srv = Servidor(cfg)
    impresora = elegir_impresora(cfg)
    log.info("Agente Kraken %s listo. Impresora: %s. Servidor: %s", VERSION, impresora, srv.base)
    espera = int(cfg.get("segundos") or 5)
    pausa_error = espera
    while True:
        try:
            t = srv.siguiente()
            pausa_error = espera
            if not t:
                time.sleep(espera)
                continue
            log.info("Imprimiendo trabajo %s (pedido %s, guía %s)", t["id"], t.get("pedido_id"), t.get("guia"))
            try:
                zpl, _ = pdf_a_zpl(descargar(t["etiqueta_url"]), cfg)
                imprimir_raw(zpl, impresora, f"Guia {t.get('guia') or t['id']}")
                srv.hecho(t["id"])
                log.info("Trabajo %s impreso", t["id"])
            except Exception as e:  # error de este trabajo: se reporta y se reintenta después
                log.exception("Falló el trabajo %s", t["id"])
                srv.fallo(t["id"], str(e))
                time.sleep(espera)
        except Exception as e:  # sin internet, servidor caído, etc.
            log.warning("Sin conexión con el servidor: %s (reintento en %ss)", e, pausa_error)
            time.sleep(pausa_error)
            pausa_error = min(pausa_error * 2, 300)


# ---------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser(description="Agente de impresión Kraken · Envíos")
    ap.add_argument("--prueba", metavar="PDF", help="Imprime un PDF local en la Zebra")
    ap.add_argument("--zpl", metavar="PDF", help="Convierte un PDF a .zpl y .png sin imprimir")
    ap.add_argument("--impresoras", action="store_true", help="Lista las impresoras instaladas")
    a = ap.parse_args()
    cfg = cargar_config()

    if a.impresoras:
        for n in listar_impresoras():
            print(n)
        return
    if a.zpl:
        zpl, img = pdf_a_zpl(Path(a.zpl).read_bytes(), cfg)
        destino = Path(a.zpl).with_suffix(".zpl")
        destino.write_bytes(zpl)
        img.save(destino.with_suffix(".vista.png"))
        print(f"Listo: {destino} ({len(zpl):,} bytes) y {destino.with_suffix('.vista.png')}")
        return
    if a.prueba:
        impresora = elegir_impresora(cfg)
        zpl, _ = pdf_a_zpl(Path(a.prueba).read_bytes(), cfg)
        imprimir_raw(zpl, impresora, "Prueba Kraken")
        print(f"Enviado a {impresora}")
        return
    ciclo(cfg)


if __name__ == "__main__":
    main()
