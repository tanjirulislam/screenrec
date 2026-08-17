; A tray application with no visible window cannot be closed by the normal
; NSIS window message, which is what produced "ScreenRec cannot be closed".
; Terminating the process outright before install removes the prompt.

!macro customInit
  nsExec::Exec 'taskkill /F /IM "ScreenRec.exe" /T'
  Sleep 800
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM "ScreenRec.exe" /T'
  Sleep 800
!macroend
