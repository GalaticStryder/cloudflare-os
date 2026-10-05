// Workerd behavioral tests for the Senpi gatekeeper. Exercises the real SenpiGatekeeperImpl facet
// (SQLite state, ActionStore, RPC boundary) through a TestHooks Durable Object, with outbound HTTP
// mocked. Covers the full request lifecycle: guide, send, apply, poll, reject, concurrency,
// connection generation, disabled runtime, and boundary denial of unknown methods.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SenpiEvidence, SenpiRun } from "../../src/types.d.ts";

const TOKEN = "test-token";
const SESSION_KEY = "session-A";

// Unique account key per test to avoid Durable Object state persistence across tests.
let accountCounter = 0;
let ACCOUNT_KEY = "account-0";
let ACCOUNT_KEY_2 = "account-0-b";

// --- Mock MCP server -------------------------------------------------------

interface MockOptions {
  readMessagesResult?: unknown;
  askResult?: unknown;
  guideResult?: unknown;
  throwOnCall?: boolean;
  throwOnAsk?: boolean;
  extraToolSchema?: Record<string, unknown>;
}

function mockSenpiServer(options: MockOptions = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const guideResult = options.guideResult ?? {
    content: [{ type: "text", text: "guide" }],
  };
  const askResult = options.askResult ?? {
    structuredContent: { status: "running", session_key: SESSION_KEY },
  };
  const readMessagesResult = options.readMessagesResult ?? {
    structuredContent: { status: "running", session_key: SESSION_KEY },
  };

  const toolSchemas: Record<string, { schema: Record<string, unknown> }> = {
    read_senpi_guide: { schema: { type: "object", properties: {} } },
    ask_agent: {
      schema: {
        type: "object",
        properties: { message: { type: "string" }, session_key: { type: "string" } },
        required: ["message"],
      },
    },
    read_messages: {
      schema: {
        type: "object",
        properties: { session_key: { type: "string" } },
        required: ["session_key"],
      },
    },
    list_approvals: {
      schema: {
        type: "object",
        properties: { session_key: { type: "string" } },
        required: ["session_key"],
      },
    },
    ...options.extraToolSchema,
  };

  const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ method: body.method, params: body.params });

    if (body.method === "initialize") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "Senpi Agent", version: "1.0.0" },
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Mcp-Session-Id": "test-session-id",
          },
        },
      );
    }

    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (body.method === "tools/list") {
      const tools = Object.entries(toolSchemas).map(([name, { schema }]) => ({
        name,
        inputSchema: schema,
      }));
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (body.method === "tools/call") {
      const toolName = body.params?.name;
      if (options.throwOnCall) throw new Error("transport error");
      if (options.throwOnAsk && toolName === "ask_agent") throw new Error("transport error");
      let result: unknown;
      if (toolName === "read_senpi_guide") result = guideResult;
      else if (toolName === "ask_agent") result = askResult;
      else if (toolName === "read_messages") result = readMessagesResult;
      else if (toolName === "list_approvals") result = { structuredContent: { approvals: [] } };
      else result = { content: [{ type: "text", text: "unknown" }] };
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  vi.stubGlobal("fetch", fetchSpy);
  return { calls, fetchSpy };
}

// --- Helpers ---------------------------------------------------------------

const hooks = env.TEST_HOOKS!.getByName("hooks");

async function setupAccount(accountKey: string = ACCOUNT_KEY, generation: number = 1) {
  await hooks.setupAccount(accountKey, TOKEN, generation);
}

async function startSession(accountKey: string = ACCOUNT_KEY) {
  await hooks.startSession(accountKey);
}

type RpcResult = { ok: boolean; value: string | null; error: string };

async function ok(result: RpcResult): Promise<unknown> {
  if (result.ok) return result.value === null ? null : JSON.parse(result.value);
  throw new Error(result.error);
}

async function okRun(result: RpcResult): Promise<SenpiRun> {
  if (result.ok) return JSON.parse(result.value!) as SenpiRun;
  throw new Error(result.error);
}

async function okEvidence(result: RpcResult): Promise<SenpiEvidence> {
  if (result.ok) return JSON.parse(result.value!) as SenpiEvidence;
  throw new Error(result.error);
}

// --- Tests -----------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  accountCounter++;
  ACCOUNT_KEY = `account-${accountCounter}`;
  ACCOUNT_KEY_2 = `account-${accountCounter}-b`;
});

