import { assertEquals } from "@std/assert";
import { test } from "@cross/test";
import { Cron } from "../src/croner.ts";

/**
 * Regression tests for #343/#370: croner used to read the system clock several
 * times while arming and running a scheduled occurrence. A forward clock step
 * (NTP correction, WSL2 host clock resync, ...) between two of those reads made
 * it re-arm for the occurrence after the one just stepped over, so the scheduled
 * occurrence was silently skipped: no fire, no error.
 *
 * The step is injected by patching Date: within a configurable window before the
 * occurrence, the clock jumps forward across it on the second consecutive read,
 * i.e. between two of croner's reads. Dates built from an explicit timestamp
 * bypass the patch, so job inputs can be constructed while it is active.
 */

/** Whole-second occurrence `seconds` out, inside the 30 s arming window */
function targetSecondsOut(RealDate: DateConstructor, seconds: number): number {
  const target = new RealDate();
  target.setSeconds(target.getSeconds() + seconds, 0);
  return target.getTime();
}

/**
 * Patch globalThis.Date so the clock jumps forward across targetMs on the
 * second consecutive read within `windowMs` before it. Returns a restore fn.
 */
function patchClockToStepAcross(
  RealDate: DateConstructor,
  targetMs: number,
  windowMs = 30_000,
): () => void {
  let offsetMs = 0, jumped = false, lastReadInWindow = false;
  const readClock = (): number => {
    const gap = targetMs - (RealDate.now() + offsetMs);
    const inWindow = gap > 0 && gap <= windowMs;
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
 * assert it fires exactly `expectedFires` times.
 *
 * The occurrence is ~2 s out: inside the 30 s arming window, while keeping the
 * whole test under bun:test's 5 s default timeout, which @cross/test cannot
 * raise.
 */
async function assertFiresDespiteClockStep(
  start: (targetMs: number, onFire: () => void) => Cron,
  options: { expectedFires?: number; windowMs?: number } = {},
) {
  const { expectedFires = 1, windowMs = 30_000 } = options;
  const RealDate = Date;
  const targetMs = targetSecondsOut(RealDate, 2);

  let fired = 0;
  const restoreClock = patchClockToStepAcross(RealDate, targetMs, windowMs);
  let job: Cron | undefined;
  try {
    job = start(targetMs, () => fired++);
    await assertFiresExactly(targetMs, expectedFires, () => fired, () => RealDate.now());
  } finally {
    restoreClock();
    job?.stop();
  }
}

/**
 * Poll in real time until the job has fired `expectedFires` times, or the
 * deadline passes 1.5 s past the occurrence. A build that skips the occurrence
 * stays short of the count until then, so the assertion still fails.
 */
async function assertFiresExactly(
  targetMs: number,
  expectedFires: number,
  firedCount: () => number,
  realNow: () => number,
) {
  const deadline = targetMs + 1_500;
  while (realNow() < deadline && firedCount() < expectedFires) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  // Give same-tick duplicate fires a moment to surface before asserting
  await new Promise<void>((resolve) => setTimeout(resolve, 400));

  assertEquals(
    firedCount(),
    expectedFires,
    firedCount() < expectedFires
      ? "occurrence silently skipped: the clock stepped forward across it " +
        "between croner's arming reads, and the job never fired" +
        (expectedFires > 1 ? ` (expected ${expectedFires} fires, got ${firedCount()})` : "")
      : "job fired more times than scheduled",
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

test("clock step forward between the trigger check and the run must not skip the next occurrence", () =>
  assertFiresDespiteClockStep(
    (_targetMs, onFire) => new Cron("* * * * * *", onFire),
    {
      // The per-second pattern makes the occurrence ~2 s out fire first, so the
      // step lands between the clock read of that run's trigger check and the
      // read that used to record the run's own start time (currentRun) — the
      // gap left after arming became single-read. The 1 s window keeps the
      // arming reads (~2 s out) outside the jump zone.
      expectedFires: 2,
      windowMs: 1_000,
    },
  ));
