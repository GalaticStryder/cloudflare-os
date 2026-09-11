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
 * Privy/owner-auth URLs (containing `/gatekeeper/privy/login/`) are opened as a popup
 * without `noopener` to preserve the opener reference. Other gatekeeper URLs use a
 * new tab with `noopener,noreferrer` as before.
 */
export function openGatekeeperPopup(url: string): boolean {
  if (!url) return false;
  if (url.includes('/gatekeeper/privy/login/')) {
    window.open(url, 'gatekeeper-login', 'popup,width=520,height=680')
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
  return true;
}
