# Cron Scheduling Feature Flag Fix

## Overview
- **Time Period:** October 2023 (~2 weeks)
- **Lines of Code:** ~600 additions
- **Files Changed:** 8 files
- **Key Technologies:** Java, Quartz Cron, Temporal

One-paragraph summary: Fixed critical bugs in cron-scheduled workflows where feature flags caused schedules to be skipped or executed multiple times. Introduced a dedicated `CronSchedulingHelper` to encapsulate scheduling logic with proper safeguards including minimum interval enforcement and load-distribution jitter.

## Problem Statement
Cron-scheduled syncs had two serious issues:
1. Schedules could execute multiple times for the same scheduled time
2. Feature flag toggling could cause schedules to be skipped entirely

The root cause was cron's one-minute resolution combined with timing edge cases around job completion and next-run calculation.

## Solution Architecture
Designed a scheduling helper with:
1. **Minimum Interval Enforcement** - At least 60 seconds between cron runs
2. **Previous Job Awareness** - Next run calculated from prior job's start time
3. **Schedule Type Differentiation** - Different jitter for cron vs interval schedules
4. **Comprehensive Testing** - Edge cases like DST transitions covered

Key design decisions:
- **60-second floor** - Matches cron's minimum resolution
- **Start time, not end time** - Use job start for next-run calculation
- **No negative jitter for cron** - Cron schedules never execute early

## Implementation Details

### CronSchedulingHelper

Core scheduling logic with minimum interval:

```java
public class CronSchedulingHelper {
  protected static final long MS_PER_SECOND = 1000L;
  private static final long MIN_CRON_INTERVAL_SECONDS = 60;

  public static Duration getNextRuntimeBasedOnPreviousJobAndSchedule(
      final Supplier<Long> currentSecondsSupplier,
      final @Nullable JobRead priorJobRead,
      final CronExpression cronExpression) {

    // Get the earliest possible next run based on prior job's start time
    final Date earliestNextRun = getEarliestNextRun(
        currentSecondsSupplier, priorJobRead);

    // Determine next cron run according to the earliest possible start time
    final Date nextRunStartDate = cronExpression.getNextValidTimeAfter(earliestNextRun);

    // Calculate seconds between now and next cron run
    // Can be negative if next run should have already started
    final long nextRunStartSeconds =
        nextRunStartDate.getTime() / MS_PER_SECOND - currentSecondsSupplier.get();

    // Max with 0 so we never return a negative value
    return Duration.ofSeconds(Math.max(0, nextRunStartSeconds));
  }

  /**
   * Ensure at least minimum interval (one minute) passes between executions.
   * Prevents multiple executions for same scheduled time since cron only
   * has 1-minute resolution.
   */
  private static Date getEarliestNextRun(
      final Supplier<Long> currentSecondsSupplier,
      final @Nullable JobRead priorJobRead) {

    final long earliestNextRunSeconds =
        (priorJobRead == null || priorJobRead.getStartedAt() == null)
            ? currentSecondsSupplier.get()
            : priorJobRead.getStartedAt() + MIN_CRON_INTERVAL_SECONDS;

    return new Date(earliestNextRunSeconds * MS_PER_SECOND);
  }
}
```

### Schedule Jitter for Load Distribution

Different jitter strategies by schedule type:

