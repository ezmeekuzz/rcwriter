; RCWriter installer additions: a page to choose the app password.
; The password is handed to the app through a one-time file in the user's
; RCWriter data folder. The app hashes it on first launch and deletes the file.

!macro customPageAfterChangeDir
  !include nsDialogs.nsh
  Var AsPwDialog
  Var AsPwField1
  Var AsPwField2
  Var AsPwValue

  Page custom AsPasswordPageCreate AsPasswordPageLeave

  Function AsPasswordPageCreate
    !insertmacro MUI_HEADER_TEXT "Set a password" "Keep other people who use this computer out of RCWriter."
    nsDialogs::Create 1018
    Pop $AsPwDialog
    ${If} $AsPwDialog == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 44u "RCWriter will ask for this password when it opens. Your scheduled articles keep being written in the background while it's locked.$\r$\n$\r$\nLeave both boxes empty to skip. If you're updating, leaving them empty keeps your current password."
    Pop $0

    ${NSD_CreateLabel} 0 52u 100% 10u "Password (at least 6 characters)"
    Pop $0
    ${NSD_CreatePassword} 0 64u 70% 13u ""
    Pop $AsPwField1

    ${NSD_CreateLabel} 0 86u 100% 10u "Confirm password"
    Pop $0
    ${NSD_CreatePassword} 0 98u 70% 13u ""
    Pop $AsPwField2

    ${NSD_SetFocus} $AsPwField1
    nsDialogs::Show
  FunctionEnd

  Function AsPasswordPageLeave
    ${NSD_GetText} $AsPwField1 $0
    ${NSD_GetText} $AsPwField2 $1
    StrCmpS $0 $1 +3 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "The passwords don't match. Type the same password in both boxes."
      Abort
    StrLen $2 $0
    ${If} $2 > 0
    ${AndIf} $2 < 6
      MessageBox MB_ICONEXCLAMATION|MB_OK "Use at least 6 characters, or leave both boxes empty to skip."
      Abort
    ${EndIf}
    StrCpy $AsPwValue $0
  FunctionEnd
!macroend

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    ${If} $AsPwValue != ""
      Push $3
      Push $4
      Push $5
      Push $6
      Push $7
      Push $8
      Push $9
      SetShellVarContext current
      CreateDirectory "$APPDATA\${PRODUCT_NAME}"
      ; Written as UTF-16LE one byte at a time (this NSIS build's word writes are unreliable),
      ; so passwords with any characters survive exactly.
      FileOpen $9 "$APPDATA\${PRODUCT_NAME}\setup-password.txt" w
      FileWriteByte $9 255
      FileWriteByte $9 254
      StrLen $3 $AsPwValue
      StrCpy $4 0
      ${While} $4 < $3
        StrCpy $5 $AsPwValue 1 $4
        System::Call "*(&w1 r5)p.r6"
        System::Call "*$6(&i2 .r7)"
        System::Free $6
        IntOp $8 $7 & 0xFF
        FileWriteByte $9 $8
        IntOp $8 $7 >> 8
        FileWriteByte $9 $8
        IntOp $4 $4 + 1
      ${EndWhile}
      FileClose $9
      StrCpy $AsPwValue ""
      ${If} $installMode == "all"
        SetShellVarContext all
      ${EndIf}
      Pop $9
      Pop $8
      Pop $7
      Pop $6
      Pop $5
      Pop $4
      Pop $3
    ${EndIf}
  !endif
!macroend
