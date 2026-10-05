import { afterEach, describe, expect, it, vi } from "vitest";

import { McpAuthRequiredError } from "../src/client.js";
import {
  McpAccountBase, type AccountEnv, type ConnectedServer,
} from "../src/account.js";

function fakeContext() {
  const values = new Map<string, unknown>();
  return {
    id: { toString: () => "account-id" },
    storage: {
      async deleteAlarm() {},
      async setAlarm() {},
      kv: {
        get<T>(key: string) { return values.get(key) as T | undefined; },
        put<T>(key: string, value: T) { values.set(key, value); },
        delete(key: string) { values.delete(key); },
      },
    },
  };
}

const testLog = { with() { return testLog; }, info() {}, warn() {} };

const server = (endpoint: string): ConnectedServer => ({
  endpoint,
  serverId: "senpi",
  serverName: "Senpi Agent",
  provenance: "deployment",
  auth: "oauth",
});

// An account that opts into URL-based client ids and requests fixed scopes, standing in for the
// Senpi connector: the AS advertises `client_id_metadata_document_supported`, so the SDK uses the
// metadata URL as the client id and skips dynamic registration.
class UrlClientIdAccount extends McpAccountBase<AccountEnv> {
  protected baseUrl(): string { return "https://gatekeeper.example/gatekeeper/senpi"; }
  protected log(): never { return testLog as never; }
  protected mintAccount(): never { return {} as never; }
  protected override oauthClientMetadataUrl(): string {
    return `${this.baseUrl()}/client-metadata.json`;
  }
  protected override oauthScopes(): string {
    return "agent:read agent:chat";
  }
  protected override async probe(
    _server: ConnectedServer, accessToken: string | null,
  ): Promise<never> {
    if (!accessToken) throw new McpAuthRequiredError("authorization required", null);
    return { serverInfo: { name: "Senpi Agent" } } as never;
  }
}

// A plain account that does not opt into the hooks: the default behavior, dynamic registration.
class PlainAccount extends McpAccountBase<AccountEnv> {
  protected baseUrl(): string { return "https://gatekeeper.example"; }
  protected log(): never { return testLog as never; }
  protected mintAccount(): never { throw new Error("not reached"); }
  protected override async probe(): Promise<never> {
    throw new McpAuthRequiredError("authorization required", null);
  }
}

// An account that enforces a fixed authorization server, standing in for the Senpi connector.
class ExpectedAsAccount extends McpAccountBase<AccountEnv> {
  protected baseUrl(): string { return "https://gatekeeper.example/gatekeeper/senpi"; }
  protected log(): never { return testLog as never; }
  protected mintAccount(): never { return {} as never; }
  protected override oauthClientMetadataUrl(): string {
    return `${this.baseUrl()}/client-metadata.json`;
  }
  protected override oauthAuthorizationServer(): string {
    return "https://senpi-auth-service.prod.senpi.ai";
  }
  protected override async probe(): Promise<never> {
    throw new McpAuthRequiredError("authorization required", null);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("URL-based client id OAuth", () => {
  it("selects the metadata URL as client id with no register request", async () => {
    const context = fakeContext();
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes("oauth-protected-resource")) {
        return Response.json({
          resource: "https://agents.senpi.ai/mcp",
          authorization_servers: ["https://senpi-auth-service.prod.senpi.ai"],
          scopes: ["agent:read", "agent:chat"],
        });
      }
      if (url.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: "https://senpi-auth-service.prod.senpi.ai",
          authorization_endpoint: "https://senpi-auth-service.prod.senpi.ai/authorize",
          token_endpoint: "https://senpi-auth-service.prod.senpi.ai/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          client_id_metadata_document_supported: true,
          scopes_supported: ["agent:read", "agent:chat"],
        });
      }
      return new Response("", { status: 404 });
    });
    const account = new UrlClientIdAccount(context as never, {});
    const nonce = "a".repeat(64);
    await account.prepareReconnect(nonce);

