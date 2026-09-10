import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_ERROR_CODES } from "@gadgets/workshop-shared/api";
import { sessionMaxAgeMs, newSessionExpiry, sessionExpiry } from "../src/auth/sessions.js";
import { SessionLeases } from "../src/auth/session-leases.js";

const now = Date.parse("2026-06-01T12:00:00Z");
const hour = 3_600_000;

afterEach(() => vi.useRealTimers());

describe("native session expiry policy", () => {
  it("defaults to one hour and accepts only 60..86400 integer seconds", () => {
    expect(sessionMaxAgeMs()).toBe(hour);
    expect(sessionMaxAgeMs("60")).toBe(60_000);
    expect(sessionMaxAgeMs("86400")).toBe(86_400_000);
  });

  it.each(["", "0", "59", "86401", "Infinity", "NaN", "1e3", "60.5", " 60", "60 ", "-60"])(
    "rejects malformed TTL %s", value => expect(() => sessionMaxAgeMs(value)).toThrow(),
  );

  it("caps provider credentials by the OS maximum and shorter provider expiry", () => {
    expect(newSessionExpiry(hour, undefined, now).valueOf()).toBe(now + hour);
    expect(newSessionExpiry(hour, new Date(now + 2 * hour), now).valueOf()).toBe(now + hour);
    expect(newSessionExpiry(hour, new Date(now + 1000), now).valueOf()).toBe(now + 1000);
  });

  it.each([new Date(now), new Date(now - 1), new Date(NaN), null, "2026-06-02"])(
    "rejects expired or malformed provider expiry %s", expiresAt => {
      expect(() => newSessionExpiry(hour, expiresAt as Date, now)).toThrow();
    },
  );

  it("bounds legacy sessions by created time, never by the time of authentication", () => {
    const record = { created: new Date(now - 1000) };
    expect(sessionExpiry(record, hour, now).valueOf()).toBe(now - 1000 + hour);
    expect(() => sessionExpiry(record, hour, now + hour - 1000)).toThrow();
  });

  it("never extends persisted expiry and applies a reduced maximum", () => {
    const record = { created: new Date(now), expiresAt: new Date(now + hour) };
    expect(sessionExpiry(record, 2 * hour, now).valueOf()).toBe(now + hour);
    expect(sessionExpiry(record, 60_000, now).valueOf()).toBe(now + 60_000);
  });

  it.each([
    { created: new Date(NaN) },
    { created: new Date(now + 1) },
    { created: new Date(now), expiresAt: new Date(NaN) },
    { created: new Date(now), expiresAt: new Date(now) },
  ])("fails closed for invalid stored metadata", record => {
    expect(() => sessionExpiry(record, hour, now)).toThrow();
  });
});

describe("connection session leases", () => {
  function setup() {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const abort = vi.fn();
    const leases = new SessionLeases(abort);
    return { leases, abort };
  }

  it("aborts at absolute expiry and releases all timers", async () => {
    const { leases, abort } = setup();
    leases.add("session", new Date(now + 1000), async () => new Date(now + hour), now);
    await vi.advanceTimersByTimeAsync(999);
    expect(abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(abort).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      code: AUTH_ERROR_CODES.invalidSessionToken,
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes revocation on a bounded recheck, not instantly", async () => {
    const { leases, abort } = setup();
    const check = vi.fn(async () => { throw new Error("revoked"); });
    leases.add("session", new Date(now + hour), check, now);
    expect(abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(check).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed within 30 seconds even when a recheck hangs", async () => {
    const { leases, abort } = setup();
    leases.add("session", new Date(now + hour), () => new Promise(() => {}), now);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues checking live sessions without extending absolute expiry", async () => {
    const { leases, abort } = setup();
    const check = vi.fn(async () => new Date(now + hour));
    leases.add("session", new Date(now + 60_000), check, now);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(check).toHaveBeenCalledTimes(3);
    expect(abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("retains older capabilities' deadlines across repeated and different authentications", async () => {
    const { leases, abort } = setup();
    leases.add("old", new Date(now + 1000), async () => new Date(now + hour), now);
    leases.add("old", new Date(now + hour), async () => new Date(now + hour), now);
    leases.add("new", new Date(now + hour), async () => new Date(now + hour), now);
    await vi.advanceTimersByTimeAsync(1000);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("limits distinct sessions without allowing repeated auth to allocate timers", () => {
    const { leases } = setup();
    for (let i = 0; i < 32; i++) {
      leases.add(String(i), new Date(now + hour), async () => new Date(now + hour), now);
    }
    const timers = vi.getTimerCount();
    leases.add("0", new Date(now + hour), async () => new Date(now + hour), now);
    expect(vi.getTimerCount()).toBe(timers);
    expect(() => leases.add("overflow", new Date(now + hour), async () => new Date(now + hour), now))
      .toThrow();
    leases[Symbol.dispose]();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposal during a recheck prevents a late result from rearming timers", async () => {
    const { leases, abort } = setup();
    const result = Promise.withResolvers<Date>();
    leases.add("session", new Date(now + hour), () => result.promise, now);
    await vi.advanceTimersByTimeAsync(15_000);
    leases[Symbol.dispose]();
    result.resolve(new Date(now + hour));
    await vi.advanceTimersByTimeAsync(hour);
    expect(abort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => leases.add("late", new Date(now + hour), () => result.promise, now)).toThrow();
  });

  it("does not start timers for unauthenticated connections or completed HTTP batches", () => {
    const { leases } = setup();
    expect(vi.getTimerCount()).toBe(0);
    leases.add("batch", new Date(now + hour), async () => new Date(now + hour), now);
    leases[Symbol.dispose]();
    expect(vi.getTimerCount()).toBe(0);
  });
});
