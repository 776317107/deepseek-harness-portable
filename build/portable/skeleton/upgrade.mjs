// upgrade.mjs — in-place upgrade of the DeepSeek Harness Portable folder edition.
//
// Updates only app\node_modules to the newest @deepseek-ai/dsh on npm; all user
// data under .\data is never touched. Runs with the bundled Node.js, so no
// system Node.js is needed. The single-file exe edition embeds its own payload
// and must be rebuilt (see build-all.ps1 / upgrade-portable.ps1).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const appDir = join(root, 'app')
const nodeExe = join(root, 'runtime', 'node', 'node.exe')
// Prefer the bundled npm@10 (runtime\tools): npm 11+ (shipped inside the
// node distribution) skips dependency install scripts by default, which would
// leave native modules (e.g. node-pty) unbuilt. npm 10 runs scripts normally.
const toolsNpmCli = join(root, 'runtime', 'tools', 'node_modules', 'npm', 'bin', 'npm-cli.js')
const nodeNpmCli = join(root, 'runtime', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npmCli = existsSync(toolsNpmCli) ? toolsNpmCli : nodeNpmCli
const cacheDir = join(root, 'data', '.npm-cache')
const pkgPath = join(appDir, 'package.json')
const installedPath = join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const registry = process.env.npm_config_registry || 'https://registry.npmmirror.com'
const PACKAGE = '@deepseek-ai/dsh'

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

function latestVersion() {
  const out = run(nodeExe, [npmCli, 'view', PACKAGE, 'version', '--registry', registry, '--cache', cacheDir], { cwd: appDir })
  const lines = out.trim().split(/\r?\n/).filter(Boolean)
  return lines[lines.length - 1].trim()
}

function installedVersion() {
  if (!existsSync(installedPath)) return null
  return JSON.parse(readFileSync(installedPath, 'utf8')).version
}

function bundledNode() {
  const out = run(nodeExe, ['--version']).trim()
  return out.startsWith('v') ? out.slice(1) : out
}

function compare(a, b) {
  // loose semver-ish compare for x.y.z[-rc.n]
  const strip = (s) => {
    const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.?(\d+))?/i)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])] : [0, 0, 0, 0]
  }
  const A = strip(a); const B = strip(b)
  for (let i = 0; i < 4; i++) { if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1 }
  return 0
}

// ---- warn if this app's web server is running ----
try {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 1500)
  const res = await fetch('http://127.0.0.1:3080/', { signal: ctrl.signal })
  clearTimeout(timer)
  if (res.ok && (await res.text()).includes('__DSH_BOOT__')) {
    console.log('提示：检测到端口 3080 已有 DeepSeek Harness 服务在运行。')
    console.log('如果是本便携版启动的，请先关闭它的命令行窗口再升级，以免旧进程占用文件。')
    console.log()
  }
} catch { /* no server running */ }

// ---- decide ----
let latest
try {
  latest = latestVersion()
} catch (e) {
  console.error('无法连接 npm 源检查最新版本：' + (e.stderr || e.message))
  console.error('请检查网络，或确认 registry 可用。')
  process.exit(1)
}
const installed = installedVersion()

console.log('DeepSeek Harness Portable 升级工具')
console.log('  npm 最新版本 : ' + latest)
console.log('  当前安装版本 : ' + (installed ?? '(未安装)'))
console.log('  内置 Node.js : v' + bundledNode())
console.log()

if (installed !== null && compare(latest, installed) <= 0) {
  console.log('已是最新版本，无需升级。')
  process.exit(0)
}

if (!process.argv.includes('--yes')) {
  console.log('发现新版本，是否升级？输入 y 确认：')
  process.stdin.setEncoding('utf8')
  process.stdin.once('data', (d) => {
    if (d.trim().toLowerCase() === 'y') doUpgrade()
    else { console.log('已取消。'); process.exit(0) }
  })
} else {
  doUpgrade()
}

function doUpgrade() {
  console.log('正在升级 ' + PACKAGE + ' -> ' + latest + ' ...')
  mkdirSync(cacheDir, { recursive: true })

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.dependencies[PACKAGE] = latest
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

  try {
    const out = run(nodeExe, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund',
      '--registry', registry, '--cache', cacheDir, '--loglevel=warn'], { cwd: appDir })
    console.log(out)
  } catch (e) {
    console.error('升级失败：' + (e.stderr || e.message))
    console.error('你的数据未受影响（都在 data\\ 下）。可重试，或换用 build-all.ps1 完整重建。')
    process.exit(1)
  }

  const nowInstalled = installedVersion()
  console.log()
  console.log('升级完成：' + (nowInstalled ?? '?'))

  // engines check
  try {
    const m = JSON.parse(readFileSync(installedPath, 'utf8'))
    const engines = m.engines?.node
    if (engines) {
      console.log('dsh ' + m.version + ' 要求 Node ' + engines + '（内置为 v' + bundledNode() + '）')
      const req = engines.match(/>=?(\d+)/)
      const bundledMajor = Number(bundledNode().split('.')[0])
      if (req && bundledMajor < Number(req[1])) {
        console.warn('警告：内置 Node 版本低于要求，建议用 build-all.ps1 重建（可自动换新版 Node）。')
      }
    }
  } catch { /* cosmetic */ }

  console.log('提示：单文件 exe 版内嵌的是旧版载荷，需用 build-all.ps1 重新构建后才能一并升级。')
  console.log('你的配置、会话、技能均未改动（data\\ 目录原样保留）。')
  // 显式退出:stdin 的 data 监听会让事件循环挂着,进程不退出会占用 runtime\node\node.exe
  process.exit(0)
}
