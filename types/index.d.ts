/** off: no pane; live: the camera is counting; countdown: the turn ended, back to work soon. */
export type JugglePhase = 'off' | 'live' | 'countdown'

export type JuggleView = 'camera' | 'settings' | 'sessions'

/** One preview frame from the helper, with what it tracked (normalised coordinates). */
export type JuggleFrame = {
  jpg: string
  w: number
  h: number
  /** [x, y, size] per detected ball */
  dets: [number, number, number][]
  /** recent [x, y] points per tracked ball */
  tracks: [number, number][][]
}

/** The juggling session running now (one per prompt). */
export type JuggleLive = {
  startedAt: number
  current: number
  last: number
  sessionBest: number
  total: number
  runs: number
}

export type JuggleSessionRecord = {
  startedAt: number
  endedAt: number
  juggles: number
  best: number
  runs: number
}

export type JugglePrefs = { camera: number; overlay: boolean }

export type JuggleCamera = { index: number; name: string }

/** What is kept on disk, in ~/.juggle-break/stats.json. */
export type JuggleSaved = {
  allTimeBest: number
  sessions: JuggleSessionRecord[]
  prefs: JugglePrefs
}

declare module 'claude-code' {
  interface PluginState {
    'juggle-break': {
      phase: JugglePhase
      view: JuggleView
      frame: JuggleFrame | null
      live: JuggleLive | null
      countdown: number
      saved: JuggleSaved
      cameras: JuggleCamera[]
      error: string | null
      confirmReset: boolean
    }
  }
}
