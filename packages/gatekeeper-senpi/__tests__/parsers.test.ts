// Parser and schema-validation logic for the Senpi connector. These are the pure functions that
// decide lifecycle state from upstream payloads; they must fail closed on anything unrecognized.

import { describe, expect, it } from "vitest";

import {
  extractStatus,
  isSenpiRunStatus,
  object,
  payload,
  schemaAccepts,
  toEvidence,
  validSessionKey,
  type EvidenceInput,
} from "../src/senpi.js";

describe("object", () => {
  it("accepts a plain object", () => {
    expect(object({})).toBe(true);
    expect(object({ a: 1 })).toBe(true);
  });

  it("rejects null, arrays, and primitives", () => {
    expect(object(null)).toBe(false);
    expect(object([])).toBe(false);
    expect(object([1, 2])).toBe(false);
    expect(object("x")).toBe(false);
    expect(object(42)).toBe(false);
    expect(object(undefined)).toBe(false);
  });
});

describe("payload", () => {
  it("returns structuredContent when it is an object", () => {
    const result: EvidenceInput = { structuredContent: { status: "running" } };
    expect(payload(result)).toEqual({ status: "running" });
  });

  it("parses a single JSON text block", () => {
    const result: EvidenceInput = {
      content: [{ type: "text", text: '{"status":"final","session_key":"abc"}' }],
    };
    expect(payload(result)).toEqual({ status: "final", session_key: "abc" });
  });

  it("returns null for non-JSON text", () => {
    const result: EvidenceInput = {
      content: [{ type: "text", text: "not json" }],
    };
    expect(payload(result)).toBeNull();
  });

  it("returns null for JSON that is not an object", () => {
    const result: EvidenceInput = {
      content: [{ type: "text", text: "[1,2,3]" }],
    };
    expect(payload(result)).toBeNull();
  });

  it("returns null when there are zero text blocks", () => {
    const result: EvidenceInput = { content: [] };
    expect(payload(result)).toBeNull();
  });

  it("returns null when there are multiple text blocks", () => {
    const result: EvidenceInput = {
      content: [
        { type: "text", text: '{"a":1}' },
        { type: "text", text: '{"b":2}' },
      ],
    };
    expect(payload(result)).toBeNull();
  });

  it("returns null for non-text content blocks", () => {
    const result: EvidenceInput = {
      content: [{ type: "image" }],
    };
    expect(payload(result)).toBeNull();
  });

  it("prefers structuredContent over text", () => {
    const result: EvidenceInput = {
      structuredContent: { status: "running" },
      content: [{ type: "text", text: '{"status":"final"}' }],
    };
    expect(payload(result)).toEqual({ status: "running" });
  });
});

describe("extractStatus", () => {
  it("returns the recognized remote status", () => {
    expect(extractStatus({ status: "final" })).toBe("final");
    expect(extractStatus({ status: "running" })).toBe("running");
    expect(extractStatus({ status: "busy" })).toBe("busy");
    expect(extractStatus({ status: "needs_approval" })).toBe("needs_approval");
    expect(extractStatus({ status: "error" })).toBe("error");
    expect(extractStatus({ status: "aborted" })).toBe("aborted");
  });

  it("returns error when success is false", () => {
    expect(extractStatus({ success: false, status: "running" })).toBe("error");
  });

  it("returns unknown for null", () => {
    expect(extractStatus(null)).toBe("unknown");
  });

  it("returns unknown for an unrecognized status", () => {
    expect(extractStatus({ status: "completed" })).toBe("unknown");
    expect(extractStatus({ status: "done" })).toBe("unknown");
    expect(extractStatus({})).toBe("unknown");
  });

  it("returns unknown for a non-string status", () => {
    expect(extractStatus({ status: 42 })).toBe("unknown");
    expect(extractStatus({ status: null })).toBe("unknown");
  });

  it("does not accept local-only statuses from remote", () => {
    expect(extractStatus({ status: "idle" })).toBe("unknown");
    expect(extractStatus({ status: "pending" })).toBe("unknown");
    expect(extractStatus({ status: "unknown" })).toBe("unknown");
  });
});

describe("validSessionKey", () => {
  it("accepts a non-empty bounded string without control chars", () => {
    expect(validSessionKey("abc")).toBe("abc");
    expect(validSessionKey("a".repeat(2048))).toBe("a".repeat(2048));
  });

  it("rejects empty strings", () => {
    expect(validSessionKey("")).toBeNull();
  });

  it("rejects strings longer than 2048 chars", () => {
    expect(validSessionKey("a".repeat(2049))).toBeNull();
  });

  it("rejects control characters", () => {
    expect(validSessionKey("a\x00b")).toBeNull();
    expect(validSessionKey("a\x1fb")).toBeNull();
    expect(validSessionKey("a\x7fb")).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(validSessionKey(42)).toBeNull();
    expect(validSessionKey(null)).toBeNull();
    expect(validSessionKey(undefined)).toBeNull();
    expect(validSessionKey({})).toBeNull();
  });
});

