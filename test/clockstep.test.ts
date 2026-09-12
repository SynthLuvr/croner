import { assertEquals } from "@std/assert";
import { test } from "@cross/test";
import { Cron } from "../src/croner.ts";

/**
 * Regression tests for #343/#370: schedule() used to read the clock twice, once
 * for the trigger delay and once for the trigger target. A forward clock step
 * (NTP correction, WSL2 host clock resync, ...) between those reads made it
 * re-arm for the occurrence after the one just stepped over, so the scheduled
 * occurrence was silently skipped: no fire, no error.
 *
 * The step is injected by patching Date: the clock jumps forward across the
 * occurrence on the second consecutive read within the final 30 seconds (the
 * maxDelay polling cap) before it, i.e. between schedule()'s arming reads.
 * Dates built from an explicit timestamp bypass the patch, so job inputs can
 * be constructed while it is active.
 */

/** Whole-second occurrence `seconds` out, inside the 30 s arming window */
function targetSecondsOut(RealDate: DateConstructor, seconds: number): number {
  const target = new RealDate();
  target.setSeconds(target.getSeconds() + seconds, 0);
  return target.getTime();
}

/**
 * Patch globalThis.Date so the clock jumps forward across targetMs on the
 * second consecutive read within the 30 s before it. Returns a restore fn.
 */
function patchClockToStepAcross(RealDate: DateConstructor, targetMs: number): () => void {
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

  globalThis.Date = PatchedDate as unknown as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}

/**
 * Start a job while the clock is patched to step across its occurrence, then
 * assert it fires exactly once.
 *
 * The occurrence is ~2 s out: inside the 30 s arming window, while keeping the
 * whole test under bun:test's 5 s default timeout, which @cross/test cannot
 * raise.
 */
async function assertFiresDespiteClockStep(
  start: (targetMs: number, onFire: () => void) => Cron,
) {
  const RealDate = Date;
  const targetMs = targetSecondsOut(RealDate, 2);

  let fired = 0;
  const restoreClock = patchClockToStepAcross(RealDate, targetMs);
  let job: Cron | undefined;
  try {
    job = start(targetMs, () => fired++);
    await assertFiresOnce(targetMs, () => fired, () => RealDate.now());
  } finally {
    restoreClock();
    job?.stop();
  }
}

/**
 * Poll in real time until the job fires, or the deadline passes 1.5 s past the
 * occurrence. A build that skips the occurrence stays unfired until then, so
 * the assertion still fails.
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

test("clock step forward between arming reads must not skip the occurrence", () =>
  assertFiresDespiteClockStep((targetMs, onFire) =>
    new Cron(new Date(targetMs).getSeconds() + " * * * * *", onFire)
  ));

test("clock step forward between arming reads must not skip the occurrence (startAt + interval)", () =>
  assertFiresDespiteClockStep((targetMs, onFire) => {
    // Same race through _calculatePreviousRun(): with a past startAt and an
    // interval, it used to sample the clock on its own, so a forward step
    // between schedule()'s reading and the walk advanced the walk past the
    // pending run
    return new Cron("* * * * * *", { startAt: new Date(targetMs - 10_000), interval: 5 }, onFire);
  }));
