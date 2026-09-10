// The connect handoff: how a finished gatekeeper connect or sign-in flow is bound to the browser
// that started it. A connect URL is a bearer capability, so the gatekeeper's final page delivers a
// single-use ticket to the Workshop over a same-origin BroadcastChannel, from a document on the
// Workshop's origin: the gatekeeper's own page when it shares that origin, otherwise the Workshop's
// /connect/handoff page, which the completion page redirects the popup to with the ticket in the
// URL fragment. Every popup is disowned before navigation, so no provider page holds the Workshop's
// window. The Workshop activates the staged grant only when that ticket is redeemed over the
// initiating user's own session (UserDurableObject.completeConnectHandoff, PendingLogin.claim).

/**
 * How long a staged connect / reconnect waits for its ticket. The handoff page delivers the ticket
 * the instant it loads, so anything not redeemed within this window was opened somewhere the
 * Workshop could not reach, and the staged grant is dropped (and, for a connect, revoked).
 */
export const PENDING_HANDOFF_LIFETIME_MS = 2 * 60 * 1000;

/**
 * The Workshop origin the handoff page must deliver its ticket on: the ticket travels over a
 * same-origin BroadcastChannel from a document on this origin, so a completion page on any other
 * origin redirects to this origin's /connect/handoff page first. Comes from deployment
 * configuration only: a request's `Origin` header or anything the client asserts could route the
 * ticket to an attacker-controlled origin, so neither is consulted. Fails closed when unset.
 */
export function handoffTargetOrigin(env: Cloudflare.Env): string {
  if (!env.PUBLIC_BASE_URL) {
    throw new Error("PUBLIC_BASE_URL is not configured, so account connections cannot complete.");
  }
  return new URL(env.PUBLIC_BASE_URL).origin;
}

/**
 * Mint a 256-bit bearer secret plus the SHA-256 (hex) under which it is stored, so a leaked storage
 * dump reveals nothing redeemable. Shared by session tokens and handoff tickets.
 */
export async function newSecretToken(): Promise<{ secret: Uint8Array; hash: string }> {
  let secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  return { secret, hash: await hashSecret(secret) };
}

/** SHA-256 hex of a secret, the form in which secrets are looked up at rest. */
export async function hashSecret(secret: Uint8Array): Promise<string> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", secret)).toHex();
}