describe("toEvidence", () => {
  it("extracts text and structured data", () => {
    const result: EvidenceInput = {
      content: [{ type: "text", text: "hello" }],
      structuredContent: { status: "final" },
    };
    const evidence = toEvidence(result);
    expect(evidence.text).toBe("hello");
    expect(evidence.data).toEqual({ status: "final" });
    expect(evidence.isError).toBe(false);
  });

  it("marks error evidence", () => {
    const result: EvidenceInput = {
      content: [{ type: "text", text: "something went wrong" }],
      isError: true,
    };
    const evidence = toEvidence(result);
    expect(evidence.isError).toBe(true);
    expect(evidence.text).toBe("something went wrong");
  });

  it("falls back to JSON string when no text", () => {
    const result: EvidenceInput = {
      structuredContent: { status: "running" },
    };
    const evidence = toEvidence(result);
    expect(evidence.text).toBe(JSON.stringify({ status: "running" }));
  });

  it("returns empty text and null data for nothing", () => {
    const result: EvidenceInput = {};
    const evidence = toEvidence(result);
    expect(evidence.text).toBe("");
    expect(evidence.data).toBeNull();
    expect(evidence.isError).toBe(false);
  });
});

describe("isSenpiRunStatus", () => {
  it("accepts all defined statuses", () => {
    for (const s of ["idle", "pending", "running", "final", "busy", "needs_approval", "error", "aborted", "unknown"]) {
      expect(isSenpiRunStatus(s)).toBe(true);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(isSenpiRunStatus("completed")).toBe(false);
    expect(isSenpiRunStatus(42)).toBe(false);
    expect(isSenpiRunStatus(null)).toBe(false);
  });
});

describe("schemaAccepts", () => {
  it("rejects an undefined schema", () => {
    expect(schemaAccepts(undefined, {})).toBe(false);
  });

  it("rejects a non-object type schema", () => {
    expect(schemaAccepts({ type: "string" }, {})).toBe(false);
  });

  it("accepts an object type with no required fields", () => {
    expect(schemaAccepts({ type: "object" }, {})).toBe(true);
  });

  it("rejects when a required field is missing", () => {
    expect(schemaAccepts({ type: "object", required: ["message"] }, {})).toBe(false);
  });

  it("accepts when all required fields are present", () => {
    expect(schemaAccepts(
      { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      { message: "hi" },
    )).toBe(true);
  });

  it("rejects when a supplied field has the wrong type", () => {
    expect(schemaAccepts(
      { type: "object", properties: { message: { type: "string" } } },
      { message: 42 },
    )).toBe(false);
  });

  it("accepts when a supplied field has the right type", () => {
    expect(schemaAccepts(
      { type: "object", properties: { message: { type: "string" } } },
      { message: "hi" },
    )).toBe(true);
  });

  it("rejects unknown required fields that the schema demands", () => {
    expect(schemaAccepts(
      { type: "object", required: ["session_key"] },
      { message: "hi" },
    )).toBe(false);
  });

  it("accepts initial ask_agent without session_key when not required", () => {
    expect(schemaAccepts(
      { type: "object", properties: { message: { type: "string" }, session_key: { type: "string" } }, required: ["message"] },
      { message: "hi" },
    )).toBe(true);
  });

  it("rejects additionalProperties false with unknown field", () => {
    expect(schemaAccepts(
      { type: "object", properties: { message: { type: "string" } }, additionalProperties: false },
      { message: "hi", extra: 1 },
    )).toBe(false);
  });

  it("rejects additionalProperties true with unknown non-string field", () => {
    expect(schemaAccepts(
      { type: "object", properties: { message: { type: "string" } }, additionalProperties: true },
      { message: "hi", extra: 1 },
    )).toBe(false);
  });

  it("rejects array type (only string properties supported)", () => {
    expect(schemaAccepts(
      { type: "object", properties: { items: { type: "array" } } },
      { items: [1, 2] },
    )).toBe(false);
  });

  it("rejects boolean type (only string properties supported)", () => {
    expect(schemaAccepts(
      { type: "object", properties: { flag: { type: "boolean" } } },
      { flag: true },
    )).toBe(false);
  });
});
