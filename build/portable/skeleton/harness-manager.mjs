// harness-manager.mjs — DeepSeek Harness 桌面管理器(WebView2 壳的后端)
// 复用便携版内嵌 node.exe,零外部依赖。
// 职责:REST API(实例/插件/升级/备份/settings/日志)+ 内嵌单页 UI。
// 入口:
//   node harness-manager.mjs --cli list|start <n>|stop <n>   # 命令行接管旧实例管理器
//   node harness-manager.mjs [--managed] [--port <p>]        # 启动管理服务器
// --managed:壳模式(ppid 轮询,壳崩溃即自退,防僵尸)
import { spawn, spawnSync, exec } from 'node:child_process'
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
  unlinkSync, createWriteStream, statSync, rmSync, openSync, writeSync, closeSync,
  copyFileSync,
} from 'node:fs'
import { join, dirname, resolve, isAbsolute, normalize, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { EventEmitter } from 'node:events'

// ---- 形态与路径 ----
const scriptDir = dirname(fileURLToPath(import.meta.url))
const exeEdition = existsSync(join(scriptDir, '.extracted.ok'))
let runtimeRoot = scriptDir
const appRoot = exeEdition ? dirname(dirname(scriptDir)) : scriptDir
// exe 旁的副本(launcher 复制的,方便双击):本身无 runtime,
// 从 appRoot\portable\<version> 缓存定位运行时;data 仍在 exe 旁。
if (!exeEdition && !existsSync(join(scriptDir, 'runtime', 'node', 'node.exe'))) {
  const cacheBase = join(scriptDir, 'portable')
  if (existsSync(cacheBase)) {
    const vers = readdirSync(cacheBase).filter((n) => existsSync(join(cacheBase, n, '.extracted.ok')))
    if (vers.length) runtimeRoot = join(cacheBase, vers.sort().pop())
  }
}
let dataRoot = join(appRoot, 'data')
// 启动配置固定在默认 data 下(不随 data 位置迁移,否则配置会"搬家")
const launchConfigFile = join(appRoot, 'data', '.manager', 'launch.json')
let managerDir = join(dataRoot, '.manager')
let backupsDir = join(dataRoot, 'backups')
const nodeExe = join(runtimeRoot, 'runtime', 'node', 'node.exe')
const dshBin = join(runtimeRoot, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const upgradeScript = join(runtimeRoot, 'upgrade.mjs')
const settingsFile = join(dataRoot, 'settings.yaml')

// ---- 工具 ----
function isPidAlive(pid) {
  if (!pid || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function webPortOpen(port) {
  return new Promise((resolveOk) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 700 }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolveOk(/dsh|deepseek\s*harness/i.test(body)))
    })
    req.on('error', () => resolveOk(false))
    req.on('timeout', () => { req.destroy(); resolveOk(false) })
  })
}
function buildEnv(absData) {
  const env = { ...process.env }
  env.DSH_HOME = absData
  env.DSH_AGENTS_HOME = join(absData, '.agents')
  env.PNPM_HOME = join(absData, '.pnpm-home')
  env.PNPM_STORE_DIR = join(absData, '.pnpm-store')
  env.PATH = [
    join(runtimeRoot, 'runtime', 'node'),
    join(runtimeRoot, 'runtime', 'tools', 'node_modules', '.bin'),
    env.PATH || '',
  ].join(';')
  if (!process.env.DSH_TELEMETRY_DISABLED) env.DSH_TELEMETRY_DISABLED = '1'
  return env
}
function dirSize(root, exclude) {
  let total = 0
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      const rel = relative(root, p)
      if (exclude.some((x) => rel === x || rel.startsWith(x + '\\') || rel.startsWith(x + '/'))) continue
      if (e.isDirectory()) walk(p)
      else { try { total += statSync(p).size } catch { /* locked */ } }
    }
  }
  walk(root)
  return total
}
function fmtSize(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

// ---- 检测非管理器启动的 dsh 服务(如手动 exe/dsh.cmd 启动的默认实例)----
function detectRunningServices() {
  const out = []
  let netstat
  try { netstat = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 15000 }).stdout } catch { return out }
  const listening = new Map()
  for (const line of String(netstat).split(/\r?\n/)) {
    const m = line.match(/TCP\s+127\.0\.0\.1:(\d+)\s+.*LISTENING\s+(\d+)/)
    if (m) {
      const port = Number(m[1])
      const pid = Number(m[2])
      if (!listening.has(port)) listening.set(port, pid)
    }
  }
  for (let port = 3080; port <= 3095; port++) {
    if (listening.has(port)) out.push({ port, pid: listening.get(port) })
  }
  return out
}
async function detectDshServices() {
  const found = []
  for (const s of detectRunningServices()) {
    if (await webPortOpen(s.port)) found.push(s)
  }
  return found
}
function stopServiceByPid(pid) {
  let ok = false
  if (isPidAlive(pid)) {
    try {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', shell: true })
      ok = r.status === 0
    } catch { ok = false }
  }
  return ok
}
// 升级/恢复等危险操作前:有 dsh 服务在运行则拒绝
async function anyDshRunning() {
  return (await detectDshServices()).length > 0
}

// ---- 一键启动配置 ----
const launchPidFile = join(managerDir, 'launch.pid')
function defaultLaunchConfig() {
  return { port: 3080, autoOpenBrowser: true, extraArgs: [], dataDir: '' }
}
function readLaunchConfig() {
  try { return { ...defaultLaunchConfig(), ...JSON.parse(readFileSync(launchConfigFile, 'utf8')) } }
  catch { return defaultLaunchConfig() }
}
function writeLaunchConfig(cfg) {
  mkdirSync(dirname(launchConfigFile), { recursive: true })
  writeFileSync(launchConfigFile, JSON.stringify(cfg, null, 2))
}
function launchStatus() {
  const cfg = readLaunchConfig()
  const port = Number(cfg.port) || 3080
  return { cfg, port, running: null }
}
async function launchNow() {
  const cfg = readLaunchConfig()
  const port = Number(cfg.port) || 3080
  // 端口已有 dsh 服务:直接开浏览器(或提示)
  if (await webPortOpen(port)) {
    return { ok: true, alreadyRunning: true, port, message: `端口 ${port} 已有 dsh 服务在运行` }
  }
  // 清理失效 pid 残留
  try { unlinkSync(launchPidFile) } catch { /* none */ }
  const args = ['web']
  if (port > 0) args.push('--port', String(port))
  if (Array.isArray(cfg.extraArgs)) args.push(...cfg.extraArgs)
  const launchLog = join(managerDir, 'launch.log')
  mkdirSync(managerDir, { recursive: true })
  writeFileSync(launchLog, '', { flag: 'a' })
  const out = createWriteStream(launchLog, { flags: 'a', encoding: 'utf8' })
  const child = spawn(nodeExe, [dshBin, ...args], {
    cwd: appRoot, detached: true, windowsHide: true,
    env: buildEnv(dataRoot),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  writeFileSync(launchPidFile, String(child.pid))
  child.unref()
  // 等待端口就绪后自动打开浏览器
  if (cfg.autoOpenBrowser) {
    ;(async () => {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        if (await webPortOpen(port)) {
          spawn('cmd', ['/c', 'start', '', `"http://127.0.0.1:${port}"`], { windowsHide: true }).unref()
          break
        }
      }
    })()
  }
  return { ok: true, pid: child.pid, port, message: `已启动 dsh(端口 ${port}),等待就绪…` }
}

// ---- 升级(复用 upgrade.mjs 逻辑)----
function installedVersion() {
  const p = join(runtimeRoot, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')).version } catch { return null }
}
function latestVersion() {
  const npmCli = join(runtimeRoot, 'runtime', 'tools', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const fallback = join(runtimeRoot, 'runtime', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const cli = existsSync(npmCli) ? npmCli : fallback
  const registry = process.env.npm_config_registry || 'https://registry.npmmirror.com'
  const r = spawnSync(nodeExe, [cli, 'view', '@deepseek-ai/dsh', 'version', '--registry', registry, '--cache', join(dataRoot, '.npm-cache')], { encoding: 'utf8', timeout: 60000 })
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').split('\n')[0] || 'npm view 失败')
  const lines = String(r.stdout).trim().split(/\r?\n/).filter(Boolean)
  return lines[lines.length - 1].trim()
}
function compareVersions(a, b) {
  const strip = (s) => {
    const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.?(\d+))?/i)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])] : [0, 0, 0, 0]
  }
  const A = strip(a); const B = strip(b)
  for (let i = 0; i < 4; i++) { if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1 }
  return 0
}

