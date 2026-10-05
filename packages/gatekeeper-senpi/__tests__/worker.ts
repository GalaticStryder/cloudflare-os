// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds a hook Durable Object for the code that depends on `ctx.props`.
//
// `TestHooks` has to be a Durable Object rather than a WorkerEntrypoint: a `DurableObjectClass` from
// `ctx.exports.X({props})` is only reachable through `ctx.facets`, which is the same way the overseer
// instantiates a gatekeeper in production.
//
// `SenpiAccount` here extends the production `SenpiAccount` with a test-only setup method that writes
// mock credentials directly to KV, bypassing the OAuth flow. In production, credentials are only ever
// set through the OAuth flow; this method exists solely so workerd tests can exercise the real
// session/queue path.
//
// The TestHooks DO wraps session calls and catches errors internally, returning structured results.
// This avoids unhandled rejections from the RPC boundary when session methods throw expected errors.

import { DurableObject, RpcTarget } from "cloudflare:workers";
import type { ActionDescription, ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { ConnectedServer } from "@gadgets/mcp-shared/account";

import { SenpiAccount as SenpiAccountBase, SenpiGatekeeperImpl, SenpiSession } from "../src/senpi.js";

export { default } from "../src/senpi.js";
export { SenpiGatekeeperImpl, GatekeeperVendor, GatekeeperUserImpl, SenpiVerifier } from "../src/senpi.js";

/** A SenpiGatekeeperImpl subclass whose env can be toggled to `SENPI_ENABLED="false"` mid-test. */
export class ToggleableSenpiGatekeeper extends SenpiGatekeeperImpl {
  #disabled = false;
  #realEnv?: Env;
  /** Toggles whether the facet sees SENPI_ENABLED as "false". Test-only. */
  async setDisabled(disabled: boolean): Promise<void> {
    if (this.#realEnv === undefined) {
      this.#realEnv = this.env;
      Object.defineProperty(this, "env", {
        get: () => this.#disabled ? { ...this.#realEnv!, SENPI_ENABLED: "false" } : this.#realEnv!,
        configurable: true,
      });
    }
    this.#disabled = disabled;
  }
}

/** A SenpiAccount that can be set up with mock credentials for testing. */
export class SenpiAccount extends SenpiAccountBase {
  /** Sets up mock credentials, bypassing the OAuth flow. Test-only. */
  async setupTestConnection(server: ConnectedServer, accessToken: string, generation: number): Promise<void> {
    this.ctx.storage.kv.put("server", server);
    this.ctx.storage.kv.put("connectionGeneration", generation);
    this.ctx.storage.kv.put("tokens", {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      issuer: "https://senpi-auth-service.prod.senpi.ai",
      expiresAt: Date.now() + 3600 * 1000,
    });
    this.ctx.storage.kv.put("expiredNotified", false);
  }
}

export type Observation = { title: string; description: string };
export type Submission = { action: number; description: ActionDescription };

/** A test approval queue that records observations and submissions. */
export class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  #observations: Observation[] = [];
  #submissions: Submission[] = [];
  #disposed = 0;
  #failSubmission = false;
  #failObservation = false;

  get observations(): Observation[] { return this.#observations; }
  get submissions(): Submission[] { return this.#submissions; }
  get disposed(): number { return this.#disposed; }
  get failSubmission(): boolean { return this.#failSubmission; }
  set failSubmission(value: boolean) { this.#failSubmission = value; }
  get failObservation(): boolean { return this.#failObservation; }
  set failObservation(value: boolean) { this.#failObservation = value; }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    if (this.#failObservation) throw new Error("observation rejected");
    this.#observations.push({ title: description.title, description: description.description });
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    if (this.#failSubmission) throw new Error("submission rejected");
    this.#submissions.push({ action, description });
  }

  async bindHook(): Promise<void> { throw new Error("Research does not register hooks."); }
  async bindHookForGadget(): Promise<void> { throw new Error("Research does not register hooks."); }

  [Symbol.dispose](): void {
    this.#disposed++;
  }
}

export class TestHooks extends DurableObject<Env> {
  #queues = new Map<string, TestApprovalQueue>();
  #facets = new Map<string, Fetcher<SenpiGatekeeperImpl>>();
  #toggleableFacets = new Map<string, Fetcher<ToggleableSenpiGatekeeper>>();
  #sessions = new Map<string, Rpc.Stub<SenpiSession>>();
  #accountIds = new Map<string, string>();

  #gatekeeper(accountObjectId: string) {
    const facetName = `SENPI_GATEKEEPER_${accountObjectId}`;
    return this.ctx.facets.get<SenpiGatekeeperImpl>(facetName, () => ({
      class: this.ctx.exports.SenpiGatekeeperImpl({ props: { accountObjectId } }),
    }));
  }

  #account(accountObjectId: string) {
    return this.env.SENPI_ACCOUNT.get(
      this.env.SENPI_ACCOUNT.idFromString(accountObjectId),
    );
  }

  #accountId(accountKey: string): string {
    let id = this.#accountIds.get(accountKey);
    if (!id) {
      id = this.env.SENPI_ACCOUNT.newUniqueId().toString();
      this.#accountIds.set(accountKey, id);
    }
    return id;
  }

  /** Sets up mock credentials on the SenpiAccount DO. */
  async setupAccount(accountKey: string, accessToken: string, generation: number = 1): Promise<void> {
    const id = this.#accountId(accountKey);
    const server: ConnectedServer = {
      endpoint: "https://agents.senpi.ai/mcp",
      serverId: "senpi-agent",
      serverName: "Senpi Agent",
      provenance: "deployment",
      auth: "oauth",
    };
    await this.#account(id).setupTestConnection(server, accessToken, generation);
  }

  /** Reconnects the account to a new generation. */
  async reconnectAccount(accountKey: string, accessToken: string, generation: number): Promise<void> {
    const id = this.#accountId(accountKey);
    const server: ConnectedServer = {
      endpoint: "https://agents.senpi.ai/mcp",
      serverId: "senpi-agent",
      serverName: "Senpi Agent",
      provenance: "deployment",
      auth: "oauth",
    };
    await this.#account(id).setupTestConnection(server, accessToken, generation);
  }

  /** Creates a session for the account. */
  async startSession(accountKey: string): Promise<void> {
    const id = this.#accountId(accountKey);
    const queue = new TestApprovalQueue();
    this.#queues.set(accountKey, queue);
    const facet = this.#gatekeeper(id);
    this.#facets.set(accountKey, facet);
    const session = await facet.startSession(queue);
    this.#sessions.set(accountKey, session);
  }

  /** Creates a session on a ToggleableSenpiGatekeeper facet whose env can be disabled mid-test. */
  async startToggleableSession(accountKey: string): Promise<void> {
    const id = this.#accountId(accountKey);
    const queue = new TestApprovalQueue();
    this.#queues.set(accountKey, queue);
    // ToggleableSenpiGatekeeper is exported from the test worker (the main module) but not declared
    // in the production GlobalProps.durableNamespaces, so ctx.exports needs a typed extension.
    const exports = this.ctx.exports as typeof this.ctx.exports & {
      ToggleableSenpiGatekeeper(options: { props: { accountObjectId: string } }): DurableObjectClass<ToggleableSenpiGatekeeper>;
    };
    const facet = this.ctx.facets.get<ToggleableSenpiGatekeeper>(`TOGGLEABLE_${accountKey}`, () => ({
      class: exports.ToggleableSenpiGatekeeper({ props: { accountObjectId: id } }),
    }));
    this.#toggleableFacets.set(accountKey, facet);
    const session = await facet.startSession(queue);
    this.#sessions.set(accountKey, session);
  }

  /** Toggles the ToggleableSenpiGatekeeper facet's SENPI_ENABLED between "true" and "false". */
  async setDisabled(accountKey: string, disabled: boolean): Promise<void> {
    const facet = this.#toggleableFacets.get(accountKey);
    if (facet) await facet.setDisabled(disabled);
  }

  /** Calls readGuide on the session, catching errors. */
  async readGuide(accountKey: string): Promise<{ ok: boolean; value: string | null; error: string }> {
    const session = this.#sessions.get(accountKey);
    if (!session) return { ok: false, value: null, error: "No session." };
    try {
      const value = await session.readGuide();
      return { ok: true, value: JSON.stringify(value), error: "" };
    } catch (err) {
      return { ok: false, value: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Calls sendMessage on the session, catching errors. */
  async sendMessage(accountKey: string, message: string, requestId: string): Promise<{ ok: boolean; value: string | null; error: string }> {
    const session = this.#sessions.get(accountKey);
    if (!session) return { ok: false, value: null, error: "No session." };
    try {
      const value = await session.sendMessage(message, requestId);
      return { ok: true, value: JSON.stringify(value), error: "" };
    } catch (err) {
      return { ok: false, value: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Calls readRun on the session, catching errors. */
  async readRun(accountKey: string): Promise<{ ok: boolean; value: string | null; error: string }> {
    const session = this.#sessions.get(accountKey);
    if (!session) return { ok: false, value: null, error: "No session." };
    try {
      const value = await session.readRun();
      return { ok: true, value: JSON.stringify(value), error: "" };
    } catch (err) {
      return { ok: false, value: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Calls listPendingProposals on the session, catching errors. */
  async listPendingProposals(accountKey: string): Promise<{ ok: boolean; value: string | null; error: string }> {
    const session = this.#sessions.get(accountKey);
    if (!session) return { ok: false, value: null, error: "No session." };
    try {
      const value = await session.listPendingProposals();
      return { ok: true, value: JSON.stringify(value), error: "" };
    } catch (err) {
      return { ok: false, value: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Applies a staged action through the facet's native approval path. */
  async apply(accountKey: string, actionId: number): Promise<{ ok: boolean; value: string | null; error: string }> {
    const facet = this.#facets.get(accountKey) ?? this.#toggleableFacets.get(accountKey);
    if (!facet) return { ok: false, value: null, error: "No session." };
    try {
      await facet.applyAction(actionId);
      return { ok: true, value: null, error: "" };
    } catch (err) {
      return { ok: false, value: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Rejects a staged action through the facet's native approval path. */
  async reject(accountKey: string, actionId: number): Promise<{ ok: boolean; value: string | null; error: string }> {
    const facet = this.#facets.get(accountKey) ?? this.#toggleableFacets.get(accountKey);
    if (!facet) return { ok: false, value: null, error: "No session." };
    try {
      await facet.rejectAction(actionId);
      return { ok: true, value: null, error: "" };
    } catch (err) {
      return { ok: false, value: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Probes a forbidden method on the session, returning the error or null if it succeeded. */
  async probeForbiddenMethod(accountKey: string, method: string, ...args: unknown[]): Promise<string | null> {
    const session = this.#sessions.get(accountKey);
    if (!session) return "No session.";
    try {
      const fn = Reflect.get(session, method) as ((...a: unknown[]) => Promise<unknown>) | undefined;
      if (typeof fn !== "function") return `method '${method}' not found`;
      await Reflect.apply(fn, session, args);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Returns the number of observations recorded on the approval queue. */
  async observationCount(accountKey: string): Promise<number> {
    return this.#queues.get(accountKey)?.observations.length ?? 0;
  }

  /** Returns the observations recorded on the approval queue. */
  async observations(accountKey: string): Promise<Observation[]> {
    return [...(this.#queues.get(accountKey)?.observations ?? [])];
  }

  /** Returns the number of submissions recorded on the approval queue. */
  async submissionCount(accountKey: string): Promise<number> {
    return this.#queues.get(accountKey)?.submissions.length ?? 0;
  }

  /** Returns the submissions recorded on the approval queue, JSON-serialized for the RPC boundary. */
  async submissions(accountKey: string): Promise<string> {
    return JSON.stringify([...(this.#queues.get(accountKey)?.submissions ?? [])]);
  }

  /** Sets whether submitAction should reject. */
  async setFailSubmission(accountKey: string, fail: boolean): Promise<void> {
    const queue = this.#queues.get(accountKey);
    if (queue) queue.failSubmission = fail;
  }

  /** Sets whether authorizeObservation should reject. */
  async setFailObservation(accountKey: string, fail: boolean): Promise<void> {
    const queue = this.#queues.get(accountKey);
    if (queue) queue.failObservation = fail;
  }

  /** Returns the number of times the approval queue was disposed. */
  async disposeCount(accountKey: string): Promise<number> {
    return this.#queues.get(accountKey)?.disposed ?? 0;
  }

  /** Disposes the session and its approval queue. */
  async disposeSession(accountKey: string): Promise<void> {
    const session = this.#sessions.get(accountKey);
    if (session) session[Symbol.dispose]();
  }
}
