; Extra settings for the Windows installer (electron-builder picks this file up by itself).
!macro customHeader
  ; draw at the screen's real resolution: without this, Windows stretches the whole installer
  ; (text, buttons, window) on scaled displays and it looks blurry
  ManifestDPIAware true
!macroend
