import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'juggle',
  props: { title: 'Juggle break', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: {} } as never,
} as const

const waiting = { id: 'b1', type: 'shell', status: 'running', description: 'Wait 20 seconds' }

// A turn that leaves work running in the background is not the end of Claude's work.
test('the break outlasts a turn that left background work running', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/nonexistent' })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('classic.Stop', async () => ({}))
  const ui = await $.ui.mount({ plugin: 'juggle-break', surface: 'terminal', ...PANE })

  await $.prompt.submit({ text: 'wait 20s', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ text: /Counting/ })).toBeDefined()

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [waiting] })
  expect(await ui.find({ text: /Counting/ })).toBeDefined()

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  expect(await ui.find({ text: /Back to work in/ })).toBeDefined()
  await ui.unmount()
})