// ---- 插件 ----
function parsePluginList(text) {
  const plugins = []
  const lines = String(text).split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^[├└──\s]*([@\w][\w.-]*\/[\w.-]+|[\w.-]+)@([\d.]+)/)
    if (m && !plugins.some((p) => p.name === m[1])) plugins.push({ name: m[1], version: m[2] })
  }
  return plugins
}
function listPlugins(profile) {
  const r = spawnSync(nodeExe, [dshBin, 'plugin', '--profile', profile, 'list'], {
    cwd: appRoot, encoding: 'utf8', timeout: 120000, env: buildEnv(dataRoot),
  })
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').split('\n').slice(-5).join('\n') || 'plugin list 失败')
  return parsePluginList(r.stdout)
}

// ---- 操作广播(插件/升级 SSE)----
const ops = new EventEmitter()
let activeOp = null // { kind: 'plugin'|'upgrade', proc: ChildProcess }
function startOp(kind, cmd, args, env) {
  if (activeOp && isPidAlive(activeOp.proc.pid)) {
    throw new Error('已有操作进行中,请等待完成')
  }
  const proc = spawn(cmd, args, { cwd: appRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  activeOp = { kind, proc }
  const emit = (data, done) => ops.emit('out', { kind, data, done })
  const pump = (stream) => {
    let buf = ''
    stream.on('data', (chunk) => {
      buf += chunk.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop()
      for (const l of lines) if (l.trim()) emit(l)
    })
    stream.on('end', () => { if (buf.trim()) emit(buf) })
  }
  pump(proc.stdout)
  pump(proc.stderr)
  proc.on('exit', (code) => {
    emit(`(退出码 ${code})`, true)
    activeOp = null
  })
  proc.on('error', (err) => {
    emit(`启动失败: ${err.message}`, true)
    activeOp = null
  })
  return proc
}

// ---- 备份(zip STORE 纯 JS 写入器,支持 \\?\ 长路径)----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
function dosDateTime(ts) {
  const d = new Date(ts)
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}
const BACKUP_EXCLUDE = ['backups', 'webview2-cache', '.npm-cache', '.manager']
function createBackup(note) {
  mkdirSync(backupsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const name = `backup-${stamp}.zip`
  const zipPath = join(backupsDir, name)
  const fd = openSync(zipPath, 'w')
  const central = []
  let offset = 0
  const files = []
  const walk = (dir, rel) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = join(dir, e.name)
      const relPath = rel ? rel + '/' + e.name : e.name
      if (BACKUP_EXCLUDE.some((x) => e.name === x)) continue
      if (e.isDirectory()) walk(abs, relPath)
      else files.push({ abs, relPath })
    }
  }
  walk(dataRoot, '')
  const writeBuf = (buf) => writeSync(fd, buf)
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xFFFF); return b }
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b }
  for (const f of files) {
    let data
    try { data = readFileSync('\\\\?\\' + f.abs) } catch { continue }
    const nameBuf = Buffer.from(f.relPath.replace(/\\/g, '/'), 'utf8')
    const { time, date } = dosDateTime(statSync(f.abs).mtimeMs)
    const crc = crc32(data)
    const lfh = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time), u16(date),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0),
      nameBuf,
    ])
    writeBuf(lfh); writeBuf(data)
    const cd = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(date),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset),
      nameBuf,
    ])
    central.push(cd)
    offset += lfh.length + data.length
  }
  const cdStart = offset
  let cdSize = 0
  for (const c of central) { writeBuf(c); cdSize += c.length }
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cdSize), u32(cdStart), u16(0),
  ])
  writeBuf(eocd)
  closeSync(fd)
  if (note) writeFileSync(zipPath.replace(/\.zip$/, '.txt'), note, 'utf8')
  return { file: basename(zipPath), size: statSync(zipPath).size, count: files.length }
}
function listBackups() {
  if (!existsSync(backupsDir)) return []
  return readdirSync(backupsDir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const p = join(backupsDir, f)
      const s = statSync(p)
      const noteFile = p.replace(/\.zip$/, '.txt')
      return {
        file: f, size: s.size, sizeText: fmtSize(s.size),
        time: s.mtime.toISOString(), note: existsSync(noteFile) ? readFileSync(noteFile, 'utf8') : '',
      }
    })
    .sort((a, b) => b.time.localeCompare(a.time))
}
function restoreBackup(file) {
  const zipPath = join(backupsDir, basename(file))
  if (!existsSync(zipPath)) throw new Error('备份不存在: ' + file)
  const buf = readFileSync(zipPath)
  let pos = 0
  let count = 0
  while (pos + 30 <= buf.length) {
    if (buf.readUInt32LE(pos) !== 0x04034b50) break
    const method = buf.readUInt16LE(pos + 8)
    const compSize = buf.readUInt32LE(pos + 18)
    const nameLen = buf.readUInt16LE(pos + 26)
    const extraLen = buf.readUInt16LE(pos + 28)
    const name = buf.slice(pos + 30, pos + 30 + nameLen).toString('utf8')
    const dataStart = pos + 30 + nameLen + extraLen
    if (dataStart + compSize > buf.length) break
    if (method === 0) {
      if (!name.endsWith('/')) {
        const target = join(dataRoot, name)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, buf.slice(dataStart, dataStart + compSize))
        count++
      }
    } else {
      throw new Error('不支持的压缩方法(备份应为 STORE 模式): ' + name)
    }
    pos = dataStart + compSize
  }
  return { count }
}

// ---- settings ----
function readSettings() {
  return existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : ''
}
function writeSettings(content) {
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(settingsFile, content, 'utf8')
}

