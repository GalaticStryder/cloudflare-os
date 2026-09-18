import { useEffect, useMemo, useRef, useState } from 'react'
import { PrivyProvider, getIdentityToken, useLogin, useLoginWithSiwe, usePrivy } from '@privy-io/react-auth'
import type { RpcStub } from 'capnweb'
import type { LoginAttempt } from '@gadgets/workshop-shared/api'
import { Button, Loader } from '@cloudflare/kumo'

/**
 * In-page Privy sign-in for the gatekeeper flow.
 *
 * The popup-based gatekeeper login breaks inside mobile in-app wallet browsers
 * (MetaMask, Rainbow, …), which block `window.open`. Instead of opening
 * `/gatekeeper/privy/login/<flowId>` in a popup, this component runs the whole
 * Privy authentication inside the Workshop page — using Privy's own UI elements —
 * and completes the same server-side flow (`/gatekeeper/privy/flow/<flowId>/complete`)
 * the popup used to. The completion POST is same-origin, satisfying the flow
 * endpoint's Origin and Sec-Fetch-Site checks.
 *
 * Wallet interaction happens through the wallet's own native prompts (an injected
 * `window.ethereum` when present, Privy's modal otherwise), which work in every
 * browser environment including restricted in-app webviews.
 */

export type PrivySignInConfig = { appId: string; clientId: string | null; origin: string }

/**
 * Pre-warms Cloudflare bot-protection cookies for auth.privy.io by loading it in a
 * hidden iframe. After this, the Privy SDK's direct fetches to auth.privy.io include
 * those cookies and pass the bot check; everything else goes through the same-origin
 * proxy, which has no browser-level challenge. Same technique the gatekeeper's own
 * login page uses.
 */
function usePrivyPrewarm(appId: string | null): boolean {
  const [warmed, setWarmed] = useState(false)
  useEffect(() => {
    if (!appId) return
    const iframe = document.createElement('iframe')
    iframe.style.display = 'none'
    iframe.src = `https://auth.privy.io/apps/${appId}/embedded-wallets`
    const done = () => {
      setWarmed(true)
      iframe.remove()
    }
    iframe.addEventListener('load', done)
    // If the iframe never fires "load", proceed anyway — the proxy may be sufficient.
    const timer = window.setTimeout(done, 5000)
    document.body.appendChild(iframe)
    return () => { window.clearTimeout(timer); iframe.remove() }
  }, [appId])
  return warmed
}

/**
 * Loads the gatekeeper's public Privy config (appId / clientId / origin) and pre-warms
 * the auth.privy.io cookies, so an in-page sign-in can start without delay. `enabled`
 * should be true only when a Privy-backed auth vendor is actually offered.
 */
export function usePrivySignInConfig(enabled: boolean): { config: PrivySignInConfig | null; unavailable: boolean } {
  const [config, setConfig] = useState<PrivySignInConfig | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetch('/gatekeeper/privy/config', { credentials: 'omit', cache: 'no-store' })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error('unavailable'))))
      .then((value: PrivySignInConfig) => {
        if (cancelled || typeof value?.appId !== 'string' || typeof value?.origin !== 'string') return
        setConfig({ appId: value.appId, clientId: value.clientId ?? null, origin: value.origin })
      })
      .catch(() => { if (!cancelled) setUnavailable(true) })
    return () => { cancelled = true }
  }, [enabled])
  const warmed = usePrivyPrewarm(config?.appId ?? null)
  // The config is only usable once the prewarm has had its chance.
  if (unavailable) return { config: null, unavailable }
  if (!config || !warmed) return { config: null, unavailable: false }
  return { config, unavailable: false }
}

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

function hasInjectedWallet(): boolean {
  return typeof window !== 'undefined' && !!(window as { ethereum?: unknown }).ethereum
}

