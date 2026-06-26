/**
 * LOCAL activity-history engine — a temporary shadow of `@arkade-os/sdk`'s
 * activity feature (arkade-os/ts-sdk PRs #582 / #583 / #584), which is not yet
 * on coinflip's SDK line (the `arkade-script` branch). It groups the wallet's
 * flat transaction history into logical activities, so a dice game's several
 * transactions render as one "Dice game" row instead of scattered Sent/Received
 * entries.
 *
 * When the activity feature reaches coinflip's SDK line, delete this file and
 * call `wallet.getActivityHistory()` instead — the resolver/membership shape
 * here mirrors the SDK's exactly, so the swap is mechanical.
 */
import type { TxHistoryEntry } from "../store/modules/ark/ark";

/** One transaction's participation in one logical action. A tx may return several. */
export interface GroupMembership {
  /** Stable id of the action; txs sharing it group together. Namespace it (`game:`/`boarding:`). */
  groupId: string;
  /** Human label, e.g. "Dice game". */
  label?: string;
  /** Category for icon/filtering, e.g. "game". */
  kind?: string;
  /** Free-form row data. */
  metadata?: Record<string, unknown>;
  /** This tx's contribution to THIS group, in sats; defaults to the tx's full amount. */
  amount?: number;
}

/** The label/kind/metadata an activity carries. */
export interface ActivityIntent {
  label?: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}

/** A pluggable resolver: `prepare()` loads correlation data, `resolve()` is pure + sync. */
export interface ActivityResolver {
  id: string;
  prepare?(): Promise<void>;
  resolve(tx: TxHistoryEntry): GroupMembership[] | undefined;
}

/** One logical activity: the projection of all txs sharing a groupId. */
export interface Activity {
  /** The groupId, or the tx's own txid when ungrouped. */
  id: string;
  /** Merged intent for the group, if any resolver tagged it. */
  intent?: ActivityIntent;
  /** Member txs, oldest-first. */
  txs: TxHistoryEntry[];
  /** Net sats across the group (sum of members' attributed amounts). */
  amount: number;
  /** Earliest member createdAt (unix ms). */
  createdAt: number;
  /** True once every member tx is settled. */
  settled: boolean;
}

/** Net sats this tx moved the wallet, SIGNED: SENT is negative, RECEIVED positive.
 *  `TxHistoryEntry.amount` is an unsigned magnitude — the direction lives in `type`. */
function signedAmount(tx: TxHistoryEntry): number {
  return tx.type === "SENT" ? -Math.abs(tx.amount) : Math.abs(tx.amount);
}

/**
 * Project a flat tx list into grouped activities via resolvers. A tx with no
 * memberships becomes its own single-member activity (= the flat row). A
 * resolver that throws/rejects is isolated and contributes nothing.
 */
export async function buildActivities(
  txs: TxHistoryEntry[],
  resolvers: ActivityResolver[]
): Promise<Activity[]> {
  await Promise.all(
    resolvers.map(async (r) => {
      try {
        await r.prepare?.();
      } catch {
        /* a failed prepare leaves this resolver with stale/empty data */
      }
    })
  );

  const merge = (a: GroupMembership, b: GroupMembership): GroupMembership => ({
    groupId: a.groupId,
    label: a.label ?? b.label,
    kind: a.kind ?? b.kind,
    metadata: { ...b.metadata, ...a.metadata },
    amount: a.amount ?? b.amount,
  });

  type Bucket = {
    intent?: ActivityIntent;
    members: { tx: TxHistoryEntry; amount: number }[];
  };
  const buckets = new Map<string, Bucket>();

  for (const tx of txs) {
    const perGroup = new Map<string, GroupMembership>();
    for (const r of resolvers) {
      let ms: GroupMembership[] | undefined;
      try {
        ms = r.resolve(tx);
      } catch {
        ms = undefined; // one bad tag must not break the whole history
      }
      for (const m of ms ?? []) {
        const existing = perGroup.get(m.groupId);
        perGroup.set(m.groupId, existing ? merge(existing, m) : { ...m });
      }
    }

    if (perGroup.size === 0) {
      buckets.set(tx.txid, { members: [{ tx, amount: signedAmount(tx) }] });
      continue;
    }
    for (const m of perGroup.values()) {
      const b = buckets.get(m.groupId) ?? { members: [] };
      b.intent = {
        label: b.intent?.label ?? m.label,
        kind: b.intent?.kind ?? m.kind,
        metadata: { ...m.metadata, ...b.intent?.metadata },
      };
      b.members.push({ tx, amount: m.amount ?? signedAmount(tx) });
      buckets.set(m.groupId, b);
    }
  }

  const latest = (a: Activity) => Math.max(...a.txs.map((t) => t.createdAt));
  return [...buckets.entries()]
    .map(([id, b]): Activity => {
      const members = [...b.members].sort(
        (x, y) => x.tx.createdAt - y.tx.createdAt
      );
      return {
        id,
        intent: b.intent,
        txs: members.map((x) => x.tx),
        amount: members.reduce((s, x) => s + x.amount, 0),
        createdAt: members[0].tx.createdAt,
        settled: members.every((x) => x.tx.settled),
      };
    })
    .sort((a, c) => latest(c) - latest(a));
}

/** Built-in resolver: labels boarding (deposit) transactions. */
export function boardingResolver(): ActivityResolver {
  return {
    id: "boarding",
    resolve(tx) {
      if (!tx.isBoarding) return undefined;
      return [
        { groupId: `boarding:${tx.txid}`, label: "Deposit", kind: "boarding" },
      ];
    },
  };
}

/** A coinflip game reduced to its display data + every on-chain txid it touched. */
export interface CoinflipGameRecord {
  id: string;
  tier: number;
  winner: "player" | "house" | null;
  txids: string[];
}

/**
 * Built-in resolver: tags a dice game's transactions as one "Dice game"
 * activity. `getGames` supplies the stored game records (with their txids);
 * `prepare()` indexes them by txid so `resolve()` is a pure O(1) lookup.
 */
export function gameActivityResolver(
  getGames: () => CoinflipGameRecord[]
): ActivityResolver {
  let byTxid = new Map<string, CoinflipGameRecord>();
  return {
    id: "coinflip-games",
    async prepare() {
      const next = new Map<string, CoinflipGameRecord>();
      for (const g of getGames()) {
        for (const t of g.txids) {
          if (t) next.set(t, g);
        }
      }
      byTxid = next;
    },
    resolve(tx) {
      const g = byTxid.get(tx.txid);
      if (!g) return undefined;
      return [
        {
          groupId: `game:${g.id}`,
          label: "Dice game",
          kind: "game",
          metadata: { gameId: g.id, tier: g.tier, winner: g.winner },
        },
      ];
    },
  };
}
