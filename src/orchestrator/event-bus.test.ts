import { describe, expect, it } from "vitest";
import { EventBus } from "./event-bus";

describe("EventBus", () => {
  it("replays buffered events to a late subscriber, then closes", async () => {
    const bus = new EventBus<number>();
    bus.emit(1);
    bus.emit(2);
    bus.close();

    const received: number[] = [];
    for await (const event of bus.subscribe()) received.push(event);
    expect(received).toEqual([1, 2]);
  });

  it("delivers live events to a subscriber that joined before they were emitted", async () => {
    const bus = new EventBus<number>();
    const collected = collect(bus.subscribe());
    bus.emit(10);
    bus.emit(20);
    bus.close();
    expect(await collected).toEqual([10, 20]);
  });

  it("does not duplicate events when emit happens during subscribe setup", async () => {
    const bus = new EventBus<string>();
    bus.emit("a");
    const collected = collect(bus.subscribe());
    bus.emit("b");
    bus.close();
    expect(await collected).toEqual(["a", "b"]);
  });

  it("supports multiple concurrent subscribers", async () => {
    const bus = new EventBus<number>();
    const a = collect(bus.subscribe());
    const b = collect(bus.subscribe());
    bus.emit(1);
    bus.emit(2);
    bus.close();
    expect(await a).toEqual([1, 2]);
    expect(await b).toEqual([1, 2]);
  });

  it("ignores emits after close", async () => {
    const bus = new EventBus<number>();
    bus.emit(1);
    bus.close();
    bus.emit(2);
    const received: number[] = [];
    for await (const event of bus.subscribe()) received.push(event);
    expect(received).toEqual([1]);
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}
