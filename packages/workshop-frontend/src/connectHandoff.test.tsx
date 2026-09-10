// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import {
  CONNECT_HANDOFF_ACK_MESSAGE_TYPE, CONNECT_HANDOFF_MESSAGE_TYPE,
} from '@gadgets/workshop-shared/gatekeeper'
import {
  HANDOFF_PATH, broadcastHandoffUntilAcked, handoffTabToken, openConnectWindow,
  ticketFromHandoffFragment, useConnectHandoffListener,
} from './connectHandoff'
import ConnectHandoffPage from './ConnectHandoffPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TICKET = 'a'.repeat(64)
// The token a tab holds and its popups inherit; the handoff page names it in every envelope.
const TAB = 'f00d'.repeat(8)
const HANDOFF_TAB_KEY = 'gadgets.handoffTab'
const holdTab = (token = TAB) => sessionStorage.setItem(HANDOFF_TAB_KEY, token)

function Listener({ api, onError }: { api: RpcStub<AuthenticatedApi> | null; onError: (m: string) => void }) {
  useConnectHandoffListener(api, onError)
  return null
}

// Lets a BroadcastChannel message reach its listeners.
const delivered = () => new Promise(resolve => setTimeout(resolve, 20))

// Lets the RPC promise settle and React flush.
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

// What the handoff page does: broadcast on the channel named after the message type. Delivery is
// asynchronous, so callers wait a tick before asserting.
async function broadcast(...messages: unknown[]) {
  const channel = new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
  for (const message of messages) channel.postMessage(message)
  await new Promise(resolve => setTimeout(resolve, 20))
  channel.close()
}

// What `openConnectWindow` leaves behind in this tab: the marker that makes a broadcast ticket ours,
// stamped with when the popup was opened.
const CONNECT_PENDING_KEY = 'gadgets.connectPending'
const pending = (openedAt = Date.now()) => sessionStorage.setItem(CONNECT_PENDING_KEY, String(openedAt))

// The next acknowledgement posted on the channel, as the handoff page hears it (the page's own
// broadcasts pass this receiver too, so anything but an ack is skipped).
function nextAck(): Promise<unknown> {
  const receiver = new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
  return new Promise(resolve => {
    receiver.addEventListener('message', (event: MessageEvent) => {
      if (event.data?.type !== CONNECT_HANDOFF_ACK_MESSAGE_TYPE) return
      receiver.close()
      resolve(event.data)
    })
  })
}

// A popup as window.open returns it: an opener pointing back at us, and a location to navigate.
function fakePopup() {
  return {
    opener: window as Window | null,
    location: { replace: vi.fn<(url: string) => void>() },
  }
}

