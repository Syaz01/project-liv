# Oficina virtual

Liv puede mostrar lo que pasa en una **oficina virtual**: un equipo de agentes
de IA que trabaja por su cuenta (por ejemplo, el que lleva un canal de YouTube:
ideas, guion, edición, miniaturas, publicación). La oficina es otro programa,
hecho con la herramienta que quieras; Liv solo la **escucha** y enseña en la
isla lo que importa de un vistazo:

- quién está trabajando y en qué;
- **cuántas cosas esperan una decisión tuya**;
- los errores y los hitos («guion listo», «vídeo publicado»);
- un acceso directo para abrir la oficina.

Liv no dirige la oficina ni toma decisiones por ti: enseña y te lleva a ella.

## Dos formas de usarla

1. **Solo acceso directo.** En *Ajustes → Integraciones → Oficina virtual*,
   escribe la dirección de tu oficina y, en la lista de esa misma página,
   activa «Oficina» (cuenta como una de tus cuatro píldoras). La píldora
   «Oficina» abre esa dirección. No hace falta nada más.
2. **Integración directa.** La oficina avisa a Liv de lo que pasa enviándole
   eventos (abajo). La píldora aparece sola con el primer evento, sin
   activarla. Con *Mostrar mi oficina virtual* desactivado en Ajustes, Liv no
   hace caso de los eventos.

Las dos se combinan: la tarjeta de la oficina siempre tiene su botón para
abrirla.

## Cómo envía eventos la oficina

Cada evento es **un objeto JSON** que se pasa por la entrada estándar al relé de
Liv con el argumento `office`:

```
%LOCALAPPDATA%\Liv\bin\liv-hook.exe office
```

- El relé entrega el evento a Liv por su canal local (el mismo que usan los
  agentes de código) y termina enseguida. No imprime nada y siempre sale con
  código 0.
- Si Liv no está abierta, el relé sale en menos de un segundo: **la oficina
  nunca se queda esperando**.
- Solo los programas de tu propia sesión de Windows pueden hablar con Liv. No
  se abre ningún puerto de red y nada sale de tu equipo.
- Un evento ocupa como mucho 16 KB. Lo que no se entiende se ignora sin error.
- Liv nunca contesta: el relé no devuelve nada a la oficina.

### PowerShell

```powershell
'{"type":"agent.state","agent":{"id":"editora","name":"Editora","role":"Edición"},"state":"working","summary":"Montando el vídeo 12"}' |
  & "$env:LOCALAPPDATA\Liv\bin\liv-hook.exe" office
```

En Windows PowerShell 5.1 los acentos se pierden al pasar texto a otro programa
(llegan como `?`); para evitarlo, ejecuta antes
`$OutputEncoding = [Text.UTF8Encoding]::new()`. En PowerShell 7 no hace falta.

### Python

```python
import json, os, subprocess

LIV = os.path.expandvars(r"%LOCALAPPDATA%\Liv\bin\liv-hook.exe")

def liv(event: dict) -> None:
    subprocess.run([LIV, "office"], input=json.dumps(event).encode("utf-8"), timeout=5)

liv({"type": "ask.open",
     "agent": {"id": "guionista", "name": "Guionista"},
     "ask": {"id": "guion-12", "title": "¿Apruebas el guion del vídeo 12?",
             "open_url": "http://localhost:3000/videos/12/guion"}})
```

### Node

```js
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const LIV = join(process.env.LOCALAPPDATA, "Liv", "bin", "liv-hook.exe");
export const liv = (event) => spawnSync(LIV, ["office"], { input: JSON.stringify(event), timeout: 5000 });

liv({ type: "news", news: { title: "Vídeo 12 publicado", level: "success" } });
```

Cualquier herramienta que pueda ejecutar un comando al cambiar de estado sirve:
los *listeners* de CrewAI, el *stream* de LangGraph o AutoGen, los *hooks* de
Claude Code y del Claude Agent SDK, los *RunHooks* del SDK de agentes de
OpenAI, el nodo *Execute Command* de n8n.

## Los eventos

Campos comunes, todos opcionales salvo `type`:

| Campo | Qué es |
|---|---|
| `v` | Versión del formato. Hoy `1`; si falta, se entiende `1`. Un evento con otra versión se ignora. |
| `type` | El tipo de evento (abajo). |
| `office` | Identificador de la oficina: minúsculas, cifras y guiones, 24 como mucho. Por defecto `office`. Si no es válido, el evento se ignora. |
| `office_name` | Nombre que se muestra, hasta 40 caracteres. Por defecto «Oficina». |
| `open_url` | Dirección que abre el botón «Abrir oficina». Solo `http://` o `https://`. Tiene prioridad sobre la de Ajustes. |

