# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这个仓库是什么

本仓库不是 DeepSeek Harness 本体，而是把 `@deepseek-ai/dsh`（DeepSeek Harness 的 npm 包）加内嵌 Node.js 运行时打包成**免安装、可移植的 Windows 应用**的封装工程。交付物在 `dist\` 下有两种形态：

- `dist\DeepSeek-Harness-Portable\` — 文件夹版（`.cmd` 启动器 + `app\` + `runtime\`）
- `dist\DeepSeek-Harness-Portable.exe` — 单文件自解压版（C# 启动器内嵌两个 zip）

两者共享同一套便携化约定（见下），只有启动入口不同。

## 构建命令

在装有 Node.js/npm 的构建机上执行（产物运行端无需 Node.js）：

```powershell
# 默认构建最新版（自动 npm 查询 @deepseek-ai/dsh 最新版本）
pwsh -ExecutionPolicy Bypass -File build-all.ps1

# 固定 dsh 版本 / Node 版本
pwsh -ExecutionPolicy Bypass -File build-all.ps1 -DshVersion 0.1.0-rc.6
pwsh -ExecutionPolicy Bypass -File build-all.ps1 -NodeVersion v24.19.0
```

封装工程本身**没有 test/lint 套件**。验证方式：构建后运行产物，例如文件夹版 `dsh.cmd web`、exe 版 `DeepSeek-Harness-Portable.exe web`（Web UI 默认 http://127.0.0.1:3080）。`build-all.ps1` 是唯一的构建/升级入口，升级时会自动备份并恢复 `data\`。

## 目录职责（大图）

| 路径 | 角色 |
| --- | --- |
| `build-all.ps1` | 唯一的编排脚本：7 步构建/升级流程 |
| `build\portable\` | 封装源码：`launcher.cs`（exe 启动器）、`build-exe.ps1`、`make-zips.ps1`、`make-icon.ps1`、`app.ico`/`app.manifest` |
| `build\portable\skeleton\` | 复制进**两种产物**的模板：`*.cmd` 启动器、`upgrade.mjs`、README/使用说明 |
| `refs\portable-src\` | 上游 `dsh-portable` 的原始 `launcher.cs`/`build.ps1`（参考，不参与构建） |
| `deepseek-harness-master\` | DeepSeek Harness 官方源码（vendored 参考，**不修改**，见下） |
| `dist\` | 构建输出（两种产物） |
| `build\`、`.npm-cache\`、`build\portable\work\` | 构建缓存与中间产物（node zip、解压后的 node、生成的 `launcher.generated.cs`、dsh.zip/node.zip），可删除重建 |

## 便携化契约（跨文件的核心不变量）

所有用户数据必须落在应用目录内，绝不写系统目录。这条契约由**两处**同时实现，改动时必须保持同步：

- 文件夹版：`build\portable\skeleton\Start-DeepSeek-Harness.cmd` 与 `dsh.cmd`
- exe 版：`build\portable\launcher.cs` 的 `BuildProcess()`（第 229-250 行）

共同点：

- `DSH_HOME` → `<应用目录>\data`（settings.yaml、.credentials.yaml、.env、profiles、sessions、attachments 全部在此）
- `DSH_AGENTS_HOME` → `<应用目录>\data\.agents`（技能目录）
- `PNPM_HOME` / `PNPM_STORE_DIR` → `data\` 下（`dsh plugin` 不污染系统目录）
- `PATH` 前置内嵌 `runtime\node` 与 `runtime\tools\node_modules\.bin`
- `DSH_TELEMETRY_DISABLED` 默认设为 `1`（用户可用环境变量覆盖）

dsh 原生支持 `DSH_HOME`（优先级：显式路径 > `$DSH_HOME` > `~/.dsh`），封装即利用该机制；参考源码见 `deepseek-harness-master\packages\util\home-paths`。

## exe 版构建与启动细节

- `build-exe.ps1` 调用 `make-zips.ps1` 打包出 `dsh.zip`（`app\` + `runtime\tools\` + 顶层文件，排除 `*.map` 与 `.cache`）与 `node.zip`（仅 `runtime\node\node.exe`），再用系统自带 .NET Framework `csc.exe` 编译 `launcher.cs` 并把两个 zip 作为托管资源嵌入。
- `launcher.cs` 里的 `const string Version = "__DSH_VERSION__"` 是模板占位符，`build-exe.ps1` 会替换成已安装 dsh 的实际版本 → 每次重建 exe 解压到新的 `portable\<version>\` 缓存目录，并清理旧缓存。
- exe 首次运行把内嵌 zip 解压到 exe 旁的 `portable\<version>\`；该位置只读时回退到 `%LOCALAPPDATA%\dsh-portable-exe\<version>`。`data\` 始终在 exe 旁。
- Web 模式（无参/`web`/`--profile web`）先探测默认端口 3080 是否已有 dsh 实例（有则只开浏览器），并用基于 data 目录的命名互斥锁防双实例写坏会话。
- 长路径：`launcher.cs` 用 `AppContext` 开关 + 手动逐条目解压（`ZipFile.ExtractToDirectory` 不感知长路径），因为嵌套 node_modules 会超过 MAX_PATH。

## 升级路径

- 文件夹版最终用户：双击 `升级-便携版.cmd` → `upgrade.mjs` 用内置 Node + npm 原地更新 `app\node_modules`，`data\` 不动。
- 关键依赖：`upgrade.mjs` 与 `build-all.ps1` 都特意用 `runtime\tools` 里的 **npm@10** 而非 node 发行版自带 npm 11，因为 npm 11+ 默认跳过依赖 install 脚本，会漏掉原生模块（如 node-pty）的编译。
- exe 版升级只能重跑 `build-all.ps1`。

## 上游源码（deepseek-harness-master\）

这是 vendored 的官方源码，仅作参考，封装工程不修改它。若任务涉及该子树，注意：

- 它的 `CLAUDE.md` 只是指向 `AGENTS.md` 的占位符，真正的约定在 `deepseek-harness-master\AGENTS.md`（含大量 dsh 专有 skill，如 `dsh-code-review`、`dsh-pre-push-checks`、`dsh-prose-standard` 等）。
- 它是 pnpm workspace（`packageManager: pnpm@11.7.0`，`engines.node: ^22.19.0 || >=24.0.0`），常用命令在 `AGENTS.md` 的 Commands 段：`pnpm install`、`pnpm run test`、`pnpm run typecheck`、`pnpm run lint`、`pnpm run build`、`pnpm dsh --profile headless "task"` 等。
