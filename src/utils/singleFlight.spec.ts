import { describe, it, expect } from "vitest";
import { singleFlight } from "./singleFlight";

describe("singleFlight", () => {
  it("concurrent callers share ONE in-flight run", async () => {
    let calls = 0;
    let release!: (v: string) => void;
    const fn = () =>
      new Promise<string>((r) => {
        calls++;
        release = r;
      });
    const once = singleFlight(fn);
    expect(once.active).toBe(false);

    const p1 = once();
    const p2 = once(); // concurrent — must reuse the in-flight run, not start a new one
    expect(calls).toBe(1);
    expect(once.active).toBe(true); // a run is in flight

    release("txA");
    expect(await p1).toBe("txA");
    expect(await p2).toBe("txA"); // both resolve to the same result
    expect(once.active).toBe(false); // settled → slot freed
  });

  it("a call AFTER the previous settles starts a fresh run", async () => {
    let calls = 0;
    const resolvers: Array<(v: string) => void> = [];
    const fn = () =>
      new Promise<string>((r) => {
        calls++;
        resolvers.push(r);
      });
    const once = singleFlight(fn);

    const p1 = once();
    resolvers[0]("tx1");
    expect(await p1).toBe("tx1");

    const p2 = once(); // previous settled → fresh run
    expect(calls).toBe(2);
    resolvers[1]("tx2");
    expect(await p2).toBe("tx2");
  });

  it("releases the in-flight slot when the run rejects, so a retry can run", async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.reject(new Error("round failed"));
    };
    const once = singleFlight(fn);

    await expect(once()).rejects.toThrow("round failed");
    await expect(once()).rejects.toThrow("round failed"); // retried, not stuck on a dead slot
    expect(calls).toBe(2);
  });
});
