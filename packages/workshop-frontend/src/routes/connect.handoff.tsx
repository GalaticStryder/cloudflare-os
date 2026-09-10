import { createFileRoute } from '@tanstack/react-router'
import ConnectHandoffPage from '../ConnectHandoffPage'

/**
 * The public, standalone page a gatekeeper on another origin redirects a finished connect popup to.
 * The literal stays equal to `HANDOFF_PATH` (connectHandoff.ts), the path the gatekeeper-kit
 * completion page redirects to; connectHandoff.test.tsx pins the two together.
 */
export const Route = createFileRoute('/connect/handoff')({
  component: ConnectHandoffPage,
})
