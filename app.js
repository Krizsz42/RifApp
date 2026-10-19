"use strict";

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => Array.from(raiz.querySelectorAll(sel));

const CONFIG = window.RIFA_CONFIG || {};
const CLAVES = {
  token: "rifaApp.token",
  expira: "rifaApp.expira",
  dispositivo: "rifaApp.dispositivo",
};

const App = {
  datos: null,
  mapa: new Map(),
  version: null,
  seleccion: new Set(),
  filtro: "",
  detalle: null,
  conexion: false,
  cargando: true,
  tiempoReal: false,
  ultimaCarga: 0,
  sorteando: false,
  ultimoSorteoId: null,
  admin: false,
  token: null,
  dispositivo: "",
  canal: null,
  errorCargaMostrado: false,
};

let cliente = null;
let temporizadorRefresco = null;

const formatoNumero = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 });
const formatoFecha = new Intl.DateTimeFormat("es-CL", {
  dateStyle: "short",
  timeStyle: "short",
});

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

// Debe coincidir con private.clave_persona() en Supabase: teléfono si existe;
// si no, nombre normalizado. Se usa solo para la animación previa al sorteo;
// la decisión final siempre la toma la función RPC.
function clavePersona(nombre, telefono) {
  const tel = String(telefono ?? "").replace(/\D/g, "");
  if (tel) return `tel:${tel}`;
  const nom = norm(nombre).replace(/[^a-z0-9]/g, "");
  return nom ? `nom:${nom}` : null;
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
  toast._t = setTimeout(() => el.classList.remove("visible"), 3800);
}

function abrirModal(selector) {
  const el = $(selector);
  if (!el) return;
  el.classList.remove("hidden");
  document.body.classList.add("sin-scroll");
}

function cerrarModal(selector) {
  const el = $(selector);
  if (!el) return;
  el.classList.add("hidden");
  if (!$$(".modal-backdrop:not(.hidden)").length) {
    document.body.classList.remove("sin-scroll");
  }
}

/* ------------------------------------------------------------------ */
/* Supabase                                                            */
/* ------------------------------------------------------------------ */

function leer(clave) {
  try {
    return localStorage.getItem(clave);
  } catch {
    return null;
  }
}

function guardar(clave, valor) {
  try {
    localStorage.setItem(clave, valor);
  } catch {
    /* El navegador puede bloquear localStorage; la app sigue funcionando. */
  }
}

function borrar(clave) {
  try {
    localStorage.removeItem(clave);
  } catch {
    /* nada */
  }
}

