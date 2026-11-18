// Una oficina virtual de mentira, para ver en la isla lo que describe
// docs/OFICINA.md sin tener todavía una oficina de verdad.
//
//   node scripts/office-demo.mjs [dirección-de-la-oficina]
//
// Con Liv abierta, hace de equipo de un canal de YouTube durante un minuto:
// cada paso es un evento JSON entregado al relé (`liv-hook.exe office`), igual
// que lo haría la oficina real. Al terminar envía `reset` y la isla queda como
// estaba. Sin dependencias: solo Node.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? "liv-hook.exe" : "liv-hook";
// El relé instalado por Liv, o el recién compilado en el repositorio.
const candidates = [
  ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "Liv", "bin", exe)] : []),
  join(root, "target", "release", exe),
];
const relay = candidates.find((path) => existsSync(path));
if (!relay) {
  console.error("No encuentro el relé de Liv. He buscado en:");
  for (const path of candidates) console.error(`  ${path}`);
  console.error("Abre Liv una vez (lo instala al arrancar) o compílalo con:");
  console.error("  cargo build --release -p liv-hook");
  process.exit(1);
}

/** Adónde llevan «Abrir oficina» y «Revisar» durante la demo. */
const officeUrl = process.argv[2] ?? "https://studio.youtube.com/";

/** Entrega un evento a Liv. El relé nunca espera: si Liv no está abierta, sale sin más. */
function send(event) {
  const result = spawnSync(relay, ["office"], {
    input: JSON.stringify({ office: "demo", ...event }),
    timeout: 5000,
    windowsHide: true,
  });
  if (result.error) console.error(`  (el relé no respondió: ${result.error.message})`);
}

const agent = (id, name, role, state, summary) => ({
  type: "agent.state", agent: { id, name, role }, state, ...(summary ? { summary } : {}),
});

/** La historia: [segundo, lo que se ve en la isla, eventos]. */
const story = [
  [0, "Llega el equipo: aparece la píldora «Canal de YouTube», en silencio (abre la isla para verla)", [
    { type: "reset" },
    { ...agent("ideas", "Ideas", "Ideas", "working", "Buscando temas para el vídeo 13"), office_name: "Canal de YouTube", open_url: officeUrl },
    agent("guionista", "Guionista", "Guion", "working", "Escribiendo el guion del vídeo 12"),
  ]],
  [4, "Cuatro agentes trabajando y una sin tarea: cinco puntos en la tarjeta", [
    agent("editora", "Editora", "Edición", "working", "Montando el vídeo 11"),
    agent("miniaturas", "Miniaturas", "Miniaturas", "working", "Probando tres miniaturas"),
    agent("publicadora", "Publicadora", "Publicación", "idle"),
  ]],
  [10, "Una novedad sin aviso: el titular de la tarjeta cambia en silencio", [
    { type: "news", agent: { id: "guionista" }, news: { title: "Guion del vídeo 12 terminado" } },
  ]],
  [15, "Algo espera tu decisión: suena la pregunta y la isla se abre (o insignia ámbar)", [
    agent("guionista", "Guionista", "Guion", "waiting", "Esperando tu visto bueno"),
    {
      type: "ask.open", agent: { id: "guionista" },
      ask: { id: "guion-12", title: "¿Apruebas el guion del vídeo 12?", detail: "8 minutos, tono divulgativo", open_url: officeUrl },
    },
  ]],
  [24, "Un error: la isla se asoma, con la insignia roja", [
    agent("editora", "Editora", "Edición", "error", "No encuentra el audio del vídeo 11"),
  ]],
  [31, "La editora se recupera y sigue", [
    agent("editora", "Editora", "Edición", "working", "Montando el vídeo 11 otra vez"),
  ]],
  [37, "La oficina cierra la petición: ya no espera nada por ti", [
    { type: "ask.close", ask: { id: "guion-12" } },
    agent("guionista", "Guionista", "Guion", "done", "Guion del vídeo 12 aprobado"),
  ]],
  [42, "Un aviso: insignia ámbar, sin moverse", [
    { type: "news", news: { title: "Queda poca cuota de subida para hoy", level: "warning" } },
  ]],
  [47, "La publicadora se pone a trabajar", [
    agent("publicadora", "Publicadora", "Publicación", "working", "Subiendo el vídeo 11"),
    agent("editora", "Editora", "Edición", "done", "Vídeo 11 montado"),
  ]],
  [53, "Un hito: la isla se asoma, con la insignia verde", [
    agent("publicadora", "Publicadora", "Publicación", "done", "Vídeo 11 publicado"),
    { type: "news", agent: { id: "publicadora" }, news: { title: "Vídeo 11 publicado", level: "success", open_url: "https://www.youtube.com/" } },
  ]],
  [60, "La oficina cierra: la píldora desaparece (si no la tienes activada en Ajustes)", [
    { type: "reset" },
  ]],
];

console.log(`Relé: ${relay}`);
console.log("Con Liv abierta, mira la isla. Dura un minuto.\n");
const started = Date.now();
for (const [second, seen, events] of story) {
  await wait(Math.max(0, second * 1000 - (Date.now() - started)));
  console.log(`[${String(second).padStart(2)} s] ${seen}`);
  for (const event of events) send(event);
}
console.log("\nFin. Si no has visto nada: ¿está Liv abierta, y activado «Mostrar mi oficina virtual»?");
