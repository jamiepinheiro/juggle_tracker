import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  JuggleCamera,
  JuggleFrame,
  JuggleLive,
  JuggleNotice,
  JugglePhase,
  JuggleSaved,
  JuggleView,
} from '../types'

const PANE = 'juggle'
const TITLE = 'Juggle break'
const COUNTDOWN_S = 5
const MAX_SESSIONS = 500

const EMPTY: JuggleSaved = { allTimeBest: 0, sessions: [], prefs: { camera: 0, overlay: true } }

const phase = atom({ plugin: 'juggle-break', key: 'phase' } as const, 'off' as JugglePhase)
const view = atom({ plugin: 'juggle-break', key: 'view' } as const, 'camera' as JuggleView)
const frame = atom({ plugin: 'juggle-break', key: 'frame' } as const, null as JuggleFrame | null)
const live = atom({ plugin: 'juggle-break', key: 'live' } as const, null as JuggleLive | null)
const countdown = atom({ plugin: 'juggle-break', key: 'countdown' } as const, 0)
const saved = atom({ plugin: 'juggle-break', key: 'saved' } as const, EMPTY)
const cameras = atom({ plugin: 'juggle-break', key: 'cameras' } as const, [] as JuggleCamera[])
const notice = atom({ plugin: 'juggle-break', key: 'notice' } as const, null as JuggleNotice | null)
const confirmReset = atom({ plugin: 'juggle-break', key: 'confirmReset' } as const, false)

// The helper child and the countdown timer belong to this load of the module; a reload ends both.
let child: AsyncGenerator<unknown, unknown> | null = null
let generation = 0
let ticker: { cancel: () => void } | null = null
// The cameras that sent no picture this break, so a dead one is skipped rather than retried.
const deadCameras = new Set<number>()

type $ = EngineInterface

let dirReady: Promise<string> | null = null
/** ~/.juggle-break, made on first use. */
function dataDir($: $) {
  dirReady ??= (async () => {
    const dir = `${(await $.env.get('HOME')) ?? '~'}/.juggle-break`
    await $.process.run(['mkdir', '-p', dir]).catch(() => undefined)
    return dir
  })()
  return dirReady
}

async function load($: $) {
  try {
    const text = await $.fs.read(`${await dataDir($)}/stats.json`)
    const data = JSON.parse(String(text)) as Partial<JuggleSaved>
    await update($, saved, () => ({
      allTimeBest: data.allTimeBest ?? 0,
      sessions: data.sessions ?? [],
      prefs: { ...EMPTY.prefs, ...data.prefs },
    }))
  } catch {
    // first run: nothing saved yet
  }
}

async function persist($: $) {
  try {
    await $.fs.write(`${await dataDir($)}/stats.json`, JSON.stringify(await read($, saved), null, 2))
  } catch (err) {
    $.ui.toast(`juggle-break: could not save stats (${String(err)})`)
  }
}

// Failures go to a toast and to ~/.juggle-break/log.txt (newest last), so they can be read back.
const logLines: string[] = []
async function log($: $, text: string, isError = false) {
  const now = new Date().toISOString()
  logLines.push(`${now} ${text}`)
  if (logLines.length > 200) logLines.shift()
  if (isError) $.ui.toast(`juggle-break: ${text}`)
  try {
    await $.fs.write(`${await dataDir($)}/log.txt`, logLines.join('\n') + '\n')
  } catch {
    // nowhere to write; the toast said it
  }
}

function python($: $) {
  return `${$.plugin.root}/.venv/bin/python`
}

function cameraApp($: $) {
  return `${$.plugin.root}/Juggle Break Camera.app/Contents/MacOS/launcher`
}

async function listCameras($: $) {
  try {
    const { stdout } = await $.process.run([python($), `${$.plugin.root}/helper/juggle.py`, '--list'], {
      cwd: `${$.plugin.root}/helper`,
    })
    const msg = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { cameras?: JuggleCamera[] }
    if (msg.cameras) await update($, cameras, () => msg.cameras ?? [])
  } catch {
    // the helper is not set up yet; start() says so
  }
}

