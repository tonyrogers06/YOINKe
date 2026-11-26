<#
.SYNOPSIS
  Packages YOINKe into:
    1. dist\YOINKe-Windows.zip
    2. dist\YOINKe-Setup.exe (via built-in Windows iexpress.exe)
#>
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dist = Join-Path $Root "dist\YOINKe-Windows"

Write-Host "Building YOINKe Windows Release in $Dist..."
Remove-Item $Dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$Dist\extension", "$Dist\native-host\bin" | Out-Null

# Copy extension
Copy-Item "$Root\extension\*" "$Dist\extension\" -Recurse -Force

# Copy native-host (exclude personal db, logs, venv, cache, local manifests)
Get-ChildItem "$Root\native-host" -Exclude "videograbber.db*","logs",".venv","__pycache__","*.bat","*.sh","manifest_host.json","com.videograbber.host.json" | ForEach-Object {
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
    Write-Host "[INFO] $tool not pre-bundled (install.bat will auto-download it)"
  }
}

# Create portable zip archive
$ZipPath = "$Root\dist\YOINKe-Windows.zip"
Remove-Item $ZipPath -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$Dist\*" -DestinationPath $ZipPath -Force
Write-Host "[OK] Release archive created: $ZipPath"

# Create self-extracting YOINKe-Setup.exe using built-in .NET compiler (no external tools)
$SetupExe = "$Root\dist\YOINKe-Setup.exe"
Remove-Item $SetupExe -Force -ErrorAction SilentlyContinue
$Csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (Test-Path $Csc) {
  $CsPath = "$Root\dist\_setup_stub.cs"
  $IcoPath = "$Root\native-host\icon.ico"
  @"
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;

class YoinkeSetup {
    static void Main() {
        string dest = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "YOINKe"
        );
        Console.WriteLine("Installing YOINKe to: " + dest);
        Directory.CreateDirectory(dest);
        string tmpZip = Path.Combine(Path.GetTempPath(), "yoinke_setup_payload.zip");
        using (Stream res = Assembly.GetExecutingAssembly().GetManifestResourceStream("YOINKe-Windows.zip"))
        using (FileStream fs = File.Create(tmpZip)) {
            res.CopyTo(fs);
        }
        // Extract/overwrite into %LOCALAPPDATA%\YOINKe
        string exTmp = Path.Combine(Path.GetTempPath(), "yoinke_ex_" + Guid.NewGuid().ToString("N").Substring(0, 8));
        ZipFile.ExtractToDirectory(tmpZip, exTmp);
        CopyDir(exTmp, dest);
        try { File.Delete(tmpZip); Directory.Delete(exTmp, true); } catch {}

        string bat = Path.Combine(dest, "native-host", "install.bat");
        Process.Start(new ProcessStartInfo("cmd.exe", "/c \"" + bat + "\"") {
            WorkingDirectory = Path.Combine(dest, "native-host"),
            UseShellExecute = true
        });
    }

    static void CopyDir(string src, string dst) {
        Directory.CreateDirectory(dst);
        foreach (string f in Directory.GetFiles(src)) {
            File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), true);
        }
        foreach (string d in Directory.GetDirectories(src)) {
            CopyDir(d, Path.Combine(dst, Path.GetFileName(d)));
        }
    }
}
"@ | Set-Content -Path $CsPath -Encoding UTF8

  $cscArgs = @(
    "/nologo", "/target:exe",
    "/out:$SetupExe",
    "/reference:System.IO.Compression.FileSystem.dll",
    "/resource:$ZipPath,YOINKe-Windows.zip"
  )
  if (Test-Path $IcoPath) { $cscArgs += "/win32icon:$IcoPath" }
  $cscArgs += $CsPath

  & $Csc @cscArgs
  Remove-Item $CsPath -Force -ErrorAction SilentlyContinue
  if (Test-Path $SetupExe) {
    Write-Host "[OK] Self-extracting installer created: $SetupExe"
  }
}