describe("session RPC boundary", () => {
  let calls: { method: string; params: unknown }[];
  beforeEach(async () => {
    calls = mockSenpiServer().calls;
    await setupAccount();
    await startSession();
  });

  it("rejects callTool through the RPC boundary with zero network calls", async () => {
    const error = await hooks.probeForbiddenMethod(ACCOUNT_KEY, "callTool", "ask_agent", {});
    expect(error).not.toBeNull();
    expect(calls.filter(c => c.method === "tools/call").length).toBe(0);
  });

  it("rejects resolve_approval through the RPC boundary with zero network calls", async () => {
    const error = await hooks.probeForbiddenMethod(ACCOUNT_KEY, "resolve_approval", "approval-1");
    expect(error).not.toBeNull();
    expect(calls.filter(c => c.method === "tools/call").length).toBe(0);
  });

  it("rejects raw ask_agent through the RPC boundary with zero network calls", async () => {
    const error = await hooks.probeForbiddenMethod(ACCOUNT_KEY, "ask_agent", "hi");
    expect(error).not.toBeNull();
    expect(calls.filter(c => c.method === "tools/call").length).toBe(0);
  });

  it("rejects raw read_messages through the RPC boundary with zero network calls", async () => {
    const error = await hooks.probeForbiddenMethod(ACCOUNT_KEY, "read_messages", SESSION_KEY);
    expect(error).not.toBeNull();
    expect(calls.filter(c => c.method === "tools/call").length).toBe(0);
  });

  it("rejects list_sessions through the RPC boundary with zero network calls", async () => {
    const error = await hooks.probeForbiddenMethod(ACCOUNT_KEY, "list_sessions");
    expect(error).not.toBeNull();
    expect(calls.filter(c => c.method === "tools/call").length).toBe(0);
  });
});

describe("readGuide", () => {
  beforeEach(async () => {
    mockSenpiServer();
    await setupAccount();
    await startSession();
  });

  it("records an observation and returns the guide evidence", async () => {
    const result = await hooks.readGuide(ACCOUNT_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.value!).text).toBe("guide");
    expect(await hooks.observationCount(ACCOUNT_KEY)).toBe(1);
  });

  it("does not mark the guide as read when observation rejects", async () => {
    await hooks.setFailObservation(ACCOUNT_KEY, true);
    const guideResult = await hooks.readGuide(ACCOUNT_KEY);
    expect(guideResult.ok).toBe(false);
    // sendMessage should still require guide
    const sendResult = await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1");
    expect(sendResult.ok).toBe(false);
    if (!sendResult.ok) expect(sendResult.error).toMatch(/guide/i);
  });

  it("does not mark the guide as read when evidence is an error", async () => {
    mockSenpiServer({ guideResult: { isError: true, content: [{ type: "text", text: "error" }] } });
    await setupAccount();
    await startSession();
    const result = await hooks.readGuide(ACCOUNT_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.value!).isError).toBe(true);
    const sendResult = await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1");
    expect(sendResult.ok).toBe(false);
    if (!sendResult.ok) expect(sendResult.error).toMatch(/guide/i);
  });

  it("does not mark the guide as read when structured success is false", async () => {
    mockSenpiServer({ guideResult: { structuredContent: { success: false }, content: [] } });
    await setupAccount();
    await startSession();
    await hooks.readGuide(ACCOUNT_KEY);
    const sendResult = await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1");
    expect(sendResult.ok).toBe(false);
    if (!sendResult.ok) expect(sendResult.error).toMatch(/guide/i);
  });
});

