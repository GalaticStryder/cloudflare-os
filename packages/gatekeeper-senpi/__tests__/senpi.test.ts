import { afterEach, describe, expect, it, vi } from "vitest";

import { McpAuthRequiredError } from "@gadgets/mcp-shared/client";
import senpiWorker, {
  ALLOWED_TOOLS,
  SENPI_ENDPOINT,
  SENPI_RESOURCE_URL,
  SENPI_SCOPES,
  SenpiAccount,
  senpiClientMetadata,
  senpiEnabled,
  senpiServer,
} from "../src/senpi.js";

describe("Senpi constants", () => {
  it("uses the fixed Senpi agent endpoint", () => {
    expect(SENPI_ENDPOINT).toBe("https://agents.senpi.ai/mcp");
  });

  it("requests the documented research scopes", () => {
    expect(SENPI_SCOPES).toBe("agent:read agent:chat offline_access");
  });

  it("exposes exactly the research-only resource URL", () => {
    expect(SENPI_RESOURCE_URL).toBe("senpi://agent/research");
  });

  it("includes the four research tools in the allowlist", () => {
    expect(ALLOWED_TOOLS.has("read_senpi_guide")).toBe(true);
    expect(ALLOWED_TOOLS.has("ask_agent")).toBe(true);
    expect(ALLOWED_TOOLS.has("read_messages")).toBe(true);
    expect(ALLOWED_TOOLS.has("list_approvals")).toBe(true);
  });

  it("excludes resolve_approval from the allowlist", () => {
    expect(ALLOWED_TOOLS.has("resolve_approval")).toBe(false);
  });

  it("excludes unknown tools from the allowlist", () => {
    expect(ALLOWED_TOOLS.has("unknown_tool")).toBe(false);
    expect(ALLOWED_TOOLS.has("")).toBe(false);
  });
});

describe("senpiEnabled", () => {
  it("returns false when SENPI_ENABLED is undefined", () => {
    expect(senpiEnabled({})).toBe(false);
  });

  it("returns false when SENPI_ENABLED is not 'true'", () => {
    expect(senpiEnabled({ SENPI_ENABLED: "false" })).toBe(false);
    expect(senpiEnabled({ SENPI_ENABLED: "" })).toBe(false);
    expect(senpiEnabled({ SENPI_ENABLED: "yes" })).toBe(false);
  });

  it("returns true only when SENPI_ENABLED is exactly 'true'", () => {
    expect(senpiEnabled({ SENPI_ENABLED: "true" })).toBe(true);
    expect(senpiEnabled({ SENPI_ENABLED: "True" })).toBe(false);
    expect(senpiEnabled({ SENPI_ENABLED: "TRUE" })).toBe(false);
  });
});

describe("senpiServer", () => {
  it("returns a deployment-provenance server with the fixed endpoint", () => {
    const server = senpiServer();
    expect(server.endpoint).toBe(SENPI_ENDPOINT);
    expect(server.serverId).toBe("senpi-agent");
    expect(server.serverName).toBe("Senpi Agent");
    expect(server.provenance).toBe("deployment");
    expect(server.auth).toBe("oauth");
  });
});

describe("senpiClientMetadata", () => {
  const baseUrl = "https://gatekeeper.example/gatekeeper/senpi";

  it("uses the metadata URL as the client id", () => {
    expect(senpiClientMetadata(baseUrl).client_id).toBe(
      `${baseUrl}/client-metadata.json`,
    );
  });

  it("reports the documented client name", () => {
    expect(senpiClientMetadata(baseUrl).client_name).toBe("Hoff OS Senpi Research");
  });

  it("declares the OAuth redirect URI", () => {
    expect(senpiClientMetadata(baseUrl).redirect_uris).toEqual([`${baseUrl}/oauth`]);
  });

  it("declares authorization_code and refresh_token grant types", () => {
    expect(senpiClientMetadata(baseUrl).grant_types).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
  });

  it("declares code response type with no client secret", () => {
    expect(senpiClientMetadata(baseUrl).response_types).toEqual(["code"]);
    expect(senpiClientMetadata(baseUrl).token_endpoint_auth_method).toBe("none");
  });

  it("includes the fixed research scopes", () => {
    expect(senpiClientMetadata(baseUrl).scope).toBe(SENPI_SCOPES);
  });
});

