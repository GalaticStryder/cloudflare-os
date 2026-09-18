/**
 * Opens a gatekeeper connection/reconnect URL in a popup or new tab.
 *
 * Returns true if a popup/tab was opened, false if the URL was empty (meaning
 * the connection was completed directly without a popup, e.g. via connectDirect).
 *
 * The Privy owner-auth verification flow requires `window.opener` to verify it was
 * opened from Hoff OS (the `requireOpener` check in the owner-auth app). Opening with
 * `noopener` strips that reference, so the popup self-rejects with "no opener".
 *
 * Privy/owner-auth URLs (containing `/gatekeeper/privy/login/`) and wallet-connect
 * URLs (containing `/gatekeeper/wallet/connect/`) are opened as a popup without
 * `noopener` to preserve the opener reference. Other gatekeeper URLs use a new tab
 * with `noopener,noreferrer` as before.
 *
 * Mobile in-app wallet browsers (MetaMask, Rainbow, …) block `window.open`: the call
 * returns null and nothing appears to happen. In that case the current tab navigates
 * to the URL instead — the owner-auth and wallet sign pages both detect redirect mode
 * (no opener) and validate the Workshop origin via `document.referrer`, then return
 * here by navigating back once the flow completes.
 */
export function openGatekeeperPopup(url: string): boolean {
  if (!url) return false;
  if (url.includes('/gatekeeper/privy/login/') || url.includes('/gatekeeper/wallet/connect/')) {
    const win = window.open(url, 'gatekeeper-login', 'popup,width=520,height=680')
    if (win) return true
    // Popup blocked (mobile in-app wallet browser) — fall back to same-tab navigation.
    window.location.href = url
    return true
  }
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
}
