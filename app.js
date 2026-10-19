"use strict";

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => Array.from(raiz.querySelectorAll(sel));

const App = {
  datos: null,
  mapa: new Map(),
  version: null,
  seleccion: new Set(),
  filtro: "",
  detalle: null,
  conexion: true,
  sorteando: false,
};

const formatoNumero = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 });

function esc(valor) {
  return String(valor ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function norm(valor) {
  return String(valor ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function dinero(valor) {
  const moneda = (App.datos?.config?.moneda || "").trim();
  const numero = formatoNumero.format(Number(valor) || 0);
  if (!moneda) return numero;
  return moneda.length <= 1 ? moneda + numero : moneda + " " + numero;
}

function etiquetaEstado(estado) {
  if (estado === "pagado") return "Pagado";
  if (estado === "apartado") return "Apartado";
  return "Disponible";
}

function toast(mensaje, esError = false) {
  const el = $("#toast");
  el.textContent = mensaje;
  el.classList.toggle("error", esError);
  el.classList.add("visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("visible"), 3400);
}

function abrirModal(selector) {
  $(selector).classList.remove("hidden");
  document.body.classList.add("sin-scroll");
}

function cerrarModal(selector) {
  $(selector).classList.add("hidden");
  if (!$$(".modal-backdrop:not(.hidden)").length) {
    document.body.classList.remove("sin-scroll");
  }
}

async function api(ruta, datos) {
  const respuesta = await fetch(ruta, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(datos || {}),
  });
  let cuerpo;
  try {
    cuerpo = await respuesta.json();
  } catch {
    throw new Error("Respuesta inválida del servidor");
  }
  if (!respuesta.ok || cuerpo.ok === false) {
    throw new Error(cuerpo.error || "No se pudo completar la operación");
  }
  return cuerpo;
}

/* ------------------------------------------------------------------ */
/* Carga y pintado del estado                                          */
/* ------------------------------------------------------------------ */

async function cargarEstado() {
  try {
    const respuesta = await fetch("/api/estado", { cache: "no-store" });
    if (!respuesta.ok) throw new Error("sin conexión");
    const datos = await respuesta.json();
    aplicarEstado(datos);
    marcarConexion(true);
  } catch {
    marcarConexion(false);
  }
}

function aplicarEstado(datos) {
  const versionAnterior = App.version;
  App.datos = datos;
  App.version = datos.version;
  App.mapa = new Map(datos.numeros.map((n) => [n.numero, n]));

  // Quitar de la selección los números que ya fueron ocupados por otra persona.
  for (const numero of Array.from(App.seleccion)) {
    const fila = App.mapa.get(numero);
    if (!fila || fila.estado !== "disponible") App.seleccion.delete(numero);
  }

  if (versionAnterior !== datos.version) {
    renderTodo();
    refrescarDetalleSiAplica();
  }
}

function renderTodo() {
  const cfg = App.datos.config;
  document.title = cfg.rifa_nombre || "Rifa";
  $("#tituloRifa").textContent = cfg.rifa_nombre || "Rifa";

  const partes = [];
  if (cfg.premio) partes.push(`Premio: ${cfg.premio}`);
  partes.push(`${cfg.total_numeros} números`);
  partes.push(`${dinero(cfg.precio)} por número`);
  $("#subtituloRifa").textContent = partes.join(" · ");

  renderStats();
  renderGrid();
  renderHistorialSorteos();
  aplicarFiltro();
  actualizarBarraSeleccion();
  $("#btnPagoCompleto").textContent = `Pagado (${dinero(cfg.precio)} c/u)`;
}

function renderStats() {
  const s = App.datos.stats;
  $("#stats").innerHTML = `
    <div class="stat"><span class="stat-label">Vendidos</span><strong>${s.vendidos}</strong></div>
    <div class="stat"><span class="stat-label">Disponibles</span><strong>${s.disponibles}</strong></div>
    <div class="stat ambar"><span class="stat-label">Apartados</span><strong>${s.apartados}</strong></div>
    <div class="stat verde"><span class="stat-label">Pagados</span><strong>${s.pagados}</strong></div>
    <div class="stat destacado"><span class="stat-label">Recaudado</span><strong>${esc(dinero(s.recaudado))}</strong></div>
    <div class="stat ambar"><span class="stat-label">Por cobrar</span><strong>${esc(dinero(s.por_cobrar))}</strong></div>
  `;
}

function renderGrid() {
  const html = App.datos.numeros.map((n) => {
    const seleccionado = App.seleccion.has(n.numero) ? " sel" : "";
    const titulo = n.nombre
      ? `Número ${n.numero} — ${n.nombre} (${etiquetaEstado(n.estado)})`
      : `Número ${n.numero} — disponible`;
    return `
      <button type="button" class="num ${n.estado}${seleccionado}" data-n="${n.numero}" title="${esc(titulo)}">
        <span class="n">${n.numero}</span>
        ${n.nombre ? `<span class="nombre">${esc(n.nombre)}</span>` : ""}
      </button>`;
  }).join("");
  $("#grid").innerHTML = html;
}

function renderHistorialSorteos() {
  const sorteos = App.datos.sorteos || [];
  const cont = $("#historialSorteos");
  if (!sorteos.length) {
    cont.innerHTML = `<p class="muted small">Todavía no se ha realizado ningún sorteo.</p>`;
    return;
  }
  cont.innerHTML = sorteos.map((s) => `
    <div class="sorteo-item">
      <span class="sorteo-num">${s.numero}</span>
      <div>
        <strong>${esc(s.nombre)}</strong>
        <span class="muted">${esc(s.fecha)}${s.premio ? " · " + esc(s.premio) : ""}</span>
      </div>
      <button type="button" class="borrar-sorteo" data-borrar-sorteo="${s.id}" title="Eliminar este sorteo del historial" aria-label="Eliminar sorteo">🗑</button>
    </div>`).join("");
}

function aplicarFiltro() {
  const consulta = norm(App.filtro.trim());
  $$("#grid .num").forEach((el) => {
    const numero = Number(el.dataset.n);
    const fila = App.mapa.get(numero);
    const texto = norm(`${numero} ${fila?.nombre || ""} ${fila?.telefono || ""} ${fila?.nota || ""}`);
    el.classList.toggle("oculto", Boolean(consulta) && !texto.includes(consulta));
  });
}

function actualizarBarraSeleccion() {
  const cantidad = App.seleccion.size;
  const barra = $("#barraSeleccion");
  barra.classList.toggle("hidden", cantidad === 0);
  $("#btnAsignar").disabled = cantidad === 0;
  if (!cantidad) return;
  const precio = App.datos?.config?.precio || 0;
  $("#txtSeleccion").textContent = `${cantidad} número${cantidad === 1 ? "" : "s"} seleccionado${cantidad === 1 ? "" : "s"}`;
  $("#txtSeleccionTotal").textContent = `Total: ${dinero(cantidad * precio)}`;
}

function refrescarDetalleSiAplica() {
  const modal = $("#modalDetalle");
  if (!App.detalle || modal.classList.contains("hidden")) return;
  const activo = document.activeElement;
  if (activo && ["INPUT", "TEXTAREA"].includes(activo.tagName)) return;
  cargarDetalle(App.detalle, false);
}

function marcarConexion(ok) {
  App.conexion = ok;
  const el = $("#estadoConexion");
  el.textContent = ok ? "● En línea" : "● Sin conexión";
  el.classList.toggle("online", ok);
  el.classList.toggle("offline", !ok);
}

/* ------------------------------------------------------------------ */
/* Selección y asignación                                              */
/* ------------------------------------------------------------------ */

function alternarSeleccion(numero) {
  if (App.seleccion.has(numero)) App.seleccion.delete(numero);
  else App.seleccion.add(numero);
  const celda = $(`#grid .num[data-n="${numero}"]`);
  if (celda) celda.classList.toggle("sel", App.seleccion.has(numero));
  actualizarBarraSeleccion();
}

function abrirAsignacion() {
  if (!App.seleccion.size) return;
  const numeros = Array.from(App.seleccion).sort((a, b) => a - b);
  $("#asignarNumeros").innerHTML = numeros.map((n) => `<span class="chip">${n}</span>`).join("");
  const form = $("#formAsignar");
  form.reset();
  $("#asigAbono").value = 0;
  $("#btnPagoCompleto").textContent = `Pagado (${dinero(App.datos.config.precio)} c/u)`;
  actualizarResumenAsignar();
  abrirModal("#modalAsignar");
  setTimeout(() => $("#asigNombre").focus(), 60);
}

function actualizarResumenAsignar() {
  const precio = Number(App.datos?.config?.precio) || 0;
  const cantidad = App.seleccion.size;
  const abono = Math.max(0, Number($("#asigAbono").value) || 0);
  $("#asigTotal").textContent = dinero(abono * cantidad);
  $("#asigSaldo").textContent = dinero(Math.max(precio - abono, 0) * cantidad);
  $$(".quick-montos .mini").forEach((b) => b.classList.remove("activo"));
}

/* ------------------------------------------------------------------ */
/* Detalle del número                                                  */
/* ------------------------------------------------------------------ */

async function cargarDetalle(numero, abrir = true) {
  try {
    const respuesta = await fetch(`/api/detalle?numero=${encodeURIComponent(numero)}`, { cache: "no-store" });
    const datos = await respuesta.json();
    if (!datos.ok) throw new Error(datos.error || "No se pudo cargar el número");
    App.detalle = datos.numero.numero;
    pintarDetalle(datos);
    if (abrir) abrirModal("#modalDetalle");
  } catch (error) {
    toast(error.message, true);
  }
}

function pintarDetalle(datos) {
  const n = datos.numero;
  $("#detNumero").textContent = n.numero;

  const badge = $("#detBadge");
  badge.className = `badge ${n.estado}`;
  badge.textContent = etiquetaEstado(n.estado);

  $("#detNombre").textContent = n.nombre || "—";
  $("#detTelefono").innerHTML = n.telefono
    ? `<a href="tel:${esc(n.telefono)}">${esc(n.telefono)}</a>`
    : "—";
  $("#detPrecio").textContent = dinero(App.datos?.config?.precio ?? 0);
  $("#detAbonado").textContent = dinero(n.abonado);
  $("#detSaldo").textContent = dinero(n.saldo);
  $("#detFecha").textContent = n.actualizado || "—";

  $("#detNota").textContent = n.nota ? `Nota: ${n.nota}` : "";
  $("#detNota").classList.toggle("hidden", !n.nota);

  $("#detPago").classList.toggle("hidden", n.saldo <= 0);
  $("#btnPagarSaldo").dataset.saldo = n.saldo;
  if (document.activeElement !== $("#detMonto")) $("#detMonto").value = "";

  if (document.activeElement !== $("#editNombre")) $("#editNombre").value = n.nombre || "";
  if (document.activeElement !== $("#editTelefono")) $("#editTelefono").value = n.telefono || "";
  if (document.activeElement !== $("#editNota")) $("#editNota").value = n.nota || "";

  const historial = $("#detHistorial");
  if (!datos.abonos.length) {
    historial.innerHTML = `<p class="muted small">Sin abonos registrados.</p>`;
  } else {
    historial.innerHTML = datos.abonos.map((a) => `
      <div class="abono-item">
        <div class="abono-info">
          <span class="abono-monto">${esc(dinero(a.monto))}</span>
          <span class="muted">${esc(a.fecha)}${a.nota ? " · " + esc(a.nota) : ""}</span>
        </div>
      </div>`).join("");
  }
}

/* ------------------------------------------------------------------ */
/* Sorteo                                                              */
/* ------------------------------------------------------------------ */

async function realizarSorteo() {
  if (App.sorteando) return;
  const soloPagados = $("#soloPagados").checked;
  const candidatos = App.datos.numeros.filter((n) =>
    soloPagados ? n.estado === "pagado" : n.estado !== "disponible"
  );
  if (!candidatos.length) {
    toast(soloPagados ? "No hay números pagados para sortear" : "Todavía no hay números vendidos", true);
    return;
  }

  App.sorteando = true;
  const boton = $("#btnSortear");
  boton.disabled = true;

  const panel = $("#resultadoSorteo");
  const numEl = $("#ganadorNumero");
  const nomEl = $("#ganadorNombre");
  const extraEl = $("#ganadorExtra");
  panel.classList.remove("hidden");
  numEl.textContent = "—";
  nomEl.textContent = "";
  extraEl.textContent = "Sorteando…";

  let indice = Math.floor(Math.random() * candidatos.length);
  const intervalo = setInterval(() => {
    indice = (indice + 1) % candidatos.length;
    numEl.textContent = candidatos[indice].numero;
    nomEl.textContent = candidatos[indice].nombre;
  }, 70);

  const inicio = Date.now();
  try {
    const resultado = await api("/api/sorteo", { solo_pagados: soloPagados });
    const restante = Math.max(0, 1400 - (Date.now() - inicio));
    await new Promise((resolver) => setTimeout(resolver, restante));
    clearInterval(intervalo);

    const ganador = resultado.ganador;
    numEl.textContent = ganador.numero;
    nomEl.textContent = ganador.nombre;
    extraEl.textContent = [
      ganador.premio ? `Premio: ${ganador.premio}` : "",
      ganador.telefono ? `Tel: ${ganador.telefono}` : "",
      ganador.fecha,
    ].filter(Boolean).join(" · ");

    aplicarEstado(resultado.estado);
    toast(`¡Ganador: número ${ganador.numero} — ${ganador.nombre}!`);
  } catch (error) {
    clearInterval(intervalo);
    panel.classList.add("hidden");
    toast(error.message, true);
  } finally {
    App.sorteando = false;
    boton.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Configuración y compartir                                           */
/* ------------------------------------------------------------------ */

function abrirConfiguracion() {
  const cfg = App.datos.config;
  $("#cfgNombre").value = cfg.rifa_nombre;
  $("#cfgPremio").value = cfg.premio || "";
  $("#cfgTotal").value = cfg.total_numeros;
  $("#cfgPrecio").value = cfg.precio;
  $("#cfgMoneda").value = cfg.moneda || "";
  abrirModal("#modalConfig");
}

async function abrirCompartir() {
  try {
    const respuesta = await fetch("/api/info", { cache: "no-store" });
    const datos = await respuesta.json();
    $("#listaEnlaces").innerHTML = datos.urls
      .map((url) => `
        <div class="enlace-item">
          <code>${esc(url)}</code>
          <button type="button" class="mini" data-copiar="${esc(url)}">Copiar</button>
        </div>`)
      .join("");
    abrirModal("#modalCompartir");
  } catch {
    toast("No se pudieron obtener los enlaces de la red", true);
  }
}

async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    toast("Enlace copiado");
  } catch {
    const area = document.createElement("textarea");
    area.value = texto;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
      toast("Enlace copiado");
    } catch {
      toast("No se pudo copiar, selecciona el enlace manualmente", true);
    }
    area.remove();
  }
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */

function conectarEventos() {
  $("#grid").addEventListener("click", (evento) => {
    const celda = evento.target.closest(".num");
    if (!celda) return;
    const numero = Number(celda.dataset.n);
    const fila = App.mapa.get(numero);
    if (!fila) return;
    if (fila.estado === "disponible") alternarSeleccion(numero);
    else cargarDetalle(numero, true);
  });

  $("#buscar").addEventListener("input", (evento) => {
    App.filtro = evento.target.value;
    aplicarFiltro();
  });

  $("#btnAsignar").addEventListener("click", abrirAsignacion);
  $("#btnLimpiarSel").addEventListener("click", () => {
    App.seleccion.clear();
    $$("#grid .num.sel").forEach((el) => el.classList.remove("sel"));
    actualizarBarraSeleccion();
  });

  $("#asigAbono").addEventListener("input", actualizarResumenAsignar);
  $$(".quick-montos .mini").forEach((boton) => {
    boton.addEventListener("click", () => {
      const valor = boton.dataset.monto === "precio" ? App.datos.config.precio : Number(boton.dataset.monto);
      $("#asigAbono").value = valor;
      actualizarResumenAsignar();
      boton.classList.add("activo");
    });
  });

  $("#formAsignar").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const boton = $("#btnConfirmarAsignar");
    boton.disabled = true;
    try {
      const resultado = await api("/api/asignar", {
        numeros: Array.from(App.seleccion),
        nombre: $("#asigNombre").value,
        telefono: $("#asigTelefono").value,
        nota: $("#asigNota").value,
        abono_por_numero: Number($("#asigAbono").value) || 0,
      });
      App.seleccion.clear();
      aplicarEstado(resultado.estado);
      actualizarBarraSeleccion();
      cerrarModal("#modalAsignar");
      toast("Números asignados correctamente");
    } catch (error) {
      toast(error.message, true);
      cargarEstado();
    } finally {
      boton.disabled = false;
    }
  });

  $("#btnAbonar").addEventListener("click", async () => {
    if (!App.detalle) return;
    const monto = Number($("#detMonto").value) || 0;
    if (monto <= 0) {
      toast("Escribe un monto mayor que cero", true);
      return;
    }
    try {
      const resultado = await api("/api/abono", { numero: App.detalle, monto });
      aplicarEstado(resultado.estado);
      await cargarDetalle(App.detalle, false);
      toast("Abono registrado");
    } catch (error) {
      toast(error.message, true);
    }
  });

  $("#btnPagarSaldo").addEventListener("click", () => {
    const saldo = Number($("#btnPagarSaldo").dataset.saldo) || 0;
    $("#detMonto").value = saldo;
    $("#detMonto").focus();
  });

  $("#formEditar").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    if (!App.detalle) return;
    try {
      const resultado = await api("/api/editar", {
        numero: App.detalle,
        nombre: $("#editNombre").value,
        telefono: $("#editTelefono").value,
        nota: $("#editNota").value,
      });
      aplicarEstado(resultado.estado);
      await cargarDetalle(App.detalle, false);
      toast("Datos actualizados");
    } catch (error) {
      toast(error.message, true);
    }
  });

  $("#btnLiberar").addEventListener("click", async () => {
    if (!App.detalle) return;
    const numero = App.detalle;
    if (!confirm(`¿Liberar el número ${numero}?\n\nSe borrarán los datos del comprador y el número quedará disponible.`)) return;
    try {
      const resultado = await api("/api/liberar", { numeros: [numero] });
      App.detalle = null;
      aplicarEstado(resultado.estado);
      cerrarModal("#modalDetalle");
      toast(`Número ${numero} liberado`);
    } catch (error) {
      toast(error.message, true);
    }
  });

  $("#btnSortear").addEventListener("click", realizarSorteo);

  $("#historialSorteos").addEventListener("click", async (evento) => {
    const boton = evento.target.closest("[data-borrar-sorteo]");
    if (!boton) return;
    const id = Number(boton.dataset.borrarSorteo);
    if (!confirm("¿Eliminar este sorteo del historial?\n\nSolo se borra el registro del sorteo; los números y los pagos no cambian.")) return;
    boton.disabled = true;
    try {
      const resultado = await api("/api/sorteo/eliminar", { id });
      $("#resultadoSorteo").classList.add("hidden");
      aplicarEstado(resultado.estado);
      toast("Sorteo eliminado del historial");
    } catch (error) {
      boton.disabled = false;
      toast(error.message, true);
      cargarEstado();
    }
  });

  $("#btnConfig").addEventListener("click", abrirConfiguracion);
  $("#formConfig").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    try {
      const resultado = await api("/api/config", {
        rifa_nombre: $("#cfgNombre").value,
        premio: $("#cfgPremio").value,
        total_numeros: Number($("#cfgTotal").value),
        precio: Number($("#cfgPrecio").value),
        moneda: $("#cfgMoneda").value,
      });
      aplicarEstado(resultado.estado);
      cerrarModal("#modalConfig");
      toast("Configuración guardada");
    } catch (error) {
      toast(error.message, true);
    }
  });

  $("#btnCompartir").addEventListener("click", abrirCompartir);
  $("#btnExportar").addEventListener("click", () => { window.location.href = "/api/export.csv"; });
  $("#btnRespaldo").addEventListener("click", () => { window.location.href = "/api/respaldo"; });

  $("#modalCompartir").addEventListener("click", (evento) => {
    const boton = evento.target.closest("[data-copiar]");
    if (boton) copiarTexto(boton.dataset.copiar);
  });

  // Cerrar modales
  $$("[data-cerrar]").forEach((boton) => {
    boton.addEventListener("click", () => {
      cerrarModal(boton.dataset.cerrar);
      if (boton.dataset.cerrar === "#modalDetalle") App.detalle = null;
    });
  });

  $$(".modal-backdrop").forEach((fondo) => {
    fondo.addEventListener("click", (evento) => {
      if (evento.target !== fondo) return;
      const id = `#${fondo.id}`;
      cerrarModal(id);
      if (id === "#modalDetalle") App.detalle = null;
    });
  });

  document.addEventListener("keydown", (evento) => {
    if (evento.key !== "Escape") return;
    const abierto = $$(".modal-backdrop:not(.hidden)").pop();
    if (!abierto) return;
    cerrarModal(`#${abierto.id}`);
    if (abierto.id === "modalDetalle") App.detalle = null;
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) cargarEstado();
  });
}

/* ------------------------------------------------------------------ */
/* Inicio                                                              */
/* ------------------------------------------------------------------ */

async function iniciar() {
  conectarEventos();
  await cargarEstado();
  setInterval(() => {
    if (!document.hidden) cargarEstado();
  }, 3000);
}

document.addEventListener("DOMContentLoaded", iniciar);
