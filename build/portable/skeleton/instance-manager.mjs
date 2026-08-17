// instance-manager.mjs — DeepSeek Harness 便携版实例管理器
// 复用便携版内嵌的 node.exe 运行(.cmd 壳调用),零额外依赖。
// 交互菜单:查看 / 新建 / 编辑 / 启动 / 停止 / 删除实例。
// 也支持一次性 CLI:node instance-manager.mjs --cli list|start <name>|stop <name>
import { spawn, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, createWriteStream } from 'node:fs'
import { join, dirname, resolve, isAbsolute, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import readline from 'node:readline'

// ---- 形态与路径 ----
const scriptDir = dirname(fileURLToPath(import.meta.url))
const exeEdition = existsSync(join(scriptDir, '.extracted.ok'))
// runtime 与脚本同目录(文件夹版=便携版根;exe 版=portable\<version>\)。
// data 根:文件夹版=脚本目录,exe 版=exe 旁(portable\<version> 上两级)。
const runtimeRoot = scriptDir
const appRoot = exeEdition ? dirname(dirname(scriptDir)) : scriptDir
const dataRoot = join(appRoot, 'data')
const instancesDir = join(dataRoot, 'instances')
const configFile = join(instancesDir, 'instances.json')
const nodeExe = join(runtimeRoot, 'runtime', 'node', 'node.exe')
const dshBin = join(runtimeRoot, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

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
  return new Promise((resolve2) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 700 }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve2(/dsh|deepseek\s*harness/i.test(body)))
    })
    req.on('error', () => resolve2(false))
    req.on('timeout', () => { req.destroy(); resolve2(false) })
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
// 清理失效 pid 文件与字段(每次查看/启动前调用)
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

// ---- 启动 / 停止 ----
async function startInstance(cfg, inst) {
  if (inst.profile === 'web') {
    const port = inst.port || 0
    if (port > 0 && await webPortOpen(port)) {
      return `拒绝启动:端口 ${port} 已有 dsh 服务在运行(可能是别的实例)`
    }
  }
  // 同数据目录防并发:另一个运行中的实例已使用该 dataDir 则拒绝
  const absData = resolveDataDir(inst.dataDir)
  for (const other of cfg.instances) {
    if (other.name === inst.name) continue
    if (resolveDataDir(other.dataDir).toLowerCase() !== absData.toLowerCase()) continue
    const st = await statusOf(other)
    if (st === 'running' || st === 'starting') {
      return `拒绝启动:数据目录 ${showDataDir(absData)} 已被实例 ${other.name} 使用(同目录双实例会写坏会话)`
    }
  }
  mkdirSync(absData, { recursive: true })
  const args = []
  if (inst.profile === 'web') {
    args.push('web')
    if (inst.port > 0) args.push('--port', String(inst.port))
  } else {
    if (!inst.task) return 'headless 实例缺少任务字符串(task)'
    args.push('--profile', 'headless', inst.task)
  }
  if (Array.isArray(inst.extraArgs)) args.push(...inst.extraArgs)
  // 先确保 log 文件存在:createWriteStream 的 open 是异步的,headless 秒退时可能来不及创建
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
    // 未指定端口:dsh 默认 3080;若输出显示其它端口则跟随
    let buf = ''
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { inst.effPort = Number(m[1]); saveConfig(cfg) }
    })
  }
  return `已启动 ${inst.name}(PID ${child.pid},${inst.profile === 'web' ? `端口 ${inst.effPort}` : 'headless'}),日志:${showDataDir(join(instancesDir, inst.name + '.log'))}`
}
function stopInstance(cfg, inst) {
  let stopped = false
  if (inst.pid > 0 && isPidAlive(inst.pid)) {
    try { execSync(`taskkill /PID ${inst.pid} /T /F`, { stdio: 'ignore' }); stopped = true } catch { /* already dead */ }
  }
  try { unlinkSync(pidPath(inst.name)) } catch { /* ignore */ }
  inst.pid = 0
  inst.effPort = inst.port || 3080
  saveConfig(cfg)
  return stopped ? `已停止 ${inst.name}` : `实例 ${inst.name} 未在运行`
}
function removeInstance(cfg, inst) {
  stopInstance(cfg, inst)
  cfg.instances = cfg.instances.filter((i) => i.name !== inst.name)
  saveConfig(cfg)
  return `已删除实例 ${inst.name}(数据目录保留在磁盘上)`
}

