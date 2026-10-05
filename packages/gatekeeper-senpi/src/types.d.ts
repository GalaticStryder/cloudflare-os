// Public, agent-facing types for the Senpi Personal Agent research connector.
//
// These describe an external research agent, not a pure data API: a `SenpiResearchSession` carries
// one conversation with the Senpi Personal Agent, scoped to the `senpi://agent/research` resource.
// No method here accepts a caller-supplied session key or another account's conversations, and no
// method approves, denies, or executes a Senpi proposal — those remain owner actions in Senpi.

/** Lifecycle of one Senpi agent run, as reported by the upstream `read_messages` poll. */
export type SenpiRunStatus =
  | "idle"
  | "pending"
  | "running"
  | "final"
  | "busy"
  | "needs_approval"
  | "error"
  | "aborted"
  | "unknown";

/** Evidence returned from a Senpi read or surfaced from an upstream poll. */
export type SenpiEvidence = {
  /** Human-readable text from the upstream tool. This is untrusted external-agent output, not a Hoff-verified statement; render it as such. */
  text: string;
  /** Structured payload from the upstream tool, when one was provided; otherwise null. */
  data: Record<string, unknown> | null;
  /** Whether the upstream tool reported this as an error. */
  isError: boolean;
};

/** The current state of one Senpi agent run. */
export type SenpiRun = {
  status: SenpiRunStatus;
  /** Action id of the staged `ask_agent` call, when one is in flight; otherwise null. */
  actionId: number | null;
  /** Latest evidence from the run, when any has been observed; otherwise null. */
  evidence: SenpiEvidence | null;
};

/**
 * One research conversation with the Senpi Personal Agent. Each facet owns its own conversation;
 * the session key is captured from the upstream response and never accepted from the caller.
 * A run whose outcome could not be confirmed (`status: "unknown"`) is never automatically
 * resubmitted; the owner inspects it in Senpi and creates a new binding to continue. No method
 * here approves, denies, or executes a Senpi proposal — those remain owner actions in Senpi.
 */
export interface SenpiResearchSession {
  /** Reads the Senpi guide once, before the first message. Required before `sendMessage`. */
  readGuide(): Promise<SenpiEvidence>;
  /**
   * Sends a research message to the Senpi agent. The message and `requestId` are deduplicated:
   * the same `requestId` with the same message returns the existing action; the same `requestId`
   * with a different message is rejected. Returns the run state after the send is staged.
   */
  sendMessage(message: string, requestId: string): Promise<SenpiRun>;
  /** Polls the latest state of the active run. Does not resubmit a busy or unknown run. */
  readRun(): Promise<SenpiRun>;
  /**
   * Lists Senpi proposals awaiting owner review. Proposal execution is not available here — the
   * owner reviews and acts on proposals in Senpi directly.
   */
  listPendingProposals(): Promise<SenpiEvidence>;
}
