import { useEffect, useState } from 'react'
import { broadcastHandoffUntilAcked, handoffTabToken, ticketFromHandoffFragment } from './connectHandoff'
import { useDocumentTitle } from './useDocumentTitle'

/**
 * The Workshop's own end of a cross-origin connect handoff, served at `HANDOFF_PATH`
 * (`/connect/handoff`). A gatekeeper's completion page can broadcast a ticket to Workshop tabs only
 * from a document on the Workshop's origin, so a gatekeeper on another origin redirects the finished
 * popup here with the ticket in the URL fragment instead; this page, being on our origin by
 * construction, reads the ticket, strips it from the address bar and broadcasts it on the same
 * channel to the same listeners (`broadcastHandoffUntilAcked`), then closes on the ack.
 *
 * The page broadcasts whatever ticket its URL carries, so it is a way to put a ticket in front of a
 * Workshop tab that did not earn it; what stops that is the tab token. A popup inherits the token of
 * the tab that opened it through the `sessionStorage` copy `window.open()` makes, the envelope names
 * it, and listeners accept only their own tab's. This page opened any other way — a link, a pasted
 * URL — holds no token and reports the link invalid without broadcasting.
 *
 * It needs no session and no RPC, and it must never mount `useConnectHandoffListener`: the same
 * `sessionStorage` copy brings the connect marker along, so a listener here would race the real tab
 * for its own ticket.
 */
export default function ConnectHandoffPage() {
  useDocumentTitle('Connected')
  // Read once, in the initializer, so the effect below can strip the fragment without a re-run
  // (StrictMode) seeing an empty hash. The initializer touches no history: the router patches
  // `history.replaceState` to update itself synchronously, which must not happen mid-render.
  const [handoff] = useState(() => ({
    ticket: ticketFromHandoffFragment(window.location.hash),
    tab: handoffTabToken(),
  }))
  const [unreachable, setUnreachable] = useState(false)
  const valid = handoff.ticket !== null && handoff.tab !== null

  useEffect(() => {
    // Drop only the hash, keeping the router's history state object, so the ticket leaves the
    // address bar before anything else happens.
    if (window.location.hash !== '') {
      window.history.replaceState(window.history.state, '', window.location.pathname)
    }
    if (handoff.ticket === null || handoff.tab === null) return
    return broadcastHandoffUntilAcked(handoff.ticket, handoff.tab, { onUnreachable: () => setUnreachable(true) })
  }, [handoff])

  const [title, detail] = !valid
    ? ["This link isn't valid", 'Go back to the Workshop and start the connection again.']
    : unreachable
      ? ["This window couldn't reach the Workshop", 'Go back to the Workshop tab and start the connection again.']
      : ['Connected', 'Returning to the Workshop…']

  return (
    <div className="flex min-h-full items-center justify-center bg-kumo-base px-5 py-12">
      <div className="w-full max-w-[420px]">
        <h1 className="text-[17px] font-semibold tracking-tight text-kumo-strong">{title}</h1>
        <p className="mt-1.5 text-sm text-kumo-subtle">{detail}</p>
      </div>
    </div>
  )
}