// ---- 概览 ----
function overview() {
  return {
    edition: exeEdition ? 'exe' : 'folder',
    appRoot,
    dataRoot,
    dshVersion: installedVersion(),
    nodeVersion: (() => {
      try { return spawnSync(nodeExe, ['--version'], { encoding: 'utf8' }).stdout.trim() } catch { return '?' }
    })(),
    dataSize: fmtSize(dirSize(dataRoot, BACKUP_EXCLUDE)),
  }
}
function dataUsage() {
  const rows = []
  for (const e of readdirSync(dataRoot, { withFileTypes: true })) {
    if (BACKUP_EXCLUDE.some((x) => x === e.name)) continue
    const p = join(dataRoot, e.name)
    const size = e.isDirectory() ? dirSize(p, []) : statSync(p).size
    rows.push({ name: e.name, isDir: e.isDirectory(), size, sizeText: fmtSize(size) })
  }
  rows.sort((a, b) => b.size - a.size)
  return rows
}

// ---- 日志与系统健康 ----
function managerLog(message) {
  try {
    const dir = join(dataRoot, '.manager')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manager.log'),
      new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' + message + '\r\n',
      { flag: 'a' })
  } catch { /* 日志失败不阻断 */ }
}

/// explorer /factory 僵尸进程 PID 集。Windows 11 已知 bug:IFileDialog 等 Shell
/// COM 调用激活的 explorer.exe /factory,{75dff2b7...} -Embedding 进程在调用方
/// 释放后不退出,反复调用(如文件夹选择框)会堆积几十个、占数 GB 内存,并拖垮
/// ShellExecute 打开目录的通道(表现为程序调用无反应,手动双击正常)。
function explorerFactoryPids() {
  try {
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object { $_.CommandLine -like '*75dff2b7*' } | ForEach-Object { $_.ProcessId }`],
      { encoding: 'utf8', timeout: 15000, windowsHide: true })
    return new Set(String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number))
  } catch { return new Set() }
}

function killPids(pids) {
  for (const pid of pids) {
    try { spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 已退出 */ }
  }
}

// ---- HTTP 服务器 ----
function readBody(req) {
  return new Promise((res) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      try { res(data ? JSON.parse(data) : {}) } catch { res({}) }
    })
  })
}
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}
function startServer() {
  // 应用启动配置中的 data 位置(存于固定位置 launch.json;改配置需重启生效)
  try {
    const cfg = JSON.parse(readFileSync(launchConfigFile, 'utf8'))
    if (cfg.dataDir && String(cfg.dataDir).trim()) {
      const next = resolve(appRoot, cfg.dataDir)
      if (existsSync(next) || true) dataRoot = next
    }
  } catch { /* 默认 data */ }
  managerDir = join(dataRoot, '.manager')
  backupsDir = join(dataRoot, 'backups')

  // Origin 防护:仅本机
  const originOk = (req) => {
    const o = req.headers.origin
    if (!o) return true
    const host = req.headers.host || ''
    try { return new URL(o).host === host } catch { return false }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    try {
      if (path.startsWith('/api/')) {
        if (!originOk(req)) return sendJson(res, 403, { error: 'forbidden origin' })
        return await apiRoute(req, res, url)
      }
      // 静态 UI
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(UI_HTML)
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) })
    }
  })

  const apiRoute = async (req, res, url) => {
    const p = url.pathname
    const method = req.method

    if (p === '/api/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, pid: process.pid, dsh: installedVersion() })
    }
    if (p === '/api/overview' && method === 'GET') {
      return sendJson(res, 200, overview())
    }
    if (p === '/api/data/usage' && method === 'GET') {
      return sendJson(res, 200, { rows: dataUsage() })
    }

    // ---- 一键启动 ----
    if (p === '/api/launch/status' && method === 'GET') {
      const cfg = readLaunchConfig()
      const port = Number(cfg.port) || 3080
      const running = await webPortOpen(port)
      const pid = (() => {
        try { return Number(readFileSync(launchPidFile, 'utf8')) } catch { return 0 }
      })()
      return sendJson(res, 200, { cfg, port, running, pid, pidAlive: isPidAlive(pid) })
    }
    if (p === '/api/launch/config' && method === 'GET') {
      return sendJson(res, 200, { cfg: readLaunchConfig() })
    }
    if (p === '/api/launch/config' && method === 'PUT') {
      const body = await readBody(req)
      const cfg = { ...readLaunchConfig(), ...body }
      if (!Number.isInteger(Number(cfg.port)) || Number(cfg.port) < 0 || Number(cfg.port) > 65535) {
        return sendJson(res, 400, { error: '端口须为 0-65535 的数字' })
      }
      cfg.port = Number(cfg.port)
      cfg.autoOpenBrowser = !!cfg.autoOpenBrowser
      if (!Array.isArray(cfg.extraArgs)) cfg.extraArgs = []
      if (cfg.dataDir !== undefined) cfg.dataDir = String(cfg.dataDir).trim()
      writeLaunchConfig(cfg)
      return sendJson(res, 200, { ok: true, cfg, restartNeeded: true })
    }
    if (p === '/api/launch/start' && method === 'POST') {
      return sendJson(res, 200, await launchNow())
    }
    // 系统文件夹选择框(PowerShell WinForms),返回所选路径(相对 appRoot)
    if (p === '/api/launch/pick-dir' && method === 'POST') {
      const startPath = readLaunchConfig().dataDir
        ? resolve(appRoot, readLaunchConfig().dataDir)
        : dataRoot
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$f.Description = '选择数据目录(DSH_HOME)'",
        "$f.SelectedPath = '" + String(startPath).replace(/'/g, "''") + "'",
        "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }",
      ].join('; ')
      // FolderBrowserDialog 底层是 IFileDialog COM,会激活 explorer /factory 进程;
      // Win11 上关闭对话框后这些进程不退出(泄漏)。记录前后 PID 差集并回收,防止堆积。
      const before = explorerFactoryPids()
      const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8', timeout: 120000 })
      const leaked = [...explorerFactoryPids()].filter((id) => !before.has(id))
      if (leaked.length) {
        managerLog('pick-dir: cleaned ' + leaked.length + ' leaked explorer factory pids')
        killPids(leaked)
      }
      const picked = String(r.stdout || '').trim().split(/\r?\n/)[0] || ''
      if (!picked) return sendJson(res, 200, { picked: null })
      const rel = relative(appRoot, picked)
      const out = rel && !rel.startsWith('..') ? rel : picked
      return sendJson(res, 200, { picked: out, absolute: picked })
    }

    // 检测运行中的 dsh 服务(如 exe/dsh.cmd 启动的默认实例),可一键停止
    if (p === '/api/detect/services' && method === 'GET') {
      return sendJson(res, 200, { services: await detectDshServices() })
    }
    if (p === '/api/detect/stop' && method === 'POST') {
      const body = await readBody(req)
      const pid = Number(body.pid)
      if (!pid) return sendJson(res, 400, { error: '缺少 pid' })
      const ok = stopServiceByPid(pid)
      return sendJson(res, 200, { ok, message: ok ? `已停止端口 ${body.port ?? ''} 上的服务` : '进程已不存在或无法停止' })
    }

    // ---- 插件 ----
    if (p === '/api/plugins' && method === 'GET') {
      const profile = url.searchParams.get('profile') || 'web'
      try {
        const plugins = listPlugins(profile)
        // 补充启用状态:bundles 里有 = 启用
        try {
          const pkg = JSON.parse(readFileSync(join(dataRoot, 'profiles', profile, 'package.json'), 'utf8'))
          const bundles = pkg.dsh?.profile?.bundles ?? []
          for (const pl of plugins) pl.enabled = bundles.includes(pl.name)
        } catch { for (const pl of plugins) pl.enabled = true }
        return sendJson(res, 200, { plugins })
      } catch (e) { return sendJson(res, 500, { error: e.message }) }
    }
    if (p === '/api/plugins' && method === 'POST') {
      const body = await readBody(req)
      const profile = body.profile || 'web'
      if (!body.name) return sendJson(res, 400, { error: '缺少插件名' })
      startOp("plugin", nodeExe, [dshBin, "plugin", "--profile", profile, "add", body.name], buildEnv(dataRoot))
      return sendJson(res, 200, { ok: true })
    }
    if (p === '/api/plugins/remove' && method === 'POST') {
      const body = await readBody(req)
      const profile = body.profile || 'web'
      startOp("plugin", nodeExe, [dshBin, "plugin", "--profile", profile, "remove", body.name], buildEnv(dataRoot))
      return sendJson(res, 200, { ok: true })
    }
    // 禁用/启用:改 profile 的 dsh.profile.bundles(保留 dependencies,
    // 重新启用不需要重新安装)
    if (p === '/api/plugins/state' && method === 'POST') {
      const body = await readBody(req)
      const profile = body.profile || 'web'
      const pkgFile = join(dataRoot, 'profiles', profile, 'package.json')
      if (!existsSync(pkgFile)) return sendJson(res, 404, { error: `profile ${profile} 不存在` })
      let pkg
      try { pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) } catch { return sendJson(res, 500, { error: '无法解析 package.json' }) }
      const bundles = pkg.dsh?.profile?.bundles ?? []
      const enabled = !!body.enabled
      const name = body.name
      if (!name) return sendJson(res, 400, { error: '缺少插件名' })
      if (enabled && !bundles.includes(name)) {
        bundles.push(name)
      } else if (!enabled && bundles.includes(name)) {
        pkg.dsh.profile.bundles = bundles.filter((b) => b !== name)
      } else {
        return sendJson(res, 200, { ok: true, message: '无需变更' })
      }
      if (enabled && pkg.dsh.profile.bundles !== bundles) pkg.dsh.profile.bundles = bundles
      writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))
      return sendJson(res, 200, { ok: true, message: enabled ? `已启用 ${name}(重启后生效)` : `已禁用 ${name}(重启后生效)` })
    }
    if (p === '/api/ops/stream' && method === 'GET') {
      return sseOps(res)
    }

    // ---- 升级 ----
    if (p === '/api/upgrade/check' && method === 'GET') {
      try {
        const latest = latestVersion()
        const installed = installedVersion()
        return sendJson(res, 200, { latest, installed, upToDate: installed !== null && compareVersions(latest, installed) <= 0 })
      } catch (e) { return sendJson(res, 500, { error: e.message }) }
    }
    if (p === '/api/upgrade' && method === 'POST') {
      if (await anyDshRunning()) return sendJson(res, 409, { error: '有 dsh 服务正在运行,请先停止再升级(升级会重装 app\\node_modules)' })
      if (!existsSync(upgradeScript)) return sendJson(res, 500, { error: 'upgrade.mjs 不存在' })
      startOp("upgrade", nodeExe, [upgradeScript, "--yes"], buildEnv(dataRoot))
      return sendJson(res, 200, { ok: true })
    }

    // ---- 备份 ----
    if (p === '/api/backups' && method === 'GET') {
      return sendJson(res, 200, { backups: listBackups() })
    }
    if (p === '/api/backups' && method === 'POST') {
      const body = await readBody(req)
      const r = createBackup(body.note || '')
      return sendJson(res, 200, { ok: true, ...r })
    }
    if (p === '/api/backups/delete' && method === 'POST') {
      const body = await readBody(req)
      const zipPath = join(backupsDir, basename(body.file || ''))
      if (!existsSync(zipPath)) return sendJson(res, 404, { error: '备份不存在' })
      try { unlinkSync(zipPath) } catch (e) { return sendJson(res, 500, { error: '删除失败: ' + e.message }) }
      try { unlinkSync(zipPath.replace(/\.zip$/, '.txt')) } catch { /* note 文件可有可无 */ }
      return sendJson(res, 200, { ok: true, message: '已删除备份 ' + body.file })
    }
    if (p === '/api/backups/restore' && method === 'POST') {
      const body = await readBody(req)
      if (await anyDshRunning()) return sendJson(res, 409, { error: '有 dsh 服务正在运行,请先全部停止再恢复' })
      let snapshot = null
      if (body.mode === 'clean') {
        // 彻底恢复:先自动快照当前 data(留后路),再清空(保留 backups;
        // webview2-cache/.manager 若被壳锁定则删除失败,跳过即可)
        snapshot = createBackup('恢复前自动快照').file
        for (const e of readdirSync(dataRoot, { withFileTypes: true })) {
          if (e.name === 'backups') continue
          try { rmSync(join(dataRoot, e.name), { recursive: true, force: true }) } catch { /* locked: skip */ }
        }
      }
      const r = restoreBackup(body.file)
      return sendJson(res, 200, { ok: true, snapshot, ...r })
    }

    // ---- settings ----
    if (p === '/api/settings' && method === 'GET') {
      return sendJson(res, 200, { content: readSettings(), path: settingsFile })
    }
    if (p === '/api/settings' && method === 'PUT') {
      const body = await readBody(req)
      writeSettings(body.content || '')
      return sendJson(res, 200, { ok: true })
    }

    // ---- 快捷操作 ----
    if (p === '/api/quick/dsh-web' && method === 'POST') {
      const body = await readBody(req)
      const port = body.port || 3080
      // exec 走 shell:引号语义正常(spawn 会把参数内引号转义成 \" 字面量,
      // 导致 cmd /c start 打开名为 \"...\" 的文件而无反应)
      exec(`start "" "http://127.0.0.1:${port}"`, { windowsHide: true }).unref()
      return sendJson(res, 200, { ok: true })
    }
    if (p === '/api/quick/explore' && method === 'POST') {
      const body = await readBody(req)
      const target = resolve(appRoot, body.path || 'data')
      // 白名单:只允许打开 appRoot 内的目录
      if (!target.startsWith(resolve(appRoot))) return sendJson(res, 400, { error: '路径越界' })
      // ShellExecute(exec start)打开目录最终由 explorer 处理;若系统堆积大量
      // explorer /factory 僵尸进程(Win11 Shell COM 泄漏),该通道会静默失效。
      // 检测到异常时降级为 cmd 窗口定位目录——不依赖 explorer,必然可用。
      const zombies = explorerFactoryPids().size
      const degraded = zombies > 10
      const cmd = degraded
        ? `start "" cmd /k cd /d "${target}"`
        : `start "" "${target}"`
      exec(cmd, { windowsHide: true }, (err) => {
        managerLog((err ? 'explore FAIL ' + err.message : 'explore ok') + ' (degraded=' + degraded + ') target=' + target)
      }).unref()
      return sendJson(res, 200, degraded
        ? { ok: true, degraded: true, message: '检测到系统资源管理器异常(' + zombies + ' 个残留进程),已改用命令行窗口打开。建议重启电脑或重启资源管理器后恢复。' }
        : { ok: true })
    }

    // ---- 清理 WebView2 缓存 ----
    if (p === '/api/cleanup/webview2' && method === 'POST') {
      const wv = join(dataRoot, 'webview2-cache')
      if (existsSync(wv)) {
        try { rmSync(wv, { recursive: true, force: true }) } catch (e) { return sendJson(res, 500, { error: '清理失败(壳正在运行中锁定该目录,请先关闭管理器窗口): ' + e.message }) }
      }
      return sendJson(res, 200, { ok: true })
    }

    // ---- 关闭 ----
    if (p === '/api/shutdown' && method === 'POST') {
      sendJson(res, 200, { ok: true })
      setTimeout(() => process.exit(0), 100)
      return
    }

    return sendJson(res, 404, { error: 'not found' })
  }

  // SSE:操作输出(插件/升级)
  function sseOps(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const onOut = ({ data, done }) => {
      res.write(`data: ${JSON.stringify({ data, done })}\n\n`)
      if (done) res.write('data: {"done":true}\n\n')
    }
    ops.on('out', onOut)
    const timer = setInterval(() => res.write(': hb\n\n'), 15000)
    reqCleanup(res, () => { ops.off('out', onOut); clearInterval(timer) })
  }
  const reqCleanup = (res, fn) => res.on('close', fn)

  const port = Number(process.argv.find((a, i) => process.argv[i - 1] === '--port') || process.env.MANAGER_PORT || 3099)
  const tryListen = (p, attempts) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempts > 0) {
        tryListen(p + Math.floor(Math.random() * 2000) + 1, attempts - 1)
      } else {
        console.error('HARNESS_MANAGER_ERROR', err.message)
        process.exit(1)
      }
    })
    server.listen(p, '127.0.0.1', () => {
      const actual = server.address().port
      console.log(`HARNESS_MANAGER_URL http://127.0.0.1:${actual}`)
      mkdirSync(managerDir, { recursive: true })
      writeFileSync(join(managerDir, 'port'), String(actual))
    })
  }
  tryListen(port, 3)

  // --managed:壳崩溃(ppid 消失)则自退
  if (process.argv.includes('--managed')) {
    const ppid = process.ppid
    setInterval(() => {
      try { process.kill(ppid, 0) } catch { process.exit(0) }
    }, 5000)
  }
}

