// Una sesión de Claude Code de mentira, para ver en la isla lo que hace Liv
// mientras un agente trabaja, pide permiso, pregunta y termina, sin instalar
// los hooks.
//
//   node scripts/session-demo.mjs              trabaja y termina bien
//   node scripts/session-demo.mjs --error      termina con un error
//   node scripts/session-demo.mjs --permiso    pide permiso para un comando: responde en la isla
//   node scripts/session-demo.mjs --pregunta   hace una pregunta con opciones: responde en la isla
//
// Con Liv abierta, entrega al relé (`liv-hook.exe <Evento>`) los mismos eventos
// que enviaría Claude Code. Con --permiso y --pregunta el relé espera tu clic
// en la isla, como en una sesión real, y aquí se muestra lo que Liv contestó.
// Las opciones se pueden combinar. Sin dependencias: solo Node.

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

const has = (flag) => process.argv.includes(flag);
const session = `demo-${Date.now()}`;
// El relé mira el entorno para saber qué agente habla: lanzado desde la app de
// escritorio de Claude lo tomaría por ella. Aquí habla Claude Code a secas.
const env = { ...process.env };
delete env.CLAUDE_CODE_ENTRYPOINT;

/**
 * Entrega un evento a Liv y devuelve lo que el relé imprime para Claude Code.
 * Solo una petición de permiso espera respuesta (hasta dos minutos); el resto
 * sale enseguida, y también cuando Liv no está abierta.
 */
function send(event, fields = {}) {
  const result = spawnSync(relay, [event], {
    input: JSON.stringify({ session_id: session, cwd: root, hook_event_name: event, ...fields }),
    timeout: event === "PermissionRequest" ? 125_000 : 5000,
    windowsHide: true,
    env,
  });
  if (result.error) console.error(`  (el relé no respondió: ${result.error.message})`);
  return result.stdout?.toString("utf8").trim() ?? "";
}

/** Lo que el relé contestó a una petición, dicho en claro. */
function answered(out) {
  if (!out) return "nada: Liv no decidió (la tarjeta caducó, se plegó, o Liv está en pausa o apartada), así que Claude Code preguntaría en su terminal";
  try {
    const decision = JSON.parse(out).hookSpecificOutput?.decision;
    if (decision?.behavior === "deny") return `DENEGAR${decision.message ? ` («${decision.message}»)` : ""}`;
    if (decision?.behavior === "allow") {
      const answers = decision.updatedInput?.answers;
      return answers ? `la respuesta ${JSON.stringify(answers)}` : "PERMITIR";
    }
  } catch {
    // Se muestra tal cual más abajo.
  }
  return out;
}

const tool = (name, input) => [["PreToolUse", { tool_name: name, tool_input: input }], ["PostToolUse", { tool_name: name, tool_input: input }]];
const file = join(root, "src", "ejemplo.ts");

/** La historia: [lo que se ve en la isla, eventos, segundos de pausa después]. */
const story = [
  ["La sesión empieza: Liv se muestra compacta y sus luces pasan a violeta (pensando)", [
    ["SessionStart"],
    ["UserPromptSubmit", { prompt: "Arregla las pruebas que fallan" }],
  ], 3],
  ["Lee un archivo: luces azules (trabajando)", tool("Read", { file_path: file }), 3],
  ["Edita: el paso lleva +1 −1 y, con la isla abierta, se puede ver el diff", tool("Edit", {
    file_path: file, old_string: "const total = precio * cantidad;", new_string: "const total = precio * cantidad * (1 + iva);",
  }), 3],
];
if (has("--permiso")) {
  story.push(["Pide permiso: la isla se abre con Denegar y Permitir. Responde en la isla…", [
    ["PermissionRequest", { tool_name: "Bash", tool_input: { command: "npm test -- --watch=false", description: "Ejecutar las pruebas" } }],
  ], 2]);
}
if (has("--pregunta")) {
  story.push(["Hace una pregunta: la isla se abre con las opciones. Elige una en la isla…", [
    ["PermissionRequest", {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "¿Qué hago con la prueba que depende de la red?",
          header: "Prueba",
          multiSelect: false,
          options: [
            { label: "Simular la red", description: "Sustituir la llamada por una respuesta fija" },
            { label: "Saltarla", description: "Marcarla como pendiente" },
            { label: "Dejarla", description: "No tocarla" },
          ],
        }],
      },
    }],
  ], 2]);
}
story.push(
  ["Ejecuta las pruebas", tool("Bash", { command: "npm test" }), 4],
  has("--error")
    ? ["Falla: con la isla plegada, Liv se asoma entera con las luces en rojo", [
        ["StopFailure", { error: "server_error", error_details: "El servidor devolvió un error" }],
      ], 11]
    : ["Termina: con la isla plegada, Liv se asoma entera con las luces en verde", [
        ["Stop", { last_assistant_message: "Listo: las 12 pruebas pasan." }],
      ], 11],
  ["La sesión se cierra y la isla queda como estaba", [["SessionEnd"]], 0],
);

console.log(`Relé: ${relay}`);
console.log("Con Liv abierta, mira la isla.\n");
for (const [seen, events, pause] of story) {
  console.log(`· ${seen}`);
  for (const [event, fields] of events) {
    const out = send(event, fields);
    if (event === "PermissionRequest") console.log(`    Liv contestó: ${answered(out)}`);
  }
  await wait(pause * 1000);
}
console.log("\nFin. Si no has visto nada: ¿está Liv abierta, sin pausar y sin una app a pantalla completa delante?");