describe("sendMessage", () => {
  beforeEach(async () => {
    mockSenpiServer();
    await setupAccount();
    await startSession();
  });

  it("requires readGuide before sendMessage", async () => {
    const result = await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/guide/i);
    expect(await hooks.submissionCount(ACCOUNT_KEY)).toBe(0);
  });

  it("creates one card showing the exact escaped message including backticks and HTML", async () => {
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const message = "Test `code` <script>alert(1)</script> & more";
    await okRun(await hooks.sendMessage(ACCOUNT_KEY, message, "req-1"));
    const subs = JSON.parse(await hooks.submissions(ACCOUNT_KEY)) as { action: number; description: { title: string; description: string; autoApprovable: boolean; awaitDecision: boolean; implementsRevert: boolean } }[];
    expect(subs.length).toBe(1);
    // The message is safely escaped (JSON-encoded in a code block), not raw HTML
    expect(subs[0].description.description).toContain("credits");
    expect(subs[0].description.description).not.toContain("<script>");
    expect(subs[0].description.description).not.toContain("</script>");
    // The raw backtick and ampersand are escaped, not literal
    expect(subs[0].description.description).toContain("\\u0060");
    expect(subs[0].description.description).toContain("\\u0026");
  });

  it("makes zero ask_agent calls before apply", async () => {
    const { calls } = mockSenpiServer();
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    const toolCalls = calls.filter(c => c.method === "tools/call" && (c.params as { name?: string }).name === "ask_agent");
    expect(toolCalls.length).toBe(0);
  });

  it("reject then apply cannot dispatch", async () => {
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.reject(ACCOUNT_KEY, run.actionId!));
    const applyResult = await hooks.apply(ACCOUNT_KEY, run.actionId!);
    expect(applyResult.ok).toBe(false);
  });

  it("same ID same body returns the same run without a new card", async () => {
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run1 = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    const run2 = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    expect(run2.actionId).toBe(run1.actionId);
    expect(await hooks.submissionCount(ACCOUNT_KEY)).toBe(1);
  });

  it("same ID different body rejects", async () => {
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    const result = await hooks.sendMessage(ACCOUNT_KEY, "world", "req-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/different/i);
  });

  it("after rejection returns aborted and no new card", async () => {
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.reject(ACCOUNT_KEY, run.actionId!));
    const run2 = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    expect(run2.status).toBe("aborted");
    expect(await hooks.submissionCount(ACCOUNT_KEY)).toBe(1);
  });
});

describe("apply", () => {
  beforeEach(async () => {
    mockSenpiServer();
    await setupAccount();
    await startSession();
  });

  it("apply same action twice sends exactly one ask_agent call", async () => {
    const { calls } = mockSenpiServer();
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));
    const toolCalls = calls.filter(c => c.method === "tools/call" && (c.params as { name?: string }).name === "ask_agent");
    expect(toolCalls.length).toBe(1);
  });

  it("first ask arguments have message and no session key", async () => {
    const { calls } = mockSenpiServer();
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));
    const askCall = calls.find(c => c.method === "tools/call" && (c.params as { name?: string }).name === "ask_agent");
    expect(askCall).toBeDefined();
    const args = (askCall!.params as { arguments: Record<string, unknown> }).arguments;
    expect(args.message).toBe("hello");
    expect(args.session_key).toBeUndefined();
  });

  it("guide and ask are the only tools called", async () => {
    const { calls } = mockSenpiServer();
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));
    const toolNames = calls
      .filter(c => c.method === "tools/call")
      .map(c => (c.params as { name?: string }).name)
      .toSorted();
    expect(toolNames).toEqual(["ask_agent", "read_senpi_guide"]);
  });
});

