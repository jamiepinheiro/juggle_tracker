import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  JuggleCamera,
  JuggleFrame,
  JuggleLive,
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
const error = atom({ plugin: 'juggle-break', key: 'error' } as const, null as string | null)
const waiting = atom({ plugin: 'juggle-break', key: 'waiting' } as const, null as string | null)
const confirmReset = atom({ plugin: 'juggle-break', key: 'confirmReset' } as const, false)

// The helper child and the countdown timer belong to this load of the module; a reload ends both.
let child: AsyncGenerator<unknown, unknown> | null = null
let generation = 0
let ticker: { cancel: () => void } | null = null

type $ = EngineInterface

async function statsPath($: $) {
  const home = (await $.env.get('HOME')) ?? '~'
  return `${home}/.juggle-break/stats.json`
}

async function load($: $) {
  try {
    const text = await $.fs.read(await statsPath($))
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
    const path = await statsPath($)
    await $.process.run(['mkdir', '-p', path.slice(0, path.lastIndexOf('/'))])
    await $.fs.write(path, JSON.stringify(await read($, saved), null, 2))
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
    const path = await statsPath($)
    const dir = path.slice(0, path.lastIndexOf('/'))
    await $.process.run(['mkdir', '-p', dir])
    await $.fs.write(`${dir}/log.txt`, logLines.join('\n') + '\n')
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
    await update($, error, () => `The camera helper is not set up. Run ${$.plugin.root}/setup.sh once.`)
    return
  }
  await update($, error, () => null)
  await update($, waiting, () => null)
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
        await update($, error, () => `Camera helper failed: ${String(err)}`)
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
      await update($, waiting, () => String(msg.message))
      await log($, `helper waiting: ${String(msg.message)}`)
      return
    case 'ready':
      await update($, waiting, () => null)
      await log($, `helper ready: ${line}`)
      return
    case 'error':
      await update($, error, () => String(msg.message))
      await log($, `helper error: ${String(msg.message)}`, true)
      return
  }
}

function cancelCountdown() {
  ticker?.cancel()
  ticker = null
}

