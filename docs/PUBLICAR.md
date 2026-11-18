# Publicar Liv

Todo lo que hace falta para publicar Liv está preparado en el repositorio. Lo
que sigue son los pasos que solo puede dar quien lo publica, en orden. Ninguno
se ejecuta solo.

## Antes de empezar

- El instalador no está firmado. La primera vez que alguien lo ejecute,
  Windows SmartScreen avisará de que el editor es desconocido («Más
  información» → «Ejecutar de todas formas»). Firmarlo requiere un certificado
  de firma de código, que es de pago.
- Liv se desarrolla y se prueba en Windows. El código para Linux que venía con
  la base se conserva, pero no se ha probado y no se publica instalador para él.

## 1. Hacer la copia con historial limpio

El historial de este repositorio empieza con el código de partida, que incluía
el personaje, los iconos y los sonidos de Coucou. Liv no puede distribuirlos
(ver [`NOTICE.md`](../NOTICE.md)) y el historial se publica con el
repositorio, así que se publica una copia con un único commit:

```powershell
node scripts/export-clean.mjs
```

Crea `..\Liv-publico` con los archivos del commit actual y un solo commit. No
toca este repositorio ni sube nada. El script dice qué nombre y qué correo
llevará ese commit: **serán públicos**. Si prefieres otros (GitHub ofrece una
dirección `…@users.noreply.github.com` en Settings → Emails), cámbialos antes
de subir:

```powershell
git -C ..\Liv-publico config user.name "Tu nombre"
git -C ..\Liv-publico config user.email "tu-usuario@users.noreply.github.com"
git -C ..\Liv-publico commit --amend --reset-author --no-edit
```

A partir de aquí se trabaja en la copia; este repositorio queda como archivo
privado.

## 2. Crear el repositorio y subirlo

```powershell
gh auth login
```

```powershell
gh repo create liv --private --source ..\Liv-publico --remote origin --push
```

Empieza en privado: revisa en GitHub que está lo que debe y nada más, y hazlo
público cuando quieras desde Settings → General → Change visibility.

La integración continua (`.github/workflows/ci.yml`) se ejecuta sola con cada
subida a `main`: compila y pasa todas las pruebas en Windows.

## 3. Encender el aviso de versiones nuevas (opcional)

Está apagado hasta que exista dónde mirar. En
`src-tauri/src/update.rs`, cambia

```rust
pub const RELEASES_REPO: Option<&str> = None;
```

por el repositorio público, por ejemplo `Some("tu-usuario/liv")`. Liv solo
consulta la lista de versiones de ese repositorio, sin enviar nada del usuario,
y pregunta antes de hacerlo la primera vez.

## 4. Publicar una versión

1. Sube la versión en `src-tauri/tauri.conf.json`, en `Cargo.toml` (la del
   espacio de trabajo) y en `package.json`.
2. Confirma, sube y etiqueta con el mismo número:

   ```powershell
   git tag windows-v0.1.0
   ```

   ```powershell
   git push origin main windows-v0.1.0
   ```

3. `.github/workflows/release.yml` compila el instalador y lo adjunta a una
   versión en **borrador**. Revísala en GitHub → Releases y publícala.

Para compilar el instalador en este equipo, sin GitHub:

```powershell
npm run pack
```

Deja `release\Liv-Windows-<versión>-setup.exe`. Se instala por usuario, sin
permisos de administrador.

## Qué hace el desinstalador

Quita la aplicación, el relé de hooks, los archivos soltados y el registro.
Antes pregunta si quitar también los hooks de Liv de Claude Code y de los
demás agentes: con un sí, borra solo las entradas de Liv y deja junto a cada
archivo de ajustes una copia con fecha; con un no (o en una desinstalación
silenciosa) no toca esos archivos. Los ajustes de Liv (`%APPDATA%\Liv`) y las
claves guardadas en el Administrador de credenciales de Windows se conservan.
