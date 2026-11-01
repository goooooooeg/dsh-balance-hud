import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * dsh-balance-hud — Host half.
 *
 * 只做三件事：
 *  1. 通过 DSH 的 `deepseekAccount` 服务读**账号登录态**的余额（不自己拼 HTTP、不碰凭据）；
 *  2. 用与官方计费口径一致的规则算出「现在是不是峰时 / 这个时段何时结束 / 下一个切换点」；
 *  3. 把两者下发到一个同源只读路由，供页面里的 HUD 挂件轮询。
 *
 * 余额与时段都是个人数据，因此路由只接受同源 GET（并优先委托宿主的信任栅栏）。
 */

const SNAPSHOT_PATH = '/dsh-balance-hud/snapshot'
const ALERT_SOUND_PATH = '/dsh-balance-hud/alert.mp3'
const ALERT_SOUND_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'alert.mp3')
const TURN_STATE_PATH = '/dsh-balance-hud/turn-state'
// 跨窗口「任务完成」：宿主层监听所有会话的 turn/end（与当前显示哪个会话无关）
const turnState = { seq: 0, at: 0, turn: 0, sessionId: '' }
const subagentSessionIds = new Set()
const CACHE_MS = 20_000
const BALANCE_TIMEOUT_MS = 8_000
const BJ_OFFSET_MS = 8 * 3600 * 1000

// ── 峰谷时段（官方计价规则，北京时间）────────────────────────────────────────
// 高峰：周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00；
// 其余时段（含周末、调休上班的周末、法定节假日全天）一律空闲价。
const PEAK_WINDOWS = [
  [9, 12],
  [14, 18],
]
// 只列「放假」的日期；调休上班日都落在周末，按周末规则本来就是谷价。
// ⚠️ 每年 11 月国务院发布次年安排后需要在这里补下一年。
const HOLIDAY_VALLEY = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
])

function bjParts(ms) {
  const d = new Date(Number(ms) + BJ_OFFSET_MS)
  return {
    dow: d.getUTCDay(),
    hour: d.getUTCHours(),
    date: d.toISOString().slice(0, 10),
  }
}

function isPeakAt(ms) {
  const { dow, hour, date } = bjParts(ms)
  if (dow === 0 || dow === 6) return false
  if (HOLIDAY_VALLEY.has(date)) return false
  return PEAK_WINDOWS.some(([start, end]) => hour >= start && hour < end)
}

// 时段边界只可能落在北京时间的 0/9/12/14/18 点。
function edgesAround(ms, days) {
  const day0 = Math.floor((Number(ms) + 8 * 3600 * 1000) / 86400000) * 86400000 - BJ_OFFSET_MS
  const out = []
  for (let d = -days; d <= days; d += 1) {
    for (const hour of [0, 9, 12, 14, 18]) out.push(day0 + d * 86400000 + hour * 3600000)
  }
  return out.sort((a, b) => a - b)
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function bjLabel(ms) {
  const d = new Date(Number(ms) + BJ_OFFSET_MS)
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes())
}

function bjDayLabel(ms) {
  const d = new Date(Number(ms) + BJ_OFFSET_MS)
  return d.toISOString().slice(0, 10)
}

function pricingAt(atMs) {
  const now = Number.isFinite(Number(atMs)) ? Number(atMs) : Date.now()
  const peak = isPeakAt(now)
  const edges = edgesAround(now, 3)

  // 当前时段起点：状态在它这一刻翻过来的那条边界。
  let windowStartAt = null
  for (const edge of edges) {
    if (edge > now) break
    if (isPeakAt(edge) === peak && isPeakAt(edge - 1) !== peak) windowStartAt = edge
  }
  // 下一个切换点
  let nextChangeAt = null
  for (const edge of edges) {
    if (edge <= now) continue
    if (isPeakAt(edge) !== peak) {
      nextChangeAt = edge
      break
    }
  }
  if (windowStartAt === null) windowStartAt = now - 3600_000
  if (nextChangeAt === null) nextChangeAt = now + 3600_000

  const startLabel = bjLabel(windowStartAt)
  const endLabel = bjLabel(nextChangeAt)
  const crossDay = bjDayLabel(nextChangeAt) !== bjDayLabel(windowStartAt)
  const { dow, date } = bjParts(now)

  return {
    peak,
    weekend: dow === 0 || dow === 6,
    holiday: HOLIDAY_VALLEY.has(date),
    windowStartAt,
    windowEndAt: nextChangeAt,
    startLabel,
    endLabel,
    crossDay,
    nextChangeAt,
    nextIsPeak: !peak,
    nowMs: now,
  }
}

