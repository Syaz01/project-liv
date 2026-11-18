# La oficina virtual: guía para construirla

Este documento es para quien vaya a construir la **oficina virtual** —una
persona o un asistente de IA en otra conversación— sin haber trabajado antes en
Liv. Explica qué es Liv, qué hace ya la isla por una oficina, cómo se habla con
ella y qué se ha decidido sobre el proyecto. El contrato exacto de los eventos
está en [OFICINA.md](OFICINA.md): ese archivo manda; aquí se resume y se da el
contexto que le falta.

## 1. Liv en dos minutos

Liv es una *Dynamic Island* para Windows: una isla pequeña en lo alto de la
pantalla que muestra lo que pasa y se abre cuando hace falta. En ella vive Liv,
un robot.

- **Hecha con** Tauri 2: Rust en `src-tauri/`, TypeScript sin framework en
  `src/`, y un relé pequeño en `hook/` (el ejecutable `liv-hook`).
- **Qué muestra:** las sesiones de los agentes de código (Claude Code, Codex,
  Antigravity, Gemini CLI, Copilot CLI, Cursor…), con sus permisos y preguntas;
  un chat; la música; el portapapeles, una repisa de archivos y capturas.
- **Cómo se entera de los agentes:** cada agente tiene *hooks* que ejecutan
  `liv-hook`, y el relé pasa el evento a la app por un canal local (una tubería
  con nombre de Windows). Si la app no responde, el relé sale enseguida: nunca
  bloquea al agente.
- **Píldoras:** cada cosa que la isla sigue es una píldora (Claude Code, Google
  AI, Música…). La que está delante decide la tarjeta de la izquierda, el color
  de Liv y el de las motas del fondo. La oficina es una píldora más
  (`integration_office`, amarilla).
- **Repositorio público:** `Syaz01/project-liv` en GitHub. Las versiones se
  publican con etiquetas `windows-vX.Y.Z`.

### Reglas de Liv que afectan a la oficina

- **Liv solo escucha a la oficina.** No le contesta, no la dirige y nada de lo
  que la oficina envíe puede aprobar, ejecutar ni abrir nada por sí solo.
- **Nunca se aprueba un permiso sin un clic de la persona.** La oficina tampoco
  debe hacerlo en su nombre.
- **Nunca bloquear a un agente.** Lo que se cuelgue de un agente (un hook, un
  relé) sale de inmediato si nadie contesta.
- **Sin telemetría.** Todo es local; solo se llama a lo que la persona
  configuró.
- **Nunca sobrescribir la configuración de un agente** (por ejemplo
  `~/.claude/settings.json`): copia con fecha, fusión, mostrar el cambio y
  escribir solo tras confirmar. Liv ya tiene sus entradas ahí; hay que
  convivir con ellas, no pisarlas.
- **Los secretos, al Administrador de credenciales de Windows**, nunca a disco
  ni a git.

## 2. Qué hace ya la isla por una oficina

Todo esto existe hoy en Liv y no hay que construirlo:

| En la isla | Qué hace |
|---|---|
| **Pestaña de la oficina** (icono de edificio en la cabecera) | Con una oficina conocida, trae su píldora al frente y muestra su tarjeta. Sin ninguna, abre *Ajustes → Integraciones → Oficina virtual*. |
| **Píldora «Oficina»** | Aparece sola con el primer evento, o activándola en Ajustes. Lleva una insignia: ámbar si algo espera, roja si hay un error, verde si algo salió bien. |
| **Tarjeta de la oficina** | Nombre, cuántos agentes hay o cuántas cosas esperan, un titular, un punto por agente con el color de su estado, y los botones **Revisar** y **Abrir oficina**. |
| **Avisos** | Una petición (`ask.open`) abre la isla; un error o un éxito hacen que Liv se asome; lo demás se actualiza en silencio. |
| **Liv** | Con la oficina delante, su antena y sus ojos dicen el estado: ámbar si algo espera, rojo si un agente falló, azul si alguno trabaja. |

Ajustes de Liv que cuentan: *Mostrar mi oficina virtual* (si está apagado, Liv
ignora los eventos) y la **dirección de la oficina**, que es lo que abre el
botón «Abrir oficina» cuando el evento no trae otra.