describe("metadata HTTP", () => {
  const base = "https://test.example.com/gatekeeper/senpi";
  const metadataPath = "/gatekeeper/senpi/client-metadata.json";

  it("returns 503 when disabled", async () => {
    const req = new Request(`https://test.example.com${metadataPath}`);
    const res = await senpiWorker.fetch(req, { SENPI_ENABLED: "false", BASE_URL: base }, {} as never);
    expect(res.status).toBe(503);
  });

  it("returns metadata JSON on GET", async () => {
    const req = new Request(`https://test.example.com${metadataPath}`);
    const res = await senpiWorker.fetch(req, { SENPI_ENABLED: "true", BASE_URL: base }, {} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json() as { client_name: string; scope: string; grant_types: string[] };
    expect(body.client_name).toBe("Hoff OS Senpi Research");
    expect(body.scope).toBe("agent:read agent:chat offline_access");
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
  });

  it("returns no body on HEAD", async () => {
    const req = new Request(`https://test.example.com${metadataPath}`, { method: "HEAD" });
    const res = await senpiWorker.fetch(req, { SENPI_ENABLED: "true", BASE_URL: base }, {} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.text()).toBe("");
  });

  it("returns 405 for unsupported methods", async () => {
    const req = new Request(`https://test.example.com${metadataPath}`, { method: "POST" });
    const res = await senpiWorker.fetch(req, { SENPI_ENABLED: "true", BASE_URL: base }, {} as never);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
  });
});

const SENPI_BASE_URL = "https://gatekeeper.example/gatekeeper/senpi";
const SENPI_PRM_URL = "https://agents.senpi.ai/.well-known/oauth-protected-resource/mcp";
const SENPI_AS = "https://senpi-auth-service.prod.senpi.ai";

function fakeSenpiContext() {
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

const senpiTestLog = { with() { return senpiTestLog; }, info() {}, warn() {} };

class TestSenpiAccount extends SenpiAccount {
  protected override log(): never { return senpiTestLog as never; }
  protected override mintAccount(): never { return {} as never; }
  protected override async probe(): Promise<never> {
    throw new McpAuthRequiredError("authorization required", SENPI_PRM_URL);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("Senpi OAuth scope regression", () => {
  it("authorize URL scope matches client metadata scope (both include offline_access once)", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      fetched.push(url);
      const method = init?.method ?? "GET";
      if (url === SENPI_PRM_URL && method === "GET") {
        return Response.json({
          resource: SENPI_ENDPOINT,
          authorization_servers: [SENPI_AS],
          scopes_supported: ["agent:read", "agent:chat"],
        });
      }
      if (url === `${SENPI_AS}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer: SENPI_AS,
          authorization_endpoint: `${SENPI_AS}/oauth/authorize`,
          token_endpoint: `${SENPI_AS}/oauth/token`,
          code_challenge_methods_supported: ["S256"],
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          client_id_metadata_document_supported: true,
          scopes_supported: ["agent:read", "agent:chat", "offline_access"],
        });
      }
      return new Response("", { status: 404 });
    });

    const env = { SENPI_ENABLED: "true", BASE_URL: SENPI_BASE_URL } as Env;
    const account = new TestSenpiAccount(fakeSenpiContext() as never, env);
    const nonce = "a".repeat(64);
    await account.prepareReconnect(nonce);

    const outcome = await account.beginConnect(nonce, senpiServer());
    expect(outcome.kind).toBe("redirect");
    const redirect = new URL((outcome as { url: string }).url);

    const authorizeScopes = redirect.searchParams.get("scope")!.split(" ").toSorted();
    const metadataScopes = senpiClientMetadata(SENPI_BASE_URL).scope!.split(" ").toSorted();
    expect(authorizeScopes).toEqual(metadataScopes);
    expect(authorizeScopes).toEqual(["agent:chat", "agent:read", "offline_access"]);
    expect(authorizeScopes.filter((s) => s === "offline_access").length).toBe(1);
    expect(redirect.searchParams.get("prompt")).toBe("consent");
    expect(redirect.searchParams.get("client_id")).toBe(`${SENPI_BASE_URL}/client-metadata.json`);
    expect(redirect.searchParams.get("redirect_uri")).toBe(`${SENPI_BASE_URL}/oauth`);
    expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
    expect(redirect.searchParams.get("code_challenge")?.length).toBe(43);
    expect(redirect.searchParams.get("resource")).toBe(SENPI_ENDPOINT);
    expect(fetched.some((u) => u.endsWith("/register"))).toBe(false);
  });
});
