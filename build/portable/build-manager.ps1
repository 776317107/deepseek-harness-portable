# build-manager.ps1 — build the Harness Manager desktop shell (WebView2).
#
#   1. download the Microsoft.Web.WebView2 NuGet package once (cached under
#      build\portable\webview2\) — provides the managed DLLs for csc and the
#      native WebView2Loader.dll to ship beside the exe.
#   2. compile build\portable\HarnessManager.cs with the system csc.exe.
#   3. stage HarnessManager.exe + WebView2Loader.dll into
#      build\portable\skeleton\ (top-level files flow into BOTH editions:
#      folder edition via build-all.ps1 step 5, exe payload via make-zips).
#
# NOTE: keep this script ASCII-only — Windows PowerShell 5.1 decodes a
# BOM-less UTF-8 script as ANSI (build-all.ps1 step 5 had this exact bug).
# The C# source may contain UTF-8 (Chinese) text; read it explicitly.

param(
    [string]$WebView2Version = "1.0.2903.40"
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$CacheDir = Join-Path $ScriptDir "webview2"
$Source = Join-Path $ScriptDir "HarnessManager.cs"
$Skeleton = Join-Path $ScriptDir "skeleton"

function Find-Csc {
    foreach ($base in @(
        "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319",
        "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319"
    )) {
        $candidate = Join-Path $base "csc.exe"
        if (Test-Path $candidate) { return $candidate }
    }
    throw ".NET Framework csc.exe not found; install .NET Framework 4.x"
}

# ---- 1. WebView2 SDK cache ----
$versionFile = Join-Path $CacheDir "VERSION.txt"
$coreDll = Join-Path $CacheDir "Microsoft.Web.WebView2.Core.dll"
$winFormsDll = Join-Path $CacheDir "Microsoft.Web.WebView2.WinForms.dll"
$loaderDll = Join-Path $CacheDir "WebView2Loader.dll"
$haveCache = (Test-Path $coreDll) -and (Test-Path $winFormsDll) -and (Test-Path $loaderDll)

if (-not ($haveCache -and (Test-Path $versionFile) -and ((Get-Content $versionFile -Raw).Trim() -eq $WebView2Version))) {
    Write-Host "downloading WebView2 SDK $WebView2Version ..."
    New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
    $nupkg = Join-Path $CacheDir "Microsoft.Web.WebView2.$WebView2Version.nupkg"
    $zip = Join-Path $CacheDir "Microsoft.Web.WebView2.$WebView2Version.zip"
    $extract = Join-Path $CacheDir "pkg"
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
    Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$WebView2Version" -OutFile $nupkg
    Copy-Item $nupkg $zip -Force
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $extract)
    Copy-Item (Join-Path $extract "lib\net462\Microsoft.Web.WebView2.Core.dll") $coreDll -Force
    Copy-Item (Join-Path $extract "lib\net462\Microsoft.Web.WebView2.WinForms.dll") $winFormsDll -Force
    # native loader must be the x64 build and sit beside the exe at runtime
    Copy-Item (Join-Path $extract "runtimes\win-x64\native\WebView2Loader.dll") $loaderDll -Force
    Remove-Item -Recurse -Force $extract
    Remove-Item $nupkg, $zip -Force -ErrorAction SilentlyContinue
    Set-Content -Path $versionFile -Value $WebView2Version
    Write-Host "WebView2 SDK cached"
} else {
    Write-Host "WebView2 SDK cache OK ($WebView2Version)"
}

# ---- 2. compile ----
# csc decodes sources by the system codepage unless a BOM is present, so
# re-encode the UTF-8 source into a BOM'd temp file first (same pattern as
# build-exe.ps1).
$tempSource = Join-Path $CacheDir "HarnessManager.generated.cs"
$sourceText = Get-Content $Source -Raw -Encoding UTF8
Set-Content -Path $tempSource -Value $sourceText -Encoding UTF8

$csc = Find-Csc
$icon = Join-Path $ScriptDir "app.ico"
$manifest = Join-Path $ScriptDir "app.manifest"
$outExe = Join-Path $Skeleton "HarnessManager.exe"
$iconArgs = @(); if (Test-Path $icon) { $iconArgs = @("/win32icon:$icon") }
$manifestArgs = @(); if (Test-Path $manifest) { $manifestArgs = @("/win32manifest:$manifest") }

Write-Host "csc     : $csc"
& $csc /nologo /target:winexe /platform:x64 /out:$outExe `
    /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll `
    /r:$coreDll /r:$winFormsDll `
    $iconArgs $manifestArgs `
    $tempSource

if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

# ---- 3. ship the managed + native DLLs beside the exe ----
# .NET Framework resolves assemblies from the exe directory / GAC only, so
# the WebView2 managed DLLs must ship next to HarnessManager.exe too (the
# native WebView2Loader.dll alone is not enough).
Copy-Item $loaderDll (Join-Path $Skeleton "WebView2Loader.dll") -Force
Copy-Item $coreDll (Join-Path $Skeleton "Microsoft.Web.WebView2.Core.dll") -Force
Copy-Item $winFormsDll (Join-Path $Skeleton "Microsoft.Web.WebView2.WinForms.dll") -Force
Write-Host "built: $outExe (+ WebView2 DLLs staged to skeleton)"