async function begin($: $) {
  cancelCountdown()
  if ((await read($, phase)) !== 'live') {
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
const ACCENT_LIGHT = '#E2531C'
const FONT = `font-family="ui-rounded, 'SF Pro Rounded', system-ui, sans-serif"`
const NUM = `${FONT} font-weight="800" style="font-variant-numeric: tabular-nums"`
const THEMED = `<style>.fg{fill:#f5f5f7}.dim{fill:#98989f}.acc{fill:${ACCENT}}
@media (prefers-color-scheme: light){.fg{fill:#1c1c1e}.dim{fill:#6e6e73}.acc{fill:${ACCENT_LIGHT}}}</style>`
const SHADOW = '<filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="3" flood-color="#000" flood-opacity="0.6"/></filter>'

function esc(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The score row: big numbers over small labels, the live count in the accent. */
function scoresSvg(stats: { label: string; value: number; accent?: boolean }[]) {
  const W = 600
  const H = 96
  const col = W / stats.length
  const cells = stats.map(({ label, value, accent }, i) => {
    const x = (col * (i + 0.5)).toFixed(0)
    return `<text x="${x}" y="58" text-anchor="middle" font-size="58" ${NUM} class="${accent ? 'acc' : 'fg'}">${value}</text>` +
      `<text x="${x}" y="86" text-anchor="middle" font-size="17" ${FONT} font-weight="600" class="dim">${esc(label)}</text>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${THEMED}${cells.join('')}</svg>`
}

/** One camera frame with the session drawn over it, as the iOS live view does. */
function frameSvg(f: JuggleFrame, l: JuggleLive | null, overlay: boolean, now: number) {
  const { w, h } = f
  const parts = [`<image href="data:image/jpeg;base64,${f.jpg}" x="0" y="0" width="${w}" height="${h}"/>`]
  if (overlay) {
    for (const trail of f.tracks) {
      if (trail.length === 0) continue
      const pts = trail.map(([x, y]) => `${(x * w).toFixed(1)},${(y * h).toFixed(1)}`).join(' ')
      parts.push(`<polyline points="${pts}" fill="none" stroke="${ACCENT}" stroke-opacity="0.8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`)
      const [x, y] = trail[trail.length - 1]
      parts.push(`<circle cx="${(x * w).toFixed(1)}" cy="${(y * h).toFixed(1)}" r="${Math.max(6, h * 0.035).toFixed(1)}" fill="none" stroke="${ACCENT}" stroke-width="2"/>`)
    }
    for (const [x, y, size] of f.dets) {
      parts.push(`<circle cx="${(x * w).toFixed(1)}" cy="${(y * h).toFixed(1)}" r="${Math.max(3, (size * h) / 2).toFixed(1)}" fill="none" stroke="#fff" stroke-opacity="0.8" stroke-width="1.2"/>`)
    }
  }
  if (l) {
    // Top left: time, runs, best, throws on a translucent chip.
    const line2 = `${l.runs} runs · best ${l.sessionBest} · ${l.total} throws`
    const chipW = Math.min(w - 16, 26 + line2.length * 6.3)
    parts.push(`<rect x="8" y="8" width="${chipW.toFixed(0)}" height="44" rx="7" fill="#000" fill-opacity="0.45"/>`,
      `<text x="17" y="27" font-size="14" ${NUM} fill="#fff">${clock(now - l.startedAt)}</text>`,
      `<text x="17" y="44" font-size="12" ${FONT} font-weight="500" fill="#fff">${esc(line2)}</text>`)

    // Bottom middle: the run being juggled, huge, with a caption; the last run under it between runs.
    const n = l.current
    const caption = n > 0 ? (l.bestBefore > 0 && n > l.bestBefore ? 'New personal best' : 'this run') : 'Start throwing'
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

/** The end of a session: the seconds left, big, then the session's numbers. */
function countdownSvg(left: number, s: JuggleSaved, l: JuggleLive | null, now: number) {
  const W = 600
  const H = 300
  const stat = (x: number, value: number, label: string, accent = false) =>
    `<text x="${x}" y="236" text-anchor="middle" font-size="52" ${NUM} class="${accent ? 'acc' : 'fg'}">${value}</text>` +
    `<text x="${x}" y="264" text-anchor="middle" font-size="16" ${FONT} font-weight="600" class="dim">${label}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${THEMED}` +
    `<text x="300" y="34" text-anchor="middle" font-size="22" ${FONT} font-weight="600" class="fg">Returning to work in</text>` +
    `<text x="300" y="150" text-anchor="middle" font-size="120" ${NUM} class="acc">${left}</text>` +
    stat(100, l?.sessionBest ?? 0, 'Session best', true) +
    stat(300, l?.total ?? 0, 'Juggles') +
    stat(500, s.allTimeBest, 'All time best') +
    `<text x="300" y="292" text-anchor="middle" font-size="15" ${FONT} class="dim">${l?.runs ?? 0} runs · ${minutes(l ? now - l.startedAt : 0)}</text></svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await load($)
    void listCameras($)
    await $.command.register({ name: 'juggle', description: 'Open the juggle break pane' })
    return started
  })

  on('command.run', { command: 'juggle' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Juggle break pane opened. It starts counting with your next prompt.' }
  })

  // A prompt starts a juggling session; one folded into a running turn changes nothing.
  on('prompt.submit', async ($, e, next) => {
    await log($, `prompt.submit (turnId ${e.turnId ?? 'none'})`)
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
    const p = await read($, phase)
    const v = await read($, view)
    const s = await read($, saved)
    const l = await read($, live)
    const err = await read($, error)
    const wait = await read($, waiting)

    const stat = (label: string, value: number, key: string) => (
      <Box key={key} flexDirection="column" alignItems="center" flexGrow={1}>
        <Text bold>{String(value)}</Text>
        <Text dimColor>{label}</Text>
      </Box>
    )

    const drawn = e.surface === 'desktop' || e.surface === 'mobile'
    const Svg = drawn ? $.ui.resolve(e).Svg : null
    const current = l?.current ?? 0
    const scores = Svg ? (
      <Box key="scores" flexGrow={1}>
        <Svg
          source={scoresSvg([
            { label: 'All time best', value: s.allTimeBest },
            { label: 'Last', value: l?.last ?? 0 },
            { label: 'Current', value: current, accent: current > 0 },
          ])}
          alt={`All time best ${s.allTimeBest}, last ${l?.last ?? 0}, current ${current}`}
        />
      </Box>
    ) : (
      [stat('All time best', s.allTimeBest, 'best'), stat('Last', l?.last ?? 0, 'last'), stat('Current', current, 'current')]
    )
    const header = (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {scores}
        <Button key="cog" plain label="⚙" onPress={() => void update($, view, cur => (cur === 'camera' ? 'settings' : 'camera'))} />
      </Box>
    )

    let body
    if (v === 'settings' || v === 'sessions') {
      const tabs = (
        <Box flexDirection="row" gap={1}>
          <Button key="tab-settings" variant={v === 'settings' ? 'primary' : 'secondary'} label="Settings" onPress={() => void update($, view, () => 'settings')} />
          <Button key="tab-sessions" variant={v === 'sessions' ? 'primary' : 'secondary'} label="Sessions" onPress={() => void update($, view, () => 'sessions')} />
          <Button key="done" label="Done" onPress={() => void update($, view, () => 'camera')} />
        </Box>
      )
      if (v === 'settings') {
        const cams = await read($, cameras)
        const asking = await read($, confirmReset)
        const options = (cams.length ? cams : [{ index: 0, name: 'Default camera' }]).map(c => ({
          value: String(c.index),
          label: c.name,
        }))
        const Select = e.surface === 'mobile' ? null : $.ui.resolve(e).Select
        body = (
          <Box flexDirection="column" gap={1}>
            {tabs}
            {Select ? (
              <Select
                key="camera"
                label="Camera"
                options={options}
                value={String(s.prefs.camera)}
                onSelect={value =>
                  void (async () => {
                    await update($, saved, cur => ({ ...cur, prefs: { ...cur.prefs, camera: Number(value) } }))
                    await persist($)
                    if ((await read($, phase)) === 'live') await startHelper($)
                  })()
                }
              />
            ) : (
              <Text dimColor>Camera {String(s.prefs.camera)}</Text>
            )}
            <Button
              key="overlay"
              label={`Overlay tracking data: ${s.prefs.overlay ? 'On' : 'Off'}`}
              onPress={() =>
                void (async () => {
                  await update($, saved, cur => ({ ...cur, prefs: { ...cur.prefs, overlay: !cur.prefs.overlay } }))
                  await persist($)
                })()
              }
            />
            {asking ? (
              <Box flexDirection="column">
                <Text>Reset your all-time best and session history?</Text>
                <Box flexDirection="row" gap={1}>
                  <Button key="reset-yes" variant="primary" label="Yes, reset" onPress={() => void resetScores($)} />
                  <Button key="reset-no" label="Cancel" onPress={() => void update($, confirmReset, () => false)} />
                </Box>
              </Box>
            ) : (
              <Button key="reset" label="Reset score" onPress={() => void update($, confirmReset, () => true)} />
            )}
          </Box>
        )
      } else {
        const total = s.sessions.reduce((n, x) => n + x.juggles, 0)
        body = (
          <Box flexDirection="column" gap={1}>
            {tabs}
            <Text dimColor>
              {`${s.sessions.length} sessions · ${total} juggles in all · best run ${s.allTimeBest}`}
            </Text>
            {s.sessions.length === 0 && <Text dimColor>No sessions yet.</Text>}
            <Box flexDirection="column">
              {s.sessions.slice(0, 50).map((x, i) => (
                <Text key={`s${i}`}>
                  {`${when(x.startedAt)}  ${x.juggles} juggles · best ${x.best} · ${x.runs} runs · ${minutes(x.endedAt - x.startedAt)}`}
                </Text>
              ))}
            </Box>
          </Box>
        )
      }
    } else if (p === 'countdown') {
      const left = await read($, countdown)
      body = Svg ? (
        <Svg source={countdownSvg(left, s, l, Date.now())} alt={`Returning to work in ${left}. Session best ${l?.sessionBest ?? 0}, ${l?.total ?? 0} juggles.`} />
      ) : (
        <Box flexDirection="column" alignItems="center" gap={1} paddingY={1}>
          <Text bold>{`Returning to work in ${left}...`}</Text>
          <Box flexDirection="column" alignItems="center">
            <Text>{`All time best: ${s.allTimeBest}`}</Text>
            <Text>{`Session best: ${l?.sessionBest ?? 0}`}</Text>
            <Text>{`Juggles this session: ${l?.total ?? 0}`}</Text>
            <Text dimColor>{`${l?.runs ?? 0} runs · ${minutes(l ? Date.now() - l.startedAt : 0)}`}</Text>
          </Box>
        </Box>
      )
    } else if (p === 'live') {
      const f = await read($, frame)
      if (err) body = <Text color="error">{err}</Text>
      else if (!f) body = <Text dimColor>{wait ?? 'Starting the camera…'}</Text>
      else if (e.surface === 'desktop' && Svg) {
        body = <Svg source={frameSvg(f, l, s.prefs.overlay, Date.now())} alt={`Camera view, ${current} this run`} />
      } else body = <Text dimColor>Counting. The camera view shows in the desktop app.</Text>
    } else {
      body = <Text dimColor>Starts counting when you send a prompt.</Text>
    }

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {body}
      </Box>
    )
  })
}
