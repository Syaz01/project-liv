# Liv — guía para agentes de código

Liv es una Dynamic Island para Windows hecha con Tauri 2: Rust en `src-tauri/`,
TypeScript sin framework en `src/` y el relé de hooks en `hook/`. Parte del
código de Coucou para Windows (MIT). El dueño del proyecto escribe en español.

## Dónde está cada cosa
- `src/island/` — la isla: máquina de estados (`fsm.ts`), geometría y bucle de animación (`island.ts`), hooks de agentes (`hooks.ts`).
- `src/core/` — estado (`state.ts`), puente con Rust (`bridge.ts`), tamaños (`layout.ts`), resortes y curvas (`anim.ts`).
- `src/views/` — las vistas de la isla; `src/settings/` y `src/hub/` — la ventana de ajustes.
- `src/style.css` — todo el aspecto de la isla.
- `src/core/office.ts`, `src/island/office.ts`, `src/views/office.ts` — la oficina virtual (`liv-hook office`); su contrato es `docs/OFICINA.md`. La pestaña de la oficina está en la cabecera (`views/views.ts`); `docs/OFICINA-PROYECTO.md` es la guía para quien construya la oficina, que es un programa aparte.
- `src/core/particles.ts` y `src/views/stars.ts` — las motas que derivan detrás de Liv en las tarjetas de la isla y en la ventana de Ajustes; `src/core/chat-look.ts` — el icono de rombos del chat y el color de Liv según quién responde.
- `src/core/appearance.ts` y `src-tauri/src/appearance.rs` — la forma de la isla abierta que el usuario elige en Ajustes → Apariencia (ancho, alto adicional, redondeo de las esquinas, opacidad): rangos, valores por defecto y el panel de la ventana; la sección de Ajustes está en `src/settings/appearance.ts`.
- `src/core/scale.ts` y `src-tauri/src/scale.rs` — el tamaño de la isla (zoom del webview); `src-tauri/src/fullscreen.rs` — apartarse cuando otra app está en pantalla completa.
- `src/core/guards.ts` — lo que la página rechaza como navegador (recargar, zoom, menú; en Rust, `webview_guard.rs`); `alerts.ts` — cuándo una alerta puede tomar la pantalla; `frames.ts` — cuándo se detiene el bucle de animación.
- `src/robot/` — Liv, el robot: su dibujo (`paint.ts`), sus caras por estado (`look.ts`), su vida y reacciones (`life.ts`, `react.ts`), su baile (`dance.ts`), su vestuario (`outfits.ts`, con el panel en `src/views/wardrobe.ts`) y el motor (`robot.ts`); las láminas de referencia están en `design/`. `src/upload/` — la secuencia de soltar un archivo; `src/recap/` — el resumen semanal; `src/whats-new/` — la tarjeta de novedades tras actualizar.
- `src-tauri/src/clipboard.rs`, `shelf.rs`, `capture.rs` — las herramientas: el historial del portapapeles (solo en memoria), la repisa de archivos (`shelf.json`, referencias a los originales; arrastre OLE hacia fuera) y las capturas de pantalla o de un área (PNG en `Imágenes\Liv`, sin red); del lado de la página, `src/core/tools.ts` (reglas), `src/island/tools.ts` (eventos de Rust) y `src/views/tools.ts` (la vista Herramientas).
- `src/pet/` — Liv en el escritorio: su ventana (`pet.html`, `main.ts`), sus salidas y regresos (`outing.ts`), el camino (`travel.ts`), la silueta y el tamaño de la ventana (`shape.ts`); del lado de la isla, `src/island/pet.ts`; la ventana en Rust, `src-tauri/src/pet.rs`.
- `src/i18n/` — los textos (`strings.json`), en español e inglés.
- `src-tauri/src/spotify.rs`, `src/core/spotify.ts`, `src/views/spotify.ts` — la píldora de música: en Windows, lo que suena en cualquier reproductor (conserva el nombre con que se guardó). `src/core/claude-models.json` — la única lista de modelos de Claude, que leen los ajustes, el chat y Rust (`claude.rs`).
- `tests/` — las pruebas de la lógica (`npm test`); `dev/` — vistas previas en el navegador con `npm run dev`, no se distribuyen; `scripts/` — iconos, sonidos (`gen-sounds.mjs`, con el sintetizador y las recetas en `scripts/sounds/`; los archivos van a `resources/sounds/`), empaquetado y demo de la oficina; `docs/` — contratos (`OFICINA.md`).
- `src-tauri/src/unhook.rs` y `src-tauri/nsis/hooks.nsh` — el desinstalador pregunta y, con un sí, `liv --remove-hooks` quita los hooks de Liv con copia de seguridad; `.github/workflows/` — integración continua y versiones en borrador; `scripts/export-clean.mjs` y `docs/PUBLICAR.md` — la copia con historial limpio y los pasos para publicar.
- `src-tauri/src/lib.rs` — arranque y registro de comandos; `island.rs` — posición de la ventana y paso de clics; `pipe.rs` y `hooks.rs` — el canal con los agentes.
- `coucou-main/`, `island-main/`, `NusaSetup/` — proyectos de referencia, fuera del repositorio. No se editan. `NusaSetup.exe` no se ejecuta.

## Comandos
```
npm install
npm run tauri dev
npx tsc --noEmit
npm test
cargo test --workspace --locked
```

## Reglas
- El aspecto y el movimiento de la isla (tamaños, radios, colores, resortes, curvas, tiempos de `style.css`, `core/anim.ts`, `core/layout.ts` e `island/fsm.ts`) heredados de Coucou son el valor por defecto y se conservan idénticos: no se retocan sin que se pida. El ancho de la isla abierta, su alto adicional, el redondeo de sus esquinas y su opacidad son ajustes del usuario (`src/core/appearance.ts`); con sus valores por defecto la isla es exactamente la heredada.
- Nada del material reservado de Coucou se distribuye: los nombres «Coucou» y «Mochi», el personaje y sus animaciones, el icono, los sonidos y sus imágenes. Ver `NOTICE.md`.
- `LICENSE` conserva el aviso de copyright de Louis Raillé.
- Antes de publicar el repositorio, el historial público no debe contener el personaje, los iconos ni los sonidos heredados: si están en commits anteriores, se publica con historial limpio.
- Nunca bloquear a un agente: si la app no responde, el relé sale de inmediato.
- Nunca sobrescribir `~/.claude/settings.json`: copia con fecha, fusión, mostrar el diff y escribir solo tras confirmar.
- Nunca aprobar un permiso sin un clic explícito del usuario.
- Los secretos van al Administrador de credenciales de Windows, nunca a disco ni a git.
- Sin telemetría. Solo se llama a los servicios que el usuario configuró.
- 0 % de CPU con la isla oculta: el bucle de animación se detiene cuando nada se mueve.
- El DOM se construye con nodos y `textContent`, nunca con `innerHTML`.
- La lógica va en módulos sin DOM ni Tauri, con su prueba al lado en `tests/`.