// ── 余额（账号登录态）──────────────────────────────────────────────────────
function numOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), ms)),
  ])
}

async function readAccountBalance(ctx) {
  let account = null
  try {
    account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null
  } catch (err) {
    account = null
  }
  if (!account || typeof account.getBalance !== 'function') {
    return { ok: false, code: 'NO_ACCOUNT_SERVICE', error: '当前 DSH 没有账号服务（deepseekAccount）' }
  }

  let result
  try {
    result = await withTimeout(
      account.getBalance({
        version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
        locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }),
      BALANCE_TIMEOUT_MS,
    )
  } catch (err) {
    return { ok: false, code: 'BALANCE_FAILED', error: String((err && err.message) || err).slice(0, 200) }
  }
  if (result && result.__timeout) {
    return { ok: false, code: 'BALANCE_TIMEOUT', error: '账号余额请求超时' }
  }
  if (!result) {
    return { ok: false, code: 'NOT_SIGNED_IN', error: '未登录 DeepSeek 账号' }
  }
  if (result.status !== 'ready') {
    return { ok: false, code: 'NOT_READY', error: '账号余额接口未就绪（' + String(result.status || 'unknown') + '）' }
  }

  const normal = (Array.isArray(result.value) ? result.value : []).filter((w) => w && numOrNull(w.balance) !== null)
  const bonusWallets = (Array.isArray(result.bonusWallets) ? result.bonusWallets : []).filter(
    (w) => w && numOrNull(w.balance) !== null,
  )
  const all = normal.concat(bonusWallets)
  if (all.length === 0) {
    return { ok: false, code: 'NO_WALLET', error: '账号没有可读的余额钱包' }
  }

  const currencyOf = (w) => String((w && w.currency) || 'CNY').toUpperCase()
  const nonZero = all.filter((w) => Number(w.balance) > 0)
  const pick =
    nonZero.find((w) => currencyOf(w) === 'CNY') ||
    nonZero[0] ||
    all.find((w) => currencyOf(w) === 'CNY') ||
    all[0]
  const currency = currencyOf(pick)
  const sum = (list) =>
    list
      .filter((w) => currencyOf(w) === currency)
      .reduce((acc, w) => acc + Number(w.balance), 0)

  const recharge = sum(normal)
  const bonus = sum(bonusWallets)
  return {
    ok: true,
    total: Number((recharge + bonus).toFixed(6)),
    recharge: Number(recharge.toFixed(6)),
    bonus: Number(bonus.toFixed(6)),
    currency,
    updatedAt: Date.now(),
  }
}

// ── 今日已用（余额差值记账）──────────────────────────────────────────────
// 只做一件朴素的事：当天第一次看到余额记为基准，之后每次余额**下降**就累加。
// 充值（余额上升）不抵消已用，只更新基准；跨北京日零点重置。
const LEDGER_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'balance-hud')
const LEDGER_FILE = path.join(LEDGER_DIR, 'ledger.json')

function dayKey(ms) {
  return new Date(Number(ms) + BJ_OFFSET_MS).toISOString().slice(0, 10)
}

function loadLedger() {
  try {
    const raw = fs.readFileSync(LEDGER_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    return null
  }
}

function saveLedger(ledger) {
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true })
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2))
  } catch (err) {}
}