function obtenerDispositivo() {
  let dispositivo = leer(CLAVES.dispositivo);
  if (dispositivo) return dispositivo;

  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    dispositivo = window.crypto.randomUUID();
  } else {
    dispositivo = `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  guardar(CLAVES.dispositivo, dispositivo);
  return dispositivo;
}

function inicializarCliente() {
  const url = String(CONFIG.SUPABASE_URL || "").trim();
  const clave = String(CONFIG.SUPABASE_ANON_KEY || "").trim();

  if (
    !url ||
    !clave ||
    url.includes("TU-PROYECTO") ||
    clave.includes("TU_ANON_KEY") ||
    !window.supabase ||
    typeof window.supabase.createClient !== "function"
  ) {
    return false;
  }

  try {
    cliente = window.supabase.createClient(url, clave, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      realtime: {
        params: { eventsPerSecond: 5 },
      },
    });
    return true;
  } catch (error) {
    console.error("No se pudo crear el cliente de Supabase:", error);
    return false;
  }
}

async function rpc(nombre, parametros = {}) {
  if (!cliente) throw new Error("Supabase no está configurado");

  const { data, error } = await cliente.rpc(nombre, parametros);

  if (error) {
    if (error.code === "28000") limpiarSesion(false);

    const fallo = new Error(error.message || "No se pudo completar la operación");
    fallo.code = error.code;
    throw fallo;
  }

  // Algunas RPC devuelven ok:false (por ejemplo, PIN incorrecto) en vez de
  // lanzar una excepción, para que el intento quede registrado en Supabase.
  if (data && data.ok === false) {
    const fallo = new Error(data.error || "No se pudo completar la operación");
    fallo.code = data.code;
    throw fallo;
  }

  return data;
}

/* ------------------------------------------------------------------ */
/* Sesión de administrador                                             */
/* ------------------------------------------------------------------ */

function tokenVigente() {
  const expira = leer(CLAVES.expira);
  if (!expira) return true;
  const fecha = Date.parse(expira);
  return Number.isNaN(fecha) || fecha > Date.now();
}

function guardarSesion(datos) {
  App.token = datos.token;
  App.admin = true;

  guardar(CLAVES.token, datos.token);
  if (datos.expira) guardar(CLAVES.expira, datos.expira);

  actualizarInterfazAdmin();
}

function limpiarSesion(avisar = false) {
  App.token = null;
  App.admin = false;
  App.seleccion.clear();
  $$("#grid .num.sel").forEach((el) => el.classList.remove("sel"));

  borrar(CLAVES.token);
  borrar(CLAVES.expira);
  actualizarInterfazAdmin();
  actualizarBarraSeleccion();

  if (avisar) toast("Sesión de administrador cerrada");
}

function actualizarInterfazAdmin() {
  document.body.classList.toggle("es-admin", App.admin);

  const boton = $("#btnAdmin");
  if (boton) {
    boton.textContent = App.admin ? "👤 Admin" : "🔒 Entrar";
    boton.classList.toggle("activo", App.admin);
  }

  $("#adminLogin")?.classList.toggle("hidden", App.admin);
  $("#adminPanel")?.classList.toggle("hidden", !App.admin);

  const expira = leer(CLAVES.expira);
  const elExpira = $("#adminExpira");
  if (elExpira) {
    const fecha = expira ? new Date(expira) : null;
    elExpira.textContent =
      App.admin && fecha && !Number.isNaN(fecha.getTime())
        ? `Cierre automático de sesión: ${formatoFecha.format(fecha)}`
        : "";
  }
}

async function validarSesionGuardada() {
  if (!App.token) return;

  try {
    const valida = await rpc("validar_sesion", { p_token: App.token });
    if (!valida) {
      limpiarSesion(false);
      return;
    }
    App.admin = true;
    actualizarInterfazAdmin();
  } catch (error) {
    // Si es un problema de red conservamos el token y reintentamos al recargar.
    if (error.code === "28000") limpiarSesion(false);
  }
}

function abrirAdmin() {
  actualizarInterfazAdmin();
  abrirModal("#modalAdmin");
  if (!App.admin) setTimeout(() => $("#adminPin")?.focus(), 60);
}

async function entrarAdmin() {
  const pin = $("#adminPin").value;
  if (!pin) {
    toast("Escribe el PIN", true);
    return;
  }

  const boton = $("#btnEntrarPin");
  boton.disabled = true;

  try {
    const datos = await rpc("verificar_pin", {
      p_pin: pin,
      p_dispositivo: App.dispositivo,
    });

    guardarSesion(datos);
    $("#formLogin").reset();
    cerrarModal("#modalAdmin");
    toast("Modo administrador activado");
  } catch (error) {
    toast(error.message, true);
  } finally {
    boton.disabled = false;
  }
}

async function salirAdmin() {
  const token = App.token;
  limpiarSesion(false);
  cerrarModal("#modalAdmin");
  toast("Sesión de administrador cerrada");

  if (token) {
    try {
      await rpc("cerrar_sesion", { p_token: token });
    } catch {
      /* La sesión local ya quedó cerrada. */
    }
  }
}

async function cambiarPin(evento) {
  evento.preventDefault();

  if (!App.admin) {
    abrirAdmin();
    return;
  }

  const actual = $("#pinActual").value;
  const nuevo = $("#pinNuevo").value;
  const nuevo2 = $("#pinNuevo2").value;

  if (nuevo.length < 6) {
    toast("El PIN nuevo debe tener al menos 6 caracteres", true);
    return;
  }

  if (nuevo !== nuevo2) {
    toast("Los dos PIN nuevos no coinciden", true);
    return;
  }

  const boton = evento.target.querySelector("button[type=submit]");
  boton.disabled = true;

  try {
    const datos = await rpc("cambiar_pin", {
      p_token: App.token,
      p_pin_actual: actual,
      p_pin_nuevo: nuevo,
    });

    guardarSesion(datos);
    $("#formCambiarPin").reset();
    toast("PIN actualizado. Las otras sesiones se cerraron.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    boton.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Carga y pintado del estado                                          */
/* ------------------------------------------------------------------ */

function marcarConexion(ok) {
  App.conexion = Boolean(ok);
  App.cargando = false;
  actualizarIndicadorConexion();
}

function marcarTiempoReal(ok) {
  App.tiempoReal = Boolean(ok);
  actualizarIndicadorConexion();
}

function actualizarIndicadorConexion() {
  const el = $("#estadoConexion");
  if (!el) return;

  let texto = "● Conectando…";
  let clase = "";

  if (!cliente) {
    texto = "● Falta configurar";
    clase = "offline";
  } else if (App.cargando) {
    texto = "● Conectando…";
    clase = "";
  } else if (!App.conexion) {
    texto = "● Sin conexión";
    clase = "offline";
  } else if (App.tiempoReal) {
    texto = "● En vivo";
    clase = "online";
  } else {
    texto = "● En línea";
    clase = "online";
  }

  el.textContent = texto;
  el.classList.toggle("online", clase === "online");
  el.classList.toggle("offline", clase === "offline");
}

async function cargarEstado() {
  if (!cliente) return;

  try {
    const datos = await rpc("estado_rifa");
    aplicarEstado(datos);
    marcarConexion(true);
    App.ultimaCarga = Date.now();
    App.errorCargaMostrado = false;
  } catch (error) {
    marcarConexion(false);

    if (!App.errorCargaMostrado) {
      App.errorCargaMostrado = true;
      toast(
        error.message
          ? `No se pudo cargar la rifa: ${error.message}`
          : "No se pudo cargar la rifa",
        true
      );
    }
    console.error("Error al cargar la rifa:", error);
  }
}

function aplicarEstado(datos) {
  if (!datos || !Array.isArray(datos.numeros)) {
    throw new Error("La respuesta de Supabase no tiene el formato esperado");
  }

  // Evita que una respuesta lenta y vieja pise un estado más reciente.
  const versionRecibida = Number(datos.version);
  if (
    App.version !== null &&
    Number.isFinite(versionRecibida) &&
    versionRecibida < Number(App.version)
  ) {
    return;
  }

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
  const premios = App.datos.premios || [];
  document.title = cfg.rifa_nombre || "Rifa";
  $("#tituloRifa").textContent = cfg.rifa_nombre || "Rifa";

  const partes = [];
  if (premios.length) {
    const pendientes = premios.filter((p) => !p.sorteo_id).length;
    partes.push(
      `${pendientes} de ${premios.length} premio${premios.length === 1 ? "" : "s"} por sortear`
    );
  } else if (cfg.premio) {
    partes.push(`Premio: ${cfg.premio}`);
  }
  partes.push(`${cfg.total_numeros} números`);
  partes.push(`${dinero(cfg.precio)} por número`);
  $("#subtituloRifa").textContent = partes.join(" · ");

  renderStats();
  renderGrid();
  renderPremios();
  renderHistorialSorteos();
  sincronizarResultadoSorteo();
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

function renderPremios() {
  const premios = App.datos.premios || [];
  const sorteos = App.datos.sorteos || [];
  const cont = $("#listaPremios");
  const resumen = $("#premiosResumen");
  if (!cont) return;

  const sorteados = premios.filter((p) => p.sorteo_id).length;
  const pendientes = premios.length - sorteados;

  if (resumen) {
    resumen.textContent = premios.length
      ? `${pendientes} pendiente${pendientes === 1 ? "" : "s"} · ${sorteados} sorteado${sorteados === 1 ? "" : "s"}`
      : "";
  }

  if (!premios.length) {
    cont.innerHTML = `<p class="muted small">Todavía no hay premios en la lista.${App.admin ? " Agrega el primero arriba." : ""} Se usará el premio general de la configuración.</p>`;
    renderSelectPremio();
    return;
  }

  cont.innerHTML = premios.map((p) => {
    const sorteo = p.sorteo_id
      ? sorteos.find((s) => Number(s.id) === Number(p.sorteo_id))
      : null;
    const detalle = p.sorteo_id
      ? sorteo
        ? `Ganado por #${sorteo.numero} — ${esc(sorteo.nombre)}`
        : "Sorteado"
      : "Pendiente";
    const acciones = p.sorteo_id
      ? ""
      : `<button type="button" class="mini" data-editar-premio="${p.id}">Editar</button>
         <button type="button" class="mini danger" data-borrar-premio="${p.id}">Eliminar</button>`;
    return `
      <div class="premio-item${p.sorteo_id ? " sorteado" : ""}">
        <div class="premio-info">
          <strong>${esc(p.nombre)}</strong>
          <span class="muted">${detalle}</span>
        </div>
        <div class="premio-acciones solo-admin">${acciones}</div>
      </div>`;
  }).join("");

  renderSelectPremio();
}