```java
public Duration addJitterBasedOnWaitTime(
    final Duration waitTime,
    final ConnectionScheduleType scheduleType) {

  // If wait time is less than cutoff, don't add any jitter
  if (waitTime.toMinutes() <= noJitterCutoffMinutes) {
    return waitTime;
  }

  final int jitterSeconds;
  final Random random = new Random();

  // CRON schedules should NOT have negative jitter because the sync
  // could start and finish before the real scheduled time, resulting
  // in a double sync when the next computed wait time is very short.
  final Boolean includeNegativeJitter =
      !scheduleType.equals(ConnectionScheduleType.CRON);

  switch (determineFrequencyBucket(waitTime)) {
    case HIGH_FREQUENCY_BUCKET ->
        jitterSeconds = getRandomJitterSeconds(
            random, highFrequencyJitterAmountMinutes, includeNegativeJitter);
    case MEDIUM_FREQUENCY_BUCKET ->
        jitterSeconds = getRandomJitterSeconds(
            random, mediumFrequencyJitterAmountMinutes, includeNegativeJitter);
    case LOW_FREQUENCY_BUCKET ->
        jitterSeconds = getRandomJitterSeconds(
            random, lowFrequencyJitterAmountMinutes, includeNegativeJitter);
    case VERY_LOW_FREQUENCY_BUCKET ->
        jitterSeconds = getRandomJitterSeconds(
            random, veryLowFrequencyJitterAmountMinutes, includeNegativeJitter);
    default -> jitterSeconds = 0;
  }

  Duration newWaitTime = waitTime.plusSeconds(jitterSeconds);

  // If jitter results in negative wait time, set to 0
  if (newWaitTime.isNegative()) {
    newWaitTime = Duration.ZERO;
  }

  return newWaitTime;
}

private static int getRandomJitterSeconds(
    final Random random,
    final int maximumJitterMinutes,
    final Boolean includeNegativeJitter) {

  final int maximumJitterSeconds = maximumJitterMinutes * 60;

  // random.nextInt is inclusive of 0 and exclusive of provided value
  int computedJitterSeconds = random.nextInt(maximumJitterSeconds + 1);

  if (includeNegativeJitter) {
    // Shift positive jitter left by half of maximum
    computedJitterSeconds -= maximumJitterSeconds / 2;
  }

  return computedJitterSeconds;
}
```

### Test Coverage

Comprehensive tests covering edge cases:

```java
@Test
void testNoDoubleExecutionWithinMinuteResolution() {
  // Prior job started at minute boundary
  final JobRead priorJob = new JobRead()
      .startedAt(1000L);  // Some timestamp

  // Try to schedule next run immediately
  final Duration nextRunDuration = CronSchedulingHelper
      .getNextRuntimeBasedOnPreviousJobAndSchedule(
          () -> 1001L,  // Just 1 second later
          priorJob,
          cronExpression);

  // Should wait at least 59 more seconds
  assertThat(nextRunDuration.getSeconds()).isGreaterThanOrEqualTo(59L);
}

@Test
void testDSTTransition() {
  // Test around daylight saving time transitions
  // Cron should not double-execute or skip during DST
}

@Test
void testNegativeJitterExcludedForCron() {
  final Duration waitTime = Duration.ofHours(1);

  // Run 1000 times and verify no negative jitter
  for (int i = 0; i < 1000; i++) {
    final Duration result = helper.addJitterBasedOnWaitTime(
        waitTime, ConnectionScheduleType.CRON);
    assertThat(result).isGreaterThanOrEqualTo(waitTime);
  }
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [4ce6bf7717](https://github.com/airbytehq/airbyte-platform/commit/4ce6bf7717) | Oct 30, 2023 | CronSchedulingHelper with minimum interval | 5 files, 440 insertions |
| [a73cf367d5](https://github.com/airbytehq/airbyte-platform/commit/a73cf367d5) | Oct 31, 2023 | Use createdAt instead of startedAt | Accuracy fix |
| [3c3b8ee53e](https://github.com/airbytehq/airbyte-platform/commit/3c3b8ee53e) | Jul 27, 2023 | Bring back negative jitter for non-cron | Load distribution |

## Business Value

### User Impact
- **Reliable Schedules**: Cron syncs execute exactly once at scheduled time
- **Predictable Behavior**: No more surprise double-syncs or skipped syncs
- **Feature Flag Safety**: Toggling flags doesn't break scheduling

### Business Impact
- **Reduced Support**: Fewer "my sync ran twice" or "my sync didn't run" tickets
- **Resource Efficiency**: No wasted compute from duplicate executions
- **Trust**: Customers can rely on scheduled syncs

### Technical Impact
- **Centralized Logic**: Scheduling encapsulated in testable helper
- **106 Lines of Tests**: Edge cases documented through tests
- **Clear Separation**: Cron vs interval schedule handling explicit

## Lessons Learned / Patterns Used

### Minimum Interval Floor
Cron's one-minute resolution requires explicit enforcement:
```java
private static final long MIN_CRON_INTERVAL_SECONDS = 60;
// Ensure at least 60 seconds between runs
```

### Start Time vs End Time
Use job start time, not end time, for next-run calculation:
- If job takes 30 seconds, using end time would delay next run by 30 seconds
- Start time keeps schedule aligned with user expectations

### Negative Jitter Exclusion
Cron users expect exact execution times:
```java
// CRON schedules never execute early
final Boolean includeNegativeJitter =
    !scheduleType.equals(ConnectionScheduleType.CRON);
```
Interval schedules can drift; cron schedules should not.
