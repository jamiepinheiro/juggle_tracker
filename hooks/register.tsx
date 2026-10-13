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

function python($: $) {
  return `${$.plugin.root}/.venv/bin/python`
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
  if (!(await $.fs.exists(python($)))) {
    await update($, error, () => `The camera helper is not set up. Run ${$.plugin.root}/setup.sh once.`)
    return
  }
  await update($, error, () => null)
  const { camera } = (await read($, saved)).prefs
  const stream = $.process.spawn({
    argv: [python($), `${$.plugin.root}/helper/juggle.py`, '--camera', String(camera)],
    cwd: `${$.plugin.root}/helper`,
  })
  child = stream
  void (async () => {
    let buffer = ''
    try {
      for await (const { stream: pipe, text } of stream) {
        if (mine !== generation) break
        if (pipe !== 'stdout') continue
        buffer += text
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (line && mine === generation) await onMessage($, line)
        }
      }
    } catch (err) {
      if (mine === generation) await update($, error, () => `Camera helper failed: ${String(err)}`)
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
    case 'error':
      await update($, error, () => String(msg.message))
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
    await update($, live, () => ({ startedAt: now, current: 0, last: 0, sessionBest: 0, total: 0, runs: 0 }))
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

function svgFor(f: JuggleFrame, overlay: boolean) {
  const parts = [`<image href="data:image/jpeg;base64,${f.jpg}" x="0" y="0" width="${f.w}" height="${f.h}"/>`]
  if (overlay) {
    for (const trail of f.tracks) {
      const pts = trail.map(([x, y]) => `${(x * f.w).toFixed(1)},${(y * f.h).toFixed(1)}`).join(' ')
      parts.push(`<polyline points="${pts}" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>`)
    }
    for (const [x, y, size] of f.dets) {
      parts.push(`<circle cx="${(x * f.w).toFixed(1)}" cy="${(y * f.h).toFixed(1)}" r="${Math.max(3, (size * f.h) / 2).toFixed(1)}" fill="none" stroke="#facc15" stroke-width="2"/>`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.w} ${f.h}" width="${f.w}" height="${f.h}">${parts.join('')}</svg>`
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
    if (e.turnId === undefined) void begin($).catch(() => undefined)
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

    const stat = (label: string, value: number, key: string) => (
      <Box key={key} flexDirection="column" alignItems="center" flexGrow={1}>
        <Text bold>{String(value)}</Text>
        <Text dimColor>{label}</Text>
      </Box>
    )

    const header = (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {stat('All time best', s.allTimeBest, 'best')}
        {stat('Last', l?.last ?? 0, 'last')}
        {stat('Current', l?.current ?? 0, 'current')}
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
      body = (
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
      else if (!f) body = <Text dimColor>Starting the camera…</Text>
      else if (e.surface === 'desktop') {
        const { Svg } = $.ui.resolve(e)
        body = <Svg source={svgFor(f, s.prefs.overlay)} alt="Camera view" />
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
