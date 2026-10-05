/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Test-only environment types for the workerd suite. Augments `Cloudflare.Env` with the bindings
// declared in `vitest.worker.config.ts` (absent from `worker-configuration.d.ts`). The production
// `src/env.d.ts` is still included for `GlobalProps`, the `*.txt` module declaration, and the base
// `Cloudflare.Env` vars. `SENPI_ACCOUNT` is the test `SenpiAccount` subclass (with
// `setupTestConnection`), typed by the binding rather than `ctx.exports` so no cast is needed.

import type { TestHooks, SenpiAccount, ToggleableSenpiGatekeeper } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      SENPI_ACCOUNT: DurableObjectNamespace<SenpiAccount>;
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
      TOGGLEABLE_GATEKEEPER: DurableObjectNamespace<ToggleableSenpiGatekeeper>;
    }
  }
}
