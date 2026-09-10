// The browser half of the gatekeeper connect handoff (see `GatekeeperVendor.connectAccount` in
// workshop-shared). A connect URL is a bearer capability, so the Workshop opens it as a popup; when
// the flow finishes, the gatekeeper's page delivers a single-use ticket back here, and redeeming it
// over our authenticated session is what activates the grant. One transport carries the ticket: the
// same-origin BroadcastChannel named `CONNECT_HANDOFF_MESSAGE_TYPE`, on which the browser lets only
// documents on our origin speak. It is broadcast either by the gatekeeper's completion page itself,
// when the gatekeeper shares our origin, or by our own `/connect/handoff` page after that completion
// page redirected the popup there with the ticket in the URL fragment. That page broadcasts whatever
// ticket its URL carries, so its envelope also names the tab that opened the popup (`HANDOFF_TAB_KEY`)
// and listeners accept only their own tab's; a handoff link opened any other way reaches nobody.

import { useEffect } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import {
  CONNECT_HANDOFF_ACK_MESSAGE_TYPE, CONNECT_HANDOFF_MESSAGE_TYPE,
} from '@gadgets/workshop-shared/gatekeeper'

/**
 * Path of the Workshop page a gatekeeper on another origin redirects a finished popup to, with the
 * ticket in the URL fragment (`/connect/handoff#<ticket>`). The gatekeeper-kit completion page
 * duplicates the literal — the kit must not depend on this package — and each package pins it with
 * a test.
 */
export const HANDOFF_PATH = '/connect/handoff'

/** Host the backend is served from; `main.tsx` opens the RPC WebSocket against it. */
export function getBackendHost(): string {
  // Only the Vite dev server is hosted separately from the backend. Built assets are served from
  // the same origin in both production and run-local mode.
  if (import.meta.env.DEV) {
    return import.meta.env.VITE_BACKEND_HOST?.trim() || 'localhost:8787'
  }
  return window.location.host
}

const TICKET_PATTERN = /^[0-9a-f]{64}$/

/** Whether `value` has the shape of a handoff ticket: 64 lowercase hex characters. */
function isTicket(value: unknown): value is string {
  return typeof value === 'string' && TICKET_PATTERN.test(value)
}

/**
 * `sessionStorage` key of the token that names this tab in the envelopes our `/connect/handoff` page
 * broadcasts. `window.open()` starts a popup with a copy of the opener's `sessionStorage`, so a popup
 * carries the token of the tab that opened it, while a document reached any other way — a link, a
 * pasted URL — carries none. Minted by `openDisownedPopup` before this tab's first popup opens and
 * kept for the tab's life: a popup reused by name keeps the copy it was created with, so the token
 * must not change between openings.
 */
const HANDOFF_TAB_KEY = 'gadgets.handoffTab'

/**
 * The tab token this document holds (`HANDOFF_TAB_KEY`), or null when it holds none or storage is
 * unavailable. In a popup this is the token of the tab that opened it.
 */
export function handoffTabToken(): string | null {
  try {
    return sessionStorage.getItem(HANDOFF_TAB_KEY)
  } catch {
    return null
  }
}

// Gives this tab a token if it has none yet. Storage can be unavailable (a disabled cookie jar, a
// sandboxed frame); the popup then inherits no token and its handoff page reports the link invalid.
function mintHandoffTabToken(): void {
  try {
    if (sessionStorage.getItem(HANDOFF_TAB_KEY) !== null) return
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    sessionStorage.setItem(HANDOFF_TAB_KEY, Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''))
  } catch { /* no token to inherit */ }
}

/**
 * The ticket a handoff envelope carries, or null unless `data` is a well-formed one this tab may act
 * on. A BroadcastChannel is same-origin by construction, so there is no origin left to check; what is
 * checked is the `tab` field. Our `/connect/handoff` page always sets it, to the token it inherited
 * from the tab that opened the popup, and an envelope naming any other tab is not ours: the page
 * broadcasts whatever ticket its URL carries, so without this a handoff link an attacker crafted and
 * the user opened would have this tab redeem the attacker's ticket. An envelope without the field is
 * the gatekeeper's own completion page on our origin, whose ticket the gatekeeper embedded
 * server-side for a flow reached only through its single-use URL, so it needs no token.
 */
export function parseHandoffEnvelope(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const { type, ticket, tab } = data as { type?: unknown; ticket?: unknown; tab?: unknown }
  if (type !== CONNECT_HANDOFF_MESSAGE_TYPE) return null
  if (tab !== undefined && (typeof tab !== 'string' || tab !== handoffTabToken())) return null
  return isTicket(ticket) ? ticket : null
}

/**
 * The ticket a `/connect/handoff` URL fragment carries (`window.location.hash`, with or without its
 * leading `#`, percent-encoded or not), or null unless it decodes to a well-formed ticket.
 */
