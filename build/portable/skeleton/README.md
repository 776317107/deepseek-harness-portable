# DeepSeek Harness Portable（便携版）

免安装、可移植的 **DeepSeek Harness** 桌面版：内嵌 Node.js 运行时与
`@deepseek-ai/dsh` 及其全部依赖，在任何 Windows 电脑上双击即可运行，
**无需预装 Node.js**。

- 程序：DeepSeek Harness `@deepseek-ai/dsh` `0.1.0-rc.6`
- 运行时：Node.js `v24.19.0`（LTS，win-x64，内嵌）
- 平台：Windows 10 / 11（x64）

---

## 快速开始

1. 把整个 `DeepSeek-Harness-Portable` 文件夹放到任意位置
   （移动硬盘、U 盘、桌面均可，路径可含中文与空格）。
2. 双击 **`启动-DeepSeek-Harness.cmd`**（或 `Start-DeepSeek-Harness.cmd`）。
3. 浏览器自动可访问 **http://127.0.0.1:3080**（首次启动后手动打开即可）。
4. 在 Web 界面的设置里填入 DeepSeek API Key，开始使用。
5. 关闭弹出的命令行窗口（或按 `Ctrl+C`）即停止服务。

命令行用法（高级）：

```bat
dsh.cmd web                                   :: 启动 Web UI（默认）
dsh.cmd --profile headless "帮我总结这段代码"   :: 无界面跑一个任务
dsh.cmd --profile web --help                   :: 查看 Web 参数
dsh.cmd plugin --profile web add <插件包>      :: 安装插件
```

### 安装插件

插件（bundle）是声明了 `dsh.bundle` 的 npm 包，安装到 `data\profiles\<name>\`，随文件夹迁移：

```bat
dsh.cmd plugin --profile web add <npm包名>         :: 从 npm 安装
dsh.cmd plugin --profile web add github:xx/yy      :: 从 git 安装
dsh.cmd plugin --profile web remove <插件包名>     :: 移除
```

安装完成后**重启 Web UI 生效**。注意 pnpm 10+ 的构建授权机制：

- 插件含原生模块（如 ssh2）时，安装可能提示 `ERR_PNPM_IGNORED_BUILDS`。编辑
  `data\profiles\web\pnpm-workspace.yaml`，把 `allowBuilds` 下对应包的值改为
  `true`（授权该包在安装时执行构建脚本），再重新执行安装命令。
- 提示缺少 Visual Studio 工具链属可选原生模块编译失败（如 ssh2 加密绑定），
  一般不影响使用。

---

## 便携性说明（重要）

**所有数据都保存在本文件夹内，绝不写入系统目录。**

- `data\` —— 唯一的用户数据根目录（对应 `DSH_HOME`）：
  - `data\settings.yaml` —— 设置（模型、API 地址等）
  - `data\.credentials.yaml` / `data\.env` —— API Key 等凭据
  - `data\profiles\<name>\` —— 各 profile 及其插件（`node_modules`）
  - `data\sessions\` 等 —— 会话历史、附件、匿名 ID
- `runtime\node\` —— 内嵌 Node.js 运行时（只读，勿改）
- `app\` —— dsh 程序本体（只读，勿改）

启动脚本会做三件事：

1. 以自身目录为基准计算 `DSH_HOME=<本文件夹>\data`，并自动创建；
2. 用内嵌的 `runtime\node\node.exe` 启动 dsh，**不依赖系统 Node.js**；
3. 把 pnpm 的 home/store 也重定向到 `data\` 下（`dsh plugin` 安装插件时
   同样不污染系统目录）。

因此：**把整个文件夹复制到另一台电脑或移动硬盘，配置、Key、插件、
会话历史原样可用，无需任何设置。**

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `DSH_HOME` | 用户数据根目录，固定指向 `<应用目录>\data`（启动脚本强制设置） |
| `DSH_AGENTS_HOME` | 技能（skills）目录，固定指向 `<应用目录>\data\.agents`（启动脚本强制设置） |
| `DSH_TELEMETRY_DISABLED` | 默认 `1`（关闭会话遥测，隐私优先）；想开启可自行设置为空并重启 |
| `PNPM_HOME` / `PNPM_STORE_DIR` | pnpm 数据目录，重定向到 `data\` 下 |

> 提示：dsh 原生支持 `DSH_HOME` 环境变量指定配置目录（默认是
> `~/.dsh`）。本便携版利用该机制，把一切数据固定在应用自身目录内。

---

## 目录结构

```
DeepSeek-Harness-Portable/
├── 启动-DeepSeek-Harness.cmd    双击启动 Web UI（中文入口）
├── Start-DeepSeek-Harness.cmd   双击启动 Web UI（英文入口）
├── 升级-便携版.cmd               一键升级（文件夹版，联网自动更新 dsh）
├── dsh.cmd                      命令行入口（等价于系统里的 dsh）
├── Stop-DeepSeek-Harness.cmd    停止服务（默认 3080 端口）
├── README.md / 使用说明.txt      本文档
├── data\                        用户数据（可整体复制迁移）
├── runtime\node\                内嵌 Node.js v24.19.0
├── runtime\tools\               内嵌 pnpm / npm10 等工具
└── app\                         @deepseek-ai/dsh 及全部依赖
```

---

## 如何升级（官方 dsh 发布新版本时）

**文件夹版**：双击 **`升级-便携版.cmd`**。脚本会用内置的 Node.js + npm 联网查询
`@deepseek-ai/dsh` 最新版本并原地更新 `app\`，**`data\` 里的配置、会话、技能
原样保留**，无需重装、无需系统 Node.js。

**单文件 exe 版**：exe 把程序本体内嵌在自身内部，升级需要重新构建（在构建机上，
有 Node.js/npm 即可）：

```powershell
# 在打包工程根目录执行（自动保留 dist\DeepSeek-Harness-Portable\data\）
pwsh -ExecutionPolicy Bypass -File build-all.ps1
```

构建脚本会：自动查询最新 dsh 版本 → 重新安装 `app\` → 用系统自带的
.NET Framework csc.exe 重新编译 exe。exe 内嵌的版本号会随 dsh 版本变化，
首次运行时自动解压到新的缓存目录并清理旧缓存。

> 升级须知：
> - dsh 目前是预发布版本（0.1.0-rc.x），官方声明可能存在破坏性变更；升级前
>   建议先备份 `data\` 文件夹（直接复制一份即可）。
> - 若新版 dsh 要求更高的 Node.js，构建脚本会提示；用 `-NodeVersion vX.Y.Z`
>   参数重新构建即可。
> - 升级需要联网（npm 源默认 registry.npmmirror.com，可用 `npm_config_registry`
>   环境变量覆盖）。

---

## 常见问题

- **端口被占用？** 先运行 `Stop-DeepSeek-Harness.cmd`，或换端口：
  `dsh.cmd web --port 3081`（以 Web 实际参数为准，可用 `dsh.cmd web --help` 查看）。
- **换了电脑/目录后配置还在吗？** 在 —— 全部在 `data\` 里，随文件夹一起走。
- **想彻底重置？** 删除 `data\` 即可（会丢失全部配置与会话）。
- **杀毒软件拦截？** 属正常提示；便携版不改系统、不写注册表，放心使用。
- **`dsh plugin` 需要联网**：安装/更新插件时需访问 npm 仓库。

## 免责声明

本项目为第三方封装的便携版，DeepSeek Harness 本体（MIT License）来自
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
请遵守 DeepSeek 平台与开源许可条款。