describe("polling and lifecycle", () => {
  it("running blocks new send; after read_messages final, new send includes session-A", async () => {
    mockSenpiServer({
      readMessagesResult: { structuredContent: { status: "final", session_key: SESSION_KEY } },
    });
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));

    const runStatus = await okRun(await hooks.readRun(ACCOUNT_KEY));
    expect(runStatus.status).toBe("final");

    // After final, a new send should include session-A
    const { calls } = mockSenpiServer({
      readMessagesResult: { structuredContent: { status: "final", session_key: SESSION_KEY } },
    });
    const run2 = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "next", "req-2"));
    await ok(await hooks.apply(ACCOUNT_KEY, run2.actionId!));
    const askCalls = calls.filter(c => c.method === "tools/call" && (c.params as { name?: string }).name === "ask_agent");
    const lastAsk = askCalls[askCalls.length - 1];
    const args = (lastAsk!.params as { arguments: Record<string, unknown> }).arguments;
    expect(args.session_key).toBe(SESSION_KEY);
  });

  it.each(["running", "busy", "needs_approval"] as const)(
    "%s status blocks new send before readRun; after final, new request succeeds on same session",
    async (status) => {
      mockSenpiServer({
        askResult: { structuredContent: { status, session_key: SESSION_KEY } },
        readMessagesResult: { structuredContent: { status, session_key: SESSION_KEY } },
      });
      await setupAccount();
      await startSession();
      await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
      const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
      await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));

      // Attempt NEW send BEFORE readRun -> rejects (not terminal)
      const { calls } = mockSenpiServer({
        readMessagesResult: { structuredContent: { status, session_key: SESSION_KEY } },
      });
      const sendResult = await hooks.sendMessage(ACCOUNT_KEY, "next", "req-2");
      expect(sendResult.ok).toBe(false);
      // No second card/ask
      expect(await hooks.submissionCount(ACCOUNT_KEY)).toBe(1);
      expect(calls.filter(c => c.method === "tools/call" && (c.params as { name?: string }).name === "ask_agent").length).toBe(0);

      // read_messages returns final
      mockSenpiServer({
        readMessagesResult: { structuredContent: { status: "final", session_key: SESSION_KEY } },
      });
      const runStatus = await okRun(await hooks.readRun(ACCOUNT_KEY));
      expect(runStatus.status).toBe("final");

      // New request succeeds on same session
      const { calls: calls2 } = mockSenpiServer({
        readMessagesResult: { structuredContent: { status: "final", session_key: SESSION_KEY } },
      });
      const run2 = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "next", "req-2"));
      await ok(await hooks.apply(ACCOUNT_KEY, run2.actionId!));
      const askCalls = calls2.filter(c => c.method === "tools/call" && (c.params as { name?: string }).name === "ask_agent");
      expect(askCalls.length).toBe(1);
      const args = (askCalls[0].params as { arguments: Record<string, unknown> }).arguments;
      expect(args.session_key).toBe(SESSION_KEY);
    },
  );

  it("missing session key results in unknown status and blocks new send", async () => {
    mockSenpiServer({ askResult: { structuredContent: { status: "running" } } });
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));
    const runStatus = await okRun(await hooks.readRun(ACCOUNT_KEY));
    expect(runStatus.status).toBe("unknown");
    const sendResult = await hooks.sendMessage(ACCOUNT_KEY, "next", "req-2");
    expect(sendResult.ok).toBe(false);
  });

  it("mismatched session key results in unknown", async () => {
    mockSenpiServer({ askResult: { structuredContent: { status: "running", session_key: "wrong-key" } } });
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));
    const runStatus = await okRun(await hooks.readRun(ACCOUNT_KEY));
    expect(runStatus.status).toBe("unknown");
  });

  it("malformed JSON text returns unknown not running", async () => {
    mockSenpiServer({ askResult: { content: [{ type: "text", text: "not json" }] } });
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));
    const runStatus = await okRun(await hooks.readRun(ACCOUNT_KEY));
    expect(runStatus.status).toBe("unknown");
  });

  it("plain text without structured content returns unknown", async () => {
    mockSenpiServer({ askResult: { content: [{ type: "text", text: "just text" }, { type: "text", text: "more" }] } });
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));
    const runStatus = await okRun(await hooks.readRun(ACCOUNT_KEY));
    expect(runStatus.status).toBe("unknown");
  });

  it("isError true results in unknown status", async () => {
    mockSenpiServer({ askResult: { isError: true, content: [{ type: "text", text: "error" }] } });
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));
    const runStatus = await okRun(await hooks.readRun(ACCOUNT_KEY));
    expect(runStatus.status).toBe("unknown");
  });

  it("success false results in unknown status", async () => {
    mockSenpiServer({ askResult: { structuredContent: { success: false, status: "running", session_key: SESSION_KEY } } });
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));
    const runStatus = await okRun(await hooks.readRun(ACCOUNT_KEY));
    expect(runStatus.status).toBe("unknown");
  });

  it("JSON text with status and session_key is accepted", async () => {
    mockSenpiServer({
      askResult: { content: [{ type: "text", text: JSON.stringify({ status: "running", session_key: SESSION_KEY }) }] },
    });
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));
    const runStatus = await okRun(await hooks.readRun(ACCOUNT_KEY));
    expect(runStatus.status).toBe("running");
    expect(runStatus.evidence).not.toBeNull();
  });
});

describe("timeout and crash recovery", () => {
  it("send timeout results in unknown; apply again rejects; no retry", async () => {
    const { calls } = mockSenpiServer({ throwOnAsk: true });
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    const applyResult = await hooks.apply(ACCOUNT_KEY, run.actionId!);
    expect(applyResult.ok).toBe(false);
    const runStatus = await okRun(await hooks.readRun(ACCOUNT_KEY));
    expect(runStatus.status).toBe("unknown");
    // Apply again should reject (not retry)
    const applyResult2 = await hooks.apply(ACCOUNT_KEY, run.actionId!);
    expect(applyResult2.ok).toBe(false);
    // No ask_agent calls should have succeeded — the mock throws, so none complete
    const askCalls = calls.filter(c => c.method === "tools/call" && (c.params as { name?: string }).name === "ask_agent");
    // Exactly one attempt (from the first apply); the second apply rejects without retrying
    expect(askCalls.length).toBe(1);
  });
});

