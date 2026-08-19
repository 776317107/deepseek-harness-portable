# pack-zip.ps1 — 打包文件夹版为 zip(排除 data 用户数据)
$ErrorActionPreference = "Stop"

$src   = "F:\MyResource\AI\AICodding\Deepseek-harness-Despktop\dist\DeepSeek-Harness-Portable"
$stage = "F:\MyResource\AI\AICodding\Deepseek-harness-Despktop\dist\_staging\DeepSeek-Harness-Portable"
$out   = "F:\MyResource\AI\AICodding\Deepseek-harness-Despktop\dist\DeepSeek-Harness-Portable-win-x64.zip"

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# 顶层文件(启动器/文档)
Get-ChildItem -File $src | ForEach-Object { Copy-Item $_.FullName $stage -Force }

# 运行时与程序本体
Copy-Item -Recurse -Force (Join-Path $src "app") (Join-Path $stage "app")
Copy-Item -Recurse -Force (Join-Path $src "runtime") (Join-Path $stage "runtime")

# 干净的 data 目录(仅 README.txt,不含用户数据)
New-Item -ItemType Directory -Force -Path (Join-Path $stage "data") | Out-Null
$dataReadme = Join-Path $src "data\README.txt"
if (Test-Path $dataReadme) { Copy-Item $dataReadme (Join-Path $stage "data") -Force }

# 压缩(顶层为 DeepSeek-Harness-Portable 目录)
if (Test-Path $out) { Remove-Item -Force $out }
Compress-Archive -Path $stage -DestinationPath $out -CompressionLevel Optimal

# 清理 staging
Remove-Item -Recurse -Force (Split-Path $stage -Parent)

Write-Host "ZIP DONE: $out"
Get-Item $out | Select-Object Name, Length
