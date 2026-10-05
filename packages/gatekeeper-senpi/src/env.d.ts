// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    BASE_URL?: string;
    MCP_ALLOW_INSECURE?: string;
    MCP_CLIENT_NAME?: string;
    SENPI_ENABLED?: string;
  }

  interface GlobalProps {
    mainModule: typeof import("./senpi.js");
    durableNamespaces: "SenpiAccount" | "SenpiGatekeeperImpl";
  }
}

interface Env extends Cloudflare.Env {}

// Wrangler's Text module rule serves `*.txt` files as their string contents.
declare module "*.txt" {
  const content: string;
  export default content;
}
