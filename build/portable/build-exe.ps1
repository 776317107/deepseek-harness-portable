# build-exe.ps1 — build the single-file DeepSeek-Harness-Portable.exe
#
#   .\build\portable\build-exe.ps1 -PayloadDir <portable folder> -Out <exe path>
#
# Steps:
#   1. pack dsh.zip (app + tools + docs) and node.zip (node.exe) — see make-zips.ps1
#   2. compile launcher.cs with the .NET Framework csc.exe, embedding both zips
#      as managed resources (and the icon when available)

param(
    [Parameter(Mandatory = $true)][string]$PayloadDir,
    [string]$Out = (Join-Path (Get-Location) "DeepSeek-Harness-Portable.exe"),
    [string]$Source = "",
    [string]$WorkDir = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $Source) { $Source = Join-Path $ScriptDir "launcher.cs" }
if (-not $WorkDir) { $WorkDir = Join-Path $ScriptDir "work" }

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

# 1. payload zips
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
& (Join-Path $ScriptDir "make-zips.ps1") -PayloadRoot $PayloadDir -OutDir $WorkDir

$dshZip = Join-Path $WorkDir "dsh.zip"
$nodeZip = Join-Path $WorkDir "node.zip"
foreach ($p in @($dshZip, $nodeZip, $Source)) {
    if (-not (Test-Path $p)) { throw "input not found: $p" }
}

# 1b. template the launcher Version from the installed dsh package, so a
# rebuilt exe extracts into a fresh cache dir (never reuses an older payload).
$dshManifest = Join-Path $PayloadDir "app\node_modules\@deepseek-ai\dsh\package.json"
if (-not (Test-Path $dshManifest)) { throw "dsh package manifest not found: $dshManifest" }
$dshVersion = (Get-Content $dshManifest -Raw | ConvertFrom-Json).version
if (-not $dshVersion) { throw "cannot read dsh version from $dshManifest" }
$templatedSource = Join-Path $WorkDir "launcher.generated.cs"
$sourceText = Get-Content $Source -Raw
$sourceText = $sourceText -replace '__DSH_VERSION__', $dshVersion
Set-Content -Path $templatedSource -Value $sourceText -Encoding UTF8
Write-Host "launcher Version -> $dshVersion"

# 2. compile
$csc = Find-Csc
$icon = Join-Path $ScriptDir "app.ico"
$iconArgs = @()
if (Test-Path $icon) { $iconArgs = @("/win32icon:$icon") }
$manifest = Join-Path $ScriptDir "app.manifest"
$manifestArgs = @()
if (Test-Path $manifest) { $manifestArgs = @("/win32manifest:$manifest") }

Write-Host "csc     : $csc"
Write-Host "dsh.zip : $((Get-Item $dshZip).Length) bytes"
Write-Host "node.zip: $((Get-Item $nodeZip).Length) bytes"

& $csc /nologo /target:exe /out:$Out `
    /r:System.dll /r:System.Core.dll `
    /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
    /r:System.Net.Sockets.dll /r:System.Reflection.dll /r:System.Threading.dll `
    "/resource:$dshZip,dsh.zip" "/resource:$nodeZip,node.zip" `
    $iconArgs $manifestArgs `
    $templatedSource

if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
Write-Host "built: $Out ($((Get-Item $Out).Length) bytes)"
