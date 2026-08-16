# DeepSeek Harness Portable

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`）
打包成**免安装、可移植**的 Windows 桌面应用：内嵌 Node.js 运行时，任何 Windows 电脑
双击即用，无需预装 Node.js；所有配置/凭据/插件/会话都保存在应用自身目录，整体拷贝
到别的电脑即可继续使用。

## 交付物（在 `dist\` 下）

| 产物 | 说明 |
| --- | --- |
| `dist\DeepSeek-Harness-Portable.exe` | **单文件版**（约 114 MB）。双击即用；首次运行在自身旁边解压出 `portable\`（运行环境缓存）并创建 `data\`（用户数据）。命令行：`DeepSeek-Harness-Portable.exe web` / `... --profile headless "任务"` 等，与 `dsh` 一致。 |
| `dist\DeepSeek-Harness-Portable\` | **文件夹版**。双击 `启动-DeepSeek-Harness.cmd` 或 `Start-DeepSeek-Harness.cmd` 启动 Web UI（http://127.0.0.1:3080）；`dsh.cmd` 为命令行入口；`Stop-DeepSeek-Harness.cmd` 停止服务。 |

两者共享同一份运行时（Node.js v24.19.0）与 dsh（0.1.0-rc.6），启动逻辑一致：

- `DSH_HOME` 强制指向 `<应用目录>\data` —— settings.yaml、.credentials.yaml、.env、
  profiles（含插件）、sessions、attachments 等全部用户数据都在这里；
- `DSH_AGENTS_HOME` 强制指向 `<应用目录>\data\.agents`（技能目录，同样随文件夹迁移）；
- 使用内嵌 `node.exe`，不依赖系统 Node.js；
- pnpm（`dsh plugin` 用）内置于 `runtime\tools`，其 store/home 也重定向到 `data\` 下；
- 默认关闭会话遥测（`DSH_TELEMETRY_DISABLED=1`，隐私优先，可用环境变量覆盖）。

## 目录结构

```
dist\DeepSeek-Harness-Portable\
├── 启动-DeepSeek-Harness.cmd / Start-DeepSeek-Harness.cmd   启动器（双击=Web UI）
├── dsh.cmd / Stop-DeepSeek-Harness.cmd                      命令行入口 / 停止
├── README.md / 使用说明.txt
├── data\                    用户数据（唯一的可写区，整体迁移即可）
├── runtime\node\            内嵌 Node.js v24.19.0（node.exe + npm/npx）
├── runtime\tools\           内嵌 pnpm
└── app\                     @deepseek-ai/dsh 及全部依赖（npm install --omit=dev）
```

## 如何重新构建 / 升级（在装有 Node.js/npm 的构建机上）

```powershell
# 默认构建最新版（自动查询 npm 上 @deepseek-ai/dsh 的最新版本）
pwsh -ExecutionPolicy Bypass -File build-all.ps1

# 固定某个版本
pwsh -ExecutionPolicy Bypass -File build-all.ps1 -DshVersion 0.1.0-rc.6
```

脚本会：自动解析最新 dsh 版本 → 下载 Node.js v24.19.0 → `npm install @deepseek-ai/dsh`
→ 打包 pnpm/npm10 → 生成文件夹版 → 用系统自带 .NET Framework `csc.exe` 编译 C#
自解压启动器（`build\portable\launcher.cs`），产出单文件 exe。网络依赖 npm 源
（默认 registry.npmmirror.com，可在脚本中调整）。

**升级时 `data\` 自动保留**（脚本先把用户数据备份再重建，最后恢复）；exe 内嵌
版本号随 dsh 版本自动变化，首次运行会解压到新缓存目录并清理旧缓存。
文件夹版的最终用户也可直接双击文件夹内的 `升级-便携版.cmd` 原地升级（无需构建机）。

## 实现要点（供二次开发）

- 便携数据定位：利用 dsh 原生 `DSH_HOME` 环境变量（见
  `packages/util/home-paths`：优先级 显式路径 > `$DSH_HOME` > `~/.dsh`）。
- 单文件 exe：仿照 [dsh-portable](https://github.com/manjiayu20071022/dsh-portable)
  的 `launcher.cs` 思路 —— 把 `dsh.zip`（app+tools+文档）与 `node.zip`（node.exe）
  作为托管资源嵌入，首次运行解压到 exe 旁 `portable\<version>\`，之后直接复用；
  按数据目录加命名互斥锁防止双实例写坏会话；Web 模式下先探测目标端口，已有实例
  则只开浏览器。
- 源码参考：本工作区 `deepseek-harness-master\` 为 DeepSeek Harness 官方源码，
  `refs\portable-src\` 为 dsh-portable 的 launcher.cs/build.ps1 原始文件。

## 许可

DeepSeek Harness 本体为 MIT License（deepseek-ai/deepseek-harness）。本便携封装
仅做打包与启动，未修改其源码；使用请遵守 DeepSeek 平台及开源许可条款。
