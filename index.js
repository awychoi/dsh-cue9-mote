/**
 * dsh-cue9-mote — host half.
 *
 * Keeps action -> animation mapping on the Mac, listens to live DSH agent/tool
 * events, and sends the chosen animation + active-agent count to the mote over
 * the USB-Serial-JTAG bridge. Pending approvals/questions latch the display
 * across sessions until answered. No network, no reflash for mapping edits.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'cue9-mote'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, 'usb_bridge.py')
const PYTHON = process.env.CUE9_PYTHON || '/usr/local/bin/python3'
const MAPPING_PATH = join(homedir(), '.dsh', 'cue9', 'mapping.json')
const PALETTE_PATH = join(homedir(), '.dsh', 'cue9', 'palette.json')
const ACTION_HEADER = 'x-cue9-action'

const ANIMATIONS = [
  ['work', 'Frantic typing'], ['idle', 'Idle'], ['curious', 'Curious'],
  ['thinking', 'Thinking'], ['search', 'Searching'], ['read', 'Reading'],
  ['wait', 'Waiting'], ['sleep', 'Sleep'], ['wake', 'Wake'], ['approval', 'Approval'],
  ['mcq', 'Question'], ['retry', 'Retry'], ['done', 'Done'], ['offline', 'Offline'],
  ['hub', 'Hub down'],
].map(([id, label]) => ({ id, label }))

const ACTIONS = [
  { id: 'idle', label: 'Idle', map: ['idle'] },
  { id: 'session_start', label: 'Session starts', map: ['wake'] },
  { id: 'thinking', label: 'Thinking', map: ['thinking'] },
  { id: 'tool_read', label: 'Reading / inspecting', map: ['read'] },
  { id: 'tool_search', label: 'Searching the web', map: ['search'] },
  { id: 'tool_write', label: 'Writing / editing', map: ['work'] },
  { id: 'tool_exec', label: 'Running commands', map: ['work'] },
  { id: 'waiting', label: 'Waiting on a subagent', map: ['wait'] },
  { id: 'approval', label: 'Approval needed', map: ['approval'] },
  { id: 'question', label: 'Question', map: ['mcq'] },
  { id: 'done', label: 'Done', map: ['done'] },
  { id: 'error', label: 'Error', map: ['retry'] },
  { id: 'offline', label: 'No Wi-Fi / unplugged', map: ['offline'] },
  { id: 'hub_down', label: 'Hub down', map: ['hub'] },
  { id: 'sleep', label: 'Sleep', map: ['sleep'] },
]

/* Demo sequence lengths: work is the long 15 s tour, the rest are 6 s. */
const ANIMATION_SECONDS = {
  work: 15, idle: 6, curious: 6, thinking: 6, search: 6, read: 6, wait: 6,
  sleep: 6, wake: 6, approval: 6, mcq: 6, retry: 6, done: 6, offline: 6, hub: 6,
}

const VALID_ANIM = new Set(ANIMATIONS.map((a) => a.id))
const VALID_ACTION = new Set(ACTIONS.map((a) => a.id))
const CYCLE_MS = 8000
const DONE_IDLE_MS = 2500

function defaultMapping() {
  return Object.fromEntries(ACTIONS.map((a) => [a.id, [...a.map]]))
}

function normalizeMapping(input, base = defaultMapping()) {
  const out = {}
  for (const action of ACTIONS) {
    const hasKey = input !== null && typeof input === 'object'
      && Object.prototype.hasOwnProperty.call(input, action.id)
    const list = hasKey && Array.isArray(input[action.id])
      ? input[action.id]
      : (base[action.id] ?? [])
    out[action.id] = [...new Set(list.filter((id) => VALID_ANIM.has(id)))]
  }
  return out
}

function loadMapping() {
  try {
    return normalizeMapping(JSON.parse(readFileSync(MAPPING_PATH, 'utf8')), defaultMapping())
  } catch {
    return defaultMapping()
  }
}