describe('useConnectHandoffListener', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  const completeConnectHandoff = vi.fn<(ticket: string) => Promise<void>>()
  const onError = vi.fn<(message: string) => void>()
  const api = { completeConnectHandoff } as unknown as RpcStub<AuthenticatedApi>

  function mount() {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(<Listener api={api} onError={onError} />))
  }

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    completeConnectHandoff.mockReset()
    onError.mockReset()
    sessionStorage.clear()
  })

  it("redeems a ticket the gatekeeper's page broadcast on the same-origin channel", async () => {
    // The gatekeeper's completion page on our origin names no tab: its ticket was embedded
    // server-side for a flow reached only through its single-use URL.
    completeConnectHandoff.mockResolvedValue(undefined)
    pending()
    mount()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()

    expect(completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(TICKET)
    expect(onError).not.toHaveBeenCalled()
  })

  it('ignores a broadcast ticket when this tab opened no connect', async () => {
    // Every Workshop tab on the origin hears the channel; only the one that opened the popup redeems,
    // so the others neither race it nor toast that the attempt expired.
    mount()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()

    expect(completeConnectHandoff).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('spends the marker on a successful broadcast redemption and acknowledges it', async () => {
    completeConnectHandoff.mockResolvedValue(undefined)
    vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window)
    const before = Date.now()
    mount()
    openConnectWindow('https://gk.example/connect')
    expect(Number(sessionStorage.getItem(CONNECT_PENDING_KEY))).toBeGreaterThanOrEqual(before)

    const heard = nextAck()
    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()
    expect(completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(TICKET)
    // Spent: a later broadcast is not this tab's. The ack is what stops the page repeating.
    expect(sessionStorage.getItem(CONNECT_PENDING_KEY)).toBeNull()
    expect(await heard).toEqual({ type: CONNECT_HANDOFF_ACK_MESSAGE_TYPE, ticket: TICKET })
    expect(onError).not.toHaveBeenCalled()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: 'b'.repeat(64) })
    await settle()
    expect(completeConnectHandoff).toHaveBeenCalledOnce()
  })

  it('reports a rejected broadcast ticket, keeps the marker, and tries each ticket once', async () => {
    // A sibling tab's or a sign-in ticket heard first is rejected by the server; that must not
    // cost this tab its own ticket, which is still on its way. The page repeats its broadcast until
    // acked, so a ticket already tried is ignored rather than toasted again.
    completeConnectHandoff
      .mockRejectedValueOnce(new Error('This connection attempt has expired.'))
      .mockResolvedValueOnce(undefined)
    pending()
    mount()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()
    expect(completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(TICKET)
    expect(onError).toHaveBeenCalledExactlyOnceWith('This connection attempt has expired.')
    expect(sessionStorage.getItem(CONNECT_PENDING_KEY)).not.toBeNull()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()
    expect(completeConnectHandoff).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledOnce()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: 'b'.repeat(64) })
    await settle()
    expect(completeConnectHandoff).toHaveBeenCalledTimes(2)
    expect(completeConnectHandoff).toHaveBeenLastCalledWith('b'.repeat(64))
    expect(sessionStorage.getItem(CONNECT_PENDING_KEY)).toBeNull()
  })

  it('ignores a marker older than the connect lifetime', async () => {
    // An abandoned popup's flow can no longer complete once its connect and OAuth nonces have both
    // expired, so its marker must stop this tab racing its siblings for their tickets.
    pending(Date.now() - 31 * 60 * 1000)
    mount()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()

    expect(completeConnectHandoff).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('ignores a malformed broadcast', async () => {
    pending()
    mount()

    await broadcast(
      { type: 'gadgets.connect-handoff.v0', ticket: TICKET },
      { type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: 'not-a-ticket' },
      { type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET.toUpperCase() },
      { type: CONNECT_HANDOFF_MESSAGE_TYPE },
      'ticket',
      null,
    )
    await settle()

    expect(completeConnectHandoff).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it("redeems a handoff-page envelope naming this tab's token", async () => {
    // What /connect/handoff broadcasts from a popup this tab opened: the token the popup inherited.
    completeConnectHandoff.mockResolvedValue(undefined)
    pending()
    holdTab()
    mount()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET, tab: TAB })
    await settle()

    expect(completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(TICKET)
    expect(onError).not.toHaveBeenCalled()
  })

  it('ignores a handoff-page envelope naming another tab, or none this tab holds', async () => {
    // The handoff page broadcasts whatever ticket its URL carries. A page opened from a crafted link
    // holds no token or another tab's; taking its ticket would let whoever finished a leaked flow
    // make this tab redeem it with one click.
    pending()
    holdTab()
    mount()

    await broadcast(
      { type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET, tab: 'beef'.repeat(8) },
      { type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET, tab: '' },
      { type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET, tab: null },
      { type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET, tab: 42 },
    )
    await settle()
    expect(completeConnectHandoff).not.toHaveBeenCalled()

    // A tab holding no token at all matches nothing either.
    sessionStorage.removeItem(HANDOFF_TAB_KEY)
    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET, tab: TAB })
    await settle()
    expect(completeConnectHandoff).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('listens for nothing when given no session', async () => {
    pending()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(<Listener api={null} onError={onError} />))

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()

    expect(completeConnectHandoff).not.toHaveBeenCalled()
  })

  it('stops listening once unmounted', async () => {
    pending()
    mount()
    act(() => root?.unmount())
    root = undefined

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()

    expect(completeConnectHandoff).not.toHaveBeenCalled()
  })
})

