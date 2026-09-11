import { assertEquals } from "@std/assert";
import { test } from "@cross/test";
import { Cron } from "../src/croner.ts";

/**
 * Regression test for #343/#370: a forward clock step (NTP correction, WSL2 host
 * clock resync, ...) between the clock reads used while arming the timer used to
 * silently skip an occurrence. The delay and the trigger target were derived from
 * separate reads, so a step across the occurrence made the timer fire, find the
 * target still ahead, and re-arm for the following occurrence - no fire, no error.
 *
 * The step is injected by patching Date: a forward jump across the occurrence
 * happens on the second consecutive clock read within the final 30 seconds
 * (maxDelay polling cap) before the occurrence, i.e. between schedule()'s arming
 * reads.
 */
test("clock step forward between arming reads must not skip the occurrence", async () => {
  const RealDate = Date;

  // Fire once a minute, ~2 seconds out, so the initial arming lands inside the
  // final <= 30 s polling window, while the whole test stays well below the 5 s
  // default per-test timeout of bun:test (which @cross/test cannot override)
  const nowReal = new RealDate();
  const targetSecond = (nowReal.getSeconds() + 2) % 60;
  const pattern = `${targetSecond} * * * * *`;

  // Precompute the expected occurrence in real time, so the assertion does not
  // depend on croner once the step has been injected
  const expected = new RealDate(nowReal);
  expected.setSeconds(targetSecond, 0);
  if (expected.getTime() <= nowReal.getTime()) {
    expected.setMinutes(expected.getMinutes() + 1);
  }
  const targetMs = expected.getTime();

  let offsetMs = 0,
    jumped = false,
    lastReadInWindow = false,
    fired = 0;

  const readClock = (): number => {
    const gap = targetMs - (RealDate.now() + offsetMs);
    // Croner never waits longer than 30 s (maxDelay) between checks, so the
    // reads arming the timer for an occurrence always land in this window
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
      if (args.length === 0) {
        super(readClock());
      } else {
        super(...args);
      }
    }

    static now(): number {
      return readClock();
    }
  };

  let job: Cron | undefined;
  try {
    globalThis.Date = PatchedDate as unknown as DateConstructor;

    job = new Cron(pattern, () => {
      fired++;
    });

    // Wait, in real time, until the occurrence has fired, keeping the wait
    // bounded: bun:test fails any test running longer than 5 s, and @cross/test
    // cannot raise that limit, so poll for the fire instead of sleeping way
    // past the occurrence. A build that skips the occurrence stays unfired
    // until the deadline (the next one is a minute away), while a working
    // build fires at, or just before, the occurrence.
    const deadline = targetMs + 1_500;
    while (RealDate.now() < deadline && fired === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    // Give a same-tick duplicate fire a moment to surface before asserting
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    assertEquals(
      fired,
      1,
      fired === 0
        ? "occurrence silently skipped: the clock stepped forward across it " +
          "between croner's arming reads, and the job never fired"
        : "job fired more than once",
    );
  } finally {
    globalThis.Date = RealDate;
    job?.stop();
  }
});
