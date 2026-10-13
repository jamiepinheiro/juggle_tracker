import { expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'juggle',
  props: { title: 'Juggle break', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: {} } as never,
} as const

test('the pane shows the scores and settings opens from the cog', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'juggle-break', surface, ...PANE })
    // The desktop draws the scores as one SVG; the terminal writes them out.
    expect(await ui.find(surface === 'desktop' ? { key: 'scores' } : { text: /All time best/ })).toBeDefined()
    expect((await ui.find({ text: /Starts counting/ }))).toBeDefined()

    await ui.press({ key: 'cog' })
    expect(await ui.find({ key: 'overlay' })).toBeDefined()
    expect((await ui.find({ key: 'overlay' }))?.text).toMatch(/On/)
    await ui.press({ key: 'overlay' })
    expect((await ui.find({ key: 'overlay' }))?.text).toMatch(/Off/)
    await ui.press({ key: 'overlay' })

    await ui.press({ key: 'reset' })
    expect(await ui.find({ key: 'reset-yes' })).toBeDefined()
    await ui.press({ key: 'reset-no' })
    expect(await ui.find({ key: 'reset' })).toBeDefined()

    await ui.press({ key: 'tab-sessions' })
    expect(await ui.find({ text: /No sessions yet/ })).toBeDefined()
    await ui.press({ key: 'done' })
    expect(await ui.find({ text: /Starts counting/ })).toBeDefined()
    await ui.unmount()
  }
})
