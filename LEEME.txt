RIFA - GUÍA RÁPIDA
==================

1) CÓMO INICIARLA
   - Haz doble clic en "iniciar.bat".
   - Se abrirá sola una ventana del navegador con la rifa.
   - Deja la ventana negra abierta mientras uses la rifa. Ahí se guardan los datos.
   - Para cerrar todo: cierra la ventana negra o presiona Ctrl + C.

2) CÓMO LA USAN OTRAS PERSONAS (misma WiFi)
   - En la ventana negra aparecen direcciones parecidas a:
         http://192.168.1.25:8080
   - Comparte esa dirección con las demás personas (o usa el botón "Compartir").
   - Todos los celulares/PC deben estar conectados a la MISMA red WiFi.
   - Los cambios se ven automáticamente en unos segundos.

   Si un celular no abre la página:
   - Revisa que esté en la misma WiFi.
   - En Windows, permite a Python en el Firewall para redes privadas.
   - También puedes desactivar temporalmente el Firewall para probar.

3) CÓMO SE USA
   - Números blancos    = disponibles.
   - Toca uno o varios números blancos para seleccionarlos.
   - Pulsa "Asignar números" y escribe nombre, teléfono y el abono.
   - Números amarillos  = apartados (deben dinero).
   - Números verdes     = pagados por completo.
   - Toca un número ocupado para:
        * ver los datos y el historial de abonos
        * registrar un nuevo abono
        * editar nombre/teléfono/nota
        * liberar el número (si se arrepiente)
   - "Exportar" descarga un archivo CSV que abre en Excel.
   - "Respaldo" descarga una copia de la base de datos.
   - "Configurar" permite cambiar nombre, premio, precio, moneda y cantidad de números.
   - Los montos están en pesos chilenos (CLP), sin decimales y con separador de miles.

4) SORTEO
   - En la sección "Sorteo" pulsa "Realizar sorteo".
   - Puedes elegir que solo participen los números pagados.
   - El resultado queda guardado en el historial.
   - Para borrar un sorteo de prueba, usa el ícono de basura en el historial.
     Solo se borra ese registro; los números y pagos no cambian.

5) IMPORTANTE
   - Los datos NO están en internet: viven en el archivo "rifa.db" de esta carpeta.
   - Haz un "Respaldo" de vez en cuando, sobre todo antes de apagar el equipo.
   - No borres "rifa.db" ni la carpeta. Si quieres empezar de cero, pídelo antes.
   - Si el puerto 8080 está ocupado, el programa usará otro y lo mostrará en pantalla.

6) SI QUIERES USARLA DESDE OTRA RED O INTERNET
   - Esta versión funciona en la red local. Para usarla a distancia
     se puede publicar en un servidor o en la nube (siguiente paso).