    const outcome = await account.beginConnect(nonce, server("https://agents.senpi.ai/mcp"));
    expect(outcome.kind).toBe("redirect");
    const redirect = new URL((outcome as { url: string }).url);
    // The metadata URL became the client id, so no /register request was made.
    expect(fetched.some((url) => url.endsWith("/register"))).toBe(false);
    expect(redirect.origin).toBe("https://senpi-auth-service.prod.senpi.ai");
    expect(redirect.pathname).toBe("/authorize");
    // The fixed scopes are present, and PKCE was issued.
    expect(redirect.searchParams.get("scope")).toBe("agent:read agent:chat");
    expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
    expect(redirect.searchParams.get("code_challenge")?.length).toBe(43);
    // The resource is the MCP endpoint, per RFC 9728.
    expect(redirect.searchParams.get("resource")).toBe("https://agents.senpi.ai/mcp");
    // The redirect URI is the gatekeeper's own /oauth path.
    expect(redirect.searchParams.get("redirect_uri"))
      .toBe("https://gatekeeper.example/gatekeeper/senpi/oauth");
    // The client id sent to the AS is the metadata document URL.
    expect(redirect.searchParams.get("client_id"))
      .toBe("https://gatekeeper.example/gatekeeper/senpi/client-metadata.json");
    // The stored client information carries the URL-based client id.
    expect(context.storage.kv.get<{ client_id: string }>("oauthClient")?.client_id)
      .toBe("https://gatekeeper.example/gatekeeper/senpi/client-metadata.json");
  });

  it("rejects a replayed OAuth state", async () => {
    const context = fakeContext();
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) {
        return Response.json({
          resource: "https://agents.senpi.ai/mcp",
          authorization_servers: ["https://senpi-auth-service.prod.senpi.ai"],
          scopes: ["agent:read", "agent:chat"],
        });
      }
      if (url.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: "https://senpi-auth-service.prod.senpi.ai",
          authorization_endpoint: "https://senpi-auth-service.prod.senpi.ai/authorize",
          token_endpoint: "https://senpi-auth-service.prod.senpi.ai/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          client_id_metadata_document_supported: true,
          scopes_supported: ["agent:read", "agent:chat"],
        });
      }
      if (url === "https://senpi-auth-service.prod.senpi.ai/token") {
        return Response.json({
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return new Response("", { status: 404 });
    });
    const account = new UrlClientIdAccount(context as never, {});
    const complete = vi.fn();
    const nonce = "b".repeat(64);
    await account.setCallback({ complete } as never, nonce);
    const outcome = await account.beginConnect(nonce, server("https://agents.senpi.ai/mcp"));
    const state = new URL((outcome as { url: string }).url).searchParams.get("state")!;
    const oauthNonce = state.slice(state.indexOf(":") + 1);

    // First exchange consumes the single-use state.
    expect(await account.acceptAuthCode("code-1", oauthNonce)).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    // A replayed state is refused before the token endpoint is reached again.
    expect(await account.acceptAuthCode("code-1", oauthNonce)).toBe(false);
  });
});

describe("default OAuth hooks", () => {
  it("leaves the ordinary DCR flow unchanged when no hooks are overridden", async () => {
    const context = fakeContext();
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) {
        return Response.json({
          resource: "https://mcp.example/mcp",
          authorization_servers: ["https://auth.example"],
        });
      }
      if (url.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: "https://auth.example",
          authorization_endpoint: "https://auth.example/authorize",
          token_endpoint: "https://auth.example/token",
          registration_endpoint: "https://auth.example/register",
          response_types_supported: ["code"],
        });
      }
      if (url === "https://auth.example/register") {
        return Response.json({
          client_id: "client-id",
          redirect_uris: ["https://gatekeeper.example/oauth"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
      }
      return new Response("", { status: 404 });
    });
    const account = new PlainAccount(context as never, {});
    const nonce = "c".repeat(64);
    await account.prepareReconnect(nonce);

    const outcome = await account.beginConnect(nonce, server("https://mcp.example/mcp"));
    expect(outcome.kind).toBe("redirect");
    const redirect = new URL((outcome as { url: string }).url);
    // No URL-based client id: the AS-issued id from /register is used.
    expect(redirect.searchParams.get("client_id")).toBe("client-id");
    // No fixed scopes were requested by the provider, so the SDK falls back to the resource
    // metadata's scopes_supported (empty here), leaving scope absent.
    expect(redirect.searchParams.get("scope")).toBeNull();
  });
});

describe("expected authorization server enforcement", () => {
  it("rejects discovery that points to a different authorization server", async () => {
    const context = fakeContext();
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) {
        return Response.json({
          resource: "https://agents.senpi.ai/mcp",
          authorization_servers: ["https://wrong-auth.example"],
          scopes: ["agent:read", "agent:chat"],
        });
      }
      if (url.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: "https://wrong-auth.example",
          authorization_endpoint: "https://wrong-auth.example/authorize",
          token_endpoint: "https://wrong-auth.example/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      return new Response("", { status: 404 });
    });
    const account = new ExpectedAsAccount(context as never, {});
    const nonce = "d".repeat(64);
    await account.prepareReconnect(nonce);

    const error = await account.beginConnect(nonce, server("https://agents.senpi.ai/mcp"))
      .catch(err => err);
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).toMatch(/expected authorization server/i);
  });

  it("rejects a redirect to a different authorization server origin", async () => {
    const context = fakeContext();
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) {
        return Response.json({
          resource: "https://agents.senpi.ai/mcp",
          authorization_servers: ["https://senpi-auth-service.prod.senpi.ai"],
          scopes: ["agent:read", "agent:chat"],
        });
      }
      if (url.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: "https://senpi-auth-service.prod.senpi.ai",
          // The authorize endpoint is on a different origin than the expected AS.
          authorization_endpoint: "https://evil.example/authorize",
          token_endpoint: "https://senpi-auth-service.prod.senpi.ai/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          client_id_metadata_document_supported: true,
        });
      }
      return new Response("", { status: 404 });
    });
    const account = new ExpectedAsAccount(context as never, {});
    const nonce = "e".repeat(64);
    await account.prepareReconnect(nonce);

    const error = await account.beginConnect(nonce, server("https://agents.senpi.ai/mcp"))
      .catch(err => err);
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).toMatch(/expected authorization server/i);
  });
});
