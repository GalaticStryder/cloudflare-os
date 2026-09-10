// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

// What the shell reads from the router and from auth, set per test.
const testState = vi.hoisted(() => ({
  pathname: '/',
  isAuthenticated: false,
  isLoading: false,
  authenticatedApi: null as RpcStub<AuthenticatedApi> | null,
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: testState.pathname } }),
  Outlet: () => <div data-testid="outlet" />,
}))
vi.mock('./RpcContext', () => ({
  useRpcStub: () => ({}),
  useConnectionLost: () => false,
}))
vi.mock('./useAuth', () => ({
  CF_ACCESS_MODE: false,
  useAuth: () => ({
    isAuthenticated: testState.isAuthenticated,
    authenticatedApi: testState.authenticatedApi,
    isLoading: testState.isLoading,
    error: null,
    logout: vi.fn<() => void>(),
    login: vi.fn<(token: string) => void>(),
  }),
}))
vi.mock('./ConnectHandoffListener', () => ({
  ConnectHandoffListener: () => <div data-testid="handoff-listener" />,
}))
vi.mock('./FeatureFlagsContext', () => ({
  FeatureFlagsProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('./components/Header', () => ({ default: () => <div data-testid="header" /> }))
vi.mock('./components/AppShell/AppShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div>,
}))
vi.mock('./LoginPage', () => ({ default: () => <div data-testid="login-page" /> }))
vi.mock('./OnboardingWizard', () => ({ default: () => null }))
vi.mock('./components/billing/AccountSelectionModal', () => ({ default: () => null }))

import { Route } from './routes/__root'
import { HANDOFF_PATH } from './connectHandoff'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RootComponent = Route.options.component!

// What the authenticated shell and AuthProvider call on mount.
const signedIn = () => ({
  isOnboardingCompleted: async () => true,
  whoami: async () => ({ type: 'user', id: 'alice', name: 'Alice' }),
  amIAdmin: async () => false,
}) as unknown as RpcStub<AuthenticatedApi>

describe('the root route on the connect handoff path', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  async function render() {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<RootComponent />))
    await act(async () => { await Promise.resolve() })
  }
  const has = (testId: string) => container!.querySelector(`[data-testid="${testId}"]`) !== null

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    testState.pathname = '/'
    testState.isAuthenticated = false
    testState.isLoading = false
    testState.authenticatedApi = null
  })

  it('renders the page signed out, without waiting on auth, with no header and no listener', async () => {
    // The popup of a sign-in flow has no session yet, and must not sit on the loading spinner.
    testState.pathname = HANDOFF_PATH
    testState.isLoading = true
    await render()

    expect(has('outlet')).toBe(true)
    expect(has('header')).toBe(false)
    expect(has('login-page')).toBe(false)
    expect(has('handoff-listener')).toBe(false)
    expect(container!.textContent).not.toContain('Loading')
  })

  it('renders the page signed in without the app shell or the handoff listener', async () => {
    // A popup inherits the opener's sessionStorage, connect marker included: a listener here would
    // race the real tab for its own ticket.
    testState.pathname = HANDOFF_PATH
    testState.isAuthenticated = true
    testState.authenticatedApi = signedIn()
    await render()

    expect(has('outlet')).toBe(true)
    expect(has('app-shell')).toBe(false)
    expect(has('header')).toBe(false)
    expect(has('handoff-listener')).toBe(false)
  })

  it('mounts the handoff listener for a signed-in user on any other path', async () => {
    testState.pathname = '/'
    testState.isAuthenticated = true
    testState.authenticatedApi = signedIn()
    await render()

    expect(has('handoff-listener')).toBe(true)
    expect(has('app-shell')).toBe(true)
  })
})
