import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

function directory(name: string) {
  return env.TEST_USER_DIRECTORY.getByName(`${name}-${crypto.randomUUID()}`);
}

function user(id: string, name: string) {
  return { id, name };
}

// The first RPC into the DO pays for instantiating the whole backend bundle in its isolate (~5s
// on a dev machine when the pool is contended, as vitest.integration.config.ts also notes); the
// remaining calls take milliseconds.
describe("UserDirectoryDurableObject", { timeout: 30_000 }, () => {
  it("upserts profiles, matches name or id case-insensitively, and excludes the caller", async () => {
    const stub = directory("upsert");
    await stub.syncUser(user("ada@example.com", "Ada Lovelace"));
    await stub.syncUser(user("grace@example.com", "Grace Hopper"));

    await expect(stub.searchUsers("LOVE", "x")).resolves.toEqual([
      user("ada@example.com", "Ada Lovelace"),
    ]);
    await expect(stub.searchUsers("love", "ada@example.com")).resolves.toEqual([]);
    await expect(stub.searchUsers("grace@", "x")).resolves.toEqual([
      user("grace@example.com", "Grace Hopper"),
    ]);

    await stub.syncUser(user("ada@example.com", "Augusta Ada King"));
    await expect(stub.searchUsers("lovelace", "x")).resolves.toEqual([]);
    await expect(stub.searchUsers("augusta", "x")).resolves.toEqual([
      user("ada@example.com", "Augusta Ada King"),
    ]);
  });

  it("ranks the earliest match first and treats pattern characters literally", async () => {
    const stub = directory("rank");
    await stub.syncUser(user("al@example.com", "Al Li"));
    await stub.syncUser(user("sally@example.com", "Sally"));
    await stub.syncUser(user("%percent", "Percent"));
    await stub.syncUser(user("q@example.com", "A \"Quoted\" AND Person"));

    await expect(stub.searchUsers("al", "x")).resolves.toEqual([
      user("al@example.com", "Al Li"),
      user("sally@example.com", "Sally"),
    ]);
    await expect(stub.searchUsers("%", "x")).resolves.toEqual([
      user("%percent", "Percent"),
    ]);
    await expect(stub.searchUsers("\"Quoted\" AND", "x")).resolves.toEqual([
      user("q@example.com", "A \"Quoted\" AND Person"),
    ]);
    await expect(stub.searchUsers("  ", "x")).resolves.toEqual([]);
  });

  it("does not match across the name/id boundary", async () => {
    const stub = directory("boundary");
    await stub.syncUser(user("ada@example.com", "Grace"));

    await expect(stub.searchUsers("ceada", "x")).resolves.toEqual([]);
    await expect(stub.searchUsers("grace", "x")).resolves.toEqual([
      user("ada@example.com", "Grace"),
    ]);
  });

  it("caps broad matches at ten results", async () => {
    const stub = directory("limit");
    await Promise.all(Array.from({ length: 11 }, (_, index) => stub.syncUser(user(
      `user${index.toString().padStart(2, "0")}@example.com`,
      `Common Person ${index.toString().padStart(2, "0")}`,
    ))));

    const results = await stub.searchUsers("common", "x");
    expect(results).toHaveLength(10);
    expect(results.map(result => result.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `user${index.toString().padStart(2, "0")}@example.com`),
    );
  });
});
