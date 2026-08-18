// harness-manager.mjs — DeepSeek Harness 桌面管理器(WebView2 壳的后端)
// 复用便携版内嵌 node.exe,零外部依赖。
// 职责:REST API(实例/插件/升级/备份/settings/日志)+ 内嵌单页 UI。
// 入口:
//   node harness-manager.mjs --cli list|start <n>|stop <n>   # 命令行接管旧实例管理器
//   node harness-manager.mjs [--managed] [--port <p>]        # 启动管理服务器
// --managed:壳模式(ppid 轮询,壳崩溃即自退,防僵尸)
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
  unlinkSync, createWriteStream, statSync, rmSync, openSync, writeSync, closeSync,
} from 'node:fs'
import { join, dirname, resolve, isAbsolute, normalize, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { EventEmitter } from 'node:events'

// ---- 形态与路径 ----
const scriptDir = dirname(fileURLToPath(import.meta.url))
const exeEdition = existsSync(join(scriptDir, '.extracted.ok'))
const runtimeRoot = scriptDir
const appRoot = exeEdition ? dirname(dirname(scriptDir)) : scriptDir
const dataRoot = join(appRoot, 'data')
const instancesDir = join(dataRoot, 'instances')
const configFile = join(instancesDir, 'instances.json')
const backupsDir = join(dataRoot, 'backups')
const managerDir = join(dataRoot, '.manager')
const nodeExe = join(runtimeRoot, 'runtime', 'node', 'node.exe')
const dshBin = join(runtimeRoot, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const upgradeScript = join(runtimeRoot, 'upgrade.mjs')
const settingsFile = join(dataRoot, 'settings.yaml')

// ---- 配置 ----
function loadConfig() {
  if (!existsSync(configFile)) return { version: 1, instances: [] }
  try { return JSON.parse(readFileSync(configFile, 'utf8')) }
  catch { return { version: 1, instances: [] } }
}
function saveConfig(cfg) {
  mkdirSync(instancesDir, { recursive: true })
  writeFileSync(configFile, JSON.stringify(cfg, null, 2))
}
function pidPath(name) { return join(instancesDir, name + '.pid') }
function logPath(name) { return join(instancesDir, name + '.log') }

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
function resolveDataDir(v) {
  if (!v) return join(appRoot, 'data')
  return isAbsolute(v) ? normalize(v) : resolve(appRoot, v)
}
function showDataDir(abs) {
  const rel = relative(appRoot, abs)
  if (rel && !rel.startsWith('..')) return rel
  return abs
}
function buildEnv(absData, inst) {
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
  if (inst.env && typeof inst.env === 'object') Object.assign(env, inst.env)
  return env
}
function findExistingDataDirs() {
  const dirs = new Set()
  if (existsSync(join(dataRoot, 'settings.yaml'))) dirs.add('data')
  if (existsSync(instancesDir)) {
    for (const d of readdirSync(instancesDir, { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(join(instancesDir, d.name, 'settings.yaml'))) {
        dirs.add(join('data', 'instances', d.name))
      }
    }
  }
  return [...dirs]
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

// ---- 状态检测 ----
async function statusOf(inst) {
  if (inst.profile === 'web') {
    const port = inst.effPort || inst.port || 0
    if (port > 0) {
      if (await webPortOpen(port)) return 'running'
      return isPidAlive(inst.pid) ? 'starting' : 'stopped'
    }
    return isPidAlive(inst.pid) ? 'starting' : 'stopped'
  }
  return isPidAlive(inst.pid) ? 'running' : 'finished'
}
function sweepStale(cfg) {
  let changed = false
  for (const inst of cfg.instances) {
    if (existsSync(pidPath(inst.name)) && !isPidAlive(inst.pid)) {
      try { unlinkSync(pidPath(inst.name)) } catch { /* ignore */ }
      inst.pid = 0
      changed = true
    }
  }
  if (changed) saveConfig(cfg)
}
async function runningInstances(cfg) {
  const out = []
  for (const inst of cfg.instances) {
    const st = await statusOf(inst)
    if (st === 'running' || st === 'starting') out.push(inst.name)
  }
  return out
}

// ---- 实例启停(同旧实例管理器语义)----
async function startInstance(cfg, inst) {
  if (inst.profile === 'web') {
    const port = inst.port || 0
    if (port > 0 && await webPortOpen(port)) {
      return { ok: false, error: `拒绝启动:端口 ${port} 已有 dsh 服务在运行(可能是别的实例)` }
    }
  }
  const absData = resolveDataDir(inst.dataDir)
  for (const other of cfg.instances) {
    if (other.name === inst.name) continue
    if (resolveDataDir(other.dataDir).toLowerCase() !== absData.toLowerCase()) continue
    const st = await statusOf(other)
    if (st === 'running' || st === 'starting') {
      return { ok: false, error: `拒绝启动:数据目录 ${showDataDir(absData)} 已被实例 ${other.name} 使用(同目录双实例会写坏会话)` }
    }
  }
  mkdirSync(absData, { recursive: true })
  const args = []
  if (inst.profile === 'web') {
    args.push('web')
    if (inst.port > 0) args.push('--port', String(inst.port))
  } else {
    if (!inst.task) return { ok: false, error: 'headless 实例缺少任务字符串(task)' }
    args.push('--profile', 'headless', inst.task)
  }
  if (Array.isArray(inst.extraArgs)) args.push(...inst.extraArgs)
  mkdirSync(instancesDir, { recursive: true })
  writeFileSync(logPath(inst.name), '', { flag: 'a' })
  const out = createWriteStream(logPath(inst.name), { flags: 'a', encoding: 'utf8' })
  const child = spawn(nodeExe, [dshBin, ...args], {
    cwd: appRoot, detached: true, windowsHide: true,
    env: buildEnv(absData, inst),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  inst.pid = child.pid
  inst.effPort = inst.port || 3080
  writeFileSync(pidPath(inst.name), String(child.pid))
  saveConfig(cfg)
  child.on('exit', () => {
    try { unlinkSync(pidPath(inst.name)) } catch { /* ignore */ }
    inst.pid = 0
    saveConfig(cfg)
  })
  child.unref()
  if (inst.profile === 'web' && !inst.port) {
    let buf = ''
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { inst.effPort = Number(m[1]); saveConfig(cfg) }
    })
  }
  let warn = ''
  if (inst.profile === 'web' && resolveDataDir(inst.dataDir).toLowerCase() === dataRoot.toLowerCase()) {
    warn = '该实例与默认实例共享数据目录,如已用 exe/dsh.cmd 启动同目录实例请勿再启动'
  }
  return {
    ok: true, pid: child.pid, port: inst.effPort,
    warn,
    message: `已启动 ${inst.name}(PID ${child.pid},${inst.profile === 'web' ? `端口 ${inst.effPort}` : 'headless'})`,
  }
}
function stopInstance(cfg, inst) {
  let stopped = false
  if (inst.pid > 0 && isPidAlive(inst.pid)) {
    try {
      const r = spawnSync('taskkill', ['/PID', String(inst.pid), '/T', '/F'], { stdio: 'ignore', shell: true })
      stopped = r.status === 0
    } catch { stopped = false }
  }
  try { unlinkSync(pidPath(inst.name)) } catch { /* ignore */ }
  inst.pid = 0
  inst.effPort = inst.port || 3080
  saveConfig(cfg)
  return { ok: true, message: stopped ? `已停止 ${inst.name}` : `实例 ${inst.name} 未在运行` }
}
function removeInstance(cfg, inst) {
  stopInstance(cfg, inst)
  cfg.instances = cfg.instances.filter((i) => i.name !== inst.name)
  saveConfig(cfg)
  return { ok: true, message: `已删除实例 ${inst.name}(数据目录保留在磁盘上)` }
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
    cwd: appRoot, encoding: 'utf8', timeout: 120000, env: buildEnv(dataRoot, { env: {} }),
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
      if (rel === 'instances' && (e.name.endsWith('.log') || e.name.endsWith('.pid'))) continue
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
function overview(cfg) {
  return {
    edition: exeEdition ? 'exe' : 'folder',
    appRoot,
    dataRoot,
    dshVersion: installedVersion(),
    nodeVersion: (() => {
      try { return spawnSync(nodeExe, ['--version'], { encoding: 'utf8' }).stdout.trim() } catch { return '?' }
    })(),
    instances: cfg.instances.length,
    dataSize: fmtSize(dirSize(dataRoot, BACKUP_EXCLUDE)),
    dataDirs: findExistingDataDirs(),
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

// ---- 入口 CLI ----
async function runCli(argv) {
  const cfg = loadConfig()
  sweepStale(cfg)
  const [cmd, name] = argv
  if (cmd === 'list') {
    for (const inst of cfg.instances) {
      const st = await statusOf(inst)
      const port = inst.profile === 'web' ? (inst.effPort || inst.port || 3080) : '-'
      console.log(`${inst.name}\t${st}\t${port}\t${inst.profile}\t${showDataDir(resolveDataDir(inst.dataDir))}`)
    }
    process.exit(0)
  } else if (cmd === 'start' && name) {
    const inst = cfg.instances.find((i) => i.name === name)
    if (!inst) { console.log(`未找到实例 ${name}`); process.exit(1) }
    const r = await startInstance(cfg, inst)
    console.log(r.ok ? r.message : `错误: ${r.error}`)
    if (r.warn) console.log(`警告: ${r.warn}`)
    process.exit(r.ok ? 0 : 1)
  } else if (cmd === 'stop' && name) {
    const inst = cfg.instances.find((i) => i.name === name)
    if (!inst) { console.log(`未找到实例 ${name}`); process.exit(1) }
    console.log(stopInstance(cfg, inst).message)
    process.exit(0)
  } else {
    console.log('用法: --cli list | start <name> | stop <name>')
    process.exit(2)
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
const NAME_RE = /^[\w\u4e00-\u9fa5-]+$/
function validateInstance(inst) {
  if (!inst.name || !NAME_RE.test(inst.name)) return '名称仅允许中文、字母、数字、下划线、连字符(不含空格/路径字符)'
  if (inst.profile !== 'web' && inst.profile !== 'headless') return 'profile 必须为 web 或 headless'
  if (inst.profile === 'web') {
    const p = Number(inst.port ?? 3080)
    if (!Number.isInteger(p) || p < 0 || p > 65535) return '端口须为 0-65535 的数字'
  }
  if (inst.profile === 'headless' && !inst.task) return 'headless 实例必须填写任务字符串'
  return null
}

function startServer() {
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
    const cfg = loadConfig()
    sweepStale(cfg)
    const p = url.pathname
    const method = req.method

    if (p === '/api/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, pid: process.pid, dsh: installedVersion() })
    }
    if (p === '/api/overview' && method === 'GET') {
      return sendJson(res, 200, overview(cfg))
    }
    if (p === '/api/data/usage' && method === 'GET') {
      return sendJson(res, 200, { rows: dataUsage() })
    }

    // ---- 实例 ----
    if (p === '/api/instances' && method === 'GET') {
      const rows = []
      for (const inst of cfg.instances) {
        rows.push({ ...inst, status: await statusOf(inst), dataDirAbs: resolveDataDir(inst.dataDir) })
      }
      return sendJson(res, 200, { instances: rows, existingDataDirs: findExistingDataDirs() })
    }
    if (p === '/api/instances' && method === 'POST') {
      const body = await readBody(req)
      const err = validateInstance(body)
      if (err) return sendJson(res, 400, { error: err })
      if (cfg.instances.some((i) => i.name === body.name)) return sendJson(res, 400, { error: '该名称已存在' })
      const inst = {
        name: body.name, dataDir: body.dataDir || `data/instances/${body.name}`,
        port: Number(body.port ?? 3080), profile: body.profile,
        task: body.task || '', extraArgs: Array.isArray(body.extraArgs) ? body.extraArgs : [],
        env: body.env || {}, note: body.note || '', pid: 0, effPort: Number(body.port ?? 3080),
      }
      cfg.instances.push(inst)
      saveConfig(cfg)
      return sendJson(res, 200, { ok: true, instance: inst })
    }
    const instMatch = p.match(/^\/api\/instances\/([^/]+)$/)
    if (instMatch) {
      const name = decodeURIComponent(instMatch[1])
      const inst = cfg.instances.find((i) => i.name === name)
      if (!inst) return sendJson(res, 404, { error: '实例不存在' })
      if (method === 'PUT') {
        const body = await readBody(req)
        const err = validateInstance(body)
        if (err) return sendJson(res, 400, { error: err })
        Object.assign(inst, {
          dataDir: body.dataDir ?? inst.dataDir, port: Number(body.port ?? inst.port ?? 3080),
          profile: body.profile ?? inst.profile, task: body.task ?? inst.task ?? '',
          extraArgs: Array.isArray(body.extraArgs) ? body.extraArgs : inst.extraArgs,
          env: body.env ?? inst.env ?? {}, note: body.note ?? inst.note ?? '',
          effPort: Number(body.port ?? inst.effPort ?? 3080),
        })
        saveConfig(cfg)
        return sendJson(res, 200, { ok: true, instance: inst })
      }
      if (method === 'DELETE') {
        return sendJson(res, 200, removeInstance(cfg, inst))
      }
    }
    const instAct = p.match(/^\/api\/instances\/([^/]+)\/(start|stop)$/)
    if (instAct && method === 'POST') {
      const name = decodeURIComponent(instAct[1])
      const inst = cfg.instances.find((i) => i.name === name)
      if (!inst) return sendJson(res, 404, { error: '实例不存在' })
      if (instAct[2] === 'start') return sendJson(res, 200, await startInstance(cfg, inst))
      return sendJson(res, 200, stopInstance(cfg, inst))
    }
    if (p === '/api/instances/log' && method === 'GET') {
      const name = url.searchParams.get('name')
      const tail = Number(url.searchParams.get('tail') || 100)
      const lp = logPath(name || '')
      if (!existsSync(lp)) return sendJson(res, 200, { lines: [] })
      const text = readFileSync(lp, 'utf8')
      const lines = text.split(/\r?\n/).filter(Boolean).slice(-tail)
      return sendJson(res, 200, { lines })
    }
    if (p === '/api/log/stream' && method === 'GET') {
      const name = url.searchParams.get('name')
      return sseLog(res, name)
    }

    // ---- 插件 ----
    if (p === '/api/plugins' && method === 'GET') {
      const profile = url.searchParams.get('profile') || 'web'
      try { return sendJson(res, 200, { plugins: listPlugins(profile) }) }
      catch (e) { return sendJson(res, 500, { error: e.message }) }
    }
    if (p === '/api/plugins' && method === 'POST') {
      const body = await readBody(req)
      const profile = body.profile || 'web'
      if (!body.name) return sendJson(res, 400, { error: '缺少插件名' })
      startOp('plugin', nodeExe, [dshBin, 'plugin', '--profile', profile, 'add', body.name], buildEnv(dataRoot, { env: {} }))
      return sendJson(res, 200, { ok: true })
    }
    if (p === '/api/plugins/remove' && method === 'POST') {
      const body = await readBody(req)
      const profile = body.profile || 'web'
      startOp('plugin', nodeExe, [dshBin, 'plugin', '--profile', profile, 'remove', body.name], buildEnv(dataRoot, { env: {} }))
      return sendJson(res, 200, { ok: true })
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
      const running = await runningInstances(cfg)
      if (running.length) return sendJson(res, 409, { error: `有实例正在运行(${running.join(', ')}),请先停止再升级(升级会重装 app\\node_modules)` })
      if (!existsSync(upgradeScript)) return sendJson(res, 500, { error: 'upgrade.mjs 不存在' })
      startOp('upgrade', nodeExe, [upgradeScript, '--yes'], buildEnv(dataRoot, { env: {} }))
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
    if (p === '/api/backups/restore' && method === 'POST') {
      const body = await readBody(req)
      const running = await runningInstances(cfg)
      if (running.length) return sendJson(res, 409, { error: `有实例正在运行(${running.join(', ')}),请先全部停止再恢复` })
      const r = restoreBackup(body.file)
      return sendJson(res, 200, { ok: true, ...r })
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
      spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${port}`], { shell: true, windowsHide: true }).unref()
      return sendJson(res, 200, { ok: true })
    }
    if (p === '/api/quick/explore' && method === 'POST') {
      const body = await readBody(req)
      const target = resolve(appRoot, body.path || 'data')
      // 白名单:只允许打开 appRoot 内的目录
      if (!target.startsWith(resolve(appRoot))) return sendJson(res, 400, { error: '路径越界' })
      spawn('explorer', [target], { windowsHide: true }).unref()
      return sendJson(res, 200, { ok: true })
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

  // SSE:实例日志 tail -f
  function sseLog(res, name) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const lp = logPath(name || '')
    let lastSize = existsSync(lp) ? statSync(lp).size : 0
    const timer = setInterval(() => {
      try {
        const size = statSync(lp).size
        if (size > lastSize) {
          const fd = readFileSync(lp, 'utf8')
          const chunk = fd.slice(lastSize)
          lastSize = size
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        } else {
          res.write(': hb\n\n')
        }
      } catch { res.write(': hb\n\n') }
    }, 1500)
    reqCleanup(res, () => clearInterval(timer))
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
    <a data-view="inst" onclick="showView('inst')">◉ 实例管理</a>
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
    <h3>实例总览</h3>
    <div id="dash-inst"></div>
    <h3>快捷操作</h3>
    <div class="row">
      <button onclick="quickDshWeb()">打开 dsh Web UI</button>
      <button class="ghost" onclick="quickExplore('data')">打开 data 目录</button>
      <button class="ghost" onclick="quickExplore('.')">打开应用目录</button>
    </div>
  </div>
  <div id="view-inst" style="display:none">
    <h2>实例管理</h2>
    <div class="row" style="margin-bottom:12px">
      <button onclick="openInstModal()">＋ 新建实例</button>
      <span class="grow"></span>
      <button class="ghost sm" onclick="refreshInstances()">刷新</button>
    </div>
    <div id="inst-msg"></div>
    <table><thead><tr><th>状态</th><th>名称</th><th>模式</th><th>端口</th><th>数据目录</th><th>备注</th><th style="width:220px">操作</th></tr></thead><tbody id="inst-tbody"></tbody></table>
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
<div id="log-drawer">
  <div class="head">
    <b id="log-title">日志</b>
    <span class="grow"></span>
    <label style="margin:0"><input type="checkbox" id="log-live" checked onchange="toggleLive()" style="width:auto"> 实时</label>
    <button class="ghost sm" onclick="closeLog()">关闭</button>
  </div>
  <pre id="log-body"></pre>
</div>
<div id="modal-bg"><div id="modal"></div></div>
<script>
var V = { instances: [], refreshTimer: null, logTimer: null, logName: null, es: null, upgrLatest: null, upgrInstalled: null }
function $(id) { return document.getElementById(id) }
function msg(el, type, text) { el.className = 'msg ' + type; el.textContent = text }
function showView(name) {
  var views = ['dash', 'inst', 'plug', 'upgr', 'data']
  views.forEach(function (v) { $('view-' + v).style.display = v === name ? '' : 'none' })
  var links = document.querySelectorAll('#sidebar nav a')
  links.forEach(function (a) { a.className = a.getAttribute('data-view') === name ? 'active' : '' })
  if (name === 'dash') refreshDash()
  if (name === 'inst') refreshInstances()
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
function statusDot(st) { return '<span class="dot ' + st + '"></span>' + ({ running: '运行中', starting: '启动中', stopped: '已停止', finished: '已结束' }[st] || st) }

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
      '<div class="card"><div class="label">data 占用</div><div class="value">' + o.dataSize + '</div><div class="sub">实例数 ' + o.instances + '</div></div>'
    var insts = await api('/instances')
    V.instances = insts.instances
    var rows = insts.instances.map(function (i) {
      return '<tr><td>' + statusDot(i.status) + '</td><td>' + i.name + '</td><td>' + i.profile + '</td><td>' + (i.profile === 'web' ? (i.effPort || i.port || 3080) : '-') + '</td><td>' + i.dataDir + '</td></tr>'
    }).join('')
    $('dash-inst').innerHTML = insts.instances.length
      ? '<table><thead><tr><th>状态</th><th>名称</th><th>模式</th><th>端口</th><th>数据目录</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<div style="color:var(--dim)">还没有实例,到「实例管理」页新建。</div>'
  } catch (e) { $('foot-info').textContent = '错误: ' + e.message }
}
async function quickDshWeb() {
  try { var o = await api('/overview'); await post('/quick/dsh-web', { port: 3080 }) }
  catch (e) { alert('打开失败: ' + e.message) }
}
async function quickExplore(p) {
  try { await post('/quick/explore', { path: p }) } catch (e) { alert('打开失败: ' + e.message) }
}

// ---- 实例 ----
async function refreshInstances() {
  try {
    var r = await api('/instances')
    V.instances = r.instances
    V.existingDirs = r.existingDataDirs
    $('inst-tbody').innerHTML = r.instances.map(function (i) {
      return '<tr><td>' + statusDot(i.status) + '</td><td>' + i.name + '</td><td>' + i.profile + '</td><td>' +
        (i.profile === 'web' ? (i.effPort || i.port || 3080) : '-') + '</td><td>' + i.dataDir + '</td><td>' + (i.note || '') + '</td><td>' +
        '<button class="sm" onclick="instStart(\\'' + i.name + '\\')">启动</button> ' +
        '<button class="sm ghost" onclick="instStop(\\'' + i.name + '\\')">停止</button> ' +
        '<button class="sm ghost" onclick="instLog(\\'' + i.name + '\\')">日志</button> ' +
        '<button class="sm ghost" onclick="openInstModal(\\'' + i.name + '\\')">编辑</button> ' +
        '<button class="sm danger" onclick="instDel(\\'' + i.name + '\\')">删除</button></td></tr>'
    }).join('') || '<tr><td colspan="7" style="color:var(--dim)">(无实例)</td></tr>'
  } catch (e) { msg($('inst-msg'), 'err', e.message) }
}
function instAct(name, act) {
  return post('/instances/' + encodeURIComponent(name) + '/' + act).then(function (r) {
    msg($('inst-msg'), r.ok ? 'ok' : 'err', r.message || r.error)
    if (r.warn) msg($('inst-msg'), 'warn', '警告: ' + r.warn)
    refreshInstances()
  }).catch(function (e) { msg($('inst-msg'), 'err', e.message) })
}
function instStart(n) { instAct(n, 'start') }
function instStop(n) { instAct(n, 'stop') }
function instDel(n) {
  if (!confirm('删除实例 ' + n + '?(数据目录保留在磁盘上)')) return
  api('/instances/' + encodeURIComponent(n), { method: 'DELETE' }).then(function (r) {
    msg($('inst-msg'), 'ok', r.message); refreshInstances()
  }).catch(function (e) { msg($('inst-msg'), 'err', e.message) })
}
function openInstModal(name) {
  var cur = name ? V.instances.find(function (i) { return i.name === name }) : null
  var dirs = (V.existingDirs || []).map(function (d) { return '<option value="' + d + '">' + d + '</option>' }).join('')
  var opts = ['web', 'headless'].map(function (p) { return '<option value="' + p + '"' + (cur && cur.profile === p || !cur && p === 'web' ? ' selected' : '') + '>' + p + '</option>' }).join('')
  $('modal').innerHTML =
    '<h3>' + (cur ? '编辑实例 ' + cur.name : '新建实例') + '</h3>' +
    (cur ? '' : '<label>名称(必填,唯一)</label><input id="f-name" value="">') +
    '<label>数据目录(DSH_HOME,相对应用目录;已有目录可下拉选择)</label>' +
    '<input id="f-data" list="f-dirs" value="' + (cur ? cur.dataDir : '') + '" placeholder="data/instances/名称">' +
    '<datalist id="f-dirs">' + dirs + '</datalist>' +
    '<label>模式</label><select id="f-profile">' + opts + '</select>' +
    '<label>端口(web 模式;0=默认 3080)</label><input id="f-port" value="' + (cur ? (cur.port || 3080) : '3080') + '">' +
    '<label>headless 任务</label><input id="f-task" value="' + (cur ? (cur.task || '') : '') + '">' +
    '<label>额外参数(空格分隔)</label><input id="f-args" value="' + (cur ? (cur.extraArgs || []).join(' ') : '') + '">' +
    '<label>实例环境变量(KEY=VALUE,逗号分隔)</label><input id="f-env" value="' + (cur && cur.env ? Object.keys(cur.env).map(function (k) { return k + '=' + cur.env[k] }).join(',') : '') + '">' +
    '<label>备注</label><input id="f-note" value="' + (cur ? (cur.note || '') : '') + '">' +
    '<div class="row" style="margin-top:16px;justify-content:flex-end">' +
    '<button class="ghost" onclick="closeModal()">取消</button>' +
    '<button onclick="saveInst(\\'' + (cur ? cur.name : '') + '\\')">保存</button></div>'
  $('modal-bg').style.display = 'flex'
}
function closeModal() { $('modal-bg').style.display = 'none' }
function saveInst(oldName) {
  var body = {
    name: oldName || $('f-name').value.trim(),
    dataDir: $('f-data').value.trim() || undefined,
    profile: $('f-profile').value,
    port: parseInt($('f-port').value || '3080', 10),
    task: $('f-task').value.trim(),
    extraArgs: $('f-args').value.trim() ? $('f-args').value.trim().split(/\\s+/) : [],
    env: parseEnv($('f-env').value),
    note: $('f-note').value.trim(),
  }
  if (!oldName && !body.name) { alert('请填写名称'); return }
  var p = oldName
    ? api('/instances/' + encodeURIComponent(oldName), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    : post('/instances', body)
  p.then(function () { closeModal(); refreshInstances(); msg($('inst-msg'), 'ok', '已保存') })
    .catch(function (e) { alert(e.message) })
}
function parseEnv(s) {
  var env = {}
  s.split(',').forEach(function (kv) {
    var i = kv.indexOf('=')
    if (i > 0) env[kv.slice(0, i).trim()] = kv.slice(i + 1).trim()
  })
  return env
}
function instLog(name) {
  V.logName = name
  $('log-title').textContent = '日志: ' + name
  $('log-drawer').style.display = 'flex'
  $('log-body').textContent = '(加载中…)'
  fetchLogTail()
  if (V.logTimer) clearInterval(V.logTimer)
  V.logTimer = setInterval(fetchLogTail, 2000)
  toggleLive()
}
async function fetchLogTail() {
  try {
    var r = await api('/instances/log?name=' + encodeURIComponent(V.logName || '') + '&tail=200')
    $('log-body').textContent = r.lines.join('\\n')
    if ($('log-live').checked) $('log-body').scrollTop = $('log-body').scrollHeight
  } catch (e) { /* ignore */ }
}
function toggleLive() {
  if (!V.logName) return
  if (V.es) { V.es.close(); V.es = null }
  if ($('log-live').checked) {
    V.es = new EventSource('/api/log/stream?name=' + encodeURIComponent(V.logName))
    V.es.onmessage = function (ev) {
      var d = JSON.parse(ev.data)
      if (typeof d === 'string' && d) {
        $('log-body').textContent += d
        $('log-body').scrollTop = $('log-body').scrollHeight
      }
    }
  }
}
function closeLog() {
  $('log-drawer').style.display = 'none'
  if (V.logTimer) clearInterval(V.logTimer)
  if (V.es) { V.es.close(); V.es = null }
  V.logName = null
}

// ---- 插件 ----
async function refreshPlugins() {
  try {
    var profile = $('plug-profile').value
    var r = await api('/plugins?profile=' + profile)
    $('plug-tbody').innerHTML = r.plugins.map(function (p) {
      return '<tr><td>' + p.name + '</td><td>' + p.version + '</td><td><button class="sm danger" onclick="pluginRemove(\\'' + p.name + '\\')">移除</button></td></tr>'
    }).join('') || '<tr><td colspan="3" style="color:var(--dim)">(无插件)</td></tr>'
  } catch (e) { msg($('plug-msg'), 'err', e.message) }
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
    if (e.message.indexOf('正在运行') >= 0) refreshInstances()
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
    $('backup-tbody').innerHTML = b.backups.map(function (x) {
      return '<tr><td>' + x.file + '</td><td>' + x.sizeText + '</td><td>' + new Date(x.time).toLocaleString() + '</td><td>' + (x.note || '') + '</td>' +
        '<td><button class="sm danger" onclick="backupRestore(\\'' + x.file + '\\')">恢复</button></td></tr>'
    }).join('') || '<tr><td colspan="5" style="color:var(--dim)">(无备份)</td></tr>'
  } catch (e) { msg($('data-msg'), 'err', e.message) }
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
  if (!confirm('恢复备份 ' + file + '?将覆盖 data\\ 下同名文件,且要求所有实例已停止。')) return
  post('/backups/restore', { file: file }).then(function (r) {
    msg($('data-msg'), 'ok', '恢复完成: ' + r.count + ' 个文件')
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
setInterval(function () {
  if (['dash', 'inst'].indexOf(document.querySelector('#sidebar nav a.active').getAttribute('data-view')) >= 0) refreshInstances()
}, 4000)
</script>
</body>
</html>`

// ---- 入口 ----
const args = process.argv.slice(2)
if (args[0] === '--cli') {
  await runCli(args.slice(1))
} else {
  startServer()
}
