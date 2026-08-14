; DSH Desktop installer script - placeholders injected by scripts/make-installer.mjs
; Uses nsis7z plugin to embed app.7z directly (bypasses electron-builder 24.x
; broken NSIS payload-append that produced ~60KB empty stubs in this sandbox).

!include "MUI2.nsh"

!define PRODUCT_NAME "@@PRODUCT_NAME@@"
!define PRODUCT_VERSION "@@PRODUCT_VERSION@@"
!define EXE_NAME "@@EXE_NAME@@"

; nsis7z plugin dir + app.7z are copied into the same temp dir as this script,
; so they are referenced by a relative path (avoids makensis absolute-path bugs).
!addplugindir "@@PLUGINS@@"

Name "${PRODUCT_NAME}"
OutFile "@@OUTFILE@@"
; Embed the DeepSeek icon natively (makensis handles group-icon IDs correctly)
Icon "icon.ico"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
InstallDirRegKey HKCU "Software\${PRODUCT_NAME}" "InstallDir"
RequestExecutionLevel user

; app.7z is already LZMA2-compressed; do not recompress inside the installer
SetCompress off

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE_NAME}"
!define MUI_FINISHPAGE_RUN_TEXT "Run ${PRODUCT_NAME}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Main" SEC01
  SetOutPath "$INSTDIR"
  ; embed app.7z (relative to this script) into $PLUGINSDIR, then extract
  File "/oname=$PLUGINSDIR\app.7z" "app.7z"
  Nsis7z::Extract "$PLUGINSDIR\app.7z"
  Pop $0
  Delete "$PLUGINSDIR\app.7z"

  WriteRegStr HKCU "Software\${PRODUCT_NAME}" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${EXE_NAME}"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${EXE_NAME}"
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"
  DeleteRegKey HKCU "Software\${PRODUCT_NAME}"
SectionEnd
