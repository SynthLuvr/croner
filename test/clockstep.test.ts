import { assertEquals } from "@std/assert";
import { test } from "@cross/test";
import { Cron } from "../src/croner.ts";

/**
 * Regression test for #343/#370: schedule() used to read the clock twice, once
 * for the trigger delay and once for the trigger target. A forward clock step
 * (NTP correction, WSL2 host clock resync, ...) between those reads made it
 * re-arm for the occurrence after the one just stepped over, so the scheduled
 * occurrence was silently skipped: no fire, no error.
 *
 * The step is injected by patching Date: the clock jumps forward across the
 * occurrence on the second consecutive read within the final 30 seconds (the
 * maxDelay polling cap) before it, i.e. between schedule()'s arming reads.
 */
test("clock step forward between arming reads must not skip the occurrence", async () => {
  const RealDate = Date;

  // Occurrence ~2 s out: inside the 30 s arming window, while keeping the whole
  // test under bun:test's 5 s default timeout, which @cross/test cannot raise
  const now = new RealDate();
  const target = new RealDate(now);
  target.setSeconds(now.getSeconds() + 2, 0);
  if (target.getTime() <= now.getTime()) target.setMinutes(target.getMinutes() + 1);
  const targetMs = target.getTime();

  let offsetMs = 0, jumped = false, lastReadInWindow = false;
  const readClock = (): number => {
    const gap = targetMs - (RealDate.now() + offsetMs);
    const inWindow = gap > 0 && gap <= 30_000;
    // Step the clock across the occurrence on the second consecutive read in
    // the window, mimicking a step between croner's arming reads
    if (!jumped && inWindow && lastReadInWindow) {
      jumped = true;
      offsetMs += gap + 5_000;
    }
    lastReadInWindow = inWindow;
    return RealDate.now() + offsetMs;
  };

  // deno-lint-ignore no-explicit-any
  const PatchedDate = class extends (RealDate as any) {
    // deno-lint-ignore no-explicit-any
    constructor(...args: any[]) {
      super(args.length === 0 ? readClock() : args[0], ...args.slice(1));
    }

    static now(): number {
      return readClock();
    }
  };

  let fired = 0;
  let job: Cron | undefined;
  try {
    globalThis.Date = PatchedDate as unknown as DateConstructor;
    job = new Cron(`${target.getSeconds()} * * * * *`, () => {
      fired++;
    });
    await assertFiresOnce(targetMs, () => fired, () => RealDate.now());
  } finally {
    globalThis.Date = RealDate;
    job?.stop();
  }
});

/**
 * Poll in real time until the job fires, or the deadline passes 1.5 s past the
 * occurrence. A build that skips the occurrence stays unfired until then (the
 * next occurrence is a minute away), so the assertion still fails.
 */
async function assertFiresOnce(
  targetMs: number,
  firedCount: () => number,
  realNow: () => number,
) {
  const deadline = targetMs + 1_500;
  while (realNow() < deadline && firedCount() === 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  // Give a same-tick duplicate fire a moment to surface before asserting
  await new Promise<void>((resolve) => setTimeout(resolve, 400));

  assertEquals(
    firedCount(),
    1,
    firedCount() === 0
      ? "occurrence silently skipped: the clock stepped forward across it " +
        "between croner's arming reads, and the job never fired"
      : "job fired more than once",
  );
}
