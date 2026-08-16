# make-zips.ps1 — package the portable payload into the two zips the launcher embeds.
#
#   dsh.zip  -> <payloadRoot> minus runtime\node (app, runtime\tools, launchers, docs)
#   node.zip -> runtime\node\node.exe (single file at zip root)
#
# Excludes junk: node_modules/.cache dirs and *.map source maps.

param(
    [Parameter(Mandatory = $true)][string]$PayloadRoot,
    [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Add-Entry($archive, $fullPath, $entryName) {
    $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $in = [System.IO.File]::OpenRead($fullPath)
    try {
        $out = $entry.Open()
        try { $in.CopyTo($out) } finally { $out.Dispose() }
    } finally { $in.Dispose() }
}

function New-Zip($zipPath) {
    if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
    return [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
}

function Should-Exclude($relPath) {
    $name = [System.IO.Path]::GetFileName($relPath)
    if ($name -eq '.cache') { return $true }
    if ($name -eq 'node_modules') { return $false }  # keep node_modules, recurse inside
    if ($relPath -like '*.map') { return $true }
    return $false
}

$skipDirs = @('.cache')

function Walk($fsRoot, $relRoot, $archive) {
    foreach ($dir in [System.IO.Directory]::GetDirectories($fsRoot)) {
        $name = [System.IO.Path]::GetFileName($dir)
        if ($name -in $skipDirs) { continue }
        Walk $dir (Join-Path $relRoot $name) $archive
    }
    foreach ($file in [System.IO.Directory]::GetFiles($fsRoot)) {
        $rel = Join-Path $relRoot ([System.IO.Path]::GetFileName($file))
        if ($rel -like '*.map') { continue }
        Add-Entry $archive $file ($rel.Replace('\', '/'))
    }
}

Write-Host "packing dsh.zip ..."
$dshZip = New-Zip (Join-Path $OutDir "dsh.zip")
try {
    foreach ($dir in @('app', 'runtime', '')) {
        $src = if ($dir -eq '') { $PayloadRoot } else { Join-Path $PayloadRoot $dir }
        if (-not (Test-Path $src)) { continue }
        $relRoot = $dir.Replace('\', '/')
        # top-level files of the payload root
        if ($dir -eq '') {
            foreach ($f in [System.IO.Directory]::GetFiles($PayloadRoot)) {
                Add-Entry $dshZip $f ([System.IO.Path]::GetFileName($f))
            }
            continue
        }
        if ($dir -eq 'runtime') {
            # runtime/tools only; node.exe is packed separately
            $tools = Join-Path $src 'tools'
            if (Test-Path $tools) { Walk $tools 'runtime/tools' $dshZip }
            continue
        }
        Walk $src ($dir.Replace('\', '/')) $dshZip
    }
} finally { $dshZip.Dispose() }

Write-Host "packing node.zip ..."
$nodeExe = Join-Path $PayloadRoot "runtime\node\node.exe"
if (-not (Test-Path $nodeExe)) { throw "node.exe not found: $nodeExe" }
$nodeZip = New-Zip (Join-Path $OutDir "node.zip")
try { Add-Entry $nodeZip $nodeExe 'node.exe' } finally { $nodeZip.Dispose() }

Get-ChildItem $OutDir -Filter *.zip | Select-Object Name, Length
Write-Host "zips ready in $OutDir"