async function stopHelper() {
  generation++
  const running = child
  child = null
  if (running) await running.return(undefined).catch(() => undefined)
}

async function startHelper($: $) {
  await stopHelper()
  const mine = generation
  if (!(await $.fs.exists(python($))) || !(await $.fs.exists(cameraApp($)))) {
    await update($, notice, () => ({ text: `The camera helper is not set up. Run ${$.plugin.root}/setup.sh once.`, isError: true }))
    return
  }
  await update($, notice, () => null)
  const { camera } = (await read($, saved)).prefs
  await log($, `starting helper: camera ${camera}, root ${$.plugin.root}`)
  const stream = $.process.spawn({
    // Runs inside Juggle Break Camera.app, the app macOS asks about and grants the camera to.
    argv: ['/bin/sh', `${$.plugin.root}/helper/launch.sh`, '--camera', String(camera)],
    cwd: `${$.plugin.root}/helper`,
  })
  child = stream
  void (async () => {
    let buffer = ''
    try {
      for await (const { stream: pipe, text } of stream) {
        if (mine !== generation) break
        if (pipe !== 'stdout') {
          await log($, `helper stderr: ${text.trim().slice(0, 500)}`)
          continue
        }
        buffer += text
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (line && mine === generation) await onMessage($, line)
        }
      }
      if (mine === generation) await log($, 'helper exited')
    } catch (err) {
      if (mine === generation) {
        await update($, notice, () => ({ text: `Camera helper failed: ${String(err)}`, isError: true }))
        await log($, `helper failed: ${String(err)}`, true)
      }
    }
  })()
}

async function onMessage($: $, line: string) {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  switch (msg.type) {
    case 'frame': {
      const { jpg, w, h, dets, tracks } = msg as unknown as JuggleFrame
      await update($, frame, () => ({ jpg, w, h, dets, tracks }))
      return
    }
    case 'throw': {
      const run = Number(msg.run)
      await update($, live, l => l && { ...l, current: run, total: l.total + 1, sessionBest: Math.max(l.sessionBest, run) })
      await update($, saved, s => (run > s.allTimeBest ? { ...s, allTimeBest: run } : s))
      return
    }
    case 'run_end': {
      const n = Number(msg.n)
      await update($, live, l => l && { ...l, current: 0, last: n, runs: l.runs + 1 })
      await persist($)
      return
    }
    case 'waiting':
      await update($, notice, () => ({ text: String(msg.message), isError: false }))
      return
    case 'ready':
      await update($, notice, () => null)
      await log($, `helper ready: ${line}`)
      return
    case 'error':
      if (msg.code === 'no_picture' && (await tryNextCamera($))) return
      await update($, notice, () => ({ text: String(msg.message), isError: true }))
      await log($, `helper error: ${String(msg.message)}`, true)
      return
  }
}

/** After a camera sent no picture: switch to one not yet tried this break, and keep it as the choice. */
async function tryNextCamera($: $) {
  const { camera } = (await read($, saved)).prefs
  deadCameras.add(camera)
  const all = await read($, cameras)
  const next = all.find(c => !deadCameras.has(c.index))
  if (!next) return false
  await log($, `camera ${camera} sent no picture; trying ${next.index} (${next.name})`)
  await update($, saved, cur => ({ ...cur, prefs: { ...cur.prefs, camera: next.index } }))
  await persist($)
  await startHelper($)
  await update($, notice, () => ({ text: `Camera ${camera} sent no picture. Trying ${next.name}…`, isError: false }))
  return true
}

function cancelCountdown() {
  ticker?.cancel()
  ticker = null
}

async function begin($: $) {
  cancelCountdown()
  if ((await read($, phase)) !== 'live') {
    deadCameras.clear()
    const now = await $.clock.now()
    const bestBefore = (await read($, saved)).allTimeBest
    await update($, live, () => ({ startedAt: now, bestBefore, current: 0, last: 0, sessionBest: 0, total: 0, runs: 0 }))
    await update($, frame, () => null)
    await update($, phase, () => 'live')
    await startHelper($)
  }
  await $.ui.open({ id: PANE, title: TITLE })
}