Lo que la isla **no** hace todavía: decidir desde la isla (aprobar o rechazar
sin abrir la oficina), recibir eventos por HTTP, y mostrar varias oficinas a la
vez.

## 3. Cómo se habla con Liv

Un evento es **un objeto JSON** que se pasa por la entrada estándar al relé:

```
%LOCALAPPDATA%\Liv\bin\liv-hook.exe office
```

- El relé no imprime nada, siempre sale con código 0 y, si Liv no está abierta,
  termina en menos de un segundo.
- Solo los programas de la misma sesión de Windows pueden hablar con Liv. No se
  abre ningún puerto.
- Un evento ocupa como mucho 16 KB. Lo que no se entiende se ignora sin error.

Desde Node, que es con lo que se hará la oficina:

```js
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const LIV = join(process.env.LOCALAPPDATA, "Liv", "bin", "liv-hook.exe");
export const liv = (event) => spawnSync(LIV, ["office"], { input: JSON.stringify(event), timeout: 5000 });
```

### Los eventos, en corto

| Evento | Para qué | Obligatorio |
|---|---|---|
| `agent.state` | El estado de un agente: `idle`, `working`, `waiting`, `blocked`, `error`, `done`, `offline` | `agent.id`, `state` |
| `ask.open` | Algo espera una decisión de la persona. **Abre la isla.** | `ask.id`, `ask.title` |
| `ask.close` | Esa petición ya se resolvió | `ask.id` |
| `news` | Un hito o un aviso (`info`, `success`, `warning`, `error`) | `news.title` |
| `reset` | La oficina se cierra: Liv olvida todo lo suyo | — |

Campos comunes: `office` (identificador), `office_name` (nombre visible) y
`open_url` (dirección que abre «Abrir oficina»; solo `http` o `https`). Los
límites de longitud, los identificadores válidos y el detalle de cada campo
están en [OFICINA.md](OFICINA.md).

Cosas fáciles de pasar por alto:

- Un agente que dice `working`, `waiting` o `blocked` y lleva **15 minutos**
  sin enviar nada aparece «sin señal». Hay que reenviar su estado de vez en
  cuando.
- Liv recuerda 12 agentes, 20 peticiones y las 5 últimas noticias, y **no
  guarda nada en disco**: al abrirse de nuevo, la oficina tiene que volver a
  contarle su estado.
- Liv muestra **una** oficina: un evento con otro `office` empieza de cero.
- `ask.open` es el evento que más molesta a propósito. Solo para lo que de
  verdad espera a la persona.

## 4. La oficina que se va a construir

Decisiones ya tomadas por el dueño del proyecto:

1. **Es un programa aparte**, con su propia carpeta y su propio repositorio.
   No se toca el núcleo de Liv para construirla.
2. **Es una web local**: Vite y TypeScript, como la isla. Corre en el equipo
   de la persona y se abre en el navegador (o en una ventana propia más
   adelante).
3. **Tiene dos etapas:**
   - **Etapa 1 — ver mis agentes de código.** Los agentes que la persona ya
     usa (Claude Code, Codex, Antigravity…) mostrados como personajes en una
     oficina: quién trabaja, en qué proyecto, quién espera.
   - **Etapa 2 — equipos que trabajan solos.** Agentes con papeles que la
     propia oficina lanza y coordina; la persona aprueba y revisa.
4. **El icono de la isla muestra la tarjeta de la oficina**; desde ahí, «Abrir
   oficina» lleva a la web.

### Una forma razonable de montarla

No es obligatoria; es un punto de partida:

- **Un servidor local** en Node que escuche solo en `127.0.0.1`: guarda el
  estado de la oficina, sirve la página y es quien llama al relé de Liv.
- **La página** (Vite + TypeScript): la oficina dibujada, con sus personajes y
  lo que hace cada uno; se actualiza por un canal del propio servidor.
- **Un puente hacia Liv**: un módulo pequeño que traduce los cambios de estado
  a eventos y los envía con el relé. Debe reenviar los estados vivos cada pocos
  minutos y enviar `reset` al cerrar.
- **La dirección de la oficina** (`http://localhost:<puerto>`) va en cada
  evento como `open_url`, o una vez en los Ajustes de Liv.

### Lo que hay que decidir primero (etapa 1)

