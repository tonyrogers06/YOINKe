<#
.SYNOPSIS
  Packages YOINKe into a distributable Windows release folder & zip.
  Optionally builds standalone YOINKe.exe if PyInstaller is installed.
#>
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dist = Join-Path $Root "dist\YOINKe-Windows"

Write-Host "Building YOINKe Windows Release in $Dist..."
Remove-Item $Dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$Dist\extension", "$Dist\native-host\bin" | Out-Null

# Copy extension
Copy-Item "$Root\extension\*" "$Dist\extension\" -Recurse -Force

# Copy native-host (exclude db, logs, cache)
Get-ChildItem "$Root\native-host" -Exclude "videograbber.db*","logs","__pycache__","*.bat","*.sh" | ForEach-Object {
  Copy-Item $_.FullName "$Dist\native-host\" -Recurse -Force
}
Copy-Item "$Root\native-host\install.bat"   "$Dist\native-host\" -Force
Copy-Item "$Root\native-host\uninstall.bat" "$Dist\native-host\" -Force

# Bundle ffmpeg.exe & N_m3u8DL-RE.exe into native-host\bin if present
foreach ($tool in @("ffmpeg.exe", "N_m3u8DL-RE.exe")) {
  $src = "C:\tools\VideoGrabber\$tool"
  if (Test-Path $src) {
    Copy-Item $src "$Dist\native-host\bin\$tool" -Force
    Write-Host "[OK] Bundled $tool"
  } else {
    Write-Host "[WARN] $tool not found at $src"
  }
}

# Create zip archive
$ZipPath = "$Root\dist\YOINKe-Windows.zip"
Remove-Item $ZipPath -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$Dist\*" -DestinationPath $ZipPath -Force
Write-Host "[OK] Release archive created: $ZipPath"