/** Ends the juggling session: camera off, session recorded, the countdown started. */
async function finish($: $, withCountdown: boolean) {
  if ((await read($, phase)) !== 'live') return
  await stopHelper()
  await update($, frame, () => null)
  const l = await read($, live)
  if (l) {
    const ended = { ...l, last: l.current > 0 ? l.current : l.last, runs: l.runs + (l.current > 0 ? 1 : 0), current: 0 }
    await update($, live, () => ended)
    const endedAt = await $.clock.now()
    await update($, saved, s => ({
      ...s,
      sessions: [
        { startedAt: l.startedAt, endedAt, juggles: l.total, best: l.sessionBest, runs: ended.runs },
        ...s.sessions,
      ].slice(0, MAX_SESSIONS),
    }))
    await persist($)
  }
  if (!withCountdown) {
    await update($, phase, () => 'off')
    return
  }
  await update($, view, () => 'camera')
  await update($, phase, () => 'countdown')
  await update($, countdown, () => COUNTDOWN_S)
  startTicker($)
}

function startTicker($: $) {
  cancelCountdown()
  ticker = $.clock.every(1000, () => {
    void (async () => {
      const left = (await read($, countdown)) - 1
      if (left > 0) {
        await update($, countdown, () => left)
        return
      }
      cancelCountdown()
      await update($, phase, () => 'off')
      await $.ui.close({ id: PANE })
    })()
  })
}

async function resetScores($: $) {
  await update($, saved, s => ({ ...s, allTimeBest: 0, sessions: [] }))
  await update($, live, l => l && { ...l, current: 0, last: 0, sessionBest: 0, total: 0, runs: 0 })
  await update($, confirmReset, () => false)
  await persist($)
}