function renderSelectPremio() {
  const select = $("#sorteoPremio");
  if (!select) return;

  const premios = App.datos?.premios || [];
  const pendientes = premios.filter((p) => !p.sorteo_id);
  const anterior = select.value;

  if (premios.length) {
    if (pendientes.length) {
      select.innerHTML =
        `<option value="">Selecciona un premio…</option>` +
        pendientes.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join("");
      if (anterior && pendientes.some((p) => String(p.id) === anterior)) {
        select.value = anterior;
      } else {
        select.value = String(pendientes[0].id);
      }
    } else {
      select.innerHTML = `<option value="">No quedan premios pendientes</option>`;
    }
  } else {
    const general = String(App.datos?.config?.premio || "").trim();
    select.innerHTML = `<option value="">Premio general${general ? `: ${esc(general)}` : ""}</option>`;
  }

  select.disabled = !pendientes.length;

  const boton = $("#btnSortear");
  if (boton && !App.sorteando) {
    const habilitado = pendientes.length > 0 || premios.length === 0;
    boton.disabled = !habilitado;
    boton.title = habilitado
      ? ""
      : "Agrega un premio o elimina un sorteo del historial para volver a sortear";
  }
}

function sincronizarResultadoSorteo() {
  const panel = $("#resultadoSorteo");
  const input = $("#excluirGanador");
  if (!panel || !input || panel.classList.contains("hidden") || !App.ultimoSorteoId) return;

  const sorteo = (App.datos?.sorteos || []).find(
    (s) => Number(s.id) === Number(App.ultimoSorteoId)
  );

  if (!sorteo) {
    panel.classList.add("hidden");
    App.ultimoSorteoId = null;
    return;
  }

  input.checked = Boolean(sorteo.excluir_siguiente);
  input.dataset.id = String(sorteo.id);
  input.disabled = false;
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
      <div class="sorteo-datos">
        <strong>${esc(s.nombre)}</strong>
        <span class="muted">${esc(s.fecha)}</span>
        ${s.premio ? `<span class="sorteo-premio">🏆 ${esc(s.premio)}</span>` : ""}
      </div>
      ${s.excluir_siguiente ? `<span class="etiqueta-no-repite solo-public">No repite</span>` : ""}
      <div class="sorteo-acciones">
        <label class="check mini-check solo-admin" title="Si está marcado, esta persona no participa en los próximos sorteos">
          <input type="checkbox" data-excluir-sorteo="${s.id}" ${s.excluir_siguiente ? "checked" : ""}>
          <span>No repite</span>
        </label>
        <button type="button" class="borrar-sorteo solo-admin" data-borrar-sorteo="${s.id}" title="Eliminar este sorteo del historial" aria-label="Eliminar sorteo">🗑</button>
      </div>
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
  if (!App.admin) {
    abrirAdmin();
    return;
  }
  if (!App.seleccion.size || !App.datos) return;

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
    const datos = await rpc("detalle_numero", { p_numero: numero });
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
  if (!App.admin) {
    abrirAdmin();
    return;
  }
  if (App.sorteando || !App.datos) return;

  const soloPagados = $("#soloPagados").checked;
  const premios = App.datos.premios || [];
  const premioId = premios.length
    ? Number($("#sorteoPremio")?.value || 0)
    : null;
  const premio = premioId
    ? premios.find((p) => Number(p.id) === premioId && !p.sorteo_id)
    : null;

  if (premios.length && !premio) {
    toast("Selecciona el premio que vas a sortear", true);
    return;
  }

  const base = App.datos.numeros.filter((n) =>
    soloPagados ? n.estado === "pagado" : n.estado !== "disponible"
  );

  if (!base.length) {
    toast(soloPagados ? "No hay números pagados para sortear" : "Todavía no hay números vendidos", true);
    return;
  }

  // Refleja en la animación la misma exclusión que aplica el servidor.
  const excluidos = new Set(
    (App.datos.sorteos || [])
      .filter((s) => s.excluir_siguiente)
      .map((s) => clavePersona(s.nombre, s.telefono))
      .filter(Boolean)
  );
  const candidatos = base.filter((n) => {
    const clave = clavePersona(n.nombre, n.telefono);
    return !clave || !excluidos.has(clave);
  });

  if (!candidatos.length) {
    toast(
      'Todos los números para este sorteo ya ganaron. Desmarca "No repite" en el historial o agrega más números.',
      true
    );
    return;
  }

  App.sorteando = true;
  const boton = $("#btnSortear");
  boton.disabled = true;

  const panel = $("#resultadoSorteo");
  const numEl = $("#ganadorNumero");
  const nomEl = $("#ganadorNombre");
  const extraEl = $("#ganadorExtra");
  const excluirEl = $("#excluirGanador");
  panel.classList.remove("hidden");
  numEl.textContent = "—";
  nomEl.textContent = "";
  extraEl.textContent = "Sorteando…";
  excluirEl.checked = false;
  excluirEl.disabled = true;
  excluirEl.dataset.id = "";

  let indice = Math.floor(Math.random() * candidatos.length);
  const intervalo = setInterval(() => {
    indice = (indice + 1) % candidatos.length;
    numEl.textContent = candidatos[indice].numero;
    nomEl.textContent = candidatos[indice].nombre;
  }, 70);

  const inicio = Date.now();
  try {
    const parametros = {
      p_token: App.token,
      p_solo_pagados: soloPagados,
    };
    if (premioId) parametros.p_premio_id = premioId;

    const resultado = await rpc("realizar_sorteo", parametros);

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

    App.ultimoSorteoId = ganador.id;
    excluirEl.checked = Boolean(ganador.excluir_siguiente);
    excluirEl.disabled = false;
    excluirEl.dataset.id = String(ganador.id);

    aplicarEstado(resultado.estado);
    toast(`¡Ganador: número ${ganador.numero} — ${ganador.nombre}!`);
  } catch (error) {
    clearInterval(intervalo);
    panel.classList.add("hidden");
    App.ultimoSorteoId = null;
    toast(error.message, true);
  } finally {
    App.sorteando = false;
    renderSelectPremio();
  }
}

