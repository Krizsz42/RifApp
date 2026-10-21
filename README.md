# RifApp 🎟️

Rifa online con actualización en tiempo real. Funciona desde cualquier
dispositivo con internet, sin tener que iniciar un servidor en tu PC.

- **Sitio:** Netlify (HTML, CSS y JavaScript estáticos).
- **Datos:** Supabase (PostgreSQL + Realtime).
- **Administración:** PIN compartido. El público puede ver la rifa, pero solo
  los administradores pueden asignar números, registrar abonos, configurar y
  hacer sorteos.
- **Sorteos:** lista de premios, selección del premio en cada sorteo y opción
  **No repite** para que los ganadores no vuelvan a participar.

## Puesta en marcha

La guía paso a paso está en [`DESPLIEGUE.md`](DESPLIEGUE.md). Resumen:

1. Crear un proyecto en Supabase.
2. Ejecutar `supabase/schema.sql` en el SQL Editor.
3. Copiar `supabase/configurar_pin.sql` a `supabase/configurar_pin.local.sql`,
   poner el PIN compartido en la copia y ejecutarla. La copia no se sube a Git.
4. Copiar la URL y la clave pública (`anon` o `publishable`) de Supabase en
   `config.js`.
5. Conectar el repositorio a Netlify (o ejecutar `node scripts/build.mjs` y
   subir la carpeta `dist/`).

## Sorteos con premios

Desde **Sorteo → Premios** se agrega una lista de premios. Al sortear se elige
cuál premio se está jugando; el premio queda enlazado al historial. Cada
ganador queda marcado como **No repite** por defecto, así que no vuelve a
participar en los siguientes sorteos; se puede desmarcar desde el resultado o
el historial. Para identificar a la misma persona se usa el teléfono o, si no
hay, el nombre. Si se elimina un sorteo, su premio vuelve a quedar pendiente.

Si la lista está vacía se usa el premio general de **Configurar**. La lista y
el historial son públicos; los controles de edición solo aparecen con el PIN.

## Números al azar, imágenes y comprobantes

- **🎲 Al azar:** con sesión de administrador, elige números disponibles al
  azar para asignarlos a un comprador. Puedes indicar cuántos y reemplazar la
  selección que ya tenías.
- **📋 Disponibles:** abre la lista de números libres (con sus rangos), permite
  copiarla o descargarla en TXT y generar una imagen PNG lista para compartir
  por WhatsApp o redes sociales. La imagen se crea en el navegador y muestra
  solo los números que todavía están disponibles.
- **🧾 Comprobante:** al asignar números se muestra un comprobante PNG con los
  números del comprador, el total, los abonos y el saldo. También se puede
  abrir desde el detalle de cualquier número asignado, y descargar o compartir
  desde el celular.

## Privacidad

El enlace público es de solo lectura, pero cualquiera que lo tenga puede ver
los datos de los números, incluidos nombre, teléfono, notas e historial de
abonos. Compártelo solo con las personas que deban consultar la rifa. Si más
adelante quieres ocultar esos datos al público, se puede cambiar el diseño para
mostrarlos solo con el PIN.

## Desarrollo local

No hay build con dependencias. Para probar el sitio:

```bash
node scripts/build.mjs
npx serve dist
```

También puedes abrir el proyecto con cualquier servidor estático. La app usa
directamente Supabase, así que no necesita el antiguo `servidor.py`.

## Estructura

```text
index.html            Interfaz
app.js                Lógica y conexión con Supabase
estilos.css           Estilos
config.js             URL y clave pública de Supabase
vendor/supabase.js    Librería de Supabase (incluida localmente)
supabase/schema.sql   Tablas, funciones RPC, RLS y Realtime
supabase/configurar_pin.sql  Plantilla para definir el PIN compartido
scripts/build.mjs     Genera dist/ con los archivos publicables
netlify.toml          Configuración de Netlify
DESPLIEGUE.md         Guía de despliegue y seguridad
README-local.md       Guía de la versión local anterior
```

## Versión local anterior

`servidor.py`, `iniciar.bat` y `rifa.db` se conservan como referencia, pero la
versión online no los usa ni los publica. La guía antigua está en
[`README-local.md`](README-local.md).

`rifa.db` contiene los datos de la versión anterior. Está en `.gitignore` para
no volver a subirlo. Si ya estaba en tu repositorio, quítalo del control de
versiones con `git rm --cached rifa.db` (el archivo local se conserva).
