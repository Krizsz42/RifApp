# Poner RifApp 100% online (Netlify + Supabase)

Esta versión ya no necesita `servidor.py`, `iniciar.bat` ni tener el PC encendido.
La página se publica como sitio estático en Netlify y los datos viven en Supabase.
Los cambios se sincronizan en tiempo real entre todos los dispositivos.

## Arquitectura

- **Netlify**: sirve `index.html`, `app.js`, `estilos.css`, `config.js` y
  `vendor/supabase.js`. No ejecuta backend.
- **Supabase**: base de datos PostgreSQL, funciones RPC y canal de tiempo real.
- **PIN compartido**: solo quien lo sepa puede modificar la rifa. El público
  puede ver los números, nombres, estados y detalles en vivo, pero no editar.
- El PIN se guarda como hash bcrypt en el esquema privado `private`; nunca se
  guarda en el repositorio ni en el navegador. En el navegador se guarda un
  token de sesión de 30 días.

## 1. Crear el proyecto en Supabase

1. Entra a <https://supabase.com> y crea una cuenta.
2. Pulsa **New project**.
3. Ponle un nombre (por ejemplo `rifapp`), elige una contraseña para la base
   de datos y una región cercana (por ejemplo **South America (São Paulo)**).
4. Espera a que el proyecto termine de crearse.

> El plan gratuito es suficiente para una rifa. Ten en cuenta que Supabase
> puede pausar proyectos gratuitos que pasan muchos días sin actividad; si
> eso pasa, se reactiva desde el panel de Supabase.

## 2. Crear las tablas y funciones

1. En el panel de Supabase, abre **SQL Editor**.
2. Pulsa **New query**.
3. Copia y pega todo el contenido de `supabase/schema.sql`.
4. Pulsa **Run** (o Ctrl + Enter).
5. Debe terminar sin errores. Si aparece un error, revisa que estés en el
   proyecto correcto y vuelve a ejecutarlo: el script es idempotente.

Esto crea:

- `public.config`, `public.numeros`, `public.abonos`, `public.sorteos`.
- Las funciones RPC que usa la app.
- Las políticas RLS de solo lectura para el público.
- El esquema privado `private` con el PIN, las sesiones y los intentos.
- La publicación de tiempo real para `numeros`, `config` y `sorteos`.

## 3. Definir el PIN compartido

La forma recomendada es copiar `supabase/configurar_pin.sql` a
`supabase/configurar_pin.local.sql` (ese nombre está en `.gitignore`), cambiar
`TU_PIN_AQUI` por el PIN de las 3 personas en la copia y ejecutarla en el
**SQL Editor**. La copia comprueba que no hayas dejado el PIN de ejemplo, exige
un mínimo de 6 caracteres y cierra las sesiones anteriores.

No pongas el PIN real en `configurar_pin.sql` ni en ningún archivo que subas a
Git. También puedes pegar esta sentencia directamente en el SQL Editor, sin
guardarla en el repositorio:

```sql
insert into private.admin_pin (id, pin_hash, actualizado)
values (1, extensions.crypt('TU_PIN_AQUI', extensions.gen_salt('bf', 12)), now())
on conflict (id) do update
    set pin_hash = excluded.pin_hash,
        actualizado = excluded.actualizado;
```

Recomendaciones:

- Usa al menos 8 caracteres. Puede ser solo números si quieres, pero mientras
  más largo mejor.
- No pongas el PIN en `config.js`, en GitHub ni en un chat público.
- La app permite cambiarlo después desde **Entrar → Cambiar PIN compartido**.
  Al cambiarlo se cierran las sesiones de los otros dispositivos.

Si algún día olvidan el PIN, pueden ejecutar de nuevo la sentencia anterior
con uno nuevo y luego cerrar todas las sesiones:

```sql
delete from private.admin_sessions;
```

## 4. Conectar la app con Supabase

1. En Supabase, ve a **Project Settings → API**.
2. Copia **Project URL** y la clave pública **anon** (en proyectos nuevos
   puede aparecer como **publishable**).
3. Abre `config.js` en tu copia del proyecto y reemplaza los valores:

```js
window.RIFA_CONFIG = {
  SUPABASE_URL: "https://tu-proyecto.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...",
};
```

> La clave `anon`/`publishable` es pública por diseño; se puede subir al
> repositorio. **Nunca** pongas la clave `service_role` en el navegador ni en
> `config.js`. La seguridad real la dan las políticas RLS y el PIN.

