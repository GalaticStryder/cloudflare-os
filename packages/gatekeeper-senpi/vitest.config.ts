import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    exclude: ["__tests__/workerd/**"],
    environment: "node",
    alias: {
      // Lets modules that declare a Durable Object or an `RpcTarget` be imported at all. See the
      // stub for what it does and does not provide.
      "cloudflare:workers": fileURLToPath(
        new URL("./__tests__/stubs/cloudflare-workers.ts", import.meta.url)),
      // capnweb-validate decorators need a compiler transform not available under plain vitest.
      "capnweb-validate": fileURLToPath(
        new URL("./__tests__/stubs/capnweb-validate.ts", import.meta.url)),
    },
  },
});
