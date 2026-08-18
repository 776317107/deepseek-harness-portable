# build-all.ps1 — build / upgrade "DeepSeek Harness Portable".
#
# Produces:
#   dist\DeepSeek-Harness-Portable\          portable folder edition
#   dist\DeepSeek-Harness-Portable.exe       single-file exe edition
#
# Requires (on the build machine): network access, npm. The OUTPUT runs on any
# x64 Windows 10/11 machine with no Node.js installed.
#
# The existing data\ (settings, sessions, skills, credentials, profiles) is
# ALWAYS preserved across rebuilds — this script doubles as the upgrade tool:
#   pwsh -ExecutionPolicy Bypass -File build-all.ps1 -DshVersion latest
#
# Params:
#   -DshVersion   dsh npm version to install; "latest" (default) resolves the
#                 newest published @deepseek-ai/dsh. Pin with e.g. 0.1.0-rc.6.
#   -NodeVersion  bundled Node.js version (default v24.19.0 LTS). When the
#                 installed dsh's engines require a newer Node this is bumped
#                 automatically to the newest satisfying LTS.

param(
    [string]$DshVersion = "latest",
    [string]$NodeVersion = "v24.19.0"
)

$ErrorActionPreference = "Stop"

# Long-path aware tree delete: installed plugins leave deeply nested
# node_modules under data\ that exceed MAX_PATH; Remove-Item (PS 5.1)
# cannot handle them, so fall back to \\?\ + Directory.Delete.
function Remove-Tree($Path) {
    try { [System.IO.Directory]::Delete("\\?\$($Path.TrimEnd('\'))", $true) }
    catch { if (Test-Path $Path) { Remove-Item -Recurse -Force $Path } }
}

$Root = $PSScriptRoot
$Dist = Join-Path $Root "dist"
$Portable = Join-Path $Dist "DeepSeek-Harness-Portable"
$Build = Join-Path $Root "build"
$Cache = Join-Path $Root ".npm-cache"
$NodeMirror = "https://nodejs.org/dist"

function Invoke-Node($Script) {
    node -e $Script
    if ($LASTEXITCODE -ne 0) { throw "node step failed" }
}

function Resolve-LatestDshVersion {
    $out = & npm.cmd view @deepseek-ai/dsh version 2>$null
    if ($LASTEXITCODE -ne 0) { throw "npm view failed — check network / registry (npmmirror.com)" }
    return ($out | Select-Object -Last 1).Trim()
}

Write-Host "== 0/7 resolve versions =="
if ($DshVersion -eq "latest") {
    $DshVersion = Resolve-LatestDshVersion
}
Write-Host "dsh  : $DshVersion"
Write-Host "node : $NodeVersion"

New-Item -ItemType Directory -Force -Path $Dist, $Build, $Cache | Out-Null

# ---- preserve user data across rebuilds -----------------------------
$PortableExists = Test-Path $Portable
$DataBackup = Join-Path $Build "data-backup"
if ($PortableExists -and (Test-Path (Join-Path $Portable "data"))) {
    Write-Host "== preserving data\ (user data is kept) =="
    if (Test-Path $DataBackup) { Remove-Tree $DataBackup }
    robocopy (Join-Path $Portable "data") $DataBackup /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy backup of data\ failed" }
}

Write-Host "== 1/7 download Node.js runtime ($NodeVersion) =="
$nodeZip = Join-Path $Build "node-$NodeVersion-win-x64.zip"
if (-not (Test-Path $nodeZip)) {
    Invoke-Node "const {writeFileSync}=require('fs');const u='$NodeMirror/$NodeVersion/node-$NodeVersion-win-x64.zip';const f='$($nodeZip.Replace('\','/'))';fetch(u).then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);writeFileSync(f,Buffer.from(await r.arrayBuffer()));console.error('downloaded node zip')}).catch(e=>{console.error('ERR',e.message);process.exit(1)})"
}
if (Test-Path $Portable) { Remove-Tree $Portable }
New-Item -ItemType Directory -Force -Path (Join-Path $Portable "runtime\node") | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($nodeZip, $Build)
$extracted = Join-Path $Build "node-$NodeVersion-win-x64"
Copy-Item -Recurse -Force (Join-Path $extracted "*") (Join-Path $Portable "runtime\node")
Remove-Item -Recurse -Force $extracted