describe("queue submission failure", () => {
  it("queue submit rejects -> no ask; same req returns aborted; different req can stage", async () => {
    mockSenpiServer();
    await setupAccount();
    await startSession();
    await hooks.setFailSubmission(ACCOUNT_KEY, true);
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const sendResult = await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1");
    expect(sendResult.ok).toBe(false);
    expect(await hooks.submissionCount(ACCOUNT_KEY)).toBe(0);
    // Same request returns aborted
    await hooks.setFailSubmission(ACCOUNT_KEY, false);
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    expect(run.status).toBe("aborted");
    // Different request can stage
    const run2 = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "world", "req-2"));
    expect(run2.status).toBe("pending");
  });
});

describe("concurrent sends", () => {
  it("concurrent sends: one winner, one rejected", async () => {
    mockSenpiServer();
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const [r1, r2] = await Promise.allSettled([
      hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"),
      hooks.sendMessage(ACCOUNT_KEY, "world", "req-2"),
    ]);
    // One should succeed, one should fail
    const successes = [r1, r2].filter(r => r.status === "fulfilled" && r.value.ok);
    const failures = [r1, r2].filter(r => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok));
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(await hooks.submissionCount(ACCOUNT_KEY)).toBe(1);
  });
});

describe("connection generation", () => {
  it("reconnect between stage and apply refuses to dispatch", async () => {
    mockSenpiServer();
    await setupAccount(ACCOUNT_KEY, 1);
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    // Reconnect to generation 2
    await hooks.reconnectAccount(ACCOUNT_KEY, TOKEN, 2);
    const applyResult = await hooks.apply(ACCOUNT_KEY, run.actionId!);
    expect(applyResult.ok).toBe(false);
  });

  it("old facet read rejects after reconnect", async () => {
    mockSenpiServer();
    await setupAccount(ACCOUNT_KEY, 1);
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    // Reconnect to generation 2
    await hooks.reconnectAccount(ACCOUNT_KEY, TOKEN, 2);
    const result = await hooks.readRun(ACCOUNT_KEY);
    expect(result.ok).toBe(false);
  });
});

describe("disabled runtime", () => {
  it("senpiEnabled only accepts exact string true", async () => {
    const { senpiEnabled } = await import("../../src/senpi.js");
    expect(senpiEnabled({ SENPI_ENABLED: "false" })).toBe(false);
    expect(senpiEnabled({ SENPI_ENABLED: "true" })).toBe(true);
    expect(senpiEnabled({ SENPI_ENABLED: "True" })).toBe(false);
    expect(senpiEnabled({ SENPI_ENABLED: undefined })).toBe(false);
  });
});

describe("proposals", () => {
  it("no session proposals returns empty evidence without list_approvals call", async () => {
    const { calls } = mockSenpiServer();
    await setupAccount();
    await startSession();
    const result = await hooks.listPendingProposals(ACCOUNT_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.value!).text).toContain("No Senpi session");
    const listCalls = calls.filter(c => c.method === "tools/call" && (c.params as { name?: string }).name === "list_approvals");
    expect(listCalls.length).toBe(0);
  });

  it("after session, proposals calls list_approvals with session-A", async () => {
    const { calls } = mockSenpiServer();
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));
    await okEvidence(await hooks.listPendingProposals(ACCOUNT_KEY));
    const listCalls = calls.filter(c => c.method === "tools/call" && (c.params as { name?: string }).name === "list_approvals");
    expect(listCalls.length).toBe(1);
    const args = (listCalls[0].params as { arguments: Record<string, unknown> }).arguments;
    expect(args.session_key).toBe(SESSION_KEY);
  });

  it("unknown schema parameter blocks dispatch", async () => {
    mockSenpiServer({
      extraToolSchema: {
        ask_agent: {
          schema: {
            type: "object",
            properties: { message: { type: "string" }, unknown_required: { type: "string" } },
            required: ["message", "unknown_required"],
          },
        },
      },
    });
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    // sendMessage pre-validates the ask_agent schema; the incompatible schema blocks staging
    const sendResult = await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1");
    expect(sendResult.ok).toBe(false);
    expect(await hooks.submissionCount(ACCOUNT_KEY)).toBe(0);
  });
});