/** "1 run", "2 runs". */
function count(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function minutes(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function when(ms: number) {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// The look of the iOS app: its orange accent, heavy rounded numerals, white text with a shadow
// over the video, and translucent black chips.
const ACCENT = '#FF7A45'
const FONT = `font-family="ui-rounded, 'SF Pro Rounded', system-ui, sans-serif"`
const NUM = `${FONT} font-weight="800" style="font-variant-numeric: tabular-nums"`
const THEMED = `<style>.fg{fill:#f5f5f7}.dim{fill:#98989f}
@media (prefers-color-scheme: light){.fg{fill:#1c1c1e}.dim{fill:#6e6e73}}</style>`
const SHADOW = '<filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="3" flood-color="#000" flood-opacity="0.6"/></filter>'

function esc(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** One camera frame with the session drawn over it, as the iOS live view does. */
function frameSvg(f: JuggleFrame, l: JuggleLive | null, overlay: boolean, now: number) {
  const { w, h } = f
  const parts = [`<image href="data:image/jpeg;base64,${f.jpg}" x="0" y="0" width="${w}" height="${h}"/>`]
  if (overlay) {
    for (const trail of f.tracks) {
      const head = trail.at(-1)
      if (!head) continue
      const pts = trail.map(([x, y]) => `${(x * w).toFixed(1)},${(y * h).toFixed(1)}`).join(' ')
      parts.push(`<polyline points="${pts}" fill="none" stroke="${ACCENT}" stroke-opacity="0.8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`)
      const [x, y] = head
      parts.push(`<circle cx="${(x * w).toFixed(1)}" cy="${(y * h).toFixed(1)}" r="${Math.max(6, h * 0.035).toFixed(1)}" fill="none" stroke="${ACCENT}" stroke-width="2"/>`)
    }
    for (const [x, y, size] of f.dets) {
      parts.push(`<circle cx="${(x * w).toFixed(1)}" cy="${(y * h).toFixed(1)}" r="${Math.max(3, (size * h) / 2).toFixed(1)}" fill="none" stroke="#fff" stroke-opacity="0.8" stroke-width="1.2"/>`)
    }
  }
  if (l) {
    // Top left: time, runs, best, throws on a translucent chip.
    const line2 = `${count(l.runs, 'run')} · best run ${l.sessionBest} · ${count(l.total, 'throw')}`
    const chipW = Math.min(w - 16, 26 + line2.length * 6.3)
    parts.push(`<rect x="8" y="8" width="${chipW.toFixed(0)}" height="44" rx="7" fill="#000" fill-opacity="0.45"/>`,
      `<text x="17" y="27" font-size="14" ${NUM} fill="#fff">${clock(now - l.startedAt)}</text>`,
      `<text x="17" y="44" font-size="12" ${FONT} font-weight="500" fill="#fff">${esc(line2)}</text>`)

    // Bottom middle: the run being juggled, huge, with a caption; the last run under it between runs.
    const n = l.current
    const caption = n > 0 ? (l.bestBefore > 0 && n > l.bestBefore ? 'New record' : 'this run') : 'Start throwing'
    const big = h * 0.4
    const lastLine = n === 0 && l.last > 0
    const base = h * (lastLine ? 0.66 : 0.8)
    const cx = (w / 2).toFixed(0)
    const g = [`<text x="${cx}" y="${base.toFixed(0)}" text-anchor="middle" font-size="${big.toFixed(0)}" ${NUM} fill="${n > 0 ? ACCENT : '#fff'}">${n}</text>`,
      `<text x="${cx}" y="${(base + h * 0.085).toFixed(0)}" text-anchor="middle" font-size="${(h * 0.062).toFixed(0)}" ${FONT} font-weight="600" fill="#fff">${caption}</text>`]
    if (lastLine) {
      g.push(`<text x="${cx}" y="${(h * 0.93).toFixed(0)}" text-anchor="middle" fill="#fff" ${FONT}>` +
        `<tspan font-size="${(h * 0.07).toFixed(0)}" font-weight="600">Last run </tspan>` +
        `<tspan font-size="${(h * 0.14).toFixed(0)}" font-weight="700" style="font-variant-numeric: tabular-nums">${l.last}</tspan></text>`)
    }
    parts.push(`<g filter="url(#sh)">${g.join('')}</g>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><defs>${SHADOW}</defs>${parts.join('')}</svg>`
}

/** The video's place before the first frame: black, with a spinner while loading, or a message. */
function screenSvg(spinner: boolean, text: string | null, isError = false) {
  const w = 360
  const h = 203
  const parts = [`<rect width="${w}" height="${h}" fill="#000"/>`]
  const cy = text && spinner ? h / 2 - 12 : h / 2
  if (spinner) {
    parts.push(`<circle cx="${w / 2}" cy="${cy}" r="14" fill="none" stroke="#fff" stroke-opacity="0.2" stroke-width="3"/>`,
      `<path d="M ${w / 2} ${cy - 14} a 14 14 0 0 1 14 14" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round">` +
      `<animateTransform attributeName="transform" type="rotate" from="0 ${w / 2} ${cy}" to="360 ${w / 2} ${cy}" dur="0.9s" repeatCount="indefinite"/></path>`)
  }
  if (text) {
    // Wrap at about 52 characters a line.
    const lines: string[] = []
    for (const word of text.split(' ')) {
      const last = lines.at(-1)
      if (last !== undefined && last.length + word.length < 52) lines[lines.length - 1] = `${last} ${word}`
      else lines.push(word)
    }
    const top = spinner ? cy + 34 : h / 2 - ((lines.length - 1) * 15) / 2 + 4
    parts.push(...lines.map((line, i) =>
      `<text x="${w / 2}" y="${top + i * 15}" text-anchor="middle" font-size="11.5" ${FONT} fill="${isError ? '#ff8a80' : '#c7c7cc'}">${esc(line)}</text>`))
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join('')}</svg>`
}

/** The end of a session: the seconds left, then the session's numbers, its best run in the middle. */
function countdownSvg(left: number, s: JuggleSaved, l: JuggleLive | null, now: number) {
  const W = 600
  const H = 300
  const stat = (x: number, value: number, label: string, size = 44) =>
    `<text x="${x}" y="236" text-anchor="middle" font-size="${size}" ${NUM} class="fg">${value}</text>` +
    `<text x="${x}" y="264" text-anchor="middle" font-size="${size > 44 ? 18 : 16}" ${FONT} font-weight="600" class="dim">${label}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${THEMED}` +
    `<text x="300" y="34" text-anchor="middle" font-size="22" ${FONT} font-weight="600" class="fg">Back to work in</text>` +
    `<text x="300" y="150" text-anchor="middle" font-size="120" ${NUM} class="fg">${left}</text>` +
    stat(110, l?.total ?? 0, 'Throws') +
    stat(300, l?.sessionBest ?? 0, 'Best run', 72) +
    stat(490, s.allTimeBest, 'Record') +
    `<text x="300" y="292" text-anchor="middle" font-size="15" ${FONT} class="dim">${count(l?.runs ?? 0, 'run')} · ${minutes(l ? now - l.startedAt : 0)} break</text></svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await load($)
    void listCameras($)
    // A reload (or restart) keeps the phase but not the helper or the timer: pick the break back up.
    const p = await read($, phase)
    if (p === 'countdown') startTicker($)
    if (p === 'live') void startHelper($).catch(err => log($, `could not restart: ${String(err)}`, true))
    await $.command.register({ name: 'juggle', description: 'Open the juggle break pane' })
    return started
  })

  on('command.run', { command: 'juggle' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Juggle break opened. Your next prompt starts the camera.' }
  })

  // A prompt starts a juggling session; one folded into a running turn changes nothing.
  on('prompt.submit', async ($, e, next) => {
    if (e.turnId === undefined) void begin($).catch(err => log($, `could not start: ${String(err)}`, true))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await finish($, true)
    return done
  })

  // Closing the pane by hand turns the camera off.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind !== 'plugin') {
      cancelCountdown()
      await finish($, false)
      await update($, phase, () => 'off')
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    cancelCountdown()
    await finish($, false)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const Svg = e.surface === 'desktop' || e.surface === 'mobile' ? $.ui.resolve(e).Svg : null
    const p = await read($, phase)
    const v = await read($, view)
    const s = await read($, saved)
    const l = await read($, live)
    const note = await read($, notice)
    const f = await read($, frame)
    const now = Date.now()

    const cog = <Button key="cog" plain label="⚙" onPress={() => void update($, view, cur => (cur === 'camera' ? 'settings' : 'camera'))} />
    const stat = (label: string, value: number, key: string) => (
      <Box key={key} flexDirection="column" alignItems="center" flexGrow={1}>
        <Text bold>{String(value)}</Text>
        <Text dimColor>{label}</Text>
      </Box>
    )
    // The scores, where no video carries them: Record, then the runs of this break.
    const scores = (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {stat('Record', s.allTimeBest, 'best')}
        {stat('Last run', l?.last ?? 0, 'last')}
        {stat('This run', l?.current ?? 0, 'current')}
        {cog}
      </Box>
    )

    if (v !== 'camera') {
      const tab = (key: JuggleView, label: string) => (
        <Button key={`tab-${key}`} variant={v === key ? 'primary' : 'secondary'} label={label} onPress={() => void update($, view, () => key)} />
      )
      const tabs = (
        <Box flexDirection="row" gap={1}>
          {tab('settings', 'Settings')}
          {tab('sessions', 'History')}
          <Button key="done" label="Done" onPress={() => void update($, view, () => 'camera')} />
        </Box>
      )
      if (v === 'sessions') {
        const total = s.sessions.reduce((n, x) => n + x.juggles, 0)
        return (
          <Box flexDirection="column" gap={1}>
            {tabs}
            <Text dimColor>{`${count(s.sessions.length, 'break')} · ${count(total, 'throw')} · record ${s.allTimeBest}`}</Text>
            {s.sessions.length === 0 && <Text dimColor>No breaks yet.</Text>}
            <Box flexDirection="column">
              {s.sessions.slice(0, 50).map((x, i) => (
                <Text key={`s${i}`}>
                  {`${when(x.startedAt)}  best run ${x.best} · ${count(x.juggles, 'throw')} · ${count(x.runs, 'run')} · ${minutes(x.endedAt - x.startedAt)}`}
                </Text>
              ))}
            </Box>
          </Box>
        )
      }
      const cams = await read($, cameras)
      const asking = await read($, confirmReset)
      const Select = e.surface === 'mobile' ? null : $.ui.resolve(e).Select
      const setPrefs = async (change: Partial<JuggleSaved['prefs']>) => {
        await update($, saved, cur => ({ ...cur, prefs: { ...cur.prefs, ...change } }))
        await persist($)
      }
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          {Select ? (
            <Select
              key="camera"
              label="Camera"
              options={(cams.length ? cams : [{ index: 0, name: 'Default camera' }]).map(c => ({ value: String(c.index), label: c.name }))}
              value={String(s.prefs.camera)}
              onSelect={value =>
                void (async () => {
                  await setPrefs({ camera: Number(value) })
                  if ((await read($, phase)) === 'live') await startHelper($)
                })()
              }
            />
          ) : (
            <Text dimColor>{`Camera ${s.prefs.camera}`}</Text>
          )}
          <Button key="overlay" label={`Show ball tracking: ${s.prefs.overlay ? 'On' : 'Off'}`} onPress={() => void setPrefs({ overlay: !s.prefs.overlay })} />
          {asking ? (
            <Box flexDirection="column">
              <Text>Clear your record and break history?</Text>
              <Box flexDirection="row" gap={1}>
                <Button key="reset-yes" variant="primary" label="Yes, clear" onPress={() => void resetScores($)} />
                <Button key="reset-no" label="Cancel" onPress={() => void update($, confirmReset, () => false)} />
              </Box>
            </Box>
          ) : (
            <Button key="reset" label="Clear record and history" onPress={() => void update($, confirmReset, () => true)} />
          )}
        </Box>
      )
    }

    if (p === 'countdown') {
      const left = await read($, countdown)
      return Svg ? (
        <Svg
          source={countdownSvg(left, s, l, now)}
          alt={`Back to work in ${left}. Best run ${l?.sessionBest ?? 0}, ${count(l?.total ?? 0, 'throw')}, record ${s.allTimeBest}.`}
        />
      ) : (
        <Box flexDirection="column" alignItems="center" gap={1} paddingY={1}>
          <Text bold>{`Back to work in ${left}…`}</Text>
          <Text bold>{`Best run: ${l?.sessionBest ?? 0}`}</Text>
          <Text>{`Throws: ${l?.total ?? 0} · Record: ${s.allTimeBest}`}</Text>
        </Box>
      )
    }

    // The desktop: the video is the scoreboard (black with a spinner until it starts); under it,
    // the record and settings.
    if (e.surface === 'desktop' && Svg) {
      const live = p === 'live'
      const screen =
        live && f && !note ? (
          <Svg source={frameSvg(f, l, s.prefs.overlay, now)} alt={`Camera view, ${l?.current ?? 0} this run`} />
        ) : note ? (
          <Svg source={screenSvg(live && !note.isError, note.text, note.isError)} alt={note.text} isInteractive={live && !note.isError} />
        ) : live ? (
          <Svg source={screenSvg(true, null)} alt="Starting the camera" isInteractive />
        ) : (
          <Svg source={screenSvg(false, 'Your next prompt starts a juggle break.')} alt="Your next prompt starts a juggle break." />
        )
      return (
        <Box flexDirection="column" gap={1}>
          {screen}
          <Box flexDirection="row" alignItems="center">
            <Box flexGrow={1}>
              <Text dimColor>{`Record ${s.allTimeBest}`}</Text>
            </Box>
            {cog}
          </Box>
        </Box>
      )
    }

    let body
    if (note) body = <Text color={note.isError ? 'error' : undefined} dimColor={!note.isError}>{note.text}</Text>
    else if (p !== 'live') body = <Text dimColor>Your next prompt starts a juggle break.</Text>
    else body = <Text dimColor>Counting. The camera view shows in the desktop app.</Text>
    return (
      <Box flexDirection="column" gap={1}>
        {scores}
        {body}
      </Box>
    )
  })
}
