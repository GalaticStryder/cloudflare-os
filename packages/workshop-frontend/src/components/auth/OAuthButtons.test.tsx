// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthVendorInfo, LoginAttempt, PublicApi } from '@gadgets/workshop-shared/api'
import {
  CONNECT_HANDOFF_ACK_MESSAGE_TYPE, CONNECT_HANDOFF_MESSAGE_TYPE,
} from '@gadgets/workshop-shared/gatekeeper'
import { handoffTabToken } from '../../connectHandoff'
import OAuthButtons from './OAuthButtons'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VENDORS: AuthVendorInfo[] = [{ vendorId: 'github', displayName: 'GitHub' }]
const TICKET = 'b'.repeat(64)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

// Lets pending promises and React flush.
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

// A popup as window.open returns it: an opener pointing back at us, a location to navigate, and the
// closed flag the buttons poll.
function fakePopup() {
  return {
    opener: window as Window | null,
    location: { replace: vi.fn<(url: string) => void>() },
    closed: false,
    close: vi.fn<() => void>(),
  }
}

describe('OAuthButtons', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  const claim = vi.fn<(ticket: string) => Promise<string | null>>()
  const attempt = { claim, [Symbol.dispose]() {} } as unknown as RpcStub<LoginAttempt>

  function mount(rpcStub: RpcStub<PublicApi>, onSuccess = vi.fn<() => void>()) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(<OAuthButtons rpcStub={rpcStub} vendors={VENDORS} onSuccess={onSuccess} />))
    return onSuccess
  }

  const clickSignIn = () => act(async () => { container!.querySelector('button')!.click() })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
    claim.mockReset()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('opens the login popup disowned and claims the ticket it hears on the channel', async () => {
    const popup = fakePopup()
    let openerAtNavigation: Window | null | undefined
    popup.location.replace.mockImplementation(() => { openerAtNavigation = popup.opener })
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    claim.mockResolvedValue('alice@example.com:secret')
    const rpcStub = {
      startGatekeeperLogin: async () => ({ url: 'https://gk.example/login', attempt }),
    } as unknown as RpcStub<PublicApi>
    const onSuccess = mount(rpcStub)

    await clickSignIn()
    await settle()
    // Opened empty, disowned, then navigated: no provider page ever holds this window as its opener.
    expect(window.open).toHaveBeenCalledExactlyOnceWith('', 'gatekeeper-login', 'popup,width=520,height=680')
    expect(popup.opener).toBeNull()
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith('https://gk.example/login')
    expect(openerAtNavigation).toBeNull()

    const sender = new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
    // The page repeats its broadcast until a Workshop window acknowledges the ticket.
    const acked = new Promise<unknown>(resolve => {
      sender.addEventListener('message', (event: MessageEvent) => resolve(event.data), { once: true })
    })
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
    sender.postMessage({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await vi.waitFor(() => expect(claim).toHaveBeenCalledExactlyOnceWith(TICKET))
    await settle()
    expect(localStorage.getItem('authToken')).toBe('alice@example.com:secret')
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(await acked).toEqual({ type: CONNECT_HANDOFF_ACK_MESSAGE_TYPE, ticket: TICKET })
    expect(popup.close).toHaveBeenCalled()
    sender.close()
  })

  it('keeps listening after the popup handle reports closed, and claims a broadcast ticket', async () => {
    // The user may close the popup, or the page closes itself; the handle reporting closed hands the
    // buttons back while the attempt stays live, so a ticket that still arrives is claimed.
    const popup = fakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    claim.mockResolvedValue('alice@example.com:secret')
    const rpcStub = {
      startGatekeeperLogin: async () => ({ url: 'https://gk.example/login', attempt }),
    } as unknown as RpcStub<PublicApi>
    const onSuccess = mount(rpcStub)
    const button = () => container!.querySelector('button')!

    await clickSignIn()
    await settle()
    expect(button().disabled).toBe(true)

    popup.closed = true
    await act(() => new Promise(resolve => setTimeout(resolve, 600)))
    // Not treated as a cancellation: the buttons come back, the attempt stays live.
    expect(button().disabled).toBe(false)
    expect(container!.textContent).not.toContain('cancelled')
    expect(claim).not.toHaveBeenCalled()

    const sender = new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
    const acked = new Promise<unknown>(resolve => {
      sender.addEventListener('message', (event: MessageEvent) => resolve(event.data), { once: true })
    })
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
    sender.postMessage({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await vi.waitFor(() => expect(claim).toHaveBeenCalledExactlyOnceWith(TICKET))
    await settle()
    expect(localStorage.getItem('authToken')).toBe('alice@example.com:secret')
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(await acked).toEqual({ type: CONNECT_HANDOFF_ACK_MESSAGE_TYPE, ticket: TICKET })
    sender.close()
  })

  it('keeps waiting when a broadcast ticket belongs to another attempt', async () => {
    // A broadcast has no source to filter on, so the channel may carry another tab's sign-in ticket
    // or an account-connect ticket first. The server answers null for those; ours still lands.
    const own = fakePopup()
    vi.spyOn(window, 'open').mockReturnValue(own as unknown as Window)
    const FOREIGN = 'f'.repeat(64)
    claim.mockImplementation(async ticket => ticket === TICKET ? 'alice@example.com:secret' : null)
    const rpcStub = {
      startGatekeeperLogin: async () => ({ url: 'https://gk.example/login', attempt }),
    } as unknown as RpcStub<PublicApi>
    const onSuccess = mount(rpcStub)
    const button = () => container!.querySelector('button')!

    await clickSignIn()
    await settle()
    const sender = new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
    sender.postMessage({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: FOREIGN })
    await vi.waitFor(() => expect(claim).toHaveBeenCalledExactlyOnceWith(FOREIGN))
    await settle()
    expect(localStorage.getItem('authToken')).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(container!.textContent).not.toMatch(/expired|verified|Could not/)
    expect(button().disabled).toBe(true)

    // The foreign claim paused the popup-closed poll; closing the popup now must still hand the
    // buttons back rather than leave them stuck until the right ticket arrives.
    own.closed = true
    await act(() => new Promise(resolve => setTimeout(resolve, 600)))
    expect(button().disabled).toBe(false)
    expect(container!.textContent).not.toContain('cancelled')

    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
    sender.postMessage({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    sender.close()
    await vi.waitFor(() => expect(claim).toHaveBeenCalledWith(TICKET))
    await settle()
    expect(claim).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem('authToken')).toBe('alice@example.com:secret')
    expect(onSuccess).toHaveBeenCalledOnce()
  })

  it("claims a handoff-page envelope only when it names this tab's token", async () => {
    // Opening the popup gives this tab a token, which the popup inherits and /connect/handoff names
    // in its envelope. An envelope naming another tab comes from a handoff link opened some other
    // way; claiming it would log this browser in as whoever finished that flow.
    vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window)
    claim.mockResolvedValue('alice@example.com:secret')
    const rpcStub = {
      startGatekeeperLogin: async () => ({ url: 'https://gk.example/login', attempt }),
    } as unknown as RpcStub<PublicApi>
    const onSuccess = mount(rpcStub)
    expect(handoffTabToken()).toBeNull()

    await clickSignIn()
    await settle()
    const tab = handoffTabToken()
    expect(tab).not.toBeNull()

    const sender = new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
    sender.postMessage({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET, tab: 'beef'.repeat(8) })
    await act(() => new Promise(resolve => setTimeout(resolve, 20)))
    expect(claim).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()

    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
    sender.postMessage({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET, tab })
    sender.close()
    await vi.waitFor(() => expect(claim).toHaveBeenCalledExactlyOnceWith(TICKET))
    await settle()
    expect(localStorage.getItem('authToken')).toBe('alice@example.com:secret')
    expect(onSuccess).toHaveBeenCalledOnce()
  })

  it('tells the user when the browser blocked the popup', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const dispose = vi.fn<() => void>()
    const rpcStub = {
      startGatekeeperLogin: async () => ({
        url: 'https://gk.example/login',
        attempt: { claim, [Symbol.dispose]: dispose } as unknown as RpcStub<LoginAttempt>,
      }),
    } as unknown as RpcStub<PublicApi>
    const onSuccess = mount(rpcStub)

    await clickSignIn()
    await settle()

    expect(container!.textContent).toContain('Pop-up blocked. Please allow pop-ups and try again.')
    expect(container!.querySelector('button')!.disabled).toBe(false)
    expect(dispose).toHaveBeenCalledOnce()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('opens nothing if it was unmounted while the sign-in was starting', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window)
    const start = deferred<{ url: string; attempt: RpcStub<LoginAttempt> }>()
    const dispose = vi.fn<() => void>()
    const rpcStub = {
      startGatekeeperLogin: () => start.promise,
    } as unknown as RpcStub<PublicApi>
    mount(rpcStub)

    await clickSignIn()
    act(() => root?.unmount())
    root = undefined
    start.resolve({
      url: 'https://gk.example/login',
      attempt: { claim, [Symbol.dispose]: dispose } as unknown as RpcStub<LoginAttempt>,
    })
    await settle()

    expect(open).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
