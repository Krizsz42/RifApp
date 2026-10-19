import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const destino = join(raiz, "dist");

const archivos = [
  "index.html",
  "app.js",
  "estilos.css",
  "config.js",
  "vendor/supabase.js",
];

await rm(destino, { recursive: true, force: true });
await mkdir(destino, { recursive: true });

for (const archivo of archivos) {
  const salida = join(destino, archivo);
  await mkdir(dirname(salida), { recursive: true });
  await cp(join(raiz, archivo), salida);
}

console.log(`Sitio listo en dist/ (${archivos.length} archivos).`);
