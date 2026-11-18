# Liv

Una Dynamic Island para Windows: una isla negra en el borde superior de la
pantalla que muestra lo que está pasando y se abre cuando la necesitas.

Proyecto personal, de código abierto y sin fines de lucro.

## Estado

En construcción, por fases. La base heredada de Coucou ya está adaptada:
podada, con nombre propio, solo en español e inglés, y con un personaje propio
(Liv, un robot pequeño y redondo) en lugar del heredado, sin sus sonidos ni su icono. El núcleo de la isla, el canal con los agentes y las funciones ya están revisados, las herramientas y los sonidos están hechos, y la publicación está preparada.

Liv se desarrolla y se prueba en Windows. El código para Linux que venía con la
base se conserva, pero no se ha probado.

| Fase | Qué se hace | Estado |
|---|---|---|
| 0. Base | Repositorio con el código de partida y su licencia | Hecha |
| 1. Poda | Quitar los módulos que Liv no usa (enlace con el teléfono, WhatsApp, correo, voz, dictado, notas) | Hecha |
| 2. Renombrado | Nombre, identificador, ejecutable de hooks y carpetas propios; solo español e inglés | Hecha |
| 3. Hueco del personaje | Una forma simple en lugar del personaje heredado; sin sus sonidos ni su icono | Hecha |
| 4. Pulido del núcleo | Abrir y cerrar, hover, varios monitores, escalado, bandeja, ajustes, atajos | Hecha |
| 5. Agentes | Sesiones de Claude Code con Permitir y Denegar desde la isla | Hecha |
| 6. Funciones | Reproduciendo ahora (cualquier reproductor de Windows), chat, soltar archivos, GitHub | Hecha |
| 7. Herramientas | Portapapeles, repisa de archivos, capturas | Hecha |
| 8. Identidad | Personaje, icono y sonidos propios | Hecha |
| 9. Publicación | Integración continua, instalador y primera versión | Preparada; falta subirla (ver [`docs/PUBLICAR.md`](docs/PUBLICAR.md)) |

Las fases 5 y 6 no partieron de cero: el código heredado ya traía el canal con
los agentes (el relé de hooks, la instalación de los hooks de Claude Code con
copia y diff, las tarjetas de permiso y de pregunta, y otros agentes como Codex,
Cursor o Gemini CLI) y varias funciones (la música, el chat con varios
proveedores, soltar archivos, GitHub y otras integraciones, el resumen
semanal). De ellas se han revisado para Liv el canal con Claude Code, el chat
con Claude, la música y GitHub; el resto funciona como llegó. El aviso de
versiones nuevas está apagado hasta que Liv publique la primera.

La píldora de **Música** muestra lo que suena en cualquier aplicación que se lo
cuente a Windows (Spotify, el navegador, un reproductor), con los controles que
esa aplicación acepte. El volumen es el de la propia aplicación, nunca el del
sistema.

### Herramientas

La pestaña **Herramientas** de la isla (`Ctrl+Alt+V`) reúne tres cosas, escritas
para Liv:

- **Portapapeles**: lo último que copiaste, texto e imágenes. Un clic lo pega
  donde estabas escribiendo: la isla no te quita el foco. El historial vive solo
  en memoria: nada de lo que copias se escribe en disco y se olvida al cerrar
  Liv. Lo que un gestor de contraseñas marca como privado no se guarda. Se apaga
  en Ajustes → General → Herramientas.
- **Repisa**: suelta archivos sobre ella para tenerlos a mano y arrástralos
  después a cualquier aplicación; un clic copia el archivo. Guarda la ruta del
  original, no una copia.
- **Capturas**: un área (`Ctrl+Alt+Mayús+A`) o la pantalla (`Ctrl+Alt+Mayús+S`),
  sin la isla en la imagen. Se guardan en `Imágenes\Liv`, se copian al
  portapapeles y quedan en la repisa. No se envían a ningún sitio.

Los atajos se cambian en Ajustes.

### Sonidos

Liv tiene voz propia: catorce sonidos cortos y suaves, cada uno con su forma
para reconocerlo de oído, que suben cuando algo sale bien y bajan cuando
falla. No son grabaciones de nadie:
los sintetiza `npm run sounds` a partir de las recetas de
`scripts/sounds/recipes.mjs` y quedan en `resources/sounds` (unos 200 KB en total).
Cualquiera se sustituye dejando un archivo con su nombre en la carpeta de
sonidos (Ajustes → General), y se oyen uno a uno en `dev/sounds-preview.html`
con `npm run dev`.

Ya añadido fuera de ese orden: el **tamaño de la isla** y **ocultarse cuando
otra aplicación está en pantalla completa**, los dos en Ajustes; y la
**apariencia** de la isla abierta (Ajustes → General → Apariencia): su ancho,
un alto adicional, el redondeo de las esquinas y la opacidad, con un botón para
volver a los valores de origen.

Ya preparado: la isla puede mostrar una **oficina virtual**, un equipo de agentes de IA que trabaja en otro programa y le envía eventos — ver [`docs/OFICINA.md`](docs/OFICINA.md).

## Desarrollo

Requisitos: Windows 10 u 11, [Rust](https://rustup.rs), Node 22.18 o posterior
y las Build Tools de Visual Studio con «Desarrollo para el escritorio con C++».

```powershell
npm install
npm run tauri dev
```

Comprobaciones antes de cada cambio:

```powershell
npx tsc --noEmit
npm test
cargo test --workspace --locked
```

## Instalar y desinstalar

El instalador se compila con `npm run pack` y queda en
`release\Liv-Windows-<versión>-setup.exe`. Se instala por usuario, sin permisos
de administrador. No está firmado: Windows avisará la primera vez.

Al desinstalar, Liv pregunta si quitar también sus hooks de Claude Code y de
los demás agentes. Con un sí borra solo sus propias entradas y deja una copia
con fecha de cada archivo; sin ese sí no los toca.

Los pasos para publicar el proyecto están en
[`docs/PUBLICAR.md`](docs/PUBLICAR.md).

## Créditos y licencia

Liv parte del código de [Coucou](https://github.com/Louis-CFM/coucou), de Louis
Raillé, bajo licencia MIT. Ver [`LICENSE`](LICENSE) y [`NOTICE.md`](NOTICE.md).
