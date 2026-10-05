import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/**
 * The workerd suite: exercises the real SenpiGatekeeperImpl facet (SQLite state, ActionStore,
 * RPC boundary) through a TestHooks Durable Object, with outbound HTTP mocked. The sibling
 * `vitest.config.ts` keeps the pure-logic tests in Node.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-08",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "global_fetch_strictly_public"],
        durableObjects: {
          SENPI_ACCOUNT: { className: "SenpiAccount", useSQLite: true },
          SENPI_GATEKEEPER: { className: "SenpiGatekeeperImpl", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
          TOGGLEABLE_GATEKEEPER: { className: "ToggleableSenpiGatekeeper", useSQLite: true },
        },
        bindings: {
          SENPI_ENABLED: "true",
          MCP_CLIENT_NAME: "Hoff OS Senpi Research",
          MCP_ALLOW_INSECURE: "false",
          BASE_URL: "https://test.example.com/gatekeeper/senpi",
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