function saveMapping(mapping) {
  mkdirSync(dirname(MAPPING_PATH), { recursive: true })
  const tmp = `${MAPPING_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(mapping, null, 2) + '\n')
  renameSync(tmp, MAPPING_PATH)
}

function loadPalette() {
  try {
    const parsed = JSON.parse(readFileSync(PALETTE_PATH, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return {}
    const out = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (VALID_ANIM.has(name) && typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) {
        out[name] = value.slice(1).toLowerCase()
      }
    }
    return out
  } catch {
    return {}
  }
}

function savePalette(palette) {
  mkdirSync(dirname(PALETTE_PATH), { recursive: true })
  const text = Object.fromEntries(Object.entries(palette).map(([name, value]) => [name, `#${value}`]))
  const tmp = `${PALETTE_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(text, null, 2) + '\n')
  renameSync(tmp, PALETTE_PATH)
}

function actionForTool(name) {
  const n = String(name ?? '')
  if (['read', 'glob', 'grep', 'read_image'].includes(n)) return 'tool_read'
  if (['web_search', 'web_fetch'].includes(n)) return 'tool_search'
  if (['write', 'edit'].includes(n)) return 'tool_write'
  if (n === 'ask_user_question') return null
  if (n === 'todo_write' || n === 'skill') return 'thinking'
  if (['bash', 'terminal_open', 'terminal_write', 'terminal_read',
       'terminal_close', 'job_output', 'job_kill'].includes(n)) return 'tool_exec'
  if (['subagent', 'subagent_fork', 'send_message', 'workflow'].includes(n)) return 'waiting'
  return 'working'
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function readJson(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

export function apply(ctx) {
  let mapping = loadMapping()
  let palette = loadPalette()
  let current = null
  let currentAnim = null
  let nextCycle = 0
  let doneTimer = null
  let cycleTimer = null
  let bridge = null
  let bridgeStopped = false
  let restartTimer = null
  let lastAgents = -1
  let lastSerial = ''
  let previewing = false
  let liveAction = 'idle'
  let activeSessionId = null
  let currentSince = Date.now()
  let liveAgents = []
  let urgentApprovals = 0
  let urgentQuestions = 0
  let urgentAnim = null
  const debug = { subagentStarts: 0, subagentEnds: 0, sessionCreated: 0, sessionDisposed: 0 }
  const queue = []
  const running = new Set()
  const agents = new Set()
  const status = { connected: false, port: null, error: null }
  const usbEnabled = process.env.CUE9_DISABLE_USB !== '1'

  const send = (line) => {
    if (bridge !== null && status.connected) {
      try { bridge.stdin.write(line + '\n'); return true } catch { /* fall through */ }
    }
    if (queue.length < 50) queue.push(line)
    return false
  }

  const payload = () => ({
    ok: true,
    mapping,
    actions: ACTIONS,
    animations: ANIMATIONS,
    current,
    currentAnim,
    previewing,
    liveAction,
    activeSessionId,
    agents: agents.size,
    keys: keyCount(),
    agentsLive: liveAgents.length,
    agentsSubagents: liveAgents.filter((a) => !a.root && a.status === 'running').length,
    liveAgents,
    cycleSeconds: CYCLE_MS / 1000,
    status: { ...status, lastSerial },
    debug: { ...debug },
  })

  /* The cat itself represents the first working agent. Keys appear only for
   * the extras: additional sessions or subagents. One running session = no keys. */
  const keyCount = () => {
    const running = liveAgents.filter((agent) => agent.status === 'running')
    return Math.max(0, running.length - 1)
  }

  const urgentKind = () => (urgentApprovals > 0 ? 'approval' : urgentQuestions > 0 ? 'question' : null)

  const urgentAnimation = (kind) => {
    const wanted = kind === 'approval' ? 'approval' : 'mcq'
    return mapping[kind]?.[0] ?? wanted
  }

  const applyUrgent = (force = false) => {
    const kind = urgentKind()
    if (kind === null) {
      if (urgentAnim === null) return
      urgentAnim = null
      trigger(liveAction || 'idle')
      return
    }
    const anim = urgentAnimation(kind)
    if (!force && urgentAnim === anim && currentAnim === anim) return
    urgentAnim = anim
    current = kind
    currentAnim = anim
    currentSince = Date.now()
    send(`ANIM ${anim}`)
  }

  const beginUrgent = (kind) => {
    if (kind === 'approval') urgentApprovals++
    else urgentQuestions++
    previewing = false
    applyUrgent()
  }

  const endUrgent = (kind) => {
    if (kind === 'approval') urgentApprovals = Math.max(0, urgentApprovals - 1)
    else urgentQuestions = Math.max(0, urgentQuestions - 1)
    applyUrgent()
  }

  const pushAgents = () => {
    const n = keyCount()
    const sent = Math.min(19, n)
    if (sent === lastAgents) return
    lastAgents = sent
    send(`AGENTS ${sent}`)
  }

  const pick = (action) => {
    const list = mapping[action] ?? []
    if (list.length === 0) {
      current = action
      currentAnim = null
      return
    }
    const anim = list[Math.floor(Math.random() * list.length)]
    if (anim !== currentAnim) currentSince = Date.now()
    current = action
    currentAnim = anim
    nextCycle = Date.now() + CYCLE_MS
    send(`ANIM ${anim}`)
  }

  const trigger = (action, sessionId) => {
    if (!VALID_ACTION.has(action)) return
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      if (activeSessionId === null) activeSessionId = sessionId
      if (sessionId !== activeSessionId) return
    }
    liveAction = action
    previewing = false
    if (urgentKind() !== null) return
    const list = mapping[action] ?? []
    if (list.length === 0) {
      current = action
      currentAnim = null
      return
    }
    if (current === action && currentAnim !== null) return
    pick(action)
    if (action === 'done') {
      if (doneTimer !== null) clearTimeout(doneTimer)
      doneTimer = setTimeout(() => {
        doneTimer = null
        if (current === 'done') trigger('idle')
      }, DONE_IDLE_MS)
    }
  }

  const preview = (action) => {
    if (!VALID_ACTION.has(action)) return false
    if (doneTimer !== null) { clearTimeout(doneTimer); doneTimer = null }
    previewing = true
    pick(action)
    return true
  }

  const resumeLive = () => {
    previewing = false
    if (urgentKind() !== null) {
      applyUrgent(true)
      return true
    }
    current = null
    currentAnim = null
    trigger(liveAction || 'idle')
    return true
  }

  const onLine = (line) => {
    lastSerial = line
    if (/^PONG\b/.test(line)) status.error = null
  }

  const sendPalette = () => {
    for (const [name, color] of Object.entries(palette)) {
      send(`COLOR ${name} ${color}`)
    }
  }

  const startBridge = () => {
    if (!usbEnabled) return
    if (bridgeStopped) return
    try {
      bridge = spawn(PYTHON, [BRIDGE, '--port', process.env.CUE9_PORT || 'auto'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      status.connected = false
      status.error = String(error)
      restartTimer = setTimeout(startBridge, 2000)
      return
    }
    const rl = createInterface({ input: bridge.stdout })
    rl.on('line', (line) => {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      if (msg.type === 'status') {
        status.connected = msg.connected === true
        status.port = msg.port ?? null
        status.error = msg.error ?? null
        if (status.connected) {
          while (queue.length > 0) {
            try { bridge.stdin.write(queue.shift() + '\n') } catch { break }
          }
          pushAgents()
          sendPalette()
          if (currentAnim !== null) send(`ANIM ${currentAnim}`)
          else trigger('idle')
        }
      } else if (msg.type === 'line') {
        onLine(String(msg.line ?? ''))
      } else if (msg.type === 'error') {
        status.error = String(msg.error ?? 'bridge error')
      }
    })
    bridge.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) status.error = text.slice(0, 300)
    })
    bridge.on('error', (error) => {
      status.connected = false
      status.error = String(error)
    })
    bridge.on('exit', () => {
      bridge = null
      status.connected = false
      if (!bridgeStopped) restartTimer = setTimeout(startBridge, 1500)
    })
  }

  const restartBridge = () => {
    if (status.connected) {
      /* Never reopen the port just to nudge it: the close/open can toggle the
       * ESP32 reset/boot lines and leave the panel black. Resend in place. */
      pushAgents()
      if (currentAnim !== null) send(`ANIM ${currentAnim}`)
      return
    }
    bridgeStopped = true
    if (restartTimer !== null) { clearTimeout(restartTimer); restartTimer = null }
    if (bridge !== null) {
      try { bridge.removeAllListeners('exit'); bridge.kill() } catch { /* ignore */ }
      bridge = null
    }
    status.connected = false
    status.error = null
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (!bridgeStopped) return
      bridgeStopped = false
      startBridge()
    }, 250)
  }

  ctx.effect(() => {
    startBridge()
    return () => {
      bridgeStopped = true
      if (restartTimer !== null) clearTimeout(restartTimer)
      if (doneTimer !== null) clearTimeout(doneTimer)
      if (bridge !== null) {
        try { bridge.kill() } catch { /* ignore */ }
      }
    }
  }, 'cue9-mote: usb bridge')

  ctx.effect(() => {
    cycleTimer = setInterval(() => {
      if (urgentKind() !== null) return
      if (current !== null && currentAnim !== null && Date.now() >= nextCycle) {
        pick(current)
      }
    }, 500)
    return () => clearInterval(cycleTimer)
  }, 'cue9-mote: animation cycles')

  /* Restart the scene when its own animation sequence ends. Durations follow
   * the demo tour (work 15 s, others 6 s), not a fixed interval. No state
   * change, no serial reconnect, no panel power cycle. */
  ctx.effect(() => {
    const id = setInterval(() => {
      if (!status.connected || previewing || urgentKind() !== null || currentAnim === null) return
      const seconds = ANIMATION_SECONDS[currentAnim] ?? 6
      if (Date.now() - currentSince >= seconds * 1000) {
        send('REFRESH')
        currentSince = Date.now()
      }
    }, 250)
    return () => clearInterval(id)
  }, 'cue9-mote: sequence refresh')

  /* Liveness for the mote: if this stops, the firmware clears remote mode to
   * hub. It is a command, not a display refresh, and is never queued. */
  ctx.effect(() => {
    const id = setInterval(() => {
      if (status.connected && bridge !== null) {
        try { bridge.stdin.write('ALIVE\n') } catch { /* bridge is going away */ }
      }
    }, 1000)
    return () => clearInterval(id)
  }, 'cue9-mote: heartbeat')

  ctx.on('agent/created', ({ agent }) => {
    trigger('session_start', agent?.session?.id)
  })
  ctx.on('agent/disposed', () => {})
  ctx.on('agent/status', () => {
    /* The 500 ms agent poll below is the status authority: it sees every
     * workspace, not just the context this listener was registered in. */
  })
  ctx.on('agent/error', ({ agent }) => trigger('error', agent?.session?.id))
  ctx.on('subagent/start', (info) => {
    debug.subagentStarts++
    trigger('waiting', info?.parent?.session?.id)
  })
  ctx.on('subagent/end', (info) => {
    debug.subagentEnds++
    trigger('working', info?.parent?.session?.id)
  })
  ctx.on('session/created', () => {
    debug.sessionCreated++
  })
  ctx.on('session/disposed', (session) => {
    debug.sessionDisposed++
    if (activeSessionId === session?.id) activeSessionId = null
  })
  ctx.on('workflow/start', (info) => trigger('working', info?.parent?.session?.id))
  ctx.on('workflow/end', (info) => trigger('done', info?.parent?.session?.id))
  ctx.on('workflow/agent-start', () => {})
  ctx.on('workflow/agent-end', () => {})
  ctx.on('tools/pre-execute', (exec, next) => {
    const action = actionForTool(exec?.name)
    if (action !== null) trigger(action, exec?.agent?.session?.id)
    return next()
  })
  ctx.on('approval/request', async (req, next) => {
    beginUrgent('approval')
    try {
      return await next()
    } finally {
      endUrgent('approval')
    }
  }, { prepend: true })

  ctx.on('user-questions/request', async (req, next) => {
    if (req?.wait?.timed === true) return next()
    beginUrgent('question')
    try {
      return await next()
    } finally {
      endUrgent('question')
    }
  }, { prepend: true })
  ctx.on('session/event', (session, event) => {
    const type = event?.type
    if (type === 'turn/start') trigger('thinking', session?.id)
    else if (type === 'turn/end') trigger('done', session?.id)
  })

  ctx.effect(() => {
    const id = setInterval(() => {
      const registry = ctx.get('agents')
      const live = typeof registry?.list === 'function' ? registry.list() : []
      liveAgents = live.map((agent) => {
        const header = agent?.session?.header
        return {
          id: agent?.id,
          status: agent?.status,
          sessionId: agent?.session?.id,
          root: header?.origin !== 'subagent',
          cwd: header?.cwd ?? null,
        }
      })
      const runningNow = live.filter((agent) => agent?.status === 'running')
      agents.clear()
      for (const agent of runningNow) {
        if (typeof agent?.id === 'string') agents.add(agent.id)
      }
      pushAgents()
      const activeAgent = activeSessionId === null
        ? undefined
        : runningNow.find((agent) => agent?.session?.id === activeSessionId)
      if (previewing) {
        /* Keep the live target current while preview holds, so Resume DSH
         * lands on idle (or the current running action), not the preview. */
        if (activeAgent === undefined) {
          if (runningNow.length > 0) {
            const chosen = runningNow[runningNow.length - 1]
            const sid = chosen?.session?.id
            if (typeof sid === 'string' && sid.length > 0) {
              activeSessionId = sid
              liveAction = 'thinking'
            }
          } else if (activeSessionId !== null) {
            activeSessionId = null
            liveAction = 'idle'
          } else {
            liveAction = 'idle'
          }
        } else if (liveAction === 'done' || liveAction === 'idle') {
          liveAction = 'thinking'
        }
        return
      }
      if (activeAgent === undefined) {
        if (runningNow.length > 0) {
          const chosen = runningNow[runningNow.length - 1]
          const sid = chosen?.session?.id
          if (typeof sid === 'string' && sid.length > 0) {
            activeSessionId = sid
            trigger('thinking', sid)
          }
        } else if (activeSessionId !== null) {
          /* A running session just stopped. Show the completion beat before
           * idle; the done timer owns the transition. */
          activeSessionId = null
          if (current !== 'done') trigger('done')
        } else if (current !== null && current !== 'idle' && current !== 'done') {
          trigger('done')
        }
        if (current === 'done' && (mapping.done?.length ?? 0) === 0) trigger('idle')
      }
    }, 500)
    return () => clearInterval(id)
  }, 'cue9-mote: all-agent poll')

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/cue9/state',
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        json(res, 200, payload())
      },
    }), 'cue9-mote: state route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/cue9/mapping',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        if (req.headers[ACTION_HEADER] !== '1') return json(res, 403, { ok: false, error: 'forbidden' })
        try {
          const body = await readJson(req)
          mapping = normalizeMapping(body?.mapping, mapping)
          saveMapping(mapping)
          const previous = current
          current = null
          currentAnim = null
          if (urgentKind() !== null) applyUrgent(true)
          else if (previous !== null) trigger(previous)
          json(res, 200, payload())
        } catch (error) {
          json(res, 400, { ok: false, error: String(error) })
        }
      },
    }), 'cue9-mote: mapping route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/cue9/preview',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        if (req.headers[ACTION_HEADER] !== '1') return json(res, 403, { ok: false, error: 'forbidden' })
        try {
          const body = await readJson(req)
          if (!preview(String(body?.action ?? ''))) return json(res, 400, { ok: false, error: 'unknown-action' })
          json(res, 200, payload())
        } catch (error) {
          json(res, 400, { ok: false, error: String(error) })
        }
      },
    }), 'cue9-mote: preview route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/cue9/live',
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        if (req.headers[ACTION_HEADER] !== '1') return json(res, 403, { ok: false, error: 'forbidden' })
        resumeLive()
        json(res, 200, payload())
      },
    }), 'cue9-mote: live route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/cue9/reconnect',
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        if (req.headers[ACTION_HEADER] !== '1') return json(res, 403, { ok: false, error: 'forbidden' })
        resumeLive()
        if (!status.connected) restartBridge()
        else pushAgents()
        json(res, 200, payload())
      },
    }), 'cue9-mote: reconnect route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/cue9/palette',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        if (req.headers[ACTION_HEADER] !== '1') return json(res, 403, { ok: false, error: 'forbidden' })
        try {
          const body = await readJson(req)
          const incoming = body?.palette
          if (incoming === null || typeof incoming !== 'object') {
            return json(res, 400, { ok: false, error: 'palette-required' })
          }
          const next = {}
          for (const [name, value] of Object.entries(incoming)) {
            if (!VALID_ANIM.has(name) || typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) continue
            next[name] = value.slice(1).toLowerCase()
          }
          palette = next
          savePalette(palette)
          sendPalette()
          json(res, 200, payload())
        } catch (error) {
          json(res, 400, { ok: false, error: String(error) })
        }
      },
    }), 'cue9-mote: palette route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/cue9/usb',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        if (req.headers[ACTION_HEADER] !== '1') return json(res, 403, { ok: false, error: 'forbidden' })
        try {
          const body = await readJson(req)
          const enabled = body?.enabled === true
          if (enabled) {
            bridgeStopped = false
            startBridge()
          } else {
            bridgeStopped = true
            if (restartTimer !== null) { clearTimeout(restartTimer); restartTimer = null }
            if (bridge !== null) {
              const proc = bridge
              try { proc.removeAllListeners('exit'); proc.kill('SIGKILL') } catch { /* ignore */ }
              bridge = null
            }
            status.connected = false
            status.error = null
          }
          json(res, 200, payload())
        } catch (error) {
          json(res, 400, { ok: false, error: String(error) })
        }
      },
    }), 'cue9-mote: usb route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/cue9/demo',
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        if (req.headers[ACTION_HEADER] !== '1') return json(res, 403, { ok: false, error: 'forbidden' })
        send('DEMO')
        previewing = false
        liveAction = 'idle'
        current = null
        currentAnim = null
        json(res, 200, payload())
      },
    }), 'cue9-mote: demo route')
  })
}