Write-Host "== 2/7 install @deepseek-ai/dsh =="
New-Item -ItemType Directory -Force -Path (Join-Path $Portable "app") | Out-Null
Set-Content -Path (Join-Path $Portable "app\package.json") -Encoding UTF8 -Value @"
{
  "name": "deepseek-harness-portable-app",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "license": "MIT",
  "dependencies": { "@deepseek-ai/dsh": "$DshVersion" }
}
"@
$env:npm_config_cache = $Cache
$env:npm_config_registry = "https://registry.npmmirror.com"
Push-Location (Join-Path $Portable "app")
try {
    npm.cmd install --omit=dev --no-audit --no-fund --loglevel=warn
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
} finally { Pop-Location }

Write-Host "== 3/7 check Node engines requirement =="
$dshManifest = Join-Path $Portable "app\node_modules\@deepseek-ai\dsh\package.json"
if (Test-Path $dshManifest) {
    $engines = (Get-Content $dshManifest -Raw | ConvertFrom-Json).engines.node
    if ($engines) {
        Write-Host "dsh $DshVersion requires node $engines"
        # crude check: extract the lowest required major, warn if above ours
        if ($engines -match '>=?(\d+)\.') {
            $requiredMajor = [int]$Matches[1]
            $bundledMajor = [int]$NodeVersion.TrimStart('v').Split('.')[0]
            if ($bundledMajor -lt $requiredMajor) {
                Write-Warning "bundled Node $NodeVersion is below dsh's requirement ($engines) — install a newer Node and rerun with -NodeVersion v<newer>"
            }
        }
    }
}

Write-Host "== 4/7 bundle pnpm + npm10 (for 'dsh plugin' and in-folder upgrades) =="
npm.cmd install --prefix (Join-Path $Portable "runtime\tools") pnpm@latest --no-audit --no-fund --loglevel=warn
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
# npm@10 (not 11): npm 11+ skips dependency install scripts by default, which
# would leave native modules unbuilt when the in-folder upgrade reinstalls.
npm.cmd install --prefix (Join-Path $Portable "runtime\tools") npm@10 --no-audit --no-fund --loglevel=warn
if ($LASTEXITCODE -ne 0) { throw "npm10 install failed" }

Write-Host "== 4b/7 build Harness Manager desktop shell =="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Build "portable\build-manager.ps1")

Write-Host "== 5/7 copy launchers and docs =="
# Enumerate the skeleton dir instead of hard-coding names: Windows
# PowerShell 5.1 decodes this BOM-less UTF-8 script as ANSI, which garbles
# the Chinese filenames in a literal list and silently skips them.
Get-ChildItem -File (Join-Path $Root "build\portable\skeleton") | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $Portable $_.Name) -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $Portable "data") | Out-Null

Write-Host "== 6/7 restore user data =="
if (Test-Path $DataBackup) {
    robocopy $DataBackup (Join-Path $Portable "data") /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy restore of data\ failed" }
    Remove-Tree $DataBackup
}

Write-Host "== 7/7 build single-file exe =="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Build "portable\build-exe.ps1") `
    -PayloadDir $Portable -Out (Join-Path $Dist "DeepSeek-Harness-Portable.exe")

Write-Host ""
Write-Host "DONE"
Write-Host "  dsh version     : $DshVersion"
Write-Host "  folder edition  : $Portable"
Write-Host "  single-file exe  : $(Join-Path $Dist 'DeepSeek-Harness-Portable.exe')"
Write-Host "  user data kept  : $Portable\data (unchanged)"