describe("per-session scope", () => {
  it("two accounts have separate sessions and state", async () => {
    mockSenpiServer();
    await setupAccount(ACCOUNT_KEY);
    await setupAccount(ACCOUNT_KEY_2);
    await startSession(ACCOUNT_KEY);
    await startSession(ACCOUNT_KEY_2);
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    // Session2 should not have guide read
    const sendResult = await hooks.sendMessage(ACCOUNT_KEY_2, "hello", "req-1");
    expect(sendResult.ok).toBe(false);
    if (!sendResult.ok) expect(sendResult.error).toMatch(/guide/i);
    // Session1 observations are separate
    expect(await hooks.observationCount(ACCOUNT_KEY)).toBe(1);
    expect(await hooks.observationCount(ACCOUNT_KEY_2)).toBe(0);
  });
});

describe("readRun observation", () => {
  it("readRun records an observation on every read", async () => {
    mockSenpiServer();
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const obsBefore = await hooks.observationCount(ACCOUNT_KEY);
    await okRun(await hooks.readRun(ACCOUNT_KEY));
    const obsAfter = await hooks.observationCount(ACCOUNT_KEY);
    expect(obsAfter).toBe(obsBefore + 1);
  });
});

describe("ActionDescription fields", () => {
  it("queue submission captures autoApprovable:false, awaitDecision:true, implementsRevert:false", async () => {
    mockSenpiServer();
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    const subs = JSON.parse(await hooks.submissions(ACCOUNT_KEY)) as { action: number; description: { autoApprovable: boolean; awaitDecision: boolean; implementsRevert: boolean } }[];
    expect(subs.length).toBe(1);
    expect(subs[0].description.autoApprovable).toBe(false);
    expect(subs[0].description.awaitDecision).toBe(true);
    expect(subs[0].description.implementsRevert).toBe(false);
  });
});

describe("terminal duplicate", () => {
  it("after final, duplicate original request returns final with no new card/ask", async () => {
    mockSenpiServer({
      readMessagesResult: { structuredContent: { status: "final", session_key: SESSION_KEY } },
    });
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));
    // Poll to final
    const runStatus = await okRun(await hooks.readRun(ACCOUNT_KEY));
    expect(runStatus.status).toBe("final");
    const subsBefore = await hooks.submissionCount(ACCOUNT_KEY);
    const { calls } = mockSenpiServer({
      readMessagesResult: { structuredContent: { status: "final", session_key: SESSION_KEY } },
    });
    // Duplicate original request returns final
    const dupRun = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    expect(dupRun.status).toBe("final");
    // No new card/ask
    expect(await hooks.submissionCount(ACCOUNT_KEY)).toBe(subsBefore);
    expect(calls.filter(c => c.method === "tools/call" && (c.params as { name?: string }).name === "ask_agent").length).toBe(0);
  });
});

describe("stale-poll serialization", () => {
  it("readRun in progress blocks new send; after readRun completes, new send can stage", async () => {
    // This test verifies the per-facet exclusive operation guard: a readRun in progress
    // blocks new sends. We use a deferred gate on the fetch to hold the read_messages call,
    // then release it to let readRun complete. The key assertion is that the new send while
    // readRun is pending rejects, and only after readRun completes can a new send stage.
    //
    // The mock returns "running" for ask and "final" for read_messages. The readRun call
    // hangs on read_messages until the gate is released.
    let releaseGate: () => void;
    const gate = new Promise<void>(r => { releaseGate = r; });
    let released = false;
    const { calls } = mockSenpiServer({
      askResult: { structuredContent: { status: "running", session_key: SESSION_KEY } },
      readMessagesResult: { structuredContent: { status: "final", session_key: SESSION_KEY } },
    });
    // Wrap the mock fetch to hold read_messages calls until the gate is released
    const mockFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ method: body.method, params: body.params });
      if (body.method === "tools/call" && body.params?.name === "read_messages" && !released) {
        await gate;
      }
      return (mockFetch as (u: string, i: RequestInit) => Promise<Response>)(url, init);
    });

    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));

    // Start readRun (will hang on read_messages until gate is released)
    const readRunPromise = hooks.readRun(ACCOUNT_KEY);
    // Wait a tick for readRun to enter the exclusive operation guard
    await new Promise(r => setTimeout(r, 10));

    // New send while readRun is in progress -> rejects (operation in progress)
    const sendResult = await hooks.sendMessage(ACCOUNT_KEY, "next", "req-2");
    expect(sendResult.ok).toBe(false);
    if (!sendResult.ok) expect(sendResult.error).toMatch(/in progress|busy|pending|unavailable/i);
    // Only one card/ask from the original send
    expect(await hooks.submissionCount(ACCOUNT_KEY)).toBe(1);

    // Release the gate: read_messages returns final
    released = true;
    releaseGate!();
    await readRunPromise;

    // After readRun completes with final, a new send can stage
    const run2 = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "next", "req-2"));
    expect(run2.status).toBe("pending");
  });
});

