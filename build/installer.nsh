!macro customInit
  ; Stop the previous installed/portable processes before replacing files.
  nsExec::ExecToLog 'taskkill /F /IM DreamWallpaper.exe'
  nsExec::ExecToLog 'taskkill /F /IM WallpaperEngine.exe'
  Sleep 700
!macroend

; Startup registration is managed by the app so existing user settings are respected.


!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.dreamwallpaper.desktop"
!macroend
