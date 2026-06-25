import { describe, it, expect } from "vitest";
import {
  buildActivities,
  boardingResolver,
  gameActivityResolver,
  type CoinflipGameRecord,
} from "./activityHistory";
import type { TxHistoryEntry } from "../store/modules/ark/ark";

function tx(txid: string, over: Partial<TxHistoryEntry> = {}): TxHistoryEntry {
  return {
    txid,
    type: "RECEIVED",
    amount: 100,
    settled: true,
    createdAt: 1000,
    isBoarding: false,
    ...over,
  };
}

describe("buildActivities", () => {
  it("with no resolvers, each tx is its own single-member activity", async () => {
    const acts = await buildActivities([tx("a"), tx("b")], []);
    expect(acts).toHaveLength(2);
    expect(acts.every((x) => x.txs.length === 1)).toBe(true);
  });

  it("isolates a resolver that throws or whose prepare rejects", async () => {
    const bad: ActivityResolverLike = {
      id: "bad",
      prepare: async () => {
        throw new Error("boom");
      },
      resolve: () => {
        throw new Error("boom");
      },
    };
    const good = { id: "good", resolve: () => [{ groupId: "ok" }] };
    const [act] = await buildActivities([tx("t")], [bad, good]);
    expect(act.id).toBe("ok");
  });
});

describe("gameActivityResolver", () => {
  const games: CoinflipGameRecord[] = [
    { id: "g4", tier: 10000, winner: "player", txids: ["cofund4", "settle4"] },
    { id: "g3", tier: 5000, winner: "house", txids: ["resolve3"] },
  ];

  it("groups every tx of a game as one 'Dice game' activity; leaves others flat", async () => {
    const txs = [
      tx("cofund4", { type: "SENT", amount: -10000, createdAt: 1 }),
      tx("settle4", { type: "RECEIVED", amount: 19000, createdAt: 2 }),
      tx("deposit", { isBoarding: true, amount: 50000, createdAt: 3 }),
    ];
    const acts = await buildActivities(txs, [
      gameActivityResolver(() => games),
      boardingResolver(),
    ]);

    const game = acts.find((a) => a.id === "game:g4")!;
    expect(game.intent?.label).toBe("Dice game");
    expect(game.txs).toHaveLength(2); // cofund + settle collapsed into one row
    expect(game.amount).toBe(9000); // net: -10000 + 19000

    const deposit = acts.find((a) => a.id === "boarding:deposit")!;
    expect(deposit.intent?.label).toBe("Deposit");
  });

  it("re-indexes on prepare(): no stale entries", async () => {
    let current = games;
    const r = gameActivityResolver(() => current);
    await r.prepare!();
    expect(r.resolve(tx("cofund4"))).toBeTruthy();
    current = [{ id: "g5", tier: 1, winner: null, txids: ["cofund5"] }];
    await r.prepare!();
    expect(r.resolve(tx("cofund5"))?.[0].groupId).toBe("game:g5");
    expect(r.resolve(tx("cofund4"))).toBeUndefined();
  });
});

// minimal structural type so the throwing-resolver fixture above type-checks
interface ActivityResolverLike {
  id: string;
  prepare?(): Promise<void>;
  resolve(tx: TxHistoryEntry): { groupId: string }[] | undefined;
}
