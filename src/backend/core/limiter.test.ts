import { test, expect } from "bun:test";
import { Semaphore } from "./limiter";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("allows up to capacity concurrently", async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;

  const task = async () => {
    const release = await sem.acquire();
    active++;
    peak = Math.max(peak, active);
    await tick();
    active--;
    release();
  };

  await Promise.all(Array.from({ length: 6 }, task));
  expect(peak).toBe(2);
  expect(sem.inUse).toBe(0);
  expect(sem.queued).toBe(0);
});

test("is FIFO", async () => {
  const sem = new Semaphore(1);
  const order: number[] = [];
  const release = await sem.acquire();
  const tasks = [1, 2, 3].map(async (n) => {
    const r = await sem.acquire();
    order.push(n);
    await tick();
    r();
  });
  await tick();
  release();
  await Promise.all(tasks);
  expect(order).toEqual([1, 2, 3]);
});

test("release is idempotent", async () => {
  const sem = new Semaphore(1);
  const release = await sem.acquire();
  release();
  release();
  expect(sem.inUse).toBe(0);
  const r2 = await sem.acquire();
  expect(sem.inUse).toBe(1);
  r2();
});

test("aborted signal rejects a queued acquire without consuming a slot", async () => {
  const sem = new Semaphore(1);
  const held = await sem.acquire();
  const ctrl = new AbortController();
  const queued = sem.acquire(ctrl.signal);
  ctrl.abort(new Error("Cancelled by user"));
  expect((await queued.catch((e) => e)).message).toBe("Cancelled by user");
  expect(sem.queued).toBe(0);

  held();
  const r = await sem.acquire();
  expect(sem.inUse).toBe(1);
  r();
});

test("acquire rejects immediately on an already-aborted signal", async () => {
  const sem = new Semaphore(5);
  const ctrl = new AbortController();
  ctrl.abort();
  expect(sem.acquire(ctrl.signal)).rejects.toBeDefined();
  expect(sem.inUse).toBe(0);
});

test("runExclusive wraps acquire/release", async () => {
  const sem = new Semaphore(1);
  const result = await sem.runExclusive(async () => {
    expect(sem.inUse).toBe(1);
    return 42;
  });
  expect(result).toBe(42);
  expect(sem.inUse).toBe(0);
});

test("capacity is at least 1 for bad config values", () => {
  expect(new Semaphore(0).capacity).toBe(1);
  expect(new Semaphore(-4).capacity).toBe(1);
});