Liv muestra **una** oficina a la vez: un evento con otro `office` empieza de
cero con esa.

Los textos son de una línea (los saltos de línea se vuelven espacios) y, si
pasan de su límite, se cortan con «…». Un campo opcional que no vale —un nombre
que no es texto, una dirección que no es `http` ni `https`— se pasa por alto y
el resto del evento cuenta. Uno obligatorio que no vale deja el evento entero
sin efecto.

### `agent.state` — el estado de un agente

```json
{
  "type": "agent.state",
  "agent": { "id": "editora", "name": "Editora", "role": "Edición" },
  "state": "working",
  "summary": "Montando el vídeo 12",
  "item": { "id": "video-12", "title": "Vídeo 12", "stage": "edición" }
}
```

- `agent.id` (obligatorio): minúsculas, cifras y guiones, 24 como mucho.
  `agent.name` y `agent.role`: hasta 32 caracteres; se recuerdan, así que basta
  con enviarlos la primera vez.
- `state` (obligatorio):

  | Estado | Significa | Color del punto |
  |---|---|---|
  | `idle` | sin tarea | neutro |
  | `working` | trabajando | azul |
  | `waiting` | parado hasta que decidas algo | ámbar |
  | `blocked` | parado por otra causa (cuota, dependencia) | naranja |
  | `error` | falló | rojo |
  | `done` | terminó su tarea | verde |
  | `offline` | ya no está | apagado |

- `summary`: una línea de lo que hace ahora, hasta 140 caracteres. Si falta y
  el estado no ha cambiado, se conserva la anterior; al cambiar de estado se
  borra.
- `item`: la pieza en la que trabaja (un vídeo, un episodio) y su etapa. Si no
  hay `summary`, se muestra en su lugar («Vídeo 12 · edición»).

Un agente que dice estar `working`, `waiting` o `blocked` y lleva 15 minutos sin
enviar nada se muestra «sin señal» (su punto se atenúa) y deja de contar como
trabajando. Para evitarlo, reenvía su estado de vez en cuando; una petición o
una noticia que lo nombre también cuenta como señal.

### `ask.open` y `ask.close` — algo espera tu decisión

```json
{ "type": "ask.open",
  "agent": { "id": "guionista" },
  "ask": { "id": "guion-12", "title": "¿Apruebas el guion del vídeo 12?",
           "detail": "8 minutos, tono divulgativo",
           "open_url": "http://localhost:3000/videos/12/guion" } }
```

```json
{ "type": "ask.close", "ask": { "id": "guion-12" } }
```

- `ask.id` (obligatorio): hasta 48 caracteres; identifica la petición. Con uno
  más largo el evento se ignora.
- `ask.title` (obligatorio al abrir): hasta 100 caracteres. `ask.detail`: hasta 140.
- `ask.open_url`: adónde ir a decidir. Si falta, se usa la dirección de la oficina.
- `agent` es opcional aquí y en `news`: dice de quién viene.

Enviar otra vez un `ask.open` con un `id` que sigue pendiente lo pone al día
(título, detalle, dirección) sin volver a avisar.

Es el evento más importante: **Liv abre la isla y cuenta las peticiones
pendientes** hasta que la oficina envía `ask.close` con el mismo `id`. Liv no
responde por ti: el clic te lleva a la oficina, que es donde se decide.

### `news` — un hito o un aviso

```json
{ "type": "news", "agent": { "id": "publicadora" },
  "news": { "title": "Vídeo 12 publicado", "level": "success",
            "open_url": "https://youtu.be/…" } }
```

- `news.title` (obligatorio): hasta 100 caracteres.
- `news.level`: `info` (por defecto), `success`, `warning` o `error`.
- `news.open_url`: mientras la noticia sea el titular de la tarjeta, el botón ↗
  lleva a esa dirección.

### `reset` — la oficina se cierra

```json
{ "type": "reset" }
```

Borra todo lo que Liv sabía de la oficina. La píldora desaparece si no la
tienes activada en Ajustes.

## Qué hace la isla con cada evento

