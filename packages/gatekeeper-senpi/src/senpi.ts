import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import { stripTrailingSlashes, type ActionDescription, type ActionKind, type ApprovalQueue, type Gatekeeper, type GatekeeperConnectCallback, type GatekeeperConnectOptions, type GatekeeperUser, type GatekeeperUserVerifier, type GatekeeperVendor as Vendor, type ResourceConfiguratorFrame, type ResourceDescription, type SupportedResource, type VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { McpAccountBase, type ConnectedServer } from "@gadgets/mcp-shared/account";
import { generateNonce } from "@gadgets/mcp-shared/connect-nonce";
import { withClient, type ConnectionAccount } from "@gadgets/mcp-shared/connection";
import { handleMcpHttpRequest } from "@gadgets/mcp-shared/http";
import { htmlResponse, INVALID_LINK_HTML, SELF_CLOSING_HTML } from "@gadgets/mcp-shared/html";
import { McpGatekeeperUserBase, mcpGatekeeperUserContext, type McpGatekeeperUserProps } from "@gadgets/mcp-shared/user";
import { ActionStore } from "@gadgets/mcp-shared/action-store";
import { observerRefusalMessage } from "@gadgets/mcp-shared/sharing-policy";
import type { McpClient, McpToolCallResult, JsonSchema } from "@gadgets/mcp-shared/client";
import type { McpLog, McpLogFields } from "@gadgets/mcp-shared/log";
import type { SenpiEvidence, SenpiRun, SenpiRunStatus, SenpiResearchSession } from "./types.d.ts";
import SENPI_TYPES from "./types.txt";

export const SENPI_ENDPOINT = "https://agents.senpi.ai/mcp";
export const SENPI_AUTH_SERVER = "https://senpi-auth-service.prod.senpi.ai";
export const SENPI_RESOURCE_URL = "senpi://agent/research";
export const SENPI_SCOPES = "agent:read agent:chat offline_access";
export const ALLOWED_TOOLS = new Set(["read_senpi_guide", "ask_agent", "read_messages", "list_approvals"]);
const OAUTH_ORIGINS = ["https://agents.senpi.ai", SENPI_AUTH_SERVER];
const TOOL_ORIGINS = ["https://agents.senpi.ai"];
const REMOTE_STATUSES = new Set(["final", "running", "busy", "needs_approval", "error", "aborted"]);
const TERMINAL = new Set<SenpiRunStatus>(["idle", "final", "error", "aborted"]);
const RESOURCE: SupportedResource = { urlPattern: SENPI_RESOURCE_URL, title: "Senpi Research", description: "Optional Personal Agent research. Messages require owner review; this connector cannot approve Senpi execution." };
const AVATAR = { url: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#6b46c1"/><path d="M44 20H26a8 8 0 000 16h12a8 8 0 010 16H20" fill="none" stroke="white" stroke-width="4"/></svg>') };
const logger = createLogger<McpLogFields>({ component: "gatekeeper.senpi", vendorId: "senpi" });
const READ_GUIDE = Symbol("readGuide");
const SEND_MESSAGE = Symbol("sendMessage");
const READ_RUN = Symbol("readRun");
const READ_PROPOSALS = Symbol("readProposals");

export function senpiEnabled(env: { SENPI_ENABLED?: string }): boolean { return env.SENPI_ENABLED === "true"; }
function requireEnabled(env: { SENPI_ENABLED?: string }): void {
  if (!senpiEnabled(env)) throw new Error("The Senpi connector is not enabled.");
}
function baseUrl(env: { BASE_URL?: string }): string {
  const value = stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/senpi");
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("Invalid Senpi callback base URL.");
  return value;
}
export function senpiServer(): ConnectedServer {
  return { endpoint: SENPI_ENDPOINT, serverId: "senpi-agent", serverName: "Senpi Agent", provenance: "deployment", auth: "oauth" };
}
export function senpiClientMetadata(url: string) {
  return { client_id: `${url}/client-metadata.json`, client_name: "Hoff OS Senpi Research", redirect_uris: [`${url}/oauth`], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: SENPI_SCOPES };
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export type EvidenceInput = { content?: ReadonlyArray<{ type: string; text?: string }> | null; structuredContent?: unknown; isError?: boolean };
export function payload(result: EvidenceInput): Record<string, unknown> | null {
  if (object(result.structuredContent)) return result.structuredContent;
  const texts = (result.content ?? []).filter(c => c.type === "text");
  if (texts.length !== 1 || typeof texts[0].text !== "string") return null;
  try { const value: unknown = JSON.parse(texts[0].text); return object(value) ? value : null; } catch { return null; }
}
export function isSenpiRunStatus(value: unknown): value is SenpiRunStatus {
  return typeof value === "string" && ["idle", "pending", "running", "final", "busy", "needs_approval", "error", "aborted", "unknown"].includes(value);
}
export function validSessionKey(value: unknown): string | null {
  if (typeof value !== "string" || !value.length || value.length > 2048) return null;
  return Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ? null : value;
}
export function toEvidence(result: EvidenceInput): SenpiEvidence {
  const data = payload(result);
  const text = (result.content ?? []).filter(c => c.type === "text" && typeof c.text === "string").map(c => c.text).join("\n");
  const evidence = { text: text || (data ? JSON.stringify(data) : ""), data, isError: result.isError === true || data?.success === false };
  return new TextEncoder().encode(JSON.stringify(evidence)).length <= 64 * 1024 ? evidence : { text: "Senpi response exceeded the retained evidence limit; its lifecycle could not be confirmed.", data: null, isError: true };
}
export function extractStatus(data: Record<string, unknown> | null): SenpiRunStatus {
  if (!data) return "unknown";
  if (data.success === false) return "error";
  return typeof data.status === "string" && REMOTE_STATUSES.has(data.status) ? data.status as SenpiRunStatus : "unknown";
}
export function schemaAccepts(schema: JsonSchema | undefined, args: Record<string, unknown>): boolean {
  if (!schema || schema.type !== "object") return false;
  const props = schema.properties;
  if (props !== undefined && !object(props)) return false;
  if (Object.keys(args).length > 0 && props === undefined) return false;
  const allowedRoot = new Set(["type", "properties", "required", "additionalProperties", "description", "title", "$schema"]);
  if (Object.keys(schema).some(key => !allowedRoot.has(key))) return false;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string" || !Object.hasOwn(args, key)))) return false;
  for (const [name, value] of Object.entries(args)) {
    const prop = props![name];
    if (!object(prop) || prop.type !== "string" || typeof value !== "string") return false;
    if (Object.keys(prop).some(key => !["type", "description", "title", "default", "minLength", "maxLength", "enum", "const"].includes(key))) return false;
    if (prop.minLength !== undefined && (typeof prop.minLength !== "number" || value.length < prop.minLength)) return false;
    if (prop.maxLength !== undefined && (typeof prop.maxLength !== "number" || value.length > prop.maxLength)) return false;
    if (prop.enum !== undefined && (!Array.isArray(prop.enum) || !prop.enum.includes(value))) return false;
    if (prop.const !== undefined && prop.const !== value) return false;
  }
  return true;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!senpiEnabled(env)) return new Response("Senpi connector is not enabled.", { status: 503 });
    const base = baseUrl(env);
    if (new URL(req.url).pathname === `${new URL(base).pathname}/client-metadata.json`) {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      return new Response(req.method === "HEAD" ? null : JSON.stringify(senpiClientMetadata(base)), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    return handleMcpHttpRequest(req, {
      baseUrl: base,
      accountForId: id => ctx.exports.SenpiAccount.get(ctx.exports.SenpiAccount.idFromString(id)),
      log: logger,
      connect: async (request, account, nonce) => {
        if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
        try {
          const outcome = await account.beginConnect(nonce, senpiServer());
          if (outcome.kind === "invalid") return htmlResponse(INVALID_LINK_HTML, 400);
          if (outcome.kind === "redirect") return Response.redirect(outcome.url, 302);
          return htmlResponse(SELF_CLOSING_HTML);
        } catch {
          logger.warn("Senpi connection failed", { event: "connect.failed" });
          return new Response("Could not connect to Senpi. Please try again.", { status: 502 });
        }
      },
    });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements Vendor {
  async describe(): Promise<VendorDescription> {
    return { displayName: "Senpi Research", url: "https://senpi.ai", logo: AVATAR, color: "#6b46c1", tagline: "Optional Personal Agent research", description: "Send owner-reviewed research requests to Senpi. This connector cannot approve external trading or move funds." };
  }
  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    requireEnabled(this.env);
    const id = this.ctx.exports.SenpiAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.SenpiAccount.get(id).setCallback(callback, nonce);
    return { url: `${baseUrl(this.env)}/${id}/${nonce}` };
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return senpiEnabled(this.env) ? [RESOURCE] : []; }
  async getTypeScriptTypes(): Promise<string> { return SENPI_TYPES; }
}

export class SenpiAccount extends McpAccountBase<Env> {
  protected baseUrl(): string { return baseUrl(this.env); }
  protected log(): McpLog { return logger; }
  protected mintAccount(): Fetcher<GatekeeperUser> {
    return this.ctx.exports.GatekeeperUserImpl({ props: { accountObjectId: this.ctx.id.toString() } });
  }
  protected override oauthClientMetadataUrl(): string { return `${this.baseUrl()}/client-metadata.json`; }
  protected override oauthScopes(): string { return SENPI_SCOPES; }
  protected override oauthAuthorizationServer(): string { return SENPI_AUTH_SERVER; }
  protected override oauthClientMetadata() { return senpiClientMetadata(this.baseUrl()); }
  protected override fetchOptions() { return { ...super.fetchOptions(), allowInsecure: false, allowedOrigins: OAUTH_ORIGINS }; }
  override async beginConnect(nonce: string, target: ConnectedServer | null) {
    requireEnabled(this.env);
    if (target !== null && (target.endpoint !== SENPI_ENDPOINT || target.auth !== "oauth")) throw new Error("Invalid Senpi connection target.");
    return super.beginConnect(nonce, senpiServer());
  }
  override async acceptAuthCode(code: string, nonce: string, issuer?: string): Promise<boolean> {
    requireEnabled(this.env);
    if (issuer !== undefined && issuer !== SENPI_AUTH_SERVER) throw new Error("Unexpected authorization issuer.");
    return super.acceptAuthCode(code, nonce, issuer);
  }
  override async getConnection(endpoint: string) {
    requireEnabled(this.env);
    if (endpoint !== SENPI_ENDPOINT) throw new Error("Invalid Senpi endpoint.");
    return super.getConnection(endpoint);
  }
}

@validateRpc()
export class GatekeeperUserImpl extends McpGatekeeperUserBase<Env> implements GatekeeperUser {
  protected [mcpGatekeeperUserContext]() {
    return { account: this.ctx.exports.SenpiAccount.get(this.ctx.exports.SenpiAccount.idFromString(this.ctx.props.accountObjectId)), avatar: AVATAR, baseUrl: baseUrl(this.env) };
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return senpiEnabled(this.env) ? [RESOURCE] : []; }
  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<unknown>>; resource: SupportedResource }> {
    requireEnabled(this.env);
    if (url !== SENPI_RESOURCE_URL) throw new Error("This connection grants only Senpi research.");
    return { class: this.ctx.exports.SenpiGatekeeperImpl({ props: { accountObjectId: this.ctx.props.accountObjectId } }), resource: RESOURCE };
  }
  async startResourceConfigurator(_pattern: string): Promise<ResourceConfiguratorFrame> { throw new Error("Senpi research uses a fixed resource."); }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.SenpiVerifier({}); }
}
@validateRpc()
export class SenpiVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier { verify(): void {} }

type State = { generation: number | null; guideRead: boolean; sessionKey: string | null; requestId: string | null; run: SenpiRun };
type Receipt = { message: string; generation: number; run: SenpiRun };
const idle = (): SenpiRun => ({ status: "idle", actionId: null, evidence: null });
function quoteUntrusted(message: string): string {
  const encoded = JSON.stringify(message).replaceAll("`", "\\u0060").replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
  return "```json\n" + encoded + "\n```";
}

export class SenpiGatekeeperImpl extends DurableObject<Env, McpGatekeeperUserProps> implements Gatekeeper<SenpiSession> {
  #actions: ActionStore | undefined;
  #busy = false;
  #store(): ActionStore { return this.#actions ??= new ActionStore(this.ctx.storage.sql); }
  #state(): State { return this.ctx.storage.kv.get<State>("research") ?? { generation: null, guideRead: false, sessionKey: null, requestId: null, run: idle() }; }
  #save(state: State): void {
    this.ctx.storage.kv.put("research", state);
    if (state.requestId) {
      const key = `request:${state.requestId}`;
      const receipt = this.ctx.storage.kv.get<Receipt>(key);
      if (receipt) this.ctx.storage.kv.put(key, { ...receipt, run: state.run });
    }
  }
  #account(): ConnectionAccount { return this.ctx.exports.SenpiAccount.get(this.ctx.exports.SenpiAccount.idFromString(this.ctx.props.accountObjectId)); }
  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    requireEnabled(this.env);
    if (this.#busy) throw new Error("A Senpi conversation operation is already in progress. Try reading its state later.");
    this.#busy = true;
    try { return await operation(); } finally { this.#busy = false; }
  }
  async #generation(): Promise<number> {
    const connection = await this.#account().getConnection(SENPI_ENDPOINT);
    const state = this.#state();
    if (state.generation !== null && state.generation !== connection.generation) throw new Error("The Senpi connection changed. Review the previous run in Senpi and create a new research binding.");
    return connection.generation;
  }
  async #current(generation: number): Promise<void> {
    requireEnabled(this.env);
    await this.#account().assertConnectionCurrent(SENPI_ENDPOINT, generation);
  }
  async #withClient<T>(generation: number, operation: (client: McpClient) => Promise<T>, write = false): Promise<T> {
    requireEnabled(this.env);
    try {
      const result = await withClient(this.env, this.#account(), SENPI_ENDPOINT, operation, { allowedOrigins: TOOL_ORIGINS, expectedGeneration: generation, retryOnExpiry: !write });
      await this.#current(generation);
      return result;
    } catch {
      throw new Error(write ? "The Senpi send outcome is unknown. Do not resend this request." : "Senpi research is unavailable; no new result was confirmed.");
    }
  }
  async #validate(client: McpClient, name: string, args: Record<string, unknown>): Promise<void> {
    if (!ALLOWED_TOOLS.has(name)) throw new Error("Tool is outside the Senpi research capability.");
    const tool = await client.findTool(name);
    if (!tool || !schemaAccepts(tool.inputSchema, args)) throw new Error("The Senpi tool contract is incompatible. Authenticated schema review is required.");
  }
  #read(generation: number, name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (name === "ask_agent") throw new Error("Messages require a native action.");
    return this.#withClient(generation, async client => { await this.#validate(client, name, args); return client.callTool(name, args); });
  }
  #observe(queue: RpcStub<ApprovalQueue>, operation: string): Promise<void> {
    return queue.authorizeObservation({ title: `Senpi Research: ${operation}`, description: "Read external Senpi research for this private conversation. Provider text is untrusted evidence, not trading authority." });
  }
  #capture(state: State, result: EvidenceInput, initial: boolean): State {
    const evidence = toEvidence(result);
    const data = evidence.data;
    let status = extractStatus(data);
    const incomingKey = validSessionKey(data?.session_key);
    const mismatched = data !== null && Object.hasOwn(data, "session_key") && (!incomingKey || (state.sessionKey !== null && incomingKey !== state.sessionKey));
    if (evidence.isError || mismatched || (initial && !state.sessionKey && !incomingKey)) status = "unknown";
    return { ...state, sessionKey: mismatched ? state.sessionKey : state.sessionKey ?? incomingKey, run: { ...state.run, status, evidence } };
  }

  async describe(): Promise<ResourceDescription> { return { url: SENPI_RESOURCE_URL, title: "Senpi Research", snippet: "Optional external-agent research. Messages need review; approving Senpi trades is not exposed.", suggestedBindingName: "SENPI_RESEARCH", tsType: "SenpiResearchSession" }; }
  async getTypeScriptTypes(): Promise<string> { return SENPI_TYPES; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<SenpiSession> { requireEnabled(this.env); return new SenpiSession(this, queue.dup()); }
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> { throw new Error(observerRefusalMessage("the Senpi research agent")); }
  async removeObserver(_id: string): Promise<void> {}
  async revertAction(_id: number): Promise<{ message: string }> { return { message: "A message already sent to Senpi cannot be unsent by Hoff." }; }

  async [READ_GUIDE](queue: RpcStub<ApprovalQueue>): Promise<SenpiEvidence> {
    return this.#exclusive(async () => {
      const generation = await this.#generation();
      const evidence = toEvidence(await this.#read(generation, "read_senpi_guide", {}));
      await this.#observe(queue, "read guide");
      await this.#current(generation);
      if (!evidence.isError) this.#save({ ...this.#state(), generation, guideRead: true });
      return evidence;
    });
  }
  async [SEND_MESSAGE](queue: RpcStub<ApprovalQueue>, message: string, requestId: string): Promise<SenpiRun> {
    return this.#exclusive(async () => {
      if (typeof message !== "string" || !message.trim() || new TextEncoder().encode(message).length > 12000) throw new Error("Message must contain 1–12000 UTF-8 bytes.");
      if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) throw new Error("Invalid research request ID.");
      const generation = await this.#generation();
      const receipt = this.ctx.storage.kv.get<Receipt>(`request:${requestId}`);
      if (receipt) {
        if (receipt.message !== message) throw new Error("This request ID was already used with a different message.");
        if (receipt.generation !== generation) throw new Error("This request belongs to a previous connection.");
        await this.#observe(queue, "read existing request");
        await this.#current(generation);
        return receipt.run;
      }
      const state = this.#state();
      if (!state.guideRead) throw new Error("Call readGuide() successfully before sending a message.");
      if (!TERMINAL.has(state.run.status)) throw new Error("A Senpi request is pending or its outcome is unknown. Read the existing run; do not resend it.");
      const count = this.ctx.storage.kv.get<number>("requestCount") ?? 0;
      if (count >= 1000) throw new Error("This research conversation has reached its request-history limit.");
      const args = { message, ...(state.sessionKey ? { session_key: state.sessionKey } : {}) };
      await this.#withClient(generation, client => this.#validate(client, "ask_agent", args));
      await this.#current(generation);
      const action = this.#store().stage("ask_agent", args);
      const run: SenpiRun = { status: "pending", actionId: action.id, evidence: null };
      this.ctx.storage.kv.put(`request:${requestId}`, { message, generation, run } satisfies Receipt);
      this.ctx.storage.kv.put("requestCount", count + 1);
      this.#save({ ...state, generation, requestId, run });
      const description: ActionDescription = { title: "Senpi Research: send message", description: `Send the following message to your external Senpi Personal Agent. This shares its content with Senpi and may consume credits. It does not approve any resulting trade.\n\n${quoteUntrusted(message)}`, implementsRevert: false, awaitDecision: true, autoApprovable: false, actionKind: { tag: "senpi:send-message", label: "Send Senpi research message" } };
      try {
        await queue.submitAction(action.id, description);
      } catch {
        this.#store().reject(action.id);
        this.#save({ ...this.#state(), run: { ...run, status: "aborted", evidence: { text: "The message was not dispatched because native submission failed.", data: null, isError: true } } });
        throw new Error("The research request could not be submitted for review. It was not sent to Senpi.");
      }
      return run;
    });
  }
  async applyAction(actionId: number): Promise<void> {
    return this.#exclusive(async () => {
      const stored = this.#store().get(actionId);
      if (!stored) throw new Error("Unknown Senpi request.");
      if (stored.state === "applied") return;
      if (stored.state !== "pending" || stored.toolName !== "ask_agent") throw new Error("This Senpi request cannot be dispatched again.");
      const state = this.#state();
      if (state.run.actionId !== actionId || state.run.status !== "pending" || !state.requestId) throw new Error("This is not the active pending request.");
      const generation = await this.#generation();
      if (!state.guideRead || state.generation !== generation) throw new Error("The guide or connection is no longer current.");
      await this.#current(generation);
      this.#save({ ...state, run: { ...state.run, status: "unknown", evidence: null } });
      try {
        await this.#store().apply(actionId, fn => this.#withClient(generation, async client => {
          await this.#validate(client, "ask_agent", stored.args);
          return fn(client);
        }, true), logger);
      } catch {
        throw new Error("The Senpi send outcome could not be confirmed. Do not resend it; inspect the run in Senpi.");
      }
      const result = this.#store().get(actionId)?.result;
      if (result) this.#save(this.#capture(this.#state(), result, true));
    });
  }
  async rejectAction(actionId: number): Promise<void> {
    return this.#exclusive(async () => {
      this.#store().reject(actionId);
      const state = this.#state();
      if (state.run.actionId === actionId && state.run.status === "pending") this.#save({ ...state, run: { ...state.run, status: "aborted", evidence: { text: "The owner rejected this message; it was not sent to Senpi.", data: null, isError: false } } });
    });
  }
  async [READ_RUN](queue: RpcStub<ApprovalQueue>): Promise<SenpiRun> {
    return this.#exclusive(async () => {
      const generation = await this.#generation();
      let state = this.#state();
      if (["running", "busy", "needs_approval"].includes(state.run.status) && state.sessionKey) {
        const result = await this.#read(generation, "read_messages", { session_key: state.sessionKey });
        state = this.#capture(state, result, false);
      }
      await this.#observe(queue, "read run");
      await this.#current(generation);
      this.#save(state);
      return state.run;
    });
  }
  async [READ_PROPOSALS](queue: RpcStub<ApprovalQueue>): Promise<SenpiEvidence> {
    return this.#exclusive(async () => {
      const generation = await this.#generation();
      const state = this.#state();
      const evidence = state.sessionKey ? toEvidence(await this.#read(generation, "list_approvals", { session_key: state.sessionKey })) : { text: "No Senpi session has been established.", data: null, isError: false };
      await this.#observe(queue, "read pending proposals");
      await this.#current(generation);
      return evidence;
    });
  }
}

@validateRpc()
export class SenpiSession extends RpcTarget implements SenpiResearchSession {
  #host: SenpiGatekeeperImpl;
  #queue: RpcStub<ApprovalQueue>;
  constructor(host: SenpiGatekeeperImpl, queue: RpcStub<ApprovalQueue>) { super(); this.#host = host; this.#queue = queue; }
  [Symbol.dispose](): void { this.#queue[Symbol.dispose](); }
  readGuide(): Promise<SenpiEvidence> { return this.#host[READ_GUIDE](this.#queue); }
  sendMessage(message: string, requestId: string): Promise<SenpiRun> { return this.#host[SEND_MESSAGE](this.#queue, message, requestId); }
  readRun(): Promise<SenpiRun> { return this.#host[READ_RUN](this.#queue); }
  listPendingProposals(): Promise<SenpiEvidence> { return this.#host[READ_PROPOSALS](this.#queue); }
}
