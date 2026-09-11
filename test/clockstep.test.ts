import { assertEquals } from "@std/assert";
import { test } from "@cross/test";
import { Cron } from "../src/croner.ts";

/**
 * Regression test: a forward clock step must not silently skip an occurrence.
 *
 * Cron.schedule() used to read the clock twice when arming its timer, one read
 * for the delay (`msToNext()`) and a separate read for the trigger target
 * (`nextRun()`). When the system clock is stepped forward across the scheduled
 * occurrence between those two reads (NTP corrections, WSL2 host clock resync,
 * ...), the delay and the target end up naming different occurrences: the timer
 * fires, sees that the (post-step) target is still in the future, and re-arms
 * for the next occurrence. The stepped-over occurrence is silently skipped -
 * no fire, no error. See upstream issues #343 and #370.
 *
 * The test simulates the clock step by patching Date: a forward jump across
 * the occurrence is injected on the second consecutive clock read that lands
 * within the final 30 seconds (maxDelay polling cap) before the occurrence,
 * i.e. exactly between the two reads schedule() performs while arming.
 */
test("clock step forward between arming reads must not skip the occurrence", async () => {
  const RealDate = Date;

  // Build a pattern that fires once a minute, ~5 seconds out, so that the
  // initial arming lands inside the final <= 30 s polling window.
  const nowReal = new RealDate();
  const targetSecond = (nowReal.getSeconds() + 5) % 60;
  const pattern = `${targetSecond} * * * * *`;

  // Precompute the expected occurrence in real time, before patching Date,
  // so the test never depends on croner once the step has been injected.
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
    // reads that arm the timer for an occurrence always land in this window.
    const inWindow = gap > 0 && gap <= 30_000;
    // Inject the forward step on the second consecutive read inside the
    // window: a step crossing the occurrence between croner's arming reads.
    if (!jumped && inWindow && lastReadInWindow) {
      jumped = true;
      offsetMs += gap + 5_000; // Step across the occurrence
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

    // Wait, in real time, until the occurrence (plus margin) has passed.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, targetMs - RealDate.now()) + 4_000);
    });

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