**¿Cómo se entera la oficina de lo que hacen los agentes de código?** Liv lo
sabe por sus hooks, pero no se lo cuenta a nadie: solo escucha. Hay tres
caminos:

| Camino | A favor | En contra |
|---|---|---|
| **A. Hooks propios** en cada agente, junto a los de Liv | Estado en vivo; no depende de Liv | Hay que escribir en la configuración de cada agente con las mismas precauciones que Liv (copia, fusión, confirmar) y un relé propio que nunca bloquee |
| **B. Leer los registros** de sesión de cada agente (solo lectura) | No toca ninguna configuración | Va con retraso, cada agente guarda sus registros a su manera y los formatos cambian |
| **C. Que Liv reenvíe** sus sesiones a la oficina | Un solo juego de hooks | Hay que cambiar Liv: hoy no envía nada a nadie, y es una regla suya |

Recomendación: empezar por **B** para tener algo que ver sin tocar nada, y
pasar a **A** cuando haga falta el estado en vivo. **C** se pide en el
proyecto de Liv si se ve que compensa.

**Cuidado con los avisos dobles.** Liv ya muestra los permisos y las preguntas
de los agentes de código en sus propias píldoras. En la etapa 1 la oficina
debe enviar solo `agent.state` (que es silencioso) por esos agentes, y **no**
`ask.open` por un permiso que Liv ya está enseñando: la persona recibiría dos
avisos por lo mismo. `ask.open` y `news` son para la etapa 2, cuando el equipo
es de la propia oficina.

## 5. Lo que la oficina no debe hacer

- Escribir en los archivos o ajustes de Liv, ni depender de cómo guarda Liv
  sus cosas por dentro. El único punto de contacto es el relé.
- Abrir puertos fuera de `127.0.0.1`.
- Enviar a Liv texto que no sea para mostrar: no hay órdenes, solo estado.
- Aprobar permisos de un agente por la persona.
- Llamar a servicios que la persona no configuró.

## 6. Cómo probar

- **Sin oficina:** en el repositorio de Liv, `node scripts/office-demo.mjs`
  simula durante un minuto un equipo con agentes, una petición, un error y una
  publicación. Sirve para ver qué hace la isla con cada evento.
- **Con la oficina:** Liv abierta, *Mostrar mi oficina virtual* activado, y la
  oficina enviando eventos. La píldora aparece con el primero.
- **La pestaña:** el icono de edificio en la cabecera de la isla.
- **En el navegador, sin la app:** en el repositorio de Liv, `npm run dev` y
  `http://127.0.0.1:1420/dev/island-preview.html`; en la consola,
  `__emit("office", { type: "agent.state", agent: { id: "editora", name: "Editora" }, state: "working" })`.

## 7. Si hace falta cambiar Liv

Lo que hoy falta en la isla (decidir desde ella, HTTP, varias oficinas, el
camino C de arriba) se pide en el proyecto de Liv, no se parchea desde fuera.
Allí cada cambio va en su rama, con sus pruebas, y se publica en una versión
nueva. Lo que cambie del contrato se escribe en [OFICINA.md](OFICINA.md).

## 8. Primeros pasos sugeridos

1. Crear el proyecto (Vite + TypeScript + un servidor Node mínimo) y enviar a
   Liv un `agent.state` de prueba. Comprobar que aparece la píldora.
2. Dibujar la oficina con agentes de mentira y el puente a Liv funcionando
   (estados, reenvío periódico, `reset` al cerrar).
3. Elegir el camino A, B o C y conectar los agentes de código de verdad.
4. Etapa 2: un primer equipo propio con una petición real (`ask.open` →
   decidir en la oficina → `ask.close`).

## 9. Para empezar la otra conversación

Texto que se puede pegar tal cual, con este documento y `OFICINA.md` adjuntos
o a la vista:

> Voy a construir la oficina virtual de Liv, un programa aparte que se integra
> con la isla. Lee `docs/OFICINA-PROYECTO.md` y `docs/OFICINA.md` del
> repositorio de Liv antes de nada: el primero explica el proyecto y las
> decisiones tomadas, el segundo es el contrato de los eventos. Trabaja en una
> carpeta nueva, no en el repositorio de Liv. Empieza por el paso 1 de
> «Primeros pasos sugeridos» y pregúntame lo que no esté decidido.