export function ticketFromHandoffFragment(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  return isTicket(decoded) ? decoded : null
}

/** How often the `/connect/handoff` page repeats its envelope until a Workshop tab acknowledges it. */
const HANDOFF_REPEAT_MS = 1000

/** How long the `/connect/handoff` page keeps repeating before it tells the user it reached nobody. */
const HANDOFF_GIVE_UP_MS = 30000

/**
 * What the `/connect/handoff` page does with the ticket a gatekeeper on another origin handed it:
 * broadcasts the handoff envelope on the same-origin channel, immediately and then every second,
 * until a Workshop tab answers with a `CONNECT_HANDOFF_ACK_MESSAGE_TYPE` envelope for this ticket.
 * The envelope names `tab`, the token this popup inherited from the tab that opened it
 * (`handoffTabToken`), which is what lets that tab, and no other, accept a ticket that arrived in a
 * URL. Repeating matters because a Workshop tab whose session is mid-reconnect misses a one-shot, and
 * it is harmless because the ticket is single-use server-side. The ack is the Workshop telling this
 * window that the ticket is redeemed and it may close, which it then does. After 30 seconds
 * unacknowledged it stops and reports `onUnreachable`; so does a browser without BroadcastChannel,
 * synchronously. Returns a cleanup that stops the repeats and closes the channel (idempotent).
 */
export function broadcastHandoffUntilAcked(
  ticket: string,
  tab: string,
  options: { onUnreachable: () => void },
): () => void {
  if (!('BroadcastChannel' in globalThis)) {
    options.onUnreachable()
    return () => {}
  }
  const envelope = { type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket, tab }
  const channel = new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
  let repeat: ReturnType<typeof setInterval> | null = setInterval(() => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
    channel.postMessage(envelope)
  }, HANDOFF_REPEAT_MS)
  let giveUp: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    stop()
    options.onUnreachable()
  }, HANDOFF_GIVE_UP_MS)
  function stop() {
    if (repeat !== null) { clearInterval(repeat); repeat = null }
    if (giveUp !== null) { clearTimeout(giveUp); giveUp = null }
    channel.close()
  }
  channel.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data
    if (typeof data !== 'object' || data === null) return
    const { type, ticket: acked } = data as { type?: unknown; ticket?: unknown }
    if (type !== CONNECT_HANDOFF_ACK_MESSAGE_TYPE || acked !== ticket) return
    stop()
    window.close()
  })
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
  channel.postMessage(envelope)
  return stop
}

/**
 * Opens `url` as a popup named `name` that no page in the flow can reach back from. The popup is
 * opened empty, disowned, and only then navigated, so no page it ever visits holds `window.opener`:
 * an opener handle would let such a page navigate this authenticated tab to a phishing page (reverse
 * tabnabbing), and having none also makes the flow indifferent to COOP, which severs openers a page
 * would otherwise rely on. Disowning is done by hand rather than with the `noopener` feature because
 * that makes `window.open()` return null even on success, indistinguishable from a pop-up block.
 * Gives this tab its token (`HANDOFF_TAB_KEY`) first, so the popup's copy of `sessionStorage`
 * carries it. Throws when the browser blocked the popup.
 */
export function openDisownedPopup(url: string, name: string): Window {
  mintHandoffTabToken()
  const popup = window.open('', name, 'popup,width=520,height=680')
  if (!popup) throw new Error('Pop-up blocked. Please allow pop-ups and try again.')
  popup.opener = null
  popup.location.replace(url)
  return popup
}

/**
 * Opens a connect / reconnect / ensure-resources URL as a disowned popup (`openDisownedPopup`): a
 * connect flow can land on pages the deployment does not vouch for — notably an MCP server the user
 * pasted — so none of them may hold a handle to this tab. The completion page reaches us over the
 * same-origin channel instead (`useConnectHandoffListener`): directly when the gatekeeper shares our
 * origin, otherwise after redirecting the popup to `HANDOFF_PATH` on our origin with the ticket in
 * the URL fragment. The Vite dev server (Workshop on :3000, gatekeepers on :8787) exercises that
 * redirect path. Marks this tab as the one awaiting the ticket once the popup is open, so a blocked
 * popup leaves no marker. Throws when the browser blocked the popup.
 */
export function openConnectWindow(url: string): Window {
  const popup = openDisownedPopup(url, 'gadgets-connect')
  markConnectPending()
  return popup
}

/**
 * Set in this tab's `sessionStorage` by `openConnectWindow`, so `useConnectHandoffListener` knows a
 * broadcast ticket is one this tab asked for. Per-tab and reload-stable, which is exactly the scope
 * wanted: the tab that opened the popup redeems, its siblings stay quiet. Holds the time it was
 * set, so an abandoned popup's marker ages out instead of racing sibling tabs forever.
 */
