; Uninstall hooks for the NSIS installer.
;
; The app stages liv-hook.exe into %LOCALAPPDATA%\Liv\bin at launch, so the
; installer never recorded it and the default uninstaller leaves it behind. The
; inbox and the log live in the same place and are ours too.
;
; Liv's hooks in Claude Code's settings.json (and in the other agents' config
; files) would be left pointing at a relay that is gone. Those files belong to
; the user, so the uninstaller ASKS before touching them, and only a yes runs
; `liv.exe --remove-hooks` (src-tauri/src/unhook.rs): the same removal Settings
; offers, through the same writer — only Liv's own entries leave, and a dated
; backup is taken next to each file first. A silent uninstall (/S) answers no:
; nobody was there to say yes.
;
; The texts are picked here by the installer's language (1034 and 3082 are
; Spanish): this file is included before the languages are loaded, so it
; cannot declare LangStrings of its own.

!macro NSIS_HOOK_PREUNINSTALL
  StrCmp $LANGUAGE 1034 liv_hooks_es
  StrCmp $LANGUAGE 3082 liv_hooks_es
    StrCpy $1 "Remove Liv's hooks from Claude Code and the other agents too?$\r$\n$\r$\nOnly Liv's own entries are removed, and a dated backup of each settings file is kept next to it. If you answer No, they stay and point to a program that no longer exists."
    StrCpy $2 "Some of Liv's hooks could not be removed. You can delete them by hand from the agent's settings file (the entries that mention liv-hook)."
    Goto liv_hooks_ask
  liv_hooks_es:
    StrCpy $1 "¿Quitar también los hooks de Liv de Claude Code y de los demás agentes?$\r$\n$\r$\nSolo se quitan las entradas de Liv, y junto a cada archivo de ajustes queda una copia con fecha. Si respondes No, se quedan apuntando a un programa que ya no existe."
    StrCpy $2 "Algunos hooks de Liv no se pudieron quitar. Puedes borrarlos a mano del archivo de ajustes del agente (las entradas que mencionan liv-hook)."
  liv_hooks_ask:
  MessageBox MB_YESNO|MB_ICONQUESTION "$1" /SD IDNO IDNO liv_hooks_done
    ExecWait '"$INSTDIR\liv.exe" --remove-hooks' $0
    StrCmp $0 "0" liv_hooks_done
    MessageBox MB_OK|MB_ICONEXCLAMATION "$2" /SD IDOK
  liv_hooks_done:

  RMDir /r "$LOCALAPPDATA\Liv\bin"
  RMDir /r "$LOCALAPPDATA\Liv\inbox"
  Delete "$LOCALAPPDATA\Liv\liv.log"
!macroend