async function actualizarExclusionSorteo(id, excluir, input) {
  if (!App.admin) {
    if (input) input.checked = !excluir;
    abrirAdmin();
    return;
  }
  if (!id) return;

  if (input) input.disabled = true;

  try {
    const resultado = await rpc("actualizar_exclusion_sorteo", {
      p_token: App.token,
      p_id: id,
      p_excluir: excluir,
    });
    aplicarEstado(resultado.estado);
    toast(
      excluir
        ? "Ese ganador no participará en los próximos sorteos"
        : "Ese ganador podrá volver a participar"
    );
  } catch (error) {
    if (input) input.checked = !excluir;
    toast(error.message, true);
    cargarEstado();
  } finally {
    if (input) input.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Configuración, compartir, exportar y respaldo                       */
/* ------------------------------------------------------------------ */

function abrirConfiguracion() {
  if (!App.admin) {
    abrirAdmin();
    return;
  }
  if (!App.datos) {
    toast("La rifa todavía se está cargando", true);
    return;
  }
  const cfg = App.datos.config;
  $("#cfgNombre").value = cfg.rifa_nombre;
  $("#cfgPremio").value = cfg.premio || "";
  $("#cfgTotal").value = cfg.total_numeros;
  $("#cfgPrecio").value = cfg.precio;
  $("#cfgMoneda").value = cfg.moneda || "";
  abrirModal("#modalConfig");
}

function abrirCompartir() {
  const url = window.location.href.split("#")[0];
  $("#listaEnlaces").innerHTML = `
    <div class="enlace-item">
      <code>${esc(url)}</code>
      <button type="button" class="mini" data-copiar="${esc(url)}">Copiar</button>
    </div>`;
  abrirModal("#modalCompartir");
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

function marcaArchivo(extension) {
  const d = new Date();
  const dos = (n) => String(n).padStart(2, "0");
  return `rifa-${d.getFullYear()}${dos(d.getMonth() + 1)}${dos(d.getDate())}-${dos(d.getHours())}${dos(d.getMinutes())}.${extension}`;
}

function descargar(contenido, tipo, nombre) {
  const blob = new Blob([contenido], { type: tipo });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportarCSV() {
  if (!App.admin) {
    abrirAdmin();
    return;
  }
  if (!App.datos) return;

  const cfg = App.datos.config;
  const campo = (valor) => `"${String(valor ?? "").replace(/"/g, '""')}"`;
  const filas = [];

  filas.push(
    ["Numero", "Estado", "Nombre", "Telefono", "Precio", "Abonado", "Saldo", "Nota", "Actualizado"]
      .map(campo)
      .join(";")
  );

  for (const n of App.datos.numeros) {
    filas.push(
      [
        n.numero,
        n.estado,
        n.nombre,
        n.telefono,
        cfg.precio,
        n.abonado,
        n.saldo,
        n.nota,
        n.actualizado,
      ].map(campo).join(";")
    );
  }

  descargar(
    "\uFEFFsep=;\r\n" + filas.join("\r\n"),
    "text/csv;charset=utf-8",
    marcaArchivo("csv")
  );
  toast("CSV exportado");
}

async function descargarRespaldo() {
  if (!App.admin) {
    abrirAdmin();
    return;
  }

  try {
    const datos = await rpc("respaldo_rifa", { p_token: App.token });
    descargar(
      JSON.stringify(datos, null, 2),
      "application/json;charset=utf-8",
      marcaArchivo("json")
    );
    toast("Respaldo descargado");
  } catch (error) {
    toast(error.message, true);
  }
}

/* ------------------------------------------------------------------ */
/* Tiempo real                                                         */
/* ------------------------------------------------------------------ */

function programarRefresco() {
  clearTimeout(temporizadorRefresco);
  temporizadorRefresco = setTimeout(() => cargarEstado(), 180);
}

function conectarTiempoReal() {
  if (!cliente) return;

  if (App.canal) {
    cliente.removeChannel(App.canal);
    App.canal = null;
  }

  marcarTiempoReal(false);

  App.canal = cliente
    .channel("rifa-cambios")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "numeros" },
      programarRefresco
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "config" },
      programarRefresco
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "sorteos" },
      programarRefresco
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "premios" },
      programarRefresco
    )
    .subscribe((estado) => {
      if (estado === "SUBSCRIBED") {
        marcarTiempoReal(true);
        programarRefresco();
      } else if (estado === "CHANNEL_ERROR" || estado === "TIMED_OUT" || estado === "CLOSED") {
        marcarTiempoReal(false);
      }
    });
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

    if (fila.estado === "disponible") {
      if (!App.admin) {
        toast("Vista pública: para apartar un número, contacta al organizador", true);
        return;
      }
      alternarSeleccion(numero);
    } else {
      cargarDetalle(numero, true);
    }
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
    if (!App.admin) {
      abrirAdmin();
      return;
    }

    const boton = $("#btnConfirmarAsignar");
    boton.disabled = true;
    try {
      const resultado = await rpc("asignar_numeros", {
        p_token: App.token,
        p_numeros: Array.from(App.seleccion),
        p_nombre: $("#asigNombre").value,
        p_telefono: $("#asigTelefono").value,
        p_nota: $("#asigNota").value,
        p_abono: Number($("#asigAbono").value) || 0,
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
    if (!App.admin) {
      abrirAdmin();
      return;
    }
    if (!App.detalle) return;

    const monto = Number($("#detMonto").value) || 0;
    if (monto <= 0) {
      toast("Escribe un monto mayor que cero", true);
      return;
    }

    const boton = $("#btnAbonar");
    boton.disabled = true;

    try {
      const resultado = await rpc("registrar_abono", {
        p_token: App.token,
        p_numero: App.detalle,
        p_monto: monto,
      });
      aplicarEstado(resultado.estado);
      await cargarDetalle(App.detalle, false);
      toast("Abono registrado");
    } catch (error) {
      toast(error.message, true);
    } finally {
      boton.disabled = false;
    }
  });

  $("#btnPagarSaldo").addEventListener("click", () => {
    const saldo = Number($("#btnPagarSaldo").dataset.saldo) || 0;
    $("#detMonto").value = saldo;
    $("#detMonto").focus();
  });

  $("#formEditar").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    if (!App.admin) {
      abrirAdmin();
      return;
    }
    if (!App.detalle) return;

    const boton = evento.target.querySelector("button[type=submit]");
    boton.disabled = true;

    try {
      const resultado = await rpc("editar_numero", {
        p_token: App.token,
        p_numero: App.detalle,
        p_nombre: $("#editNombre").value,
        p_telefono: $("#editTelefono").value,
        p_nota: $("#editNota").value,
      });
      aplicarEstado(resultado.estado);
      await cargarDetalle(App.detalle, false);
      toast("Datos actualizados");
    } catch (error) {
      toast(error.message, true);
    } finally {
      boton.disabled = false;
    }
  });

  $("#btnLiberar").addEventListener("click", async () => {
    if (!App.admin) {
      abrirAdmin();
      return;
    }
    if (!App.detalle) return;

    const numero = App.detalle;
    if (!confirm(`¿Liberar el número ${numero}?\n\nSe borrarán los datos del comprador y sus abonos. El número quedará disponible.`)) return;

    const boton = $("#btnLiberar");
    boton.disabled = true;

    try {
      const resultado = await rpc("liberar_numeros", {
        p_token: App.token,
        p_numeros: [numero],
      });
      App.detalle = null;
      aplicarEstado(resultado.estado);
      cerrarModal("#modalDetalle");
      toast(`Número ${numero} liberado`);
    } catch (error) {
      toast(error.message, true);
    } finally {
      boton.disabled = false;
    }
  });

  $("#formPremio").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    if (!App.admin) {
      abrirAdmin();
      return;
    }

    const nombre = $("#nuevoPremio").value.trim();
    if (!nombre) {
      toast("Escribe el nombre del premio", true);
      return;
    }

    const boton = $("#btnAgregarPremio");
    boton.disabled = true;

    try {
      const resultado = await rpc("agregar_premio", {
        p_token: App.token,
        p_nombre: nombre,
      });
      $("#formPremio").reset();
      aplicarEstado(resultado.estado);
      const select = $("#sorteoPremio");
      if (select && resultado.id) select.value = String(resultado.id);
      toast("Premio agregado a la lista");
    } catch (error) {
      toast(error.message, true);
    } finally {
      boton.disabled = false;
    }
  });

  $("#listaPremios").addEventListener("click", async (evento) => {
    const botonEditar = evento.target.closest("[data-editar-premio]");
    const botonBorrar = evento.target.closest("[data-borrar-premio]");

    if (botonEditar) {
      if (!App.admin) {
        abrirAdmin();
        return;
      }
      const id = Number(botonEditar.dataset.editarPremio);
      const premio = (App.datos?.premios || []).find((p) => Number(p.id) === id);
      if (!premio) return;

      const nombre = prompt("Nuevo nombre del premio:", premio.nombre);
      if (nombre === null) return;

      const limpio = nombre.trim();
      if (!limpio) {
        toast("El nombre del premio no puede quedar vacío", true);
        return;
      }
      if (limpio === premio.nombre) return;

      botonEditar.disabled = true;
      try {
        const resultado = await rpc("editar_premio", {
          p_token: App.token,
          p_id: id,
          p_nombre: limpio,
        });
        aplicarEstado(resultado.estado);
        toast("Premio actualizado");
      } catch (error) {
        toast(error.message, true);
      } finally {
        botonEditar.disabled = false;
      }
      return;
    }

    if (botonBorrar) {
      if (!App.admin) {
        abrirAdmin();
        return;
      }
      const id = Number(botonBorrar.dataset.borrarPremio);
      const premio = (App.datos?.premios || []).find((p) => Number(p.id) === id);
      if (!premio) return;
      if (!confirm(`¿Eliminar el premio "${premio.nombre}" de la lista?`)) return;

      botonBorrar.disabled = true;
      try {
        const resultado = await rpc("eliminar_premio", {
          p_token: App.token,
          p_id: id,
        });
        aplicarEstado(resultado.estado);
        toast("Premio eliminado");
      } catch (error) {
        toast(error.message, true);
      } finally {
        botonBorrar.disabled = false;
      }
    }
  });

  $("#btnSortear").addEventListener("click", realizarSorteo);

  $("#excluirGanador").addEventListener("change", (evento) => {
    const input = evento.target;
    const id = Number(input.dataset.id || App.ultimoSorteoId || 0);
    actualizarExclusionSorteo(id, input.checked, input);
  });

  $("#historialSorteos").addEventListener("change", (evento) => {
    const input = evento.target.closest("[data-excluir-sorteo]");
    if (!input) return;
    actualizarExclusionSorteo(Number(input.dataset.excluirSorteo), input.checked, input);
  });

  $("#historialSorteos").addEventListener("click", async (evento) => {
    const boton = evento.target.closest("[data-borrar-sorteo]");
    if (!boton) return;
    if (!App.admin) {
      abrirAdmin();
      return;
    }

    const id = Number(boton.dataset.borrarSorteo);
    if (!confirm("¿Eliminar este sorteo del historial?\n\nSolo se borra el registro del sorteo; los números y los pagos no cambian. Si tenía un premio de la lista, vuelve a quedar pendiente.")) return;

    boton.disabled = true;
    try {
      const resultado = await rpc("eliminar_sorteo", {
        p_token: App.token,
        p_id: id,
      });
      if (Number(App.ultimoSorteoId) === id) {
        App.ultimoSorteoId = null;
        $("#resultadoSorteo").classList.add("hidden");
      }
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
    if (!App.admin) {
      abrirAdmin();
      return;
    }

    const boton = evento.target.querySelector("button[type=submit]");
    boton.disabled = true;

    try {
      const resultado = await rpc("guardar_config", {
        p_token: App.token,
        p_rifa_nombre: $("#cfgNombre").value,
        p_premio: $("#cfgPremio").value,
        p_total_numeros: Number($("#cfgTotal").value),
        p_precio: Number($("#cfgPrecio").value),
        p_moneda: $("#cfgMoneda").value,
      });
      aplicarEstado(resultado.estado);
      cerrarModal("#modalConfig");
      toast("Configuración guardada");
    } catch (error) {
      toast(error.message, true);
    } finally {
      boton.disabled = false;
    }
  });

  $("#btnCompartir").addEventListener("click", abrirCompartir);
  $("#btnExportar").addEventListener("click", exportarCSV);
  $("#btnRespaldo").addEventListener("click", descargarRespaldo);

  $("#btnAdmin").addEventListener("click", abrirAdmin);
  $("#formLogin").addEventListener("submit", (evento) => {
    evento.preventDefault();
    entrarAdmin();
  });
  $("#formCambiarPin").addEventListener("submit", cambiarPin);
  $("#btnSalirAdmin").addEventListener("click", salirAdmin);

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

  window.addEventListener("online", () => cargarEstado());
  window.addEventListener("offline", () => marcarConexion(false));
}

/* ------------------------------------------------------------------ */
/* Inicio                                                              */
/* ------------------------------------------------------------------ */

async function iniciar() {
  conectarEventos();

  App.dispositivo = obtenerDispositivo();

  if (!inicializarCliente()) {
    $("#avisoConfig").classList.remove("hidden");
    actualizarInterfazAdmin();
    actualizarIndicadorConexion();
    return;
  }

  App.token = leer(CLAVES.token);
  App.admin = Boolean(App.token) && tokenVigente();

  if (App.token && !App.admin) limpiarSesion(false);

  actualizarInterfazAdmin();
  actualizarIndicadorConexion();

  await validarSesionGuardada();
  await cargarEstado();
  conectarTiempoReal();

  // Respaldo periódico si el canal de tiempo real no está activo, si hubo
  // un error de red o, cada 5 minutos, como red de seguridad.
  setInterval(() => {
    const viejo = !App.ultimaCarga || Date.now() - App.ultimaCarga > 300000;
    if (!document.hidden && (!App.tiempoReal || !App.conexion || viejo)) cargarEstado();
  }, 30000);
}

document.addEventListener("DOMContentLoaded", iniciar);