describe('openConnectWindow', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it('always disowns the popup before navigating it', () => {
    const popup = fakePopup()
    let openerAtNavigation: Window | null | undefined
    popup.location.replace.mockImplementation(() => { openerAtNavigation = popup.opener })
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const before = Date.now()

    expect(openConnectWindow('https://gk.example/connect')).toBe(popup)
    expect(open).toHaveBeenCalledExactlyOnceWith('', 'gadgets-connect', 'popup,width=520,height=680')
    expect(open.mock.calls[0][2]).not.toContain('noopener')
    // Disowned before it is navigated, so no provider page ever sees window.opener.
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith('https://gk.example/connect')
    expect(openerAtNavigation).toBeNull()
    expect(popup.opener).toBeNull()
    expect(Number(sessionStorage.getItem(CONNECT_PENDING_KEY))).toBeGreaterThanOrEqual(before)
  })

  it('gives this tab its token before the popup is created, and keeps it', () => {
    // The popup gets a copy of sessionStorage as window.open() creates it, so the token must exist by
    // then; a popup reused by name keeps that copy, so the token must not change on a later open.
    let tokenAtOpen: string | null | undefined
    const open = vi.spyOn(window, 'open').mockImplementation(() => {
      tokenAtOpen = sessionStorage.getItem(HANDOFF_TAB_KEY)
      return fakePopup() as unknown as Window
    })
    expect(handoffTabToken()).toBeNull()

    openConnectWindow('https://gk.example/connect')
    const token = handoffTabToken()
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(tokenAtOpen).toBe(token)

    openConnectWindow('https://gk.example/connect')
    expect(open).toHaveBeenCalledTimes(2)
    expect(handoffTabToken()).toBe(token)
  })

  it('tells the user when the browser blocked the popup', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)

    expect(() => openConnectWindow('https://gk.example/connect'))
      .toThrow('Pop-up blocked. Please allow pop-ups and try again.')
    // No popup, so no ticket is coming: this tab must not claim a sibling's.
    expect(sessionStorage.getItem(CONNECT_PENDING_KEY)).toBeNull()
  })
})

describe('HANDOFF_PATH', () => {
  it('is the path the gatekeeper-kit completion page redirects a cross-origin popup to', () => {
    expect(HANDOFF_PATH).toBe('/connect/handoff')
  })

  it('is served by a file route', () => {
    // TanStack file routing: `connect.handoff.tsx` is `/connect/handoff`. The glob is resolved by
    // Vite against the source tree, so it lists exactly the route files that exist.
    expect(Object.keys(import.meta.glob('./routes/*.tsx'))).toContain('./routes/connect.handoff.tsx')
  })
})

describe('ticketFromHandoffFragment', () => {
  it('reads a ticket with or without the leading #', () => {
    expect(ticketFromHandoffFragment(`#${TICKET}`)).toBe(TICKET)
    expect(ticketFromHandoffFragment(TICKET)).toBe(TICKET)
  })

  it('decodes a percent-encoded ticket', () => {
    expect(ticketFromHandoffFragment(`#${encodeURIComponent(TICKET)}`)).toBe(TICKET)
  })

  it('rejects anything but 64 lowercase hex characters', () => {
    expect(ticketFromHandoffFragment(`#${TICKET.toUpperCase()}`)).toBeNull()
    expect(ticketFromHandoffFragment(`#${TICKET.slice(1)}`)).toBeNull()
    expect(ticketFromHandoffFragment('#zzz')).toBeNull()
  })

  it('rejects malformed percent-encoding', () => {
    expect(ticketFromHandoffFragment('#%zz')).toBeNull()
  })

  it('rejects an empty fragment', () => {
    expect(ticketFromHandoffFragment('')).toBeNull()
    expect(ticketFromHandoffFragment('#')).toBeNull()
  })
})

