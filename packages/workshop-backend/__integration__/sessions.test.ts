import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { newHttpBatchRpcSession, newWebSocketRpcSession, type RpcStub } from "capnweb";
import { AUTH_ERROR_CODES, type PublicApi } from "@gadgets/workshop-shared/api";
import { describe, expect, it, vi } from "vitest";

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));
  const socket = response.webSocket!;
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

function newUser() {
  const email = `${crypto.randomUUID()}@example.com`;
  const user = exports.UserDurableObject.getByName(email);
  return { email, user };
}

describe("native session storage and RPC", () => {
  it("rejects invalid tokens and preserves the provider expiry cap in storage", async () => {
    const { email, user } = newUser();
    const expiresAt = new Date(Date.now() + 60_000);
    const secret = (await user.loginOrCreateViaGatekeeper(email, true, expiresAt))!;
    expect((await user.authenticate(secret)).expiresAt).toEqual(expiresAt);
    for (const token of ["not-base64!", "", secret.slice(0, -1), new Uint8Array(32).toBase64()]) {
      await expect(user.authenticate(token)).rejects.toMatchObject({
        code: AUTH_ERROR_CODES.invalidSessionToken,
      });
    }
  });

  it("rejects invalid provider expiry before creating an account", async () => {
    const { email, user } = newUser();
    await expect(user.loginOrCreateViaGatekeeper(email, true, new Date(0))).rejects.toThrow();
    expect(await user.whoamiIfExists()).toBeNull();
  });

  it("rejects expired persisted and legacy sessions using their original creation time", async () => {
    const { email, user } = newUser();
    const secret = (await user.loginOrCreateViaGatekeeper(email, true))!;
    const { tokenId } = await user.authenticate(secret);
    await runInDurableObject(user, (_instance, ctx) => {
      ctx.storage.kv.put(`sessions:${tokenId}`, {
        created: new Date(Date.now() - 3_600_000),
      });
    });
    await expect(user.authenticate(secret)).rejects.toMatchObject({ code: AUTH_ERROR_CODES.invalidSessionToken });
    await runInDurableObject(user, (_instance, ctx) => {
      ctx.storage.kv.put(`sessions:${tokenId}`, {
        created: new Date(Date.now() - 1000), expiresAt: new Date(0),
      });
    });
    await expect(user.authenticate(secret)).rejects.toMatchObject({ code: AUTH_ERROR_CODES.invalidSessionToken });
  });

  it("logout requires the exact token, prevents replay, and preserves other sessions and user data", async () => {
    const { email, user } = newUser();
    const first = (await user.loginOrCreateViaGatekeeper(email, true))!;
    const second = (await user.loginOrCreateViaGatekeeper(email, true))!;
    await user.setOwnDisplayName("Keep this name");
    using api = await connect();
    await api.logout(`${email}:${new Uint8Array(32).toBase64()}`);
    await expect(user.authenticate(first)).resolves.toBeDefined();
    await api.logout(`${email}:${first}`);
    await api.logout(`${email}:${first}`);
    await expect(user.authenticate(first)).rejects.toMatchObject({ code: AUTH_ERROR_CODES.invalidSessionToken });
    await expect(user.authenticate(second)).resolves.toBeDefined();
    expect((await user.whoami()).name).toBe("Keep this name");
    await expect(api.logout(`${email}:invalid`)).rejects.toMatchObject({ code: AUTH_ERROR_CODES.invalidSessionToken });
  });

  it("closes a live WebSocket and all its authenticated capabilities at the earliest expiry", async () => {
    const { email, user } = newUser();
    const expiresAt = new Date(Date.now() + 2000);
    const first = (await user.loginOrCreateViaGatekeeper(email, true, expiresAt))!;
    const second = (await user.loginOrCreateViaGatekeeper(email, true))!;
    using api = await connect();
    using old = await api.authenticate(`${email}:${first}`);
    using newer = await api.authenticate(`${email}:${second}`);
    const broken = new Promise<void>(resolve => api.onRpcBroken(() => resolve()));
    expect((await old.whoami()).id).toBe(email);
    expect((await newer.whoami()).id).toBe(email);
    await broken;
    await expect(old.whoami()).rejects.toThrow();
    await expect(newer.whoami()).rejects.toThrow();
    expect(Date.now()).toBeGreaterThanOrEqual(expiresAt.valueOf());
  });

  it("bounds revocation across active connections without revoking a different session", async () => {
    const { email, user } = newUser();
    const first = (await user.loginOrCreateViaGatekeeper(email, true))!;
    const second = (await user.loginOrCreateViaGatekeeper(email, true))!;
    using api = await connect();
    using otherConnection = await connect();
    using unaffected = await connect();
    using old = await api.authenticate(`${email}:${first}`);
    using duplicate = await otherConnection.authenticate(`${email}:${first}`);
    using current = await unaffected.authenticate(`${email}:${second}`);
    const broken = Promise.all([api, otherConnection].map(connection =>
      new Promise<void>(resolve => connection.onRpcBroken(() => resolve()))));
    const started = Date.now();
    await unaffected.logout(`${email}:${first}`);
    await broken;
    expect(Date.now() - started).toBeLessThan(30_000);
    await expect(old.whoami()).rejects.toThrow();
    await expect(duplicate.whoami()).rejects.toThrow();
    expect((await current.whoami()).id).toBe(email);
  });

  it("finishes an authenticated HTTP batch without waiting for its session lease", async () => {
    const { email, user } = newUser();
    const secret = (await user.loginOrCreateViaGatekeeper(email, true))!;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
      exports.default.fetch(new Request(input, init)));
    try {
      using api = newHttpBatchRpcSession<PublicApi>("https://workshop.invalid/api");
      expect((await api.authenticate(`${email}:${secret}`).whoami()).id).toBe(email);
    } finally {
      fetch.mockRestore();
    }
  });
});
