#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Servidor local para administrar una rifa. Sin dependencias externas."""

import io
import json
import os
import random
import socket
import sqlite3
import sys
import tempfile
import threading
import traceback
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.abspath(os.environ.get("RIFA_DB") or os.path.join(BASE, "rifa.db"))
LOCK = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS config (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS numeros (
    numero INTEGER PRIMARY KEY,
    nombre TEXT NOT NULL DEFAULT '',
    telefono TEXT NOT NULL DEFAULT '',
    nota TEXT NOT NULL DEFAULT '',
    abonado REAL NOT NULL DEFAULT 0,
    estado TEXT NOT NULL DEFAULT 'disponible',
    actualizado TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS abonos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero INTEGER NOT NULL,
    titular TEXT NOT NULL DEFAULT '',
    monto REAL NOT NULL,
    nota TEXT NOT NULL DEFAULT '',
    fecha TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sorteos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero INTEGER NOT NULL,
    nombre TEXT NOT NULL DEFAULT '',
    telefono TEXT NOT NULL DEFAULT '',
    premio TEXT NOT NULL DEFAULT '',
    fecha TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_abonos_numero ON abonos(numero);
"""

DEFECTOS = {
    "rifa_nombre": "Rifa de 200 números",
    "premio": "",
    "total_numeros": "200",
    "precio": "1000",
    "moneda": "$",
    "version": "1",
}


def ahora():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def conectar():
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=15000")
    con.execute("PRAGMA synchronous=NORMAL")
    return con


def leer_config(con):
    return {f["clave"]: f["valor"] for f in con.execute("SELECT clave, valor FROM config")}


def bump_version(con):
    v = int(leer_config(con).get("version", "0") or 0) + 1
    con.execute("UPDATE config SET valor = ? WHERE clave = 'version'", (str(v),))


def init_db():
    con = conectar()
    con.executescript(SCHEMA)
    for clave, valor in DEFECTOS.items():
        con.execute("INSERT OR IGNORE INTO config (clave, valor) VALUES (?, ?)", (clave, valor))
    total = int(leer_config(con)["total_numeros"])
    con.executemany(
        "INSERT OR IGNORE INTO numeros (numero) VALUES (?)",
        [(n,) for n in range(1, total + 1)],
    )
    con.commit()
    con.close()


def estado_actual(con):
    c = leer_config(con)
    precio = float(c.get("precio", "0") or 0)
    numeros = []
    recaudado = 0.0
    por_cobrar = 0.0
    apartados = 0
    pagados = 0
    for f in con.execute("SELECT * FROM numeros ORDER BY numero"):
        abonado = float(f["abonado"])
        saldo = max(precio - abonado, 0.0)
        if f["estado"] != "disponible":
            recaudado += abonado
            por_cobrar += saldo
            if f["estado"] == "pagado":
                pagados += 1
            else:
                apartados += 1
        numeros.append(
            {
                "numero": f["numero"],
                "nombre": f["nombre"],
                "telefono": f["telefono"],
                "nota": f["nota"],
                "abonado": round(abonado, 2),
                "saldo": round(saldo, 2),
                "estado": f["estado"],
                "actualizado": f["actualizado"],
            }
        )

    sorteos = [dict(f) for f in con.execute("SELECT * FROM sorteos ORDER BY id DESC LIMIT 100")]

    return {
        "version": int(c.get("version", "0") or 0),
        "config": {
            "rifa_nombre": c.get("rifa_nombre", "Mi rifa"),
            "premio": c.get("premio", ""),
            "total_numeros": int(c.get("total_numeros", "0") or 0),
            "precio": round(precio, 2),
            "moneda": c.get("moneda", ""),
        },
        "stats": {
            "total": len(numeros),
            "disponibles": len(numeros) - apartados - pagados,
            "apartados": apartados,
            "pagados": pagados,
            "vendidos": apartados + pagados,
            "recaudado": round(recaudado, 2),
            "por_cobrar": round(por_cobrar, 2),
        },
        "numeros": numeros,
        "sorteos": sorteos,
    }


def detalle_numero(con, numero):
    f = con.execute("SELECT * FROM numeros WHERE numero = ?", (numero,)).fetchone()
    if not f:
        raise ValueError("Ese número no existe")
    precio = float(leer_config(con).get("precio", "0") or 0)
    abonos = [
        dict(x)
        for x in con.execute(
            "SELECT id, monto, nota, fecha, titular FROM abonos WHERE numero = ? ORDER BY id DESC",
            (numero,),
        )
    ]
    return {
        "numero": {
            "numero": f["numero"],
            "nombre": f["nombre"],
            "telefono": f["telefono"],
            "nota": f["nota"],
            "abonado": round(float(f["abonado"]), 2),
            "saldo": round(max(precio - float(f["abonado"]), 0.0), 2),
            "estado": f["estado"],
            "actualizado": f["actualizado"],
        },
        "abonos": abonos,
    }


def numeros_normalizados(valor):
    if not isinstance(valor, list) or not valor:
        raise ValueError("Selecciona al menos un número")
    try:
        return sorted({int(x) for x in valor})
    except (TypeError, ValueError):
        raise ValueError("La lista de números no es válida")


def api_asignar(datos):
    nums = numeros_normalizados(datos.get("numeros"))
    nombre = str(datos.get("nombre", "")).strip()[:80]
    telefono = str(datos.get("telefono", "")).strip()[:40]
    nota = str(datos.get("nota", "")).strip()[:300]
    if not nombre:
        raise ValueError("Escribe el nombre del comprador")
    try:
        abono = round(float(datos.get("abono_por_numero") or 0), 2)
    except (TypeError, ValueError):
        raise ValueError("El abono no es válido")
    if abono < 0:
        raise ValueError("El abono no puede ser negativo")

    with LOCK:
        con = conectar()
        try:
            con.execute("BEGIN IMMEDIATE")
            c = leer_config(con)
            precio = round(float(c.get("precio", "0") or 0), 2)
            total = int(c.get("total_numeros", "0") or 0)
            if abono > precio + 0.001:
                raise ValueError("El abono no puede ser mayor que el precio del número")
            for n in nums:
                if n < 1 or n > total:
                    raise ValueError(f"El número {n} está fuera del rango de la rifa")
                f = con.execute(
                    "SELECT estado, nombre FROM numeros WHERE numero = ?", (n,)
                ).fetchone()
                if not f:
                    raise ValueError(f"El número {n} no existe")
                if f["estado"] != "disponible":
                    dueno = f["nombre"] or "otra persona"
                    raise ValueError(f"El número {n} ya está ocupado por {dueno}")
            marca = ahora()
            nuevo_estado = "pagado" if abono >= precio - 0.001 else "apartado"
            for n in nums:
                con.execute(
                    """UPDATE numeros
                       SET nombre = ?, telefono = ?, nota = ?, abonado = ?,
                           estado = ?, actualizado = ?
                       WHERE numero = ?""",
                    (nombre, telefono, nota, abono, nuevo_estado, marca, n),
                )
                if abono > 0:
                    con.execute(
                        "INSERT INTO abonos (numero, titular, monto, nota, fecha) VALUES (?, ?, ?, ?, ?)",
                        (n, nombre, abono, "Abono inicial", marca),
                    )
            bump_version(con)
            con.commit()
            return {"ok": True, "estado": estado_actual(con)}
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()


def api_abono(datos):
    try:
        numero = int(datos.get("numero"))
        monto = round(float(datos.get("monto") or 0), 2)
    except (TypeError, ValueError):
        raise ValueError("Datos del abono no válidos")
    if monto <= 0:
        raise ValueError("El abono debe ser mayor que cero")
    nota = str(datos.get("nota", "")).strip()[:200]

    with LOCK:
        con = conectar()
        try:
            con.execute("BEGIN IMMEDIATE")
            c = leer_config(con)
            precio = round(float(c.get("precio", "0") or 0), 2)
            f = con.execute("SELECT * FROM numeros WHERE numero = ?", (numero,)).fetchone()
            if not f:
                raise ValueError("Ese número no existe")
            if f["estado"] == "disponible":
                raise ValueError("Ese número está disponible, primero asígnalo")
            abonado = float(f["abonado"])
            saldo = max(precio - abonado, 0.0)
            if saldo <= 0.001:
                raise ValueError("Ese número ya está pagado por completo")
            if monto > saldo + 0.001:
                raise ValueError(f"El abono supera el saldo pendiente ({saldo:.2f})")
            nuevo = round(abonado + monto, 2)
            nuevo_estado = "pagado" if nuevo >= precio - 0.001 else "apartado"
            marca = ahora()
            con.execute(
                "UPDATE numeros SET abonado = ?, estado = ?, actualizado = ? WHERE numero = ?",
                (nuevo, nuevo_estado, marca, numero),
            )
            con.execute(
                "INSERT INTO abonos (numero, titular, monto, nota, fecha) VALUES (?, ?, ?, ?, ?)",
                (numero, f["nombre"], monto, nota, marca),
            )
            bump_version(con)
            con.commit()
            return {"ok": True, "estado": estado_actual(con)}
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()


def api_editar(datos):
    try:
        numero = int(datos.get("numero"))
    except (TypeError, ValueError):
        raise ValueError("Número no válido")
    nombre = str(datos.get("nombre", "")).strip()[:80]
    telefono = str(datos.get("telefono", "")).strip()[:40]
    nota = str(datos.get("nota", "")).strip()[:300]
    if not nombre:
        raise ValueError("El nombre no puede quedar vacío")

    with LOCK:
        con = conectar()
        try:
            con.execute("BEGIN IMMEDIATE")
            f = con.execute("SELECT estado FROM numeros WHERE numero = ?", (numero,)).fetchone()
            if not f:
                raise ValueError("Ese número no existe")
            if f["estado"] == "disponible":
                raise ValueError("Ese número está disponible")
            con.execute(
                "UPDATE numeros SET nombre = ?, telefono = ?, nota = ?, actualizado = ? WHERE numero = ?",
                (nombre, telefono, nota, ahora(), numero),
            )
            bump_version(con)
            con.commit()
            return {"ok": True, "estado": estado_actual(con)}
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()


def api_liberar(datos):
    nums = numeros_normalizados(datos.get("numeros"))

    with LOCK:
        con = conectar()
        try:
            con.execute("BEGIN IMMEDIATE")
            marca = ahora()
            for n in nums:
                con.execute(
                    """UPDATE numeros
                       SET nombre = '', telefono = '', nota = '', abonado = 0,
                           estado = 'disponible', actualizado = ?
                       WHERE numero = ?""",
                    (marca, n),
                )
            bump_version(con)
            con.commit()
            return {"ok": True, "estado": estado_actual(con)}
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()


def api_config(datos):
    nombre = str(datos.get("rifa_nombre", "")).strip()[:80] or "Mi rifa"
    premio = str(datos.get("premio", "")).strip()[:200]
    moneda = str(datos.get("moneda", "")).strip()[:8]
    try:
        total = int(datos.get("total_numeros"))
        precio = round(float(datos.get("precio")), 2)
    except (TypeError, ValueError):
        raise ValueError("Cantidad de números o precio no válidos")
    if total < 1 or total > 10000:
        raise ValueError("La cantidad de números debe estar entre 1 y 10000")
    if precio < 0:
        raise ValueError("El precio no puede ser negativo")

    with LOCK:
        con = conectar()
        try:
            con.execute("BEGIN IMMEDIATE")
            fila = con.execute(
                "SELECT MAX(numero) AS m FROM numeros WHERE estado != 'disponible'"
            ).fetchone()
            max_ocupado = fila["m"] if fila and fila["m"] else 0
            if max_ocupado > total:
                raise ValueError(
                    f"No puedes reducir a {total} números: el número {max_ocupado} ya está vendido"
                )
            con.executemany(
                "INSERT OR IGNORE INTO numeros (numero) VALUES (?)",
                [(n,) for n in range(1, total + 1)],
            )
            con.execute("DELETE FROM numeros WHERE numero > ? AND estado = 'disponible'", (total,))
            con.execute("UPDATE config SET valor = ? WHERE clave = 'rifa_nombre'", (nombre,))
            con.execute("UPDATE config SET valor = ? WHERE clave = 'premio'", (premio,))
            con.execute("UPDATE config SET valor = ? WHERE clave = 'moneda'", (moneda,))
            con.execute("UPDATE config SET valor = ? WHERE clave = 'total_numeros'", (str(total),))
            con.execute("UPDATE config SET valor = ? WHERE clave = 'precio'", (str(precio),))
            for f in con.execute("SELECT numero, abonado FROM numeros WHERE estado != 'disponible'"):
                nuevo_estado = (
                    "pagado" if float(f["abonado"]) >= precio - 0.001 else "apartado"
                )
                con.execute(
                    "UPDATE numeros SET estado = ? WHERE numero = ?",
                    (nuevo_estado, f["numero"]),
                )
            bump_version(con)
            con.commit()
            return {"ok": True, "estado": estado_actual(con)}
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()


def api_sorteo(datos):
    solo_pagados = bool(datos.get("solo_pagados"))
    with LOCK:
        con = conectar()
        try:
            con.execute("BEGIN IMMEDIATE")
            if solo_pagados:
                filas = con.execute(
                    "SELECT numero, nombre, telefono FROM numeros WHERE estado = 'pagado'"
                ).fetchall()
                if not filas:
                    raise ValueError("No hay números pagados para sortear")
            else:
                filas = con.execute(
                    "SELECT numero, nombre, telefono FROM numeros WHERE estado != 'disponible'"
                ).fetchall()
                if not filas:
                    raise ValueError("Todavía no hay números vendidos para sortear")
            elegido = random.choice(filas)
            premio = leer_config(con).get("premio", "")
            marca = ahora()
            con.execute(
                "INSERT INTO sorteos (numero, nombre, telefono, premio, fecha) VALUES (?, ?, ?, ?, ?)",
                (elegido["numero"], elegido["nombre"], elegido["telefono"], premio, marca),
            )
            bump_version(con)
            con.commit()
            return {
                "ok": True,
                "ganador": {
                    "numero": elegido["numero"],
                    "nombre": elegido["nombre"],
                    "telefono": elegido["telefono"],
                    "premio": premio,
                    "fecha": marca,
                },
                "estado": estado_actual(con),
            }
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()


def api_eliminar_sorteo(datos):
    try:
        id_sorteo = int(datos.get("id"))
    except (TypeError, ValueError):
        raise ValueError("Sorteo no válido")

    with LOCK:
        con = conectar()
        try:
            con.execute("BEGIN IMMEDIATE")
            fila = con.execute(
                "SELECT id FROM sorteos WHERE id = ?", (id_sorteo,)
            ).fetchone()
            if not fila:
                raise ValueError("Ese sorteo ya no existe")
            con.execute("DELETE FROM sorteos WHERE id = ?", (id_sorteo,))
            bump_version(con)
            con.commit()
            return {"ok": True, "estado": estado_actual(con)}
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()


def csv_estado():
    con = conectar()
    try:
        est = estado_actual(con)
        cfg = est["config"]
        salida = io.StringIO()
        salida.write("sep=;\r\n")
        import csv

        w = csv.writer(salida, delimiter=";", lineterminator="\r\n")
        w.writerow(
            [
                "Numero",
                "Estado",
                "Nombre",
                "Telefono",
                "Precio",
                "Abonado",
                "Saldo",
                "Nota",
                "Actualizado",
            ]
        )
        for n in est["numeros"]:
            w.writerow(
                [
                    n["numero"],
                    n["estado"],
                    n["nombre"],
                    n["telefono"],
                    cfg["precio"],
                    n["abonado"],
                    n["saldo"],
                    n["nota"],
                    n["actualizado"],
                ]
            )
        return salida.getvalue().encode("utf-8-sig")
    finally:
        con.close()


def respaldo_bytes():
    fd, ruta_tmp = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        con = conectar()
        destino = sqlite3.connect(ruta_tmp)
        try:
            con.backup(destino)
        finally:
            destino.close()
            con.close()
        with open(ruta_tmp, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(ruta_tmp)
        except OSError:
            pass


def ips_locales():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


class Manejador(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE, **kwargs)

    def log_message(self, formato, *args):
        # Silenciar el ruido de cada petición; solo errores graves.
        pass

    def end_headers(self):
        ruta = urlparse(self.path).path
        if ruta == "/" or ruta.endswith((".html", ".js", ".css")):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def _json(self, obj, codigo=200):
        datos = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(codigo)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(datos)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(datos)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _bytes(self, datos, nombre, tipo):
        try:
            self.send_response(200)
            self.send_header("Content-Type", tipo)
            self.send_header("Content-Disposition", f'attachment; filename="{nombre}"')
            self.send_header("Content-Length", str(len(datos)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(datos)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _leer_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 2_000_000:
            raise ValueError("Los datos enviados son demasiado grandes")
        crudo = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(crudo.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("Formato de datos inválido")

    def do_GET(self):
        ruta = urlparse(self.path).path
        try:
            if ruta == "/api/estado":
                con = conectar()
                try:
                    self._json(estado_actual(con))
                finally:
                    con.close()
                return
            if ruta == "/api/detalle":
                qs = parse_qs(urlparse(self.path).query)
                try:
                    numero = int((qs.get("numero") or ["0"])[0])
                except (TypeError, ValueError):
                    raise ValueError("Número no válido")
                con = conectar()
                try:
                    datos = detalle_numero(con, numero)
                finally:
                    con.close()
                self._json({"ok": True, **datos})
                return
            if ruta == "/api/export.csv":
                marca = datetime.now().strftime("%Y%m%d-%H%M")
                self._bytes(
                    csv_estado(),
                    f"rifa-{marca}.csv",
                    "text/csv; charset=utf-8",
                )
                return
            if ruta == "/api/respaldo":
                marca = datetime.now().strftime("%Y%m%d-%H%M")
                self._bytes(
                    respaldo_bytes(),
                    f"respaldo-rifa-{marca}.db",
                    "application/octet-stream",
                )
                return
            if ruta == "/api/info":
                puerto = self.server.server_port
                urls = [f"http://{ip}:{puerto}" for ip in ips_locales()]
                urls.append(f"http://localhost:{puerto}")
                self._json({"ok": True, "urls": urls, "puerto": puerto})
                return
            super().do_GET()
        except ValueError as e:
            self._json({"ok": False, "error": str(e)}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        ruta = urlparse(self.path).path
        try:
            datos = self._leer_json()
            if ruta == "/api/asignar":
                self._json(api_asignar(datos))
            elif ruta == "/api/abono":
                self._json(api_abono(datos))
            elif ruta == "/api/editar":
                self._json(api_editar(datos))
            elif ruta == "/api/liberar":
                self._json(api_liberar(datos))
            elif ruta == "/api/config":
                self._json(api_config(datos))
            elif ruta == "/api/sorteo":
                self._json(api_sorteo(datos))
            elif ruta == "/api/sorteo/eliminar":
                self._json(api_eliminar_sorteo(datos))
            else:
                self._json({"ok": False, "error": "Ruta no encontrada"}, 404)
        except ValueError as e:
            self._json({"ok": False, "error": str(e)}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            self._json({"ok": False, "error": "Error interno del servidor"}, 500)


def puerto_libre(inicial):
    for puerto in range(inicial, inicial + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("0.0.0.0", puerto))
                return puerto
            except OSError:
                continue
    raise SystemExit("No se encontró un puerto libre entre %d y %d" % (inicial, inicial + 19))


def main():
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    init_db()

    puerto_pedido = 8080
    if len(sys.argv) > 1:
        try:
            puerto_pedido = int(sys.argv[1])
        except ValueError:
            pass
    elif os.environ.get("RIFA_PORT"):
        try:
            puerto_pedido = int(os.environ["RIFA_PORT"])
        except ValueError:
            pass

    puerto = puerto_libre(puerto_pedido)
    servidor = ThreadingHTTPServer(("0.0.0.0", puerto), Manejador)
    servidor.daemon_threads = True

    print("=" * 58)
    print("  RIFA - servidor local")
    print("=" * 58)
    print(f"  En esta computadora:  http://localhost:{puerto}")
    for ip in ips_locales():
        print(f"  En la red local:      http://{ip}:{puerto}")
    print("")
    print("  Abre esa dirección también en los celulares conectados")
    print("  a la misma red WiFi. Los datos se guardan en rifa.db")
    print("")
    print("  Para detener el servidor: Ctrl + C")
    print("=" * 58)

    if not os.environ.get("RIFA_NO_BROWSER"):
        threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{puerto}")).start()

    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido. Los datos quedaron guardados.")
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