describe('broadcastHandoffUntilAcked', () => {
  const heard: unknown[] = []
  let receiver: BroadcastChannel | undefined
  let stop: (() => void) | undefined
  const onUnreachable = vi.fn<() => void>()
  const realSetTimeout = setTimeout

  // Node delivers BroadcastChannel messages through the event loop, not through timers, so faking
  // only the timers the function uses leaves delivery real; `flush` waits for it on a real timer.
  const flush = () => new Promise(resolve => realSetTimeout(resolve, 10))

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.spyOn(window, 'close').mockImplementation(() => {})
    receiver = new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
    receiver.addEventListener('message', (event: MessageEvent) => { heard.push(event.data) })
  })

  afterEach(() => {
    stop?.()
    stop = undefined
    receiver?.close()
    receiver = undefined
    heard.length = 0
    onUnreachable.mockReset()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const envelope = { type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET, tab: TAB }

  async function ack(ticket: string) {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
    receiver!.postMessage({ type: CONNECT_HANDOFF_ACK_MESSAGE_TYPE, ticket })
    await flush()
  }

  it('posts the envelope immediately and again every second', async () => {
    stop = broadcastHandoffUntilAcked(TICKET, TAB, { onUnreachable })
    await flush()
    expect(heard).toEqual([envelope])

    vi.advanceTimersByTime(1000)
    await flush()
    expect(heard).toEqual([envelope, envelope])

    vi.advanceTimersByTime(2000)
    await flush()
    expect(heard).toHaveLength(4)
    expect(onUnreachable).not.toHaveBeenCalled()
  })

  it('stops repeating and closes the window once its ticket is acknowledged', async () => {
    stop = broadcastHandoffUntilAcked(TICKET, TAB, { onUnreachable })
    await flush()

    await ack(TICKET)
    expect(window.close).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(5000)
    await flush()
    // A channel never hears its own posts, so the receiver's ack is not in `heard`: only the one
    // envelope posted before the ack is, and nothing followed it.
    expect(heard).toEqual([envelope])
    vi.advanceTimersByTime(30000)
    expect(onUnreachable).not.toHaveBeenCalled()
  })

  it('ignores an acknowledgement for another ticket', async () => {
    stop = broadcastHandoffUntilAcked(TICKET, TAB, { onUnreachable })
    await flush()

    await ack('b'.repeat(64))
    expect(window.close).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    await flush()
    expect(heard).toEqual([envelope, envelope])
  })

  it('gives up after 30 seconds unacknowledged', async () => {
    stop = broadcastHandoffUntilAcked(TICKET, TAB, { onUnreachable })
    vi.advanceTimersByTime(29999)
    expect(onUnreachable).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onUnreachable).toHaveBeenCalledOnce()
    await flush()
    const posted = heard.length

    vi.advanceTimersByTime(5000)
    await flush()
    expect(heard).toHaveLength(posted)
    expect(window.close).not.toHaveBeenCalled()
  })

  it('stops repeating when cleaned up', async () => {
    stop = broadcastHandoffUntilAcked(TICKET, TAB, { onUnreachable })
    await flush()
    expect(heard).toEqual([envelope])

    stop()
    stop()  // idempotent
    vi.advanceTimersByTime(60000)
    await flush()
    expect(heard).toEqual([envelope])
    expect(onUnreachable).not.toHaveBeenCalled()
  })

  it('reports unreachable at once in a browser without BroadcastChannel', () => {
    // Removed rather than stubbed to undefined: the function tests for the property's presence.
    const scope = globalThis as { BroadcastChannel?: typeof BroadcastChannel }
    const original = scope.BroadcastChannel
    delete scope.BroadcastChannel
    try {
      stop = broadcastHandoffUntilAcked(TICKET, TAB, { onUnreachable })
      expect(onUnreachable).toHaveBeenCalledOnce()
      expect(() => stop!()).not.toThrow()
    } finally {
      scope.BroadcastChannel = original
    }
  })
})

describe('ConnectHandoffPage', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  const heard: unknown[] = []
  let receiver: BroadcastChannel | undefined

  beforeEach(() => {
    // The popup's copy of the opener's sessionStorage: the token of the tab that opened it.
    holdTab()
    receiver = new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
    receiver.addEventListener('message', (event: MessageEvent) => { heard.push(event.data) })
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    receiver?.close()
    heard.length = 0
    window.history.replaceState(null, '', '/')
    sessionStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function render(hash: string) {
    window.history.replaceState(null, '', `${HANDOFF_PATH}${hash}`)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(<ConnectHandoffPage />))
  }


  it("broadcasts the ticket from the fragment with this popup's tab token, and strips the fragment", async () => {
    render(`#${encodeURIComponent(TICKET)}`)

    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe(HANDOFF_PATH)
    expect(container!.textContent).toContain('Connected')
    await delivered()
    expect(heard).toContainEqual({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET, tab: TAB })
  })

  it('broadcasts nothing for a fragment that is not a ticket', async () => {
    render('#zzz')

    expect(window.location.hash).toBe('')
    expect(container!.textContent).toContain("This link isn't valid")
    await delivered()
    expect(heard).toEqual([])
  })

  it('broadcasts nothing when it holds no tab token, as a page opened from a link does', async () => {
    // Only a popup a Workshop tab opened inherits that tab's token; a handoff URL reached any other
    // way must not put its ticket in front of a listening tab.
    sessionStorage.clear()
    render(`#${TICKET}`)

    expect(window.location.hash).toBe('')
    expect(container!.textContent).toContain("This link isn't valid")
    await delivered()
    expect(heard).toEqual([])
  })

  it('tells the user when no Workshop tab acknowledged the ticket within 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    render(`#${TICKET}`)
    expect(container!.textContent).toContain('Connected')

    act(() => { vi.advanceTimersByTime(29999) })
    expect(container!.textContent).toContain('Connected')
    act(() => { vi.advanceTimersByTime(1) })
    expect(container!.textContent).toContain("This window couldn't reach the Workshop")
    expect(container!.textContent).toContain('Go back to the Workshop tab and start the connection again.')
  })

  it('closes itself once its ticket is acknowledged', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    render(`#${TICKET}`)
    await delivered()

    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
    receiver!.postMessage({ type: CONNECT_HANDOFF_ACK_MESSAGE_TYPE, ticket: TICKET })
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(container!.textContent).toContain('Connected')
  })
})
