# Schedule Jitter System

## Overview
- **Time Period:** June - July 2023 (~5 weeks)
- **Lines of Code:** ~400 additions
- **Files Changed:** 8 files
- **Key Technologies:** Java, Temporal

One-paragraph summary: Implemented a configurable schedule jitter system that distributes sync execution times to prevent thundering herd problems. The system adds randomized delays based on sync frequency, with special handling to ensure cron schedules never execute early.

## Problem Statement
When many connections are scheduled at common intervals (hourly, daily):
- All syncs would start simultaneously at the top of the hour
- This caused resource spikes and database contention
- Infrastructure had to be sized for peak load
- Customers on shared infrastructure experienced slowdowns

## Solution Architecture
Implemented intelligent jitter:

1. **Frequency Buckets** - Different jitter amounts based on sync frequency
2. **Positive-Only for Cron** - Cron schedules only delayed, never early
3. **Bidirectional for Intervals** - Interval schedules can shift either direction
4. **Cutoff Threshold** - No jitter for very short intervals

## Implementation Details

### Frequency Bucket Classification

```java
public enum FrequencyBucket {
  HIGH_FREQUENCY,      // < 1 hour
  MEDIUM_FREQUENCY,    // 1-6 hours
  LOW_FREQUENCY,       // 6-24 hours
  VERY_LOW_FREQUENCY   // > 24 hours
}

private FrequencyBucket determineFrequencyBucket(Duration waitTime) {
  long hours = waitTime.toHours();

  if (hours < 1) return HIGH_FREQUENCY;
  if (hours < 6) return MEDIUM_FREQUENCY;
  if (hours < 24) return LOW_FREQUENCY;
  return VERY_LOW_FREQUENCY;
}
```

### Jitter Configuration

```java
@ConfigurationProperties("airbyte.worker.sync.jitter")
public class JitterConfig {
  private int noJitterCutoffMinutes = 10;
  private int highFrequencyJitterAmountMinutes = 2;
  private int mediumFrequencyJitterAmountMinutes = 5;
  private int lowFrequencyJitterAmountMinutes = 10;
  private int veryLowFrequencyJitterAmountMinutes = 15;
}
```

### Jitter Calculation

```java
public Duration addJitterBasedOnWaitTime(
    Duration waitTime,
    ConnectionScheduleType scheduleType) {

  // Don't add jitter to very short intervals
  if (waitTime.toMinutes() <= noJitterCutoffMinutes) {
    return waitTime;
  }

  // CRON schedules should NOT have negative jitter because the sync
  // could start and finish before the real scheduled time, resulting
  // in a double sync when the next computed wait time is very short.
  final boolean includeNegativeJitter =
      !scheduleType.equals(ConnectionScheduleType.CRON);

  final int jitterSeconds = switch (determineFrequencyBucket(waitTime)) {
    case HIGH_FREQUENCY ->
        getRandomJitterSeconds(highFrequencyJitterAmountMinutes, includeNegativeJitter);
    case MEDIUM_FREQUENCY ->
        getRandomJitterSeconds(mediumFrequencyJitterAmountMinutes, includeNegativeJitter);
    case LOW_FREQUENCY ->
        getRandomJitterSeconds(lowFrequencyJitterAmountMinutes, includeNegativeJitter);
    case VERY_LOW_FREQUENCY ->
        getRandomJitterSeconds(veryLowFrequencyJitterAmountMinutes, includeNegativeJitter);
  };

  Duration newWaitTime = waitTime.plusSeconds(jitterSeconds);

  // Ensure we never return negative
  if (newWaitTime.isNegative()) {
    return Duration.ZERO;
  }

  return newWaitTime;
}
```

### Random Jitter Generation

```java
private int getRandomJitterSeconds(
    int maximumJitterMinutes,
    boolean includeNegativeJitter) {

  final int maximumJitterSeconds = maximumJitterMinutes * 60;
  final Random random = new Random();

  // Generate positive jitter: 0 to maxSeconds
  int jitterSeconds = random.nextInt(maximumJitterSeconds + 1);

  if (includeNegativeJitter) {
    // Shift to range: -max/2 to +max/2
    jitterSeconds -= maximumJitterSeconds / 2;
  }

  return jitterSeconds;
}
```

### Why Cron Needs Special Handling

```java
/*
 * Problem scenario with negative jitter for cron:
 *
 * 1. Cron scheduled for 12:00
 * 2. With -5 minute jitter, starts at 11:55
 * 3. Sync completes at 11:58
 * 4. Next cron time calculated: 12:00 (only 2 minutes away!)
 * 5. Another sync starts at 12:00 - DOUBLE EXECUTION
 *
 * Solution: Cron schedules only get positive jitter
 * - Scheduled for 12:00, jitter makes it 12:05
 * - Next calculation at 12:05 correctly returns 13:00
 */
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [d1c48feaed](https://github.com/airbytehq/airbyte-platform/commit/d1c48feaed) | Jun 16, 2023 | Add configurable schedule jitter based on bucketed wait time | Core implementation |
| [af60d88f7a](https://github.com/airbytehq/airbyte-platform/commit/af60d88f7a) | Jul 6, 2023 | Change jitter to only ever add time, rather than possibly subtract time | Initial cron fix |
| [3c3b8ee53e](https://github.com/airbytehq/airbyte-platform/commit/3c3b8ee53e) | Jul 27, 2023 | Bring back negative jitter for non-cron schedules | Refined approach |

## Business Value

### Infrastructure Impact
- **Smoother Load**: Syncs distributed across time windows
- **Reduced Peak**: Lower maximum concurrent syncs
- **Cost Savings**: Don't need to over-provision for peaks

### Reliability Impact
- **Less Contention**: Database and workers less stressed
- **Fewer Timeouts**: Resources available when needed
- **Better Predictability**: Steady-state load easier to plan for

### Customer Impact
- **Consistent Performance**: No slowdowns at popular times
- **Reliable Schedules**: Cron schedules execute correctly
- **Fair Resource Access**: No customer starves others

## Lessons Learned

### Schedule Type Awareness
Different schedule types need different treatment:
```java
// Cron: Users expect exact times, only delay
if (scheduleType == CRON) {
  jitter = positiveOnly(jitter);
}

// Interval: Slight variation is fine
if (scheduleType == BASIC_SCHEDULE) {
  jitter = bidirectional(jitter);
}
```

### Frequency-Proportional Jitter
More jitter for less frequent syncs:
```
Hourly sync:   ±2 minutes (small % of interval)
Daily sync:    ±15 minutes (still small % of interval)
```

### Edge Case Handling
Always check for negative results:
```java
Duration jittered = original.plusSeconds(jitter);
return jittered.isNegative() ? Duration.ZERO : jittered;
```
