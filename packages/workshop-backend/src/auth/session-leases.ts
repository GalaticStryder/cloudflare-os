import { AUTH_ERROR_CODES, createAuthError } from "@gadgets/workshop-shared/api";

type Lease = {
  expiresAt: number;
  checkedAt: number;
  check: () => Promise<Date>;
};

export class SessionLeases implements Disposable {
  #leases = new Map<string, Lease>();
  #expiryTimer?: ReturnType<typeof setTimeout>;
  #checkTimer?: ReturnType<typeof setTimeout>;
  #disposed = false;

  constructor(private abort: (reason: Error) => void) {}

  add(key: string, expiresAt: Date, check: () => Promise<Date>, checkedAt: number): void {
    if (this.#disposed || !Number.isFinite(expiresAt.valueOf()) || expiresAt.valueOf() <= Date.now()
        || checkedAt + 30_000 <= Date.now()) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    const existing = this.#leases.get(key);
    if (existing) {
      existing.expiresAt = Math.min(existing.expiresAt, expiresAt.valueOf());
    } else {
      if (this.#leases.size >= 32) throw new Error("Too many sessions on this connection. Reconnect.");
      this.#leases.set(key, { expiresAt: expiresAt.valueOf(), checkedAt, check });
    }
    this.#scheduleExpiry();
    this.#scheduleCheck();
  }

  #scheduleExpiry(): void {
    clearTimeout(this.#expiryTimer);
    const deadline = Math.min(...Array.from(this.#leases.values(),
      lease => Math.min(lease.expiresAt, lease.checkedAt + 30_000)));
    this.#expiryTimer = setTimeout(() => this.#fail(), Math.max(0, deadline - Date.now()));
  }

  #scheduleCheck(): void {
    if (this.#checkTimer !== undefined) return;
    this.#checkTimer = setTimeout(() => { void this.#recheck(); }, 15_000);
  }

  async #recheck(): Promise<void> {
    try {
      await Promise.all(Array.from(this.#leases.values(), async lease => {
        const checkedAt = Date.now();
        const expiresAt = await lease.check();
        if (this.#disposed) return;
        if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.valueOf())
            || expiresAt.valueOf() <= Date.now()) {
          throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
        }
        lease.expiresAt = Math.min(lease.expiresAt, expiresAt.valueOf());
        lease.checkedAt = checkedAt;
      }));
      if (this.#disposed) return;
      this.#checkTimer = undefined;
      this.#scheduleExpiry();
      this.#scheduleCheck();
    } catch {
      this.#fail();
    }
  }

  #fail(): void {
    if (this.#disposed) return;
    this[Symbol.dispose]();
    this.abort(createAuthError(AUTH_ERROR_CODES.invalidSessionToken));
  }

  [Symbol.dispose](): void {
    this.#disposed = true;
    clearTimeout(this.#expiryTimer);
    clearTimeout(this.#checkTimer);
    this.#leases.clear();
  }
}
