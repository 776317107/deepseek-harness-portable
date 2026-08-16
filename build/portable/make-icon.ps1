# make-icon.ps1 — generate a simple app.ico (blue rounded square + "DSH") using
# System.Drawing (available with .NET Framework on Windows).
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot "app.ico"
$size = 64
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$rect = New-Object System.Drawing.Rectangle 2, 2, ($size - 4), ($size - 4)
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 22, 101, 216))  # DeepSeek-ish blue
$g.FillEllipse($brush, $rect)

$font = New-Object System.Drawing.Font "Segoe UI", 20, ([System.Drawing.FontStyle]::Bold)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.DrawString("DSH", $font, $white, (New-Object System.Drawing.RectangleF 0, 0, $size, $size), $sf)

$png = Join-Path $PSScriptRoot "app-tmp.png"
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# Wrap the PNG into a minimal .ico container (single 64x64 entry, PNG-compressed).
$pngBytes = [System.IO.File]::ReadAllBytes($png)
$fs = [System.IO.File]::Create($out)
try {
    $bw = New-Object System.IO.BinaryWriter $fs
    $bw.Write([UInt16]0)      # reserved
    $bw.Write([UInt16]1)      # type: icon
    $bw.Write([UInt16]1)      # count
    $bw.Write([byte]64)       # width
    $bw.Write([byte]64)       # height
    $bw.Write([byte]0)        # palette
    $bw.Write([byte]0)        # reserved
    $bw.Write([UInt16]1)      # color planes
    $bw.Write([UInt16]32)     # bpp
    $bw.Write([UInt32]$pngBytes.Length)
    $bw.Write([UInt32]22)     # data offset (6 + 16)
    $bw.Write($pngBytes)
    $bw.Flush(); $bw.Close()
} finally { $fs.Dispose() }
Remove-Item -Force $png -ErrorAction SilentlyContinue
Write-Host "icon: $out ($((Get-Item $out).Length) bytes)"