// ---- 显示 ----
const STATUS_LABEL = { running: '●运行中', starting: '○启动中', stopped: '○已停止', finished: '●已结束' }
async function printList(cfg, rl) {
  sweepStale(cfg)
  if (cfg.instances.length === 0) {
    console.log('(还没有实例,选 2 新建)')
    return
  }
  for (const inst of cfg.instances) {
    const st = await statusOf(inst)
    const port = inst.profile === 'web' ? (inst.effPort || inst.port || 3080) : '-'
    console.log(
      `  ${inst.name.padEnd(16)} ${STATUS_LABEL[st] ?? st.padEnd(8)} 端口 ${String(port).padEnd(6)} ` +
      `${inst.profile === 'headless' ? 'headless' : 'web'.padEnd(8)} ${showDataDir(resolveDataDir(inst.dataDir))}`,
    )
    if (inst.note) console.log(`      备注:${inst.note}`)
  }
}

// ---- 输入流程(新建/编辑共用;编辑时空输入保留原值) ----
const NAME_RE = /^[\w\u4e00-\u9fa5-]+$/
async function promptInstance(rl, cfg, existing) {
  const old = existing ?? {}
  const fresh = old.name === undefined
  // 名称
  let name = null
  while (name === null) {
    const v = (await ask(rl, `实例名称${old.name ? ` [${old.name}]` : '(必填,唯一)'}: `)).trim()
    if (v === '' && old.name) { name = old.name; break }
    if (!NAME_RE.test(v)) { console.log('  名称仅允许中文、字母、数字、下划线、连字符(不含空格/路径字符)'); continue }
    if (cfg.instances.some((i) => i.name === v && i.name !== old.name)) { console.log('  该名称已存在'); continue }
    name = v
  }
  // 数据目录
  const found = findExistingDataDirs()
  let dataDir
  while (true) {
    if (found.length) console.log('  已发现的数据目录:' + found.map((d, i) => `\n    ${i + 1}. ${d}`).join(''))
    const hint = fresh ? ` [默认 data/instances/${name}]` : ` [${old.dataDir ?? 'data/instances/' + name}]`
    const v = (await ask(rl, `数据目录(DSH_HOME,${hint}): `)).trim()
    if (v === '' && old.dataDir) { dataDir = old.dataDir; break }
    if (v === '') { dataDir = `data/instances/${name}`; break }
    const idx = Number(v)
    if (/^\d+$/.test(v) && idx >= 1 && idx <= found.length) { dataDir = found[idx - 1]; break }
    dataDir = v.replace(/\\/g, '/')
    break
  }
  // 模式
  let profile
  while (true) {
    const v = (await ask(rl, `模式(web / headless) [${old.profile ?? 'web'}]: `)).trim().toLowerCase()
    if (v === '') { profile = old.profile ?? 'web'; break }
    if (v === 'web' || v === 'headless') { profile = v; break }
    console.log('  请输入 web 或 headless')
  }
  // 端口(仅 web)
  let port = old.port ?? 3080
  if (profile === 'web') {
    while (true) {
      const v = (await ask(rl, `端口(0-65535,0=使用默认 3080) [${port || 3080}]: `)).trim()
      if (v === '') break
      const n = Number(v)
      if (!/^\d+$/.test(v) || n < 0 || n > 65535) { console.log('  端口须为 0-65535 的数字'); continue }
      port = n
      break
    }
  } else {
    port = 0
  }
  // headless 任务
  let task = old.task ?? ''
  if (profile === 'headless') {
    while (true) {
      const v = (await ask(rl, `headless 任务字符串${old.task ? ` [${old.task}]` : '(必填)'}: `)).trim()
      if (v === '' && old.task) { task = old.task; break }
      if (v === '') { console.log('  headless 实例必须填写任务字符串'); continue }
      task = v
      break
    }
  }
  // 额外参数(空格分隔)
  const defArgs = old.extraArgs ? old.extraArgs.join(' ') : ''
  const vArgs = (await ask(rl, `额外 dsh 参数(空格分隔,如 --patch x.yml)[${defArgs}]: `)).trim()
  const extraArgs = vArgs === '' ? (old.extraArgs ?? []) : vArgs.split(/\s+/).filter(Boolean)
  // 环境变量(KEY=VALUE 逗号分隔)
  const defEnv = old.env ? Object.entries(old.env).map(([k, v]) => `${k}=${v}`).join(',') : ''
  const vEnv = (await ask(rl, `实例环境变量(KEY=VALUE,多个用逗号分隔)[${defEnv}]: `)).trim()
  const env = {}
  if (vEnv !== '') {
    for (const kv of vEnv.split(',')) {
      const i = kv.indexOf('=')
      if (i > 0) env[kv.slice(0, i).trim()] = kv.slice(i + 1).trim()
    }
  } else if (old.env) {
    Object.assign(env, old.env)
  }
  // 备注
  const vNote = (await ask(rl, `备注[${old.note ?? ''}]: `)).trim()
  const note = vNote === '' ? (old.note ?? '') : vNote
  return { name, dataDir, profile, port, task, extraArgs, env, note, pid: old.pid ?? 0, effPort: old.effPort ?? (port || 3080) }
}
function ask(rl, q) { return new Promise((r) => rl.question(q, r)) }

