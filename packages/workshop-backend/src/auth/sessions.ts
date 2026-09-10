import { AUTH_ERROR_CODES, createAuthError } from "@gadgets/workshop-shared/api";

export function sessionMaxAgeMs(value?: string): number {
  if (value === undefined) return 3_600_000;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)
      || Number(value) < 60 || Number(value) > 86_400) {
    throw new Error("AUTH_SESSION_MAX_AGE_SECONDS must be an integer from 60 to 86400.");
  }
  return Number(value) * 1000;
}

export function newSessionExpiry(maxAgeMs: number, credentialExpiresAt?: Date,
    now = Date.now()): Date {
  if (credentialExpiresAt !== undefined
      && (!(credentialExpiresAt instanceof Date)
          || !Number.isFinite(credentialExpiresAt.valueOf()) || credentialExpiresAt.valueOf() <= now)) {
    throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
  }
  return new Date(Math.min(now + maxAgeMs, credentialExpiresAt?.valueOf() ?? Infinity));
}

export function sessionExpiry(record: { created: Date; expiresAt?: Date }, maxAgeMs: number,
    now = Date.now()): Date {
  if (!(record.created instanceof Date) || !Number.isFinite(record.created.valueOf())
      || record.created.valueOf() > now) {
    throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
  }
  const expiresAt = newSessionExpiry(maxAgeMs, record.expiresAt, record.created.valueOf());
  if (expiresAt.valueOf() <= now) throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
  return expiresAt;
}