describe("mismatch poll retains old session", () => {
  it("ask binds session-A; read_messages returns session-B -> unknown; listPendingProposals still calls session-A", async () => {
    const { calls } = mockSenpiServer({
      askResult: { structuredContent: { status: "running", session_key: "session-A" } },
      readMessagesResult: { structuredContent: { status: "running", session_key: "session-B" } },
    });
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    await ok(await hooks.apply(ACCOUNT_KEY, run.actionId!));

    // Poll returns session-B (mismatch) -> unknown
    const runStatus = await okRun(await hooks.readRun(ACCOUNT_KEY));
    expect(runStatus.status).toBe("unknown");

    // listPendingProposals should still call with session-A (the old key), not session-B
    await okEvidence(await hooks.listPendingProposals(ACCOUNT_KEY));
    const listCalls = calls.filter(c => c.method === "tools/call" && (c.params as { name?: string }).name === "list_approvals");
    expect(listCalls.length).toBe(1);
    const args = (listCalls[0].params as { arguments: Record<string, unknown> }).arguments;
    expect(args.session_key).toBe("session-A");
  });
});

describe("failed-send quarantine", () => {
  it("failed send stays unknown and a second apply makes no network call", async () => {
    mockSenpiServer();
    await setupAccount();
    await startSession();
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const run = await okRun(await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1"));
    mockSenpiServer({ throwOnAsk: true });
    const applyResult = await hooks.apply(ACCOUNT_KEY, run.actionId!);
    expect(applyResult.ok).toBe(false);

    const { calls } = mockSenpiServer();
    const runStatus = await okRun(await hooks.readRun(ACCOUNT_KEY));
    expect(runStatus.status).toBe("unknown");

    // Apply again should reject (not retry)
    const applyResult2 = await hooks.apply(ACCOUNT_KEY, run.actionId!);
    expect(applyResult2.ok).toBe(false);

    // No new ask_agent calls should occur from the retry
    const askCalls = calls.filter(c => c.method === "tools/call" && (c.params as { name?: string }).name === "ask_agent");
    expect(askCalls.length).toBe(0);
  });
});

describe("disabled runtime guards", () => {
  it("disabling after session creation blocks all operations with zero fetch", async () => {
    const { calls } = mockSenpiServer();
    await setupAccount();
    await hooks.startToggleableSession(ACCOUNT_KEY);
    await okEvidence(await hooks.readGuide(ACCOUNT_KEY));
    const callsBefore = calls.length;

    // Disable the facet
    await hooks.setDisabled(ACCOUNT_KEY, true);

    // readGuide rejects
    const guideResult = await hooks.readGuide(ACCOUNT_KEY);
    expect(guideResult.ok).toBe(false);

    // sendMessage rejects
    const sendResult = await hooks.sendMessage(ACCOUNT_KEY, "hello", "req-1");
    expect(sendResult.ok).toBe(false);

    // readRun rejects
    const runResult = await hooks.readRun(ACCOUNT_KEY);
    expect(runResult.ok).toBe(false);

    // listPendingProposals rejects
    const proposalsResult = await hooks.listPendingProposals(ACCOUNT_KEY);
    expect(proposalsResult.ok).toBe(false);

    // apply rejects (no staged action, but should still fail with disabled error)
    const applyResult = await hooks.apply(ACCOUNT_KEY, 999);
    expect(applyResult.ok).toBe(false);

    // Zero fetch calls after disabling
    expect(calls.length - callsBefore).toBe(0);
  });
});
