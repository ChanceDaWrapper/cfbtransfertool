; Custom NSIS hooks. electron-builder auto-includes build/installer.nsh.
;
; Why this exists: the shortcuts electron-builder generated ended up with a
; CORRUPTED IconLocation -- a path made of literal '?' characters that doesn't
; resolve to any file. Windows then falls back to the blank "document" icon,
; and because the app sets a matching AppUserModelID (see app.setAppUserModelId
; in main.js), the taskbar button inherits that broken shortcut icon instead of
; the window's own (correct) icon. Recreating the shortcuts here with the icon
; explicitly pinned to the executable makes the icon deterministic.

!macro customInstall
  ; "" = no arguments; icon is $INSTDIR\<exe>, index 0 (the app icon resource).
  CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
!macroend