## 5. Publicar en Netlify

### Opción recomendada: conectar tu repositorio

1. Sube los cambios a tu repositorio de Git (GitHub, GitLab o Bitbucket).
2. Entra a <https://app.netlify.com> y pulsa **Add new site → Import an
   existing project**.
3. Elige tu proveedor y autoriza el repositorio de RifApp.
4. Netlify leerá `netlify.toml` automáticamente:
   - Build command: `node scripts/build.mjs`
   - Publish directory: `dist`
5. Pulsa **Deploy site**. En uno o dos minutos tendrás una URL como
   `https://rifapp-xxxx.netlify.app`. Si quieres un nombre más fácil de
   recordar, cámbialo en **Site configuration → Change site name**.
6. Cada vez que hagas `git push`, Netlify volverá a publicar la versión nueva.

### Opción manual (sin conectar el repositorio)

1. En tu PC, dentro de la carpeta del proyecto, ejecuta:

   ```bash
   node scripts/build.mjs
   ```

2. Se crea la carpeta `dist/` con solo los archivos del sitio.
3. Entra a <https://app.netlify.com/drop> y arrastra la carpeta `dist`.
4. Netlify te dará una URL pública.

## 6. Probar que todo funciona

1. Abre la URL de Netlify en el computador y en un celular.
2. En uno de los dispositivos pulsa **🔒 Entrar**, escribe el PIN y asigna un
   número de prueba.
3. En el otro dispositivo, sin recargar, el número debe cambiar a amarillo o
   verde en menos de un segundo.
4. Prueba registrar un abono, liberar el número y hacer un sorteo.
5. Si el número no cambia en el otro dispositivo:
   - Revisa el indicador de la barra superior: debe decir **● En vivo**.
   - En Supabase, ve a **Database → Replication** y confirma que `numeros`,
     `config` y `sorteos` están publicados en `supabase_realtime`.
   - Vuelve a ejecutar `supabase/schema.sql` para asegurar la publicación.
   - Mira la consola del navegador (F12) por si hay errores de `config.js`.

## 7. Cómo funciona la seguridad

- Cualquier persona con el enlace puede **leer** la rifa (números, nombres,
  teléfonos, notas, abonos y sorteos).
- Para **escribir** hace falta un token de sesión válido, que solo se obtiene
  con el PIN.
- Las operaciones de escritura son funciones RPC transaccionales: si dos
  personas intentan apartar el mismo número a la vez, solo una lo consigue.
- El PIN se verifica con bcrypt (costo 12). Después de 8 intentos fallidos
  desde la misma IP/dispositivo, se bloquea 15 minutos.
- Los tokens se guardan hasheados en Supabase y vencen a los 30 días.
- El sitio incluye cabeceras CSP y escapa los datos antes de mostrarlos.

Si más adelante quieres que los teléfonos, notas o el historial de abonos no
sean visibles para el público, se puede ajustar la función `estado_rifa` y las
políticas RLS.

## 8. Archivos importantes

| Archivo | Para qué sirve |
|---|---|
| `index.html` | Interfaz |
| `app.js` | Lógica de la app y conexión con Supabase |
| `estilos.css` | Diseño |
| `config.js` | URL y clave `anon` de Supabase |
| `vendor/supabase.js` | Librería de Supabase incluida localmente |
| `supabase/schema.sql` | Tablas, funciones, RLS y tiempo real |
| `supabase/configurar_pin.sql` | Plantilla para definir o cambiar el PIN |
| `netlify.toml` | Configuración de build, publicación y cabeceras |
| `scripts/build.mjs` | Copia solo los archivos del sitio a `dist/` |
| `DESPLIEGUE.md` | Esta guía |

Los archivos de la versión local anterior (`servidor.py`, `iniciar.bat`,
`rifa.db`) se conservan como referencia y **no se publican** en Netlify.

## 9. Datos actuales

La versión online arranca con 200 números y la configuración por defecto.
El archivo `rifa.db` no se migró (así se acordó). Si más adelante quieres
pasar esos datos, se puede preparar un script de importación.

`rifa.db` está en `.gitignore` para no volver a subirlo, porque contiene datos
de la versión anterior. Si ya estaba en tu repositorio, quítalo del control de
versiones con `git rm --cached rifa.db`; el archivo local se conserva.
