import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  component: 'Pane',
  requestId: 'juggle',
  props: { title: 'Juggle break', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: {} } as never,
} as const

// The engine beneath the plugin: prompts enter, turns start and end.
function engine(on: On) {
  mock.env(on, { HOME: '/nonexistent' })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  return mock.clock(on)
}

const ended = (turnId: string, agentId?: string) =>
  ({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer', ...(agentId ? { agentId } : {}) }) as const

test('the break ends once the session waits on the user, background work or not', async ($, on) => {
  const clock = engine(on)
  const ui = await $.ui.mount({ plugin: 'juggle-break', surface: 'terminal', ...PANE })
  await $.prompt.submit({ text: 'wait 20s in the background', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'wait 20s in the background', turnId: 't1' })
  expect(await ui.find({ text: /Counting/ })).toBeDefined()

  // The turn ends with the wait still running in the background: Claude hands back to the user.
  await $.turn.complete(ended('t1'))
  await clock.advance(1000)
  expect(await ui.find({ text: /Counting/ })).toBeDefined()
  await clock.advance(1500)
  expect(await ui.find({ text: /Back to work in/ })).toBeDefined()

  // The wait's result arrives later: Claude answers it without the camera.
  await clock.advance(10_000)
  await $.prompt.submit({ text: 'done', wait: false, origin: { kind: 'task-notification' } })
  expect(await ui.find({ text: /Counting/ })).toBeUndefined()
  await ui.unmount()
})

test('a queued prompt keeps the break going into its turn', async ($, on) => {
  const clock = engine(on)
  const ui = await $.ui.mount({ plugin: 'juggle-break', surface: 'terminal', ...PANE })
  await $.prompt.submit({ text: 'first', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'first', turnId: 't1' })

  await $.turn.complete(ended('t1'))
  await $.turn.start({ text: 'second, typed while the first ran', turnId: 't2' })
  await clock.advance(5000)
  expect(await ui.find({ text: /Counting/ })).toBeDefined()

  await $.turn.complete(ended('t2'))
  await clock.advance(2500)
  expect(await ui.find({ text: /Back to work in/ })).toBeDefined()
  await ui.unmount()
})

test("a subagent's turn starting in the wait does not hold the break open", async ($, on) => {
  const clock = engine(on)
  const ui = await $.ui.mount({ plugin: 'juggle-break', surface: 'terminal', ...PANE })
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'go', turnId: 't1' })

  await $.turn.complete(ended('t1'))
  await $.turn.start({ text: '', turnId: 'a1' })
  await $.turn.complete(ended('a1', 'agent-1'))
  await clock.advance(2500)
  expect(await ui.find({ text: /Back to work in/ })).toBeDefined()
  await ui.unmount()
})