function observeUsage(balance) {
  if (!balance || !balance.ok) return null
  const now = Date.now()
  const day = dayKey(now)
  const current = Number(balance.total)
  if (!Number.isFinite(current)) return null

  let ledger = loadLedger()
  let dirty = false
  if (!ledger || ledger.day !== day || !Number.isFinite(Number(ledger.last))) {
    ledger = { day, opening: current, last: current, used: 0, updatedAt: now }
    dirty = true
  } else {
    const drop = Number(ledger.last) - current
    if (drop > 0.000001) {
      ledger.used = Number((Number(ledger.used || 0) + drop).toFixed(6))
      dirty = true
    }
    if (Number(ledger.last) !== current) {
      ledger.last = current
      dirty = true
    }
    ledger.updatedAt = now
  }
  if (dirty) saveLedger(ledger)

  return {
    day: ledger.day,
    used: Number(Number(ledger.used || 0).toFixed(6)),
    opening: Number(ledger.opening || current),
    current,
    observedAt: ledger.updatedAt || now,
  }
}

// ── 路由 ──────────────────────────────────────────────────────────────────
function loopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0'
}

function selfRejection(req) {
  try {
    const headers = (req && req.headers) || {}
    let hostUrl = null
    try {
      hostUrl = new URL('http://' + String(headers.host || ''))
    } catch (err) {
      return 403
    }
    const site = String(headers['sec-fetch-site'] || '').toLowerCase()
    if (site === 'cross-site') return 403
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let originUrl = null
      try {
        originUrl = new URL(origin)
      } catch (err) {
        return 403
      }
      if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
    }
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return 405
    // 非回环部署（反代/局域网）：同源校验已经拦掉跨站页面，这里不再额外要求本机。
    return null
  } catch (err) {
    return 403
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

export function apply(ctx) {
  const sessionDisposers = []
  try {
    sessionDisposers.push(ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'turn/end') return
        const sid = session && session.id ? String(session.id) : ''
        if (sid && subagentSessionIds.has(sid)) return
        turnState.seq += 1
        turnState.at = Date.now()
        turnState.turn = event.data && typeof event.data.turn !== 'undefined' ? event.data.turn : turnState.turn
        turnState.sessionId = sid
      } catch (err) {}
    }))
  } catch (err) {}
  try {
    sessionDisposers.push(ctx.on('subagent/start', (info) => {
      try { if (info && info.id) subagentSessionIds.add(String(info.id)) } catch (err) {}
    }))
    sessionDisposers.push(ctx.on('subagent/end', (info) => {
      try { if (info && info.id) subagentSessionIds.delete(String(info.id)) } catch (err) {}
    }))
  } catch (err) {}
  const rootCtx = ctx
  let cache = null
  let inflight = null

  async function snapshot() {
    const pricing = pricingAt(Date.now())
    if (cache && Date.now() - cache.at < CACHE_MS) {
      return { ok: true, balance: cache.balance, pricing, usage: observeUsage(cache.balance) }
    }
    if (!inflight) {
      inflight = readAccountBalance(rootCtx)
        .then((balance) => {
          if (balance && balance.ok) cache = { at: Date.now(), balance }
          return balance
        })
        .catch((err) => ({ ok: false, code: 'FAILED', error: String((err && err.message) || err).slice(0, 200) }))
        .finally(() => {
          inflight = null
        })
    }
    const balance = await inflight
    return { ok: true, balance, pricing, usage: observeUsage(balance) }
  }

  function trusted(req) {
    const self = selfRejection(req)
    if (self !== null) return self
    try {
      const conn = rootCtx.get('connection')
      if (conn && typeof conn.requestRejection === 'function') {
        const code = conn.requestRejection(req)
        if (code !== undefined && code !== null && code !== false) {
          return typeof code === 'number' ? code : 403
        }
      }
    } catch (err) {
      // 栅栏自身出错：按拒绝处理（fail-closed）
      return 403
    }
    return null
  }

  ctx.inject(['webServer'], (sub) => {
    const dispose = sub.webServer.register({
      kind: 'exact',
      path: SNAPSHOT_PATH,
      handler: async (req, res) => {
        const rejection = trusted(req)
        if (rejection !== null) {
          try {
            res.statusCode = rejection
            res.end()
          } catch (err) {}
          return
        }
        try {
          const payload = await snapshot()
          sendJson(res, 200, payload)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 200) })
        }
      },
    })
    // 提醒音：直接从插件目录读文件，客户端用 <audio> 拉
    let soundCache = null
    let soundMtime = 0
    const disposeSound = sub.webServer.register({
      kind: 'exact',
      path: ALERT_SOUND_PATH,
      handler: async (req, res) => {
        const rejection = trusted(req)
        if (rejection !== null) {
          try {
            res.statusCode = rejection
            res.end()
          } catch (err) {}
          return
        }
        try {
          const stat = fs.statSync(ALERT_SOUND_FILE)
          if (!soundCache || stat.mtimeMs !== soundMtime) {
            soundCache = fs.readFileSync(ALERT_SOUND_FILE)
            soundMtime = stat.mtimeMs
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'audio/mpeg')
          res.setHeader('Content-Length', String(soundCache.length))
          res.setHeader('Cache-Control', 'no-cache')
          res.end(soundCache)
        } catch (err) {
          res.statusCode = 404
          res.end()
        }
      },
    })

    // 跨窗口任务完成信号：客户端轮询 seq，seq 增加即整轮任务结束
    const disposeTurnState = sub.webServer.register({
      kind: 'exact',
      path: TURN_STATE_PATH,
      handler: async (req, res) => {
        const rejection = trusted(req)
        if (rejection !== null) {
          try {
            res.statusCode = rejection
            res.end()
          } catch (err) {}
          return
        }
        sendJson(res, 200, { ok: true, seq: turnState.seq, at: turnState.at, turn: turnState.turn, sessionId: turnState.sessionId })
      },
    })

    // 表盘提示音（本地补丁）：按场景下发 4 句干声
    const VOICE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets')
    const VOICE_SOUND_FILES = ['alert-balance', 'alert-done', 'alert-peak', 'alert-valley'].map((name) => ({
      path: '/dsh-balance-hud/voice/' + name + '.mp3',
      file: path.join(VOICE_DIR, name + '.mp3'),
    }))
    const voiceCaches = new Map()
    const voiceDisposers = VOICE_SOUND_FILES.map((entry) => sub.webServer.register({
      kind: 'exact',
      path: entry.path,
      handler: async (req, res) => {
        const rejection = trusted(req)
        if (rejection !== null) {
          try {
            res.statusCode = rejection
            res.end()
          } catch (err) {}
          return
        }
        try {
          const stat = fs.statSync(entry.file)
          const cached = voiceCaches.get(entry.path)
          let bytes
          if (!cached || cached.mtime !== stat.mtimeMs) {
            bytes = fs.readFileSync(entry.file)
            voiceCaches.set(entry.path, { mtime: stat.mtimeMs, bytes })
          } else {
            bytes = cached.bytes
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'audio/mpeg')
          res.setHeader('Content-Length', String(bytes.length))
          res.setHeader('Cache-Control', 'no-cache')
          res.end(bytes)
        } catch (err) {
          res.statusCode = 404
          res.end()
        }
      },
    }))
    sub.effect(() => () => {
      try {
        dispose()
      } catch (err) {}
      try {
        disposeSound()
      } catch (err) {}
      try {
        disposeTurnState()
      } catch (err) {}
      for (const disposeVoice of voiceDisposers) {
        try {
          disposeVoice()
        } catch (err) {}
      }
    })
  })

  return () => {
    cache = null
    inflight = null
    for (const off of sessionDisposers) {
      try { off() } catch (err) {}
    }
  }
}
