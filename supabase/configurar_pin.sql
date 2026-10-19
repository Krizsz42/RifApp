-- =====================================================================
-- PLANTILLA para definir o cambiar el PIN compartido de administración.
--
-- IMPORTANTE: no escribas el PIN real en este archivo versionado.
--
-- 1. Copia este archivo como supabase/configurar_pin.local.sql
--    (ese nombre está en .gitignore y no se sube a Git).
-- 2. En la copia, cambia TU_PIN_AQUI por el PIN de las 3 personas.
-- 3. Ejecuta la copia en el SQL Editor de Supabase DESPUÉS de
--    haber ejecutado schema.sql.
--
-- El PIN se guarda solo como hash bcrypt en Supabase. No se publica en el
-- sitio ni queda en el repositorio; solo se escribe al iniciar sesión y se
-- envía por HTTPS a Supabase.
-- =====================================================================

do $$
declare
    v_pin text := 'TU_PIN_AQUI';
begin
    -- La comparación está partida a propósito: si usas "reemplazar todo"
    -- para cambiar el PIN, esta protección sigue funcionando.
    if v_pin = 'TU_' || 'PIN_' || 'AQUI' then
        raise exception 'Cambia TU_PIN_AQUI por un PIN real antes de ejecutar este archivo';
    end if;

    if length(v_pin) < 6 then
        raise exception 'El PIN debe tener al menos 6 caracteres';
    end if;

    insert into private.admin_pin (id, pin_hash, actualizado)
    values (1, extensions.crypt(v_pin, extensions.gen_salt('bf', 12)), now())
    on conflict (id) do update
        set pin_hash = excluded.pin_hash,
            actualizado = excluded.actualizado;

    -- Al reemplazar un PIN olvidado conviene cerrar las sesiones anteriores.
    -- Si estás definiendo el PIN por primera vez, esta línea no hace nada.
    delete from private.admin_sessions;
end;
$$;