| Evento | La isla |
|---|---|
| `ask.open` | Se abre con la tarjeta de la oficina, suena el aviso de pregunta y la píldora lleva la insignia ámbar. |
| `agent.state` con `error`, `news` con `error` | Se asoma, con la insignia roja y el sonido de error. |
| `news` con `success` | Se asoma, con la insignia verde y el sonido de tarea terminada. |
| `news` con `warning` | Insignia ámbar, sin moverse. |
| Todo lo demás | Se actualiza en silencio. |

- «Asomarse» es que Liv salga de la isla plegada en un hueco pequeño, de cuerpo
  entero y con los colores de la noticia (verde si salió bien, rojo si falló),
  sin que la isla se abra; a los pocos segundos vuelve a entrar y queda la isla
  compacta. Un clic en el hueco abre la isla con la tarjeta de la oficina. Sale
  cuando la píldora de la oficina es la que tienes delante, o con «Abrir con los
  avisos de todas las píldoras» activado (entonces pasa al frente mientras Liv
  está fuera, y después vuelve la que tenías). En los demás casos solo se
  muestra la isla compacta si estaba oculta, y la insignia dice el resto. Con
  la isla ya abierta no se mueve nada.
- «Abrirse» ocurre estés en la píldora que estés, como con un permiso de un
  agente: la píldora de la oficina pasa al frente y, al cerrarse la isla, vuelve
  la que tenías. Solo cambia la insignia, sin abrirse, cuando hay una tarjeta de
  permiso esperando tu respuesta o estás escribiendo en el chat.
- Solo avisa lo nuevo: un agente que repite que sigue en `error` no vuelve a
  avisar.
- La insignia va sobre la píldora de la oficina mientras tienes otra píldora
  delante (se ve con la isla abierta) y se quita al mirar la oficina; la ámbar
  de las peticiones sigue ahí hasta que se cierran. Con la oficina delante es
  Liv quien lo dice, en su antena y en sus ojos: ámbar si algo espera por ti, rojo si un agente ha
  fallado, azul si alguno trabaja.
- Con Liv en pausa los eventos se anotan, sin sonido ni movimiento.

Límites: 12 agentes (si llega uno más, sale el que lleva más tiempo sin dar
señales, empezando por los que no tienen nada entre manos: `idle`, `done`,
`offline`), 20 peticiones pendientes (al llegar otra se olvida la más antigua)
y las 5 últimas noticias. Nada se guarda en disco: al cerrar Liv se olvida, y
la oficina vuelve a contarlo cuando envía sus estados.

## La tarjeta de la oficina

Con la píldora de la oficina delante, la tarjeta de la isla enseña:

- el nombre de la oficina y cuántos agentes tiene; mientras algo espera por
  ti, en su lugar y en ámbar, cuántas cosas («2 esperan por ti»);
- un titular: la petición pendiente más reciente; si no hay, la última noticia;
  si no, el agente del que se supo por última vez («Editora · Montando el vídeo
  12»);
- un punto por agente, del color de su estado (hasta seis, y «+n» por el
  resto); al pasar el ratón dice su nombre, su papel, su estado y lo que hace.
  Mientras algo espera por ti los puntos dejan sitio a la pregunta, para que se
  lea entera;
- los botones **Revisar** (solo con peticiones pendientes: abre la dirección de
  la más reciente o, si no tiene, la de la oficina) y **Abrir oficina**. Sin
  ninguna dirección conocida no hay botones: la tarjeta dice que la pongas en
  Ajustes.

## Privacidad

- Los eventos llegan por un canal local que solo acepta programas de tu sesión.
- Liv no los guarda, no los envía a ningún sitio y no los escribe en su registro.
- Las direcciones solo se abren cuando haces clic, y solo si son `http` o `https`.

## Probarla sin oficina

```powershell
node scripts/office-demo.mjs
```

Con Liv abierta, simula un equipo de YouTube durante un minuto: agentes que
trabajan, un guion que espera aprobación, un error y una publicación. Durante
la demo «Abrir oficina» lleva a YouTube Studio; para que lleve a otro sitio,
pasa la dirección: `node scripts/office-demo.mjs http://localhost:3000`.

## Lo que todavía no hace

- **Decidir desde la isla** (aprobar o rechazar sin abrir la oficina). Las
  decisiones de una oficina pueden tardar horas y dependen de cada herramienta;
  por ahora la isla avisa y te lleva.
- **Recibir eventos por HTTP.** Hoy solo por el relé, que no abre puertos.
- **Varias oficinas a la vez.**
