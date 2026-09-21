// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  TabAffinityController,
  type AffinityTab,
} from '../src/background/tab-affinity.ts'

function tab(tabId: number, title = `Tab ${tabId}`): AffinityTab {
  return { tabId, windowId: 1, title, url: `https://example.com/${tabId}` }
}

describe('TabAffinityController', () => {
  it('binds the first tool target and follows metadata updates in place', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    expect(affinity.resolveTarget()).toEqual({ kind: 'initial' })

    expect(affinity.bindInitial(tab(1))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 1 } })

    affinity.observeTab(tab(1, 'Updated title'))
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1, title: 'Updated title' } })
  })

  it('fails closed on a manual switch until the matching handoff is decided', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    const handoff = affinity.snapshot()

    expect(handoff).toMatchObject({ status: 'handoff', controlled: { tabId: 1 }, active: { tabId: 2 } })
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })
    expect(affinity.decide('follow', handoff.revision - 1)).toBe(false)
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })

    expect(affinity.decide('follow', handoff.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 2 } })
  })

  it('keeps a bound session on its tab without any follow/keep decision', () => {
    // The shape the background relies on: a session that owns a tab operates it
    // while the user reads another tab, so no handoff decision is on the path.
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1), 'session-a')
    affinity.observeActive(tab(2))

    expect(affinity.resolveTarget('session-a')).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
    expect(affinity.allowsTarget(1, 'session-a')).toBe(true)
    expect(affinity.allowsTarget(2, 'session-a')).toBe(false)
    // The unbound-controller answer stays strict: no session, no decided tab.
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })
  })

  it('keeps operating the bound tab in the background after an explicit keep choice', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    const handoff = affinity.snapshot()

    expect(affinity.decide('keep', handoff.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'background', controlled: { tabId: 1 }, active: { tabId: 2 } })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })

    affinity.observeActive(tab(3))
    expect(affinity.snapshot().status).toBe('handoff')
  })

  it('stops prompting on later tab switches after keep-always', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))

    expect(affinity.decide('keep-always', affinity.snapshot().revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true, controlled: { tabId: 1 } })

    affinity.observeActive(tab(3))
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true, controlled: { tabId: 1 } })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })

    // Returning to the controlled tab and leaving again must still not prompt.
    affinity.observeActive(tab(1))
    expect(affinity.snapshot()).toMatchObject({ status: 'following', pinned: true })
    affinity.observeActive(tab(4))
    expect(affinity.snapshot().status).toBe('background')
  })

  it('drops the keep-always pin whenever the binding changes', () => {
    const followed = new TabAffinityController()
    followed.observeActive(tab(1))
    followed.bindInitial(tab(1))
    followed.observeActive(tab(2))
    followed.decide('keep-always', followed.snapshot().revision)
    followed.observeActive(tab(3))
    expect(followed.decide('follow', followed.snapshot().revision)).toBe(true)
    expect(followed.snapshot()).toMatchObject({ status: 'following', pinned: false, controlled: { tabId: 3 } })
    followed.observeActive(tab(5))
    expect(followed.snapshot().status).toBe('handoff')

    const closed = new TabAffinityController()
    closed.observeActive(tab(1))
    closed.bindInitial(tab(1))
    closed.observeActive(tab(2))
    closed.decide('keep-always', closed.snapshot().revision)
    closed.removeTab(1)
    expect(closed.snapshot()).toMatchObject({ status: 'lost', pinned: false })
  })

  it('re-raises the prompt when the pin is undone, without rebinding', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.decide('keep-always', affinity.snapshot().revision)
    affinity.observeActive(tab(3))

    const pinned = affinity.snapshot()
    expect(affinity.decide('ask-again', pinned.revision - 1)).toBe(false)
    expect(affinity.decide('ask-again', pinned.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'handoff',
      pinned: false,
      controlled: { tabId: 1 },
      active: { tabId: 3 },
    })
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })

    // Undoing a pin that is not set is a no-op rather than a state change.
    expect(affinity.decide('ask-again', affinity.snapshot().revision)).toBe(false)
  })

  it('keeps a restored pin when the tab navigated while the worker was down', () => {
    // Restart shape: the stored session snapshot carries the metadata from when
    // the session was bound, while the live tab has since navigated.
    const affinity = new TabAffinityController()
    affinity.restoreSessionTabs({ s1: tab(1, 'Title at bind time') })
    affinity.restoreControlled(tab(1, 'Title after navigating'))
    affinity.restoreFocusedSession('s1')
    expect(affinity.restorePinned()).toBe(true)
    affinity.observeActive(tab(2))
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true })

    // Same tab id, different title/url: still the binding the user pinned.
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
  })

  it('rejects a keep-always pin that has no controlled tab behind it', () => {
    const unbound = new TabAffinityController()
    unbound.observeActive(tab(1))
    expect(unbound.restorePinned()).toBe(false)
    expect(unbound.snapshot().pinned).toBe(false)

    const restored = new TabAffinityController()
    restored.restoreControlled(tab(1))
    expect(restored.restorePinned()).toBe(true)
    restored.observeActive(tab(2))
    expect(restored.snapshot()).toMatchObject({ status: 'background', pinned: true })
    expect(restored.restorePinned()).toBe(false)
  })

  it('does not silently rebind after the controlled tab closes', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.decide('keep', affinity.snapshot().revision)

    expect(affinity.removeTab(1)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'lost', controlled: null, active: { tabId: 2 } })
    expect(affinity.resolveTarget()).toEqual({ kind: 'lost' })
    expect(affinity.bindInitial(tab(2))).toBe(false)

    const lost = affinity.snapshot()
    expect(affinity.decide('follow', lost.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 2 } })
  })

  it('preserves a following tab when Chrome replaces its identity', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    const before = affinity.snapshot()

    expect(affinity.replaceTab(1, 9)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      revision: before.revision + 1,
      status: 'following',
      controlled: { tabId: 9 },
      active: { tabId: 9 },
    })
    expect(affinity.tracks(1)).toBe(false)
    expect(affinity.allowsTarget(9)).toBe(true)

    affinity.observeTab(tab(9, 'Replacement metadata'))
    expect(affinity.snapshot()).toMatchObject({
      controlled: { tabId: 9, title: 'Replacement metadata' },
      active: { tabId: 9, title: 'Replacement metadata' },
    })
  })

  it('preserves background affinity when either tracked tab is replaced', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.decide('keep', affinity.snapshot().revision)

    expect(affinity.replaceTab(1, 10)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 10 },
      active: { tabId: 2 },
    })

    expect(affinity.replaceTab(2, 20)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 10 },
      active: { tabId: 20 },
    })
    expect(affinity.allowsTarget(10)).toBe(true)
    expect(affinity.replaceTab(999, 30)).toBe(false)
  })

  it('clears the handoff if the user returns to the controlled tab', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.observeActive(tab(1, 'Tab 1 again'))

    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { title: 'Tab 1 again' } })
  })

  it('rehydrates controlled and lost states without allowing a fresh automatic bind', () => {
    const restored = new TabAffinityController()
    expect(restored.restoreControlled(tab(4))).toBe(true)
    restored.observeActive(tab(5))
    expect(restored.snapshot()).toMatchObject({ status: 'handoff', controlled: { tabId: 4 }, active: { tabId: 5 } })

    const lost = new TabAffinityController()
    expect(lost.restoreLost()).toBe(true)
    lost.observeActive(tab(5))
    expect(lost.resolveTarget()).toEqual({ kind: 'lost' })
    expect(lost.bindInitial(tab(5))).toBe(false)
  })

  it('supports independent per-session tab affinity for concurrent sessions', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    expect(affinity.bindInitial(tab(1), 'session-1')).toBe(true)

    affinity.observeActive(tab(2))
    expect(affinity.bindInitial(tab(2), 'session-2')).toBe(true)

    expect(affinity.resolveTarget('session-1')).toEqual({ kind: 'target', tab: tab(1) })
    expect(affinity.resolveTarget('session-2')).toEqual({ kind: 'target', tab: tab(2) })

    expect(affinity.allowsTarget(1, 'session-1')).toBe(true)
    expect(affinity.allowsTarget(2, 'session-1')).toBe(false)
    expect(affinity.allowsTarget(2, 'session-2')).toBe(true)
    expect(affinity.allowsTarget(1, 'session-2')).toBe(false)

    expect(affinity.hasBinding('session-1')).toBe(true)
    expect(affinity.hasBinding('session-2')).toBe(true)
    expect(affinity.hasBinding('session-nobody')).toBe(false)
    expect(affinity.hasBinding('')).toBe(false)

    const sessionMap = affinity.sessionMap()
    expect(sessionMap['session-1']).toEqual(tab(1))
    expect(sessionMap['session-2']).toEqual(tab(2))

    const restoredAffinity = new TabAffinityController()
    restoredAffinity.restoreSessionTabs(sessionMap)
    expect(restoredAffinity.resolveTarget('session-1')).toEqual({ kind: 'target', tab: tab(1) })
    expect(restoredAffinity.resolveTarget('session-2')).toEqual({ kind: 'target', tab: tab(2) })
    expect(restoredAffinity.resolveTarget('session-missing')).toEqual({ kind: 'lost' })
    expect(restoredAffinity.allowsTarget(2, 'session-missing')).toBe(false)
  })

  it('reports the session that owns the browser to a session trying to bind', () => {
    // The background refuses a competing bind off this answer, which is what
    // holds the browser to one session at a time.
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1), 'session-a')
    affinity.observeActive(tab(2))
    affinity.bindInitial(tab(2), 'session-b')

    expect(affinity.competingBinding('session-c')).toEqual({ sessionId: 'session-a', tab: tab(1) })
    expect(affinity.competingBinding('session-a')).toEqual({ sessionId: 'session-b', tab: tab(2) })
  })

  it('reports no holder once the browser is free', () => {
    const affinity = new TabAffinityController()
    affinity.bindInitial(tab(1), 'session-a')

    // The holder is asking for itself: rebinding its own tab is not a takeover.
    expect(affinity.competingBinding('session-a')).toBeUndefined()
    expect(affinity.competingBinding('  session-a  ')).toBeUndefined()
    // No session at all is not a competing one, and an anonymous call never binds.
    expect(affinity.competingBinding('')).toBeUndefined()

    affinity.unbindSession('session-a')
    expect(affinity.competingBinding('session-b')).toBeUndefined()
  })

  it('keeps one binding when a restored record names several sessions', () => {
    // A record written before bindings were exclusive can name two sessions.
    // The one the panel was showing keeps the browser; the other is released so
    // the next worker restart does not leave two sessions driving it.
    const affinity = new TabAffinityController()
    affinity.restoreSessionTabs({ 'session-a': tab(1), 'session-b': tab(2) })
    affinity.restoreFocusedSession('session-b')

    expect(affinity.dropCompetingBindings(affinity.focusedSession())).toEqual(['session-a'])
    expect(affinity.focusedSession()).toBe('session-b')
    expect(affinity.hasBinding('session-a')).toBe(false)
    expect(affinity.resolveTarget('session-b')).toMatchObject({ kind: 'target', tab: { tabId: 2 } })
    // Nothing to drop the second time: the state now matches the rule.
    expect(affinity.dropCompetingBindings(affinity.focusedSession())).toEqual([])
  })

  it('keeps the oldest binding when the caller names no keeper', () => {
    const affinity = new TabAffinityController()
    affinity.restoreSessionTabs({ 'session-a': tab(1), 'session-b': tab(2) })

    expect(affinity.dropCompetingBindings(null)).toEqual(['session-b'])
    expect(affinity.focusedSession()).toBe('session-a')
    expect(affinity.resolveTarget('session-a')).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
  })

  it('keeps the panel pointed at a bound session when the focused tab closes', () => {
    // Two sessions drive two tabs; the focused one loses its tab. Reporting no
    // focus while the other session is still operating a page is what emptied
    // the panel's operation feed, so focus has to move to a session that still
    // owns a tab.
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1), 'session-a')
    affinity.observeActive(tab(2))
    affinity.bindInitial(tab(2), 'session-b')
    expect(affinity.focusedSession()).toBe('session-a')

    expect(affinity.removeTab(1)).toBe(true)
    expect(affinity.focusedSession()).toBe('session-b')
    // The surviving session keeps its own tab: focus moving is display only.
    expect(affinity.resolveTarget('session-b')).toMatchObject({ kind: 'target', tab: { tabId: 2 } })
  })

  it('reports no focused session only once nothing is bound', () => {
    const affinity = new TabAffinityController()
    affinity.bindInitial(tab(1), 'session-a')

    expect(affinity.unbindSession('session-a')).toBe(true)
    expect(affinity.focusedSession()).toBeNull()
  })

  it('does not restore a focus that names no bound session', () => {
    // A stored focus can outlive the tab it named (closed while the worker was
    // asleep). Restoring it verbatim leaves the panel on an empty view even
    // though a restored session still holds a live tab.
    const affinity = new TabAffinityController()
    affinity.restoreSessionTabs({ 'session-a': tab(1) })
    affinity.restoreFocusedSession('session-gone')

    expect(affinity.focusedSession()).toBe('session-a')
  })

  it('lets the first session to bind take a focus left by a session that is gone', () => {
    const affinity = new TabAffinityController()
    affinity.restoreFocusedSession('session-gone')

    expect(affinity.bindInitial(tab(1), 'session-a')).toBe(true)
    expect(affinity.focusedSession()).toBe('session-a')
  })
})
