import { useEffect, useRef, useState } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthVendorInfo } from '@gadgets/workshop-shared/api'
import {
  CONNECT_HANDOFF_ACK_MESSAGE_TYPE, CONNECT_HANDOFF_MESSAGE_TYPE,
} from '@gadgets/workshop-shared/gatekeeper'
import { Button, Banner } from '@cloudflare/kumo'
import { openDisownedPopup, parseHandoffEnvelope } from '../../connectHandoff'

interface OAuthButtonsProps {
  rpcStub: RpcStub<PublicApi>
  vendors: AuthVendorInfo[]
  onSuccess?: () => void
}

// What an attempt's promise rejects with when it is torn down from outside (unmount, or a newer
// attempt) rather than failing: the caller then has no state to update.
const CANCELLED = Symbol('sign-in cancelled')

/**
 * Renders a sign-in button per auth-capable gatekeeper vendor. Clicking opens the gatekeeper's
 * OAuth popup, disowned so no provider page ever holds this window as its opener; when the flow
 * finishes, the popup delivers a handoff ticket back here, which is redeemed over RPC for the
 * session token. The ticket is what ties the session to this browser: the sign-in URL alone can be
 * finished by anyone (see connectHandoff.ts). On success the token is stored and the app
 * re-authenticates.
 *
 * The ticket arrives over one transport: the same-origin BroadcastChannel named
 * `CONNECT_HANDOFF_MESSAGE_TYPE`, broadcast by the gatekeeper's completion page when the gatekeeper
 * shares our origin, or by our own `/connect/handoff` page after a gatekeeper on another origin
 * redirected the popup there. A broadcast has no source to filter on, so a ticket heard here may be
 * another tab's sign-in or an account-connect ticket; the server answers such a claim with null, and
 * we keep listening for ours. An envelope from the handoff page is taken only when it names this
 * tab's token (`parseHandoffEnvelope`), which the popup inherited when this page opened it: that page
 * broadcasts whatever ticket its URL carries, and a ticket someone else finished a leaked sign-in
 * with must not log this browser in as them because the user clicked a link.
 */
export default function OAuthButtons({ rpcStub, vendors, onSuccess }: OAuthButtonsProps) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  // The attempt in flight, if any, as the function that tears it down: stops the popup poll, drops
  // the ticket listener and disposes the login RPC (Cap'n Web treats this as a best-effort cancel
  // and frees the client-side pending call). Run when the component unmounts mid-login (e.g. the
  // user navigates away) and when a new attempt starts, so at most one attempt is ever listening.
  const attemptRef = useRef<(() => void) | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    // Re-assert on (re)mount: under StrictMode the effect runs mount→cleanup→mount, and the cleanup
    // below sets this false. Without resetting here it would stay false for the component's whole
    // life, causing a successful login result to be silently dropped by the `!mountedRef.current`
    // guards below.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      attemptRef.current?.()
      attemptRef.current = null
    }
  }, [])

  if (vendors.length === 0) return null

  const start = async (vendorId: string) => {
    attemptRef.current?.()
    attemptRef.current = null
    setError(null)
    setPending(vendorId)
    try {
      const { url, attempt } = await rpcStub.startGatekeeperLogin(vendorId)
      // `attempt` is the capability to redeem the session token.
      const dispose = () => {
        try { (attempt as unknown as Disposable)[Symbol.dispose]() } catch { /* already disposed */ }
      }
      if (!mountedRef.current) {
        // Unmounted while the RPC was in flight: the cleanup above has already run, so nothing may
        // be opened or registered now.
        dispose()
        return
      }
      // Disowned like account-connect popups: sign-in providers are admin-allowlisted, but the popup
      // traverses provider pages all the same, and none of them may hold a handle to this window.
      // Throws the pop-up-blocked error itself.
      let popup: Window
      try {
        popup = openDisownedPopup(url, 'gatekeeper-login')
      } catch (err) {
        dispose()
        throw err
      }
      // Resolve once a ticket arrives and the claim succeeds; reject if the claim fails or the
      // attempt is torn down.
      const token = await new Promise<string>((resolve, reject) => {
        let settled = false
        let poll: number | null = null
        const channel = 'BroadcastChannel' in globalThis
          ? new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
          : null

        function stopPolling() {
          if (poll !== null) { clearInterval(poll); poll = null }
        }
        const startPolling = () => {
          if (poll !== null) return
          poll = window.setInterval(() => {
            if (!popup.closed) return
            // The handle reports closed when the user closed the popup — and also when a provider's
            // COOP moved the popup to another browsing context group mid-flow (Google does), which
            // discards the context this handle points at while the flow runs on. Either way: hand the
            // buttons back and keep listening, since the attempt itself is still live; if nothing
            // arrives it ends with the next attempt or on unmount. The page closes itself after the
            // ack, and polling pauses during a claim so that self-close is not read as a cancellation.
            stopPolling()
            if (mountedRef.current) setPending(null)
          }, 500)
        }
        function finish(fn: () => void) {
          if (settled) return
          settled = true
          attemptRef.current = null
          stopPolling()
          channel?.close()
          dispose()
          fn()
        }
        // Claims may overlap: a foreign ticket answered with null must not hold up the real one
        // behind it, and `finish` settles only once. Polling pauses during a claim so a popup that
        // closes itself on completion is not read as a cancellation, and resumes after a foreign
        // ticket, or closing the popup afterwards would leave the buttons stuck.
        function claimTicket(ticket: string) {
          if (settled) return
          stopPolling()
          attempt.claim(ticket)
            .then(t => {
              if (settled) return
              if (t === null) {
                startPolling()
                return
              }
              // The broadcasting page repeats until acknowledged; the ack tells it to close.
              // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
              channel?.postMessage({ type: CONNECT_HANDOFF_ACK_MESSAGE_TYPE, ticket })
              finish(() => resolve(t))
            })
            .catch(e => finish(() => reject(e instanceof Error ? e : new Error('Could not sign in'))))
        }

        channel?.addEventListener('message', (event: MessageEvent) => {
          const ticket = parseHandoffEnvelope(event.data)
          if (ticket !== null) claimTicket(ticket)
        })
        startPolling()
        attemptRef.current = () => finish(() => reject(CANCELLED))
      })
      // Best-effort: the page closes itself on the ack anyway.
      try { popup.close() } catch { /* already gone */ }
      if (!mountedRef.current) return  // user navigated away mid-flow; drop the result
      localStorage.setItem('authToken', token)
      if (onSuccess) onSuccess()
      else window.location.reload()
    } catch (err) {
      if (err === CANCELLED || !mountedRef.current) return
      setError(err instanceof Error ? err.message : 'Could not sign in')
      setPending(null)
    }
  }

  return (
    <div className="space-y-3">
      {error && <Banner variant="error" title={error} />}
      {vendors.map((vendor) => (
        <Button
          key={vendor.vendorId}
          variant="secondary"
          onClick={() => start(vendor.vendorId)}
          loading={pending === vendor.vendorId}
          disabled={pending !== null}
          className="w-full justify-center"
        >
          {vendor.logo && (
            <img
              src={vendor.logo.url}
              alt=""
              className="mr-1"
              style={{ height: 18, width: 'auto' }}
            />
          )}
          Continue with {vendor.displayName}
        </Button>
      ))}
    </div>
  )
}