function toHex(text: string): string {
  return '0x' + Array.from(new TextEncoder().encode(text)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function SignInInner({ url, attempt, onDone, onFail }: {
  url: string
  attempt: RpcStub<LoginAttempt>
  onDone: (token: string) => void
  onFail: (message: string) => void
}) {
  const { ready, authenticated, getAccessToken } = usePrivy()
  const { login } = useLogin({ onError: () => onFail('Wallet sign-in was cancelled or failed. Try again.') })
  const { generateSiweMessage, loginWithSiwe } = useLoginWithSiwe()
  const [phase, setPhase] = useState<'wallet' | 'verifying'>('wallet')
  const [directError, setDirectError] = useState<string | null>(null)
  const [showModalOption, setShowModalOption] = useState(false)
  const loginStarted = useRef(false)
  const submitted = useRef(false)

  // The login URL carries the flow id and its secret: /gatekeeper/privy/login/<flowId>#<nonce>
  const flowId = url.match(/\/gatekeeper\/privy\/login\/([0-9a-f]{64})/)?.[1] ?? ''
  const flowNonce = url.split('#')[1] ?? ''

  // Start waiting for the session token immediately (resolves when the server-side
  // flow completes); silenced until the completion effect awaits it.
  const tokenPromise = useMemo(() => attempt.wait(), [attempt])
  useEffect(() => { tokenPromise.catch(() => undefined) }, [tokenPromise])

  /**
   * Direct SIWE sign-in through the injected wallet — no modal, no popups. This is
   * the path that works inside mobile in-app wallet browsers, which restrict both.
   * The wallet's own native prompts handle the account request and signature.
   */
  const loginDirect = async () => {
    try {
      const ethereum = (window as { ethereum?: Eip1193 }).ethereum
      if (!ethereum) throw new Error('No injected wallet detected.')
      const accounts = await ethereum.request({ method: 'eth_requestAccounts' }) as string[]
      if (!Array.isArray(accounts) || accounts.length === 0) throw new Error('Wallet connection was rejected.')
      const address = accounts[0]
      const chainIdHex = await ethereum.request({ method: 'eth_chainId' }) as string
      const chainId = `eip155:${parseInt(chainIdHex, 16)}` as `eip155:${number}`
      const siweMessage = await generateSiweMessage({ address, chainId })
      const signature = await ethereum.request({ method: 'personal_sign', params: [toHex(siweMessage), address] }) as string
      if (typeof signature !== 'string' || !signature) throw new Error('The signature was rejected.')
      await loginWithSiwe({ signature, message: siweMessage })
    } catch (error) {
      // Fall back to the wallet-picker modal rather than failing the whole flow.
      setDirectError(error instanceof Error ? error.message : 'Direct wallet sign-in failed.')
      setShowModalOption(true)
    }
  }

  // Auto-start the sign-in once the SDK is ready: direct SIWE when a wallet is
  // injected (mobile in-app browsers, desktop extensions), the Privy modal otherwise.
  useEffect(() => {
    if (!ready || loginStarted.current) return
    loginStarted.current = true
    if (hasInjectedWallet()) void loginDirect()
    else login({ loginMethods: ['wallet'], walletChainType: 'ethereum-only' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // Once Privy is authenticated, submit the tokens to the gatekeeper flow and take
  // the resulting session token.
  useEffect(() => {
    if (!ready || !authenticated || submitted.current) return
    if (!flowId || !flowNonce) {
      onFail('The sign-in link was malformed. Start again.')
      return
    }
    submitted.current = true
    ;(async () => {
      setPhase('verifying')
      try {
        const accessToken = await getAccessToken()
        const identityToken = await getIdentityToken()
        if (!accessToken || !identityToken) throw new Error('Sign-in did not produce the required tokens.')
        const response = await fetch(`/gatekeeper/privy/flow/${flowId}/complete`, {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nonce: flowNonce, accessToken, identityToken }),
        })
        if (!response.ok) {
          const body: { error?: string } = await response.json().catch(() => ({}))
          throw new Error(body.error ?? 'Owner verification failed.')
        }
        const token = await tokenPromise
        onDone(token)
      } catch (error) {
        onFail(error instanceof Error ? error.message : 'Sign-in failed.')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated])

  if (phase === 'verifying') {
    return (
      <div className="flex flex-col items-center gap-2 py-4">
        <Loader size="sm" />
        <p className="text-sm text-kumo-subtle">Verifying owner identity…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <div className="flex flex-col items-center gap-2">
        <Loader size="sm" />
        <p className="text-sm text-kumo-subtle">
          {directError ? 'Direct sign-in failed — choose a wallet option below.' : 'Waiting for your wallet…'}
        </p>
      </div>
      {directError && <p className="text-xs text-kumo-danger text-center max-w-xs">{directError}</p>}
      {showModalOption && (
        <Button variant="secondary" onClick={() => login({ loginMethods: ['wallet'], walletChainType: 'ethereum-only' })}>
          Choose a wallet
        </Button>
      )}
    </div>
  )
}

export default function PrivySignInFlow({ config, url, attempt, onDone, onFail }: {
  config: PrivySignInConfig
  url: string
  attempt: RpcStub<LoginAttempt>
  onDone: (token: string) => void
  onFail: (message: string) => void
}) {
  return (
    <PrivyProvider
      appId={config.appId}
      clientId={config.clientId ?? undefined}
      apiUrl={`${config.origin}/gatekeeper/privy/proxy`}
      config={{
        loginMethods: ['wallet'],
        appearance: {
          theme: 'dark',
          accentColor: '#A5C9BE',
          walletChainType: 'ethereum-only',
          walletList: ['detected_ethereum_wallets', 'metamask', 'coinbase_wallet', 'rainbow', 'phantom'],
        },
        embeddedWallets: { ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' }, disableAutomaticMigration: true },
        externalWallets: { walletConnect: { enabled: true } },
      }}
    >
      <SignInInner url={url} attempt={attempt} onDone={onDone} onFail={onFail} />
    </PrivyProvider>
  )
}