// ---- 内嵌单页 UI ----
const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DeepSeek Harness Manager</title>
<style>
:root{--bg:#14161a;--panel:#1c1f26;--panel2:#22262f;--border:#2a2f3a;--text:#d8dee9;--dim:#8b93a1;--accent:#1665d8;--accent2:#1f7aeb;--green:#3fb950;--yellow:#d29922;--red:#f85149;--blue:#58a6ff}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;display:flex;height:100vh;overflow:hidden}
#sidebar{width:200px;min-width:200px;background:var(--panel);border-right:1px solid var(--border);padding:16px 0;display:flex;flex-direction:column}
#sidebar .brand{padding:0 20px 16px;font-size:17px;font-weight:700;color:#fff;letter-spacing:.5px}
#sidebar .brand small{display:block;font-size:11px;color:var(--dim);font-weight:400}
#sidebar nav a{display:flex;align-items:center;gap:10px;padding:10px 20px;color:var(--dim);text-decoration:none;cursor:pointer;border-left:3px solid transparent}
#sidebar nav a:hover{background:var(--panel2);color:var(--text)}
#sidebar nav a.active{color:#fff;border-left-color:var(--accent2);background:var(--panel2)}
#sidebar .foot{margin-top:auto;padding:12px 20px;font-size:11px;color:var(--dim)}
#main{flex:1;overflow-y:auto;padding:24px 28px}
h2{font-size:20px;margin-bottom:16px}
h3{font-size:15px;margin:18px 0 10px;color:#fff}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:8px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:14px 16px}
.card .label{font-size:12px;color:var(--dim)}
.card .value{font-size:20px;font-weight:700;margin-top:4px;color:#fff}
.card .sub{font-size:12px;color:var(--dim);margin-top:2px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--border);font-size:13px}
th{background:var(--panel2);color:var(--dim);font-weight:600;font-size:12px}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--panel2)}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle}
.dot.running{background:var(--green)}.dot.starting{background:var(--yellow)}.dot.stopped{background:#4a5160}.dot.finished{background:var(--blue)}
button{background:var(--accent);color:#fff;border:none;border-radius:6px;padding:7px 14px;font-size:13px;cursor:pointer}
button:hover{background:var(--accent2)}
button.ghost{background:transparent;border:1px solid var(--border);color:var(--text)}
button.ghost:hover{border-color:var(--accent2);color:#fff}
button.danger{background:transparent;border:1px solid var(--red);color:var(--red)}
button.danger:hover{background:var(--red);color:#fff}
button.sm{padding:4px 10px;font-size:12px}
button:disabled{opacity:.45;cursor:not-allowed}
input,select,textarea{background:var(--panel2);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:7px 10px;font-size:13px;width:100%;font-family:inherit}
textarea{font-family:Consolas,"Microsoft YaHei",monospace;font-size:12.5px}
label{display:block;font-size:12px;color:var(--dim);margin:10px 0 4px}
.row{display:flex;gap:10px;align-items:center}
.grow{flex:1}
.msg{padding:8px 12px;border-radius:6px;margin:10px 0;font-size:13px;display:none}
.msg.ok{display:block;background:#12261a;border:1px solid #1f6f3a;color:#7ee787}
.msg.err{display:block;background:#2a1215;border:1px solid #6e2b2b;color:#ff9b9b}
.msg.warn{display:block;background:#2a2112;border:1px solid #6e5a2b;color:#f0c674}
.console{background:#0d0f12;border:1px solid var(--border);border-radius:8px;padding:12px;font:12px/1.6 Consolas,monospace;height:260px;overflow-y:auto;white-space:pre-wrap;word-break:break-all}
.console .done{color:var(--yellow)}
.banner{background:#2a2112;border:1px solid #6e5a2b;color:#f0c674;border-radius:6px;padding:8px 12px;font-size:12.5px;margin-bottom:12px}
#modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:10}
#modal{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:22px;width:520px;max-height:86vh;overflow-y:auto}
#modal h3{margin:0 0 6px}
#log-drawer{position:fixed;bottom:0;left:200px;right:0;height:230px;background:var(--panel);border-top:1px solid var(--border);display:none;flex-direction:column;z-index:5}
#log-drawer .head{display:flex;align-items:center;gap:12px;padding:8px 16px;border-bottom:1px solid var(--border)}
#log-drawer pre{flex:1;overflow-y:auto;padding:10px 16px;font:12px/1.6 Consolas,monospace;margin:0}
.badge{display:inline-block;background:var(--panel2);border:1px solid var(--border);border-radius:4px;padding:1px 7px;font-size:11px;color:var(--dim)}
</style>
</head>
<body>
<div id="sidebar">
  <div class="brand">Harness 管理器<small id="brand-sub">DeepSeek Harness</small></div>
  <nav>
    <a data-view="dash" class="active" onclick="showView('dash')">▦ 仪表盘</a>
    <a data-view="plug" onclick="showView('plug')">⬡ 插件管理</a>
    <a data-view="upgr" onclick="showView('upgr')">↻ 升级管理</a>
    <a data-view="data" onclick="showView('data')">▤ 数据与备份</a>
  </nav>
  <div class="foot" id="foot-info">加载中…</div>
</div>
<div id="main">
  <div id="view-dash">
    <h2>仪表盘</h2>
    <div class="cards" id="dash-cards"></div>
    <h3>运行中的 dsh 服务</h3>
    <div id="dash-detect"></div>
    <h3>一键启动</h3>
    <div class="row" style="margin-bottom:14px">
      <button id="launch-btn" style="padding:11px 26px;font-size:15px" onclick="launchStart()">▶ 启动 dsh</button>
      <button class="ghost" style="padding:11px 14px;font-size:15px" onclick="openLaunchConfig()" title="启动设置">⚙ 设置</button>
      <span id="launch-state" style="color:var(--dim);font-size:13px"></span>
    </div>
    <h3>快捷操作</h3>
    <div class="row">
      <button onclick="quickDshWeb()">打开 dsh Web UI</button>
      <button class="ghost" onclick="quickExplore('data')">打开 data 目录</button>
      <button class="ghost" onclick="quickExplore('.')">打开应用目录</button>
    </div>
  </div>
  <div id="view-plug" style="display:none">
    <h2>插件管理</h2>
    <div class="banner">提示:插件含原生模块(如 ssh2)安装报 ERR_PNPM_IGNORED_BUILDS 时,编辑 <b>data\\profiles\\web\\pnpm-workspace.yaml</b> 把 allowBuilds 下对应包改为 true 后重试;缺 Visual Studio 属可选编译失败,一般不影响使用。</div>
    <div class="row" style="margin-bottom:12px">
      <select id="plug-profile" style="width:140px"><option value="web">profile: web</option><option value="headless">profile: headless</option></select>
      <input id="plug-add" placeholder="插件包名,如 @scope/pkg 或 github:user/repo" class="grow">
      <button onclick="pluginAdd()">安装</button>
      <button class="ghost" onclick="refreshPlugins()">刷新列表</button>
    </div>
    <div id="plug-msg"></div>
    <table><thead><tr><th>插件包</th><th>版本</th><th style="width:100px">操作</th></tr></thead><tbody id="plug-tbody"></tbody></table>
    <h3>操作输出</h3>
    <div class="console" id="plug-console">(空闲)</div>
  </div>
  <div id="view-upgr" style="display:none">
    <h2>升级管理</h2>
    <div class="cards" id="upgr-cards"></div>
    <div id="upgr-msg"></div>
    <div class="row">
      <button id="upgr-check" onclick="upgradeCheck()">检查新版本</button>
      <button id="upgr-go" onclick="upgradeGo()" disabled>升级到最新版</button>
    </div>
    <h3>升级输出</h3>
    <div class="console" id="upgr-console">(空闲)</div>
  </div>
  <div id="view-data" style="display:none">
    <h2>数据与备份</h2>
    <div class="cards" id="data-cards"></div>
    <div id="data-msg"></div>
    <h3>备份</h3>
    <div class="row" style="margin-bottom:10px">
      <input id="backup-note" placeholder="备份备注(可选)" class="grow" style="max-width:320px">
      <button onclick="backupNow()">立即备份 data</button>
    </div>
    <table><thead><tr><th>备份文件</th><th>大小</th><th>时间</th><th>备注</th><th style="width:100px">操作</th></tr></thead><tbody id="backup-tbody"></tbody></table>
    <h3>settings.yaml 编辑</h3>
    <div class="row" style="margin-bottom:8px">
      <button class="sm" onclick="loadSettings()">读取</button>
      <button class="sm ghost" onclick="saveSettings()">保存</button>
      <span id="settings-path" class="badge" style="margin-left:8px"></span>
    </div>
    <textarea id="settings-editor" rows="10" spellcheck="false"></textarea>
    <h3>data 占用明细</h3>
    <table><thead><tr><th>条目</th><th>大小</th></tr></thead><tbody id="usage-tbody"></tbody></table>
    <h3>维护</h3>
    <div class="row">
      <button class="ghost" onclick="cleanWebView2()">清理 WebView2 缓存</button>
    </div>
  </div>
</div>
<div id="modal-bg"><div id="modal"></div></div>
<script>
var V = { es: null, upgrLatest: null, upgrInstalled: null, backups: [] }
function $(id) { return document.getElementById(id) }
function msg(el, type, text) { el.className = 'msg ' + type; el.textContent = text }
function showView(name) {
  var views = ['dash', 'plug', 'upgr', 'data']
  views.forEach(function (v) { $('view-' + v).style.display = v === name ? '' : 'none' })
  var links = document.querySelectorAll('#sidebar nav a')
  links.forEach(function (a) { a.className = a.getAttribute('data-view') === name ? 'active' : '' })
  if (name === 'dash') refreshDash()
  if (name === 'plug') refreshPlugins()
  if (name === 'upgr') { upgradeCheck() }
  if (name === 'data') refreshData()
}
async function api(path, opts) {
  var r = await fetch('/api' + path, opts || {})
  var j = await r.json()
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status))
  return j
}
function post(path, body) { return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }) }
// ---- 仪表盘 ----
async function refreshDash() {
  try {
    var o = await api('/overview')
    $('brand-sub').textContent = 'dsh ' + o.dshVersion + ' · ' + o.edition
    $('foot-info').textContent = 'dsh ' + o.dshVersion + ' / ' + o.edition + ' 版'
    $('dash-cards').innerHTML =
      '<div class="card"><div class="label">dsh 版本</div><div class="value">' + o.dshVersion + '</div></div>' +
      '<div class="card"><div class="label">Node.js(内嵌)</div><div class="value">' + o.nodeVersion + '</div></div>' +
      '<div class="card"><div class="label">形态</div><div class="value">' + (o.edition === 'exe' ? '单文件 exe' : '文件夹') + '</div><div class="sub">' + o.appRoot + '</div></div>' +
      '<div class="card"><div class="label">data 占用</div><div class="value">' + o.dataSize + '</div></div>'
    // 检测运行中的 dsh 服务(如 exe / dsh.cmd 启动的默认实例)
    var svc = await api('/detect/services')
    if (svc.services.length) {
      $('dash-detect').innerHTML = '<table><thead><tr><th>端口</th><th>PID</th><th style="width:120px">操作</th></tr></thead><tbody>' +
        svc.services.map(function (s) {
          return '<tr><td>' + s.port + '</td><td>' + s.pid + '</td><td><button class="sm danger" onclick="stopDetected(' + s.pid + ',' + s.port + ')">停止</button></td></tr>'
        }).join('') + '</tbody></table>' +
        '<div style="color:var(--dim);font-size:12px;margin-top:6px">这些是直接用 exe / dsh.cmd 启动的 dsh 服务。如需停止,点「停止」。</div>'
    } else {
      $('dash-detect').innerHTML = '<div style="color:var(--dim)">(未检测到运行中的 dsh 服务)</div>'
    }
  } catch (e) { $('foot-info').textContent = '错误: ' + e.message }
}
async function stopDetected(pid, port) {
  if (!confirm('停止端口 ' + port + ' 上运行中的 dsh 服务?')) return
  try {
    var r = await post('/detect/stop', { pid: pid, port: port })
    alert(r.message)
    refreshDash()
  } catch (e) { alert('停止失败: ' + e.message) }
}
// ---- 一键启动 ----
async function refreshLaunchState() {
  try {
    var s = await api('/launch/status')
    var btn = $('launch-btn')
    if (s.running) {
      btn.textContent = '◉ 运行中(打开)'
      btn.onclick = function () { quickDshWeb() }
      $('launch-state').textContent = 'dsh 已在端口 ' + s.port + ' 运行'
    } else {
      btn.textContent = '▶ 启动 dsh'
      btn.onclick = function () { launchStart() }
      $('launch-state').textContent = '端口 ' + s.port + (s.cfg.autoOpenBrowser ? ' · 启动后自动打开浏览器' : ' · 不自动打开浏览器')
    }
  } catch (e) { $('launch-state').textContent = '' }
}
function launchStart() {
  post('/launch/start').then(function (r) {
    if (r.alreadyRunning) {
      alert('dsh 已在端口 ' + r.port + ' 运行,直接打开浏览器')
      quickDshWeb()
    } else {
      $('launch-state').textContent = r.message
      setTimeout(refreshLaunchState, 3000)
    }
  }).catch(function (e) { alert('启动失败: ' + e.message) })
}
async function openLaunchConfig() {
  var s = await api('/launch/config')
  var c = s.cfg
  $('modal').innerHTML =
    '<h3>启动设置</h3>' +
    '<label>端口(0-65535,默认 3080)</label><input id="f-lport" value="' + c.port + '">' +
    '<label style="margin-top:12px;display:flex;align-items:center;gap:8px"><input type="checkbox" id="f-lbrowser" style="width:auto"' + (c.autoOpenBrowser ? ' checked' : '') + '> 启动后自动打开浏览器</label>' +
    '<label>额外 dsh 参数(空格分隔,如 --patch x.yml)</label><input id="f-largs" value="' + (c.extraArgs || []).join(' ') + '">' +
    '<label>数据目录(data 位置;留空 = 应用目录 data)</label>' +
    '<div class="row"><input id="f-ldata" value="' + (c.dataDir || '') + '" placeholder="data" class="grow"><button class="ghost" onclick="pickDataDir()">浏览…</button></div>' +
    '<div class="banner" style="margin-top:12px">修改数据目录后需<b>重启管理器</b>生效(备份/插件/设置均指向新位置)。</div>' +
    '<div class="row" style="margin-top:14px;justify-content:flex-end">' +
    '<button class="ghost" onclick="closeModal()">取消</button>' +
    '<button onclick="saveLaunchConfig()">保存</button></div>'
  $('modal-bg').style.display = 'flex'
}
function pickDataDir() {
  post('/launch/pick-dir').then(function (r) {
    if (r.picked) $('f-ldata').value = r.picked
  }).catch(function (e) { alert('选择失败: ' + e.message) })
}
function saveLaunchConfig() {
  var cfg = {
    port: parseInt($('f-lport').value || '3080', 10),
    autoOpenBrowser: $('f-lbrowser').checked,
    extraArgs: $('f-largs').value.trim() ? $('f-largs').value.trim().split(/\\s+/) : [],
    dataDir: $('f-ldata').value.trim(),
  }
  api('/launch/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) })
    .then(function () {
      closeModal()
      alert('已保存。若修改了数据目录,请重启管理器(关闭窗口重新打开)使其生效。')
      refreshLaunchState()
    })
    .catch(function (e) { alert('保存失败: ' + e.message) })
}
async function quickDshWeb() {
  try { var o = await api('/overview'); await post('/quick/dsh-web', { port: 3080 }) }
  catch (e) { alert('打开失败: ' + e.message) }
}
async function quickExplore(p) {
  try {
    var r = await post('/quick/explore', { path: p })
    if (r.degraded) alert(r.message)
  } catch (e) { alert('打开失败: ' + e.message) }
}

function closeModal() { $('modal-bg').style.display = 'none' }

// ---- 插件 ----
async function refreshPlugins() {
  try {
    var profile = $('plug-profile').value
    var r = await api('/plugins?profile=' + profile)
    $('plug-tbody').innerHTML = r.plugins.map(function (p) {
      // 启用 / 禁用 / 移除三个功能;当前状态对应的按钮禁用
      var enableBtn = '<button class="sm"' + (p.enabled ? ' disabled' : '') + ' onclick="pluginState(\\'' + p.name + '\\',true)">启用</button>'
      var disableBtn = '<button class="sm ghost"' + (p.enabled ? '' : ' disabled') + ' onclick="pluginState(\\'' + p.name + '\\',false)">禁用</button>'
      var removeBtn = '<button class="sm danger" onclick="pluginRemove(\\'' + p.name + '\\')">移除</button>'
      return '<tr><td>' + p.name + (p.enabled ? '' : ' <span class="badge">已禁用</span>') + '</td><td>' + p.version + '</td><td style="width:230px">' +
        enableBtn + ' ' + disableBtn + ' ' + removeBtn + '</td></tr>'
    }).join('') || '<tr><td colspan="3" style="color:var(--dim)">(无插件)</td></tr>'
  } catch (e) { msg($('plug-msg'), 'err', e.message) }
}
function pluginState(name, enabled) {
  post('/plugins/state', { name: name, enabled: enabled, profile: $('plug-profile').value }).then(function (r) {
    msg($('plug-msg'), 'ok', r.message)
    refreshPlugins()
  }).catch(function (e) { msg($('plug-msg'), 'err', e.message) })
}
function pluginAdd() {
  var name = $('plug-add').value.trim()
  if (!name) { alert('请填写插件包名'); return }
  subscribeOps($('plug-console'), function () { refreshPlugins() })
  post('/plugins', { name: name, profile: $('plug-profile').value })
    .then(function () { $('plug-add').value = '' })
    .catch(function (e) { msg($('plug-msg'), 'err', e.message) })
}
function pluginRemove(name) {
  if (!confirm('移除插件 ' + name + '?')) return
  subscribeOps($('plug-console'), function () { refreshPlugins() })
  post('/plugins/remove', { name: name, profile: $('plug-profile').value })
    .catch(function (e) { msg($('plug-msg'), 'err', e.message) })
}
function subscribeOps(el, onDone) {
  el.textContent = ''
  var es = new EventSource('/api/ops/stream')
  es.onmessage = function (ev) {
    var d = JSON.parse(ev.data)
    if (d && typeof d.data === 'string') {
      el.textContent += d.data + '\\n'
      el.scrollTop = el.scrollHeight
      if (d.done) { es.close(); if (onDone) onDone() }
    }
  }
}

// ---- 升级 ----
async function upgradeCheck() {
  try {
    var r = await api('/upgrade/check')
    V.upgrLatest = r.latest; V.upgrInstalled = r.installed
    $('upgr-cards').innerHTML =
      '<div class="card"><div class="label">当前版本</div><div class="value">' + r.installed + '</div></div>' +
      '<div class="card"><div class="label">npm 最新版本</div><div class="value">' + r.latest + '</div></div>'
    if (r.upToDate) {
      msg($('upgr-msg'), 'ok', '已是最新版本')
      $('upgr-go').disabled = true
    } else {
      msg($('upgr-msg'), 'warn', '发现新版本 ' + r.latest + ',可以升级(升级会重装 app\\node_modules,data\\ 数据不受影响)')
      $('upgr-go').disabled = false
    }
  } catch (e) { msg($('upgr-msg'), 'err', '检查失败: ' + e.message) }
}
function upgradeGo() {
  if (!confirm('升级到 ' + V.upgrLatest + '?升级前请确认所有实例已停止。')) return
  subscribeOps($('upgr-console'), function () { upgradeCheck() })
  post('/upgrade').then(function () {
    msg($('upgr-msg'), 'warn', '升级进行中,请勿关闭窗口…')
  }).catch(function (e) {
    msg($('upgr-msg'), 'err', e.message)
    if (e.message.indexOf('正在运行') >= 0) refreshDash()
  })
}

// ---- 数据 ----
async function refreshData() {
  try {
    var usage = await api('/data/usage')
    var total = usage.rows.reduce(function (a, r) { return a + r.size }, 0)
    var totalText = ''
    var n = total
    if (n < 1024) totalText = n + ' B'
    else if (n < 1048576) totalText = (n / 1024).toFixed(1) + ' KB'
    else if (n < 1073741824) totalText = (n / 1048576).toFixed(1) + ' MB'
    else totalText = (n / 1073741824).toFixed(2) + ' GB'
    $('data-cards').innerHTML =
      '<div class="card"><div class="label">data 总占用</div><div class="value">' + totalText + '</div></div>' +
      '<div class="card"><div class="label">条目数</div><div class="value">' + usage.rows.length + '</div></div>'
    $('usage-tbody').innerHTML = usage.rows.map(function (r) {
      return '<tr><td>' + r.name + (r.isDir ? '/' : '') + '</td><td>' + r.sizeText + '</td></tr>'
    }).join('')
    var b = await api('/backups')
    V.backups = b.backups
    $('backup-tbody').innerHTML = b.backups.map(function (x) {
      return '<tr><td>' + x.file + '</td><td>' + x.sizeText + '</td><td>' + new Date(x.time).toLocaleString() + '</td><td>' + (x.note || '') + '</td>' +
        '<td style="width:170px"><button class="sm" onclick="backupRestore(\\'' + x.file + '\\')">恢复…</button> ' +
        '<button class="sm danger" onclick="backupDelete(\\'' + x.file + '\\')">删除</button></td></tr>'
    }).join('') || '<tr><td colspan="5" style="color:var(--dim)">(还没有备份,先点「立即备份 data」创建一个)</td></tr>'
  } catch (e) { msg($('data-msg'), 'err', e.message) }
}
function backupDelete(file) {
  if (!confirm('删除备份 ' + file + '?此操作不可恢复。')) return
  post('/backups/delete', { file: file }).then(function (r) {
    msg($('data-msg'), 'ok', r.message)
    refreshData()
  }).catch(function (e) { msg($('data-msg'), 'err', e.message) })
}
function backupNow() {
  msg($('data-msg'), 'warn', '备份生成中,请稍候…')
  post('/backups', { note: $('backup-note').value.trim() }).then(function (r) {
    msg($('data-msg'), 'ok', '备份完成: ' + r.file + ' (' + r.sizeText + ', ' + r.count + ' 个文件)')
    $('backup-note').value = ''
    refreshData()
  }).catch(function (e) { msg($('data-msg'), 'err', e.message) })
}
function backupRestore(file) {
  var b = (V.backups || []).find(function (x) { return x.file === file })
  $('modal').innerHTML =
    '<h3>恢复备份</h3>' +
    '<p style="margin:8px 0;color:var(--dim);font-size:13px">' +
    '文件: ' + file + '<br>时间: ' + (b ? new Date(b.time).toLocaleString() : '-') +
    '<br>大小: ' + (b ? b.sizeText : '-') + (b && b.note ? '<br>备注: ' + b.note : '') + '</p>' +
    '<label>恢复方式</label>' +
    '<select id="f-mode">' +
    '<option value="merge">合并恢复:覆盖 data\\ 下同名文件,保留其余内容</option>' +
    '<option value="clean">彻底恢复:先自动快照当前 data(留后路),再清空 data 后完整恢复</option>' +
    '</select>' +
    '<div class="banner" style="margin-top:12px">恢复要求所有实例已停止;正在运行的实例会拒绝恢复。</div>' +
    '<div class="row" style="margin-top:14px;justify-content:flex-end">' +
    '<button class="ghost" onclick="closeModal()">取消</button>' +
    '<button class="danger" onclick="doRestore(\\'' + file + '\\')">确认恢复</button></div>'
  $('modal-bg').style.display = 'flex'
}
function doRestore(file) {
  var mode = $('f-mode').value
  closeModal()
  msg($('data-msg'), 'warn', '恢复中,请稍候…')
  post('/backups/restore', { file: file, mode: mode }).then(function (r) {
    var extra = r.snapshot ? ',当前 data 已自动快照为 ' + r.snapshot : ''
    msg($('data-msg'), 'ok', '恢复完成: ' + r.count + ' 个文件' + extra)
    refreshData()
  }).catch(function (e) { msg($('data-msg'), 'err', e.message) })
}
async function loadSettings() {
  try {
    var r = await api('/settings')
    $('settings-editor').value = r.content
    $('settings-path').textContent = r.path
  } catch (e) { msg($('data-msg'), 'err', e.message) }
}
function saveSettings() {
  api('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: $('settings-editor').value }) })
    .then(function () { msg($('data-msg'), 'ok', 'settings.yaml 已保存') })
    .catch(function (e) { msg($('data-msg'), 'err', e.message) })
}
function cleanWebView2() {
  if (!confirm('清理 WebView2 缓存?需先关闭本管理器窗口再执行(可从命令行或浏览器重开)。')) return
  post('/cleanup/webview2').then(function () { msg($('data-msg'), 'ok', '已清理') })
    .catch(function (e) { msg($('data-msg'), 'err', e.message) })
}

// ---- 初始化 ----
refreshDash()
refreshLaunchState()
setInterval(function () {
  var v = document.querySelector('#sidebar nav a.active').getAttribute('data-view')
  if (v === 'dash') { refreshDash(); refreshLaunchState() }
}, 5000)
</script>
</body>
</html>`

// ---- 入口 ----
startServer()