const CONNECT_PENDING_KEY = 'gadgets.connectPending'

/**
 * How long a marker counts. A ticket can legitimately arrive up to the sum of the gatekeepers'
 * initiation-nonce lifetime (10 min, e.g. spent on an endpoint form), the fresh OAuth-nonce lifetime
 * (10 min, spent at the consent screen) and the Workshop's handoff lifetime (2 min) after the popup
 * opened; anything later cannot be this tab's. Rounded up: the bound exists only so an abandoned
 * popup's marker does not race sibling tabs forever.
 */
const CONNECT_PENDING_LIFETIME_MS = 30 * 60 * 1000

// Storage can be unavailable (a disabled cookie jar, a sandboxed frame); every access degrades to
// today's behaviour of redeeming whatever arrives rather than failing the connect.
function markConnectPending(): void {
  try { sessionStorage.setItem(CONNECT_PENDING_KEY, String(Date.now())) } catch { /* fall back to redeeming all */ }
}

function hasPendingConnect(): boolean {
  try {
    const marked = sessionStorage.getItem(CONNECT_PENDING_KEY)
    return marked !== null && Date.now() - Number(marked) < CONNECT_PENDING_LIFETIME_MS
  } catch {
    return true
  }
}

function clearPendingConnect(): void {
  try { sessionStorage.removeItem(CONNECT_PENDING_KEY) } catch { /* nothing to clear */ }
}

/**
 * Listens for the ticket a connect popup delivers and redeems it on the user's session. The ticket
 * arrives on the BroadcastChannel named `CONNECT_HANDOFF_MESSAGE_TYPE`, which the browser scopes to
 * our origin; it is broadcast by the gatekeeper's completion page when the gatekeeper is on our
 * origin, or by our own `/connect/handoff` page after a gatekeeper on another origin redirected the
 * popup there. Only well-formed envelopes are considered; anything else is ignored silently. A
 * broadcast has no source, so the broadcasting page repeats its envelope (a tab whose session is
 * mid-reconnect would miss a one-shot) until this tab answers with a
 * `CONNECT_HANDOFF_ACK_MESSAGE_TYPE` envelope once the redemption succeeded, then closes itself.
 *
 * Security rests on two things. The ticket is scoped server-side to the user who started the flow,
 * so a flow someone else finished yields a ticket that person's session cannot redeem. And an
 * envelope from our `/connect/handoff` page is accepted only when it names this tab's token
 * (`parseHandoffEnvelope`): that page broadcasts whatever ticket its URL carries, so a ticket the
 * finisher of a leaked flow holds must not become redeemable by the starter merely clicking a link;
 * only a popup this tab opened inherits its token. The `sessionStorage` marker `openConnectWindow`
 * sets decides *which of that user's tabs* redeems a broadcast: the one that opened the popup,
 * surviving a reload, since the storage is per-tab and reload-stable; its siblings stay silent
 * instead of racing it and toasting "expired". The marker is spent only by a successful redemption,
 * so a sibling's or a sign-in ticket heard first (which the server rejects) does not cost this tab
 * its own, and it ages out after the connect-nonce lifetime so an abandoned popup's marker stops
 * racing siblings. A connect whose tab was closed expires and is revoked like an abandoned one.
 *
 * Pass `null` to listen for nothing: a ticket must be redeemed exactly once, so only one listener may
 * be live per window (see `ConnectHandoffListener` and the blueprint page).
 */
export function useConnectHandoffListener(
  authenticatedApi: RpcStub<AuthenticatedApi> | null,
  onError: (message: string) => void,
): void {
  useEffect(() => {
    if (!authenticatedApi) return
    if (!('BroadcastChannel' in globalThis)) return
    const channel = new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
    const redeem = (ticket: string) => {
      authenticatedApi.completeConnectHandoff(ticket).then(
        () => {
          clearPendingConnect()
          // The ack is what tells the broadcasting page to stop repeating and close itself.
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
          channel.postMessage({ type: CONNECT_HANDOFF_ACK_MESSAGE_TYPE, ticket })
        },
        (err: unknown) => { onError(err instanceof Error ? err.message : String(err)) },
      )
    }
    // Tickets already tried on this session: the page repeats its broadcast until acked, and a
    // sibling tab's page may repeat too, so a ticket is redeemed (and a failure toasted) once.
    const attempted = new Set<string>()
    channel.addEventListener('message', (event: MessageEvent) => {
      const ticket = parseHandoffEnvelope(event.data)
      if (ticket === null || attempted.has(ticket) || !hasPendingConnect()) return
      attempted.add(ticket)
      redeem(ticket)
    })
    return () => { channel.close() }
  }, [authenticatedApi, onError])
}