// ---- 菜单 ----
async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('')
  console.log('==== DeepSeek Harness 实例管理器 ====')
  console.log(`形态:${exeEdition ? '单文件 exe 版' : '文件夹版'}   数据根:${showDataDir(dataRoot)}`)
  while (true) {
    console.log('')
    console.log('  1. 查看实例(含运行状态)')
    console.log('  2. 新建实例')
    console.log('  3. 编辑实例')
    console.log('  4. 启动实例')
    console.log('  5. 停止实例')
    console.log('  6. 删除实例')
    console.log('  7. 退出')
    const choice = (await ask(rl, '请选择: ')).trim()
    const cfg = loadConfig()
    sweepStale(cfg)
    if (choice === '1') { await printList(cfg, rl) }
    else if (choice === '2') {
      const inst = await promptInstance(rl, cfg, undefined)
      cfg.instances.push(inst)
      saveConfig(cfg)
      console.log(`已保存实例 ${inst.name};选 4 启动`)
    }
    else if (choice === '3') {
      const name = await pickInstance(rl, cfg, '选择要编辑的实例')
      if (!name) continue
      const old = cfg.instances.find((i) => i.name === name)
      const updated = await promptInstance(rl, cfg, old)
      Object.assign(old, updated)
      saveConfig(cfg)
      console.log(`已更新实例 ${old.name}`)
    }
    else if (choice === '4') {
      const name = await pickInstance(rl, cfg, '选择要启动的实例')
      if (!name) continue
      console.log(await startInstance(cfg, cfg.instances.find((i) => i.name === name)))
    }
    else if (choice === '5') {
      const name = await pickInstance(rl, cfg, '选择要停止的实例')
      if (!name) continue
      console.log(stopInstance(cfg, cfg.instances.find((i) => i.name === name)))
    }
    else if (choice === '6') {
      const name = await pickInstance(rl, cfg, '选择要删除的实例')
      if (!name) continue
      console.log(removeInstance(cfg, cfg.instances.find((i) => i.name === name)))
    }
    else if (choice === '7') { break }
    else { console.log('无效选择') }
  }
  rl.close()
  console.log('再见')
}
async function pickInstance(rl, cfg, title) {
  if (cfg.instances.length === 0) { console.log('(还没有实例)'); return null }
  console.log(title + ':')
  cfg.instances.forEach((i, n) => console.log(`  ${n + 1}. ${i.name}`))
  const v = (await ask(rl, '输入序号或名称: ')).trim()
  const idx = Number(v)
  if (/^\d+$/.test(v) && idx >= 1 && idx <= cfg.instances.length) return cfg.instances[idx - 1].name
  if (cfg.instances.some((i) => i.name === v)) return v
  console.log('未找到该实例')
  return null
}

// ---- CLI 一次性模式 ----
async function runCli(argv) {
  const cfg = loadConfig()
  sweepStale(cfg)
  const [cmd, name] = argv
  if (cmd === 'list') {
    await printList(cfg, null)
  } else if (cmd === 'start' && name) {
    const inst = cfg.instances.find((i) => i.name === name)
    if (!inst) { console.log(`未找到实例 ${name}`); process.exitCode = 1 }
    else console.log(await startInstance(cfg, inst))
  } else if (cmd === 'stop' && name) {
    const inst = cfg.instances.find((i) => i.name === name)
    if (!inst) { console.log(`未找到实例 ${name}`); process.exitCode = 1 }
    else console.log(stopInstance(cfg, inst))
  } else {
    console.log('用法: --cli list | start <name> | stop <name>')
  }
  process.exit(process.exitCode ?? 0)
}

// ---- 入口 ----
const args = process.argv.slice(2)
if (args[0] === '--cli') {
  await runCli(args.slice(1))
} else {
  await interactive()
}
