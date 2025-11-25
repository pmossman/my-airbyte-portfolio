# Job Failure Tracking System

## Overview
- **Time Period:** January - February 2022 (~6 weeks)
- **Lines of Code:** ~1,200 additions
- **Files Changed:** 25+ files
- **Key Technologies:** Java, PostgreSQL, OpenAPI

One-paragraph summary: Built comprehensive job failure tracking infrastructure including per-stream record counts, attempt failure summaries, and failure reason categorization. This system provides visibility into sync failures at both the job and stream level, enabling better debugging and user communication.

## Problem Statement
When data syncs failed, there was limited visibility into:
- Which specific streams failed vs succeeded
- How many records were processed before failure
- The origin of the failure (source, destination, replication)
- Historical failure patterns for debugging

## Solution Architecture
Designed a multi-layer tracking system:

1. **FailureReason Schema** - Categorized failure types with origin tracking
2. **AttemptFailureSummary** - Aggregated failure info per attempt
3. **Per-Stream Statistics** - Record counts and commit tracking per stream
4. **API Exposure** - Failure data accessible through API responses

## Implementation Details

### Failure Reason Schema

```java
public class FailureReason {
  private FailureOrigin failureOrigin;  // SOURCE, DESTINATION, REPLICATION
  private FailureType failureType;
  private String externalMessage;       // User-facing message
  private String internalMessage;       // Debug details
  private String stacktrace;
  private Boolean retryable;
  private Long timestamp;
}

public enum FailureOrigin {
  SOURCE,
  DESTINATION,
  REPLICATION,
  UNKNOWN
}
```

### Attempt Failure Summary

```java
public class AttemptFailureSummary {
  private List<FailureReason> failures;
  private Boolean partialSuccess;  // Some streams succeeded

  public static AttemptFailureSummary fromFailures(List<FailureReason> failures) {
    return new AttemptFailureSummary()
        .withFailures(failures)
        .withPartialSuccess(false);
  }
}
```

### Per-Stream Record Tracking

```java
// Track records per stream during sync
public class StreamSyncStats {
  private String streamName;
  private String streamNamespace;
  private Long recordsEmitted;
  private Long recordsCommitted;
  private Long bytesEmitted;
  private SyncStatsState state;  // COMPLETE, INCOMPLETE
}

// Migration to add stats columns
ALTER TABLE attempts
  ADD COLUMN total_stats JSONB,
  ADD COLUMN stream_stats JSONB;
```

### API Response Enhancement

```java
// Exposing failure data in API
public AttemptRead toAttemptRead(Attempt attempt) {
  return new AttemptRead()
      .id(attempt.getId())
      .status(attempt.getStatus())
      .failureSummary(attempt.getFailureSummary())
      .totalStats(attempt.getTotalStats())
      .streamStats(attempt.getStreamStats());
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [bf9e9cae38](https://github.com/airbytehq/airbyte-platform/commit/bf9e9cae38) | Jan 11, 2022 | Track per-stream record counts and records committed | Core stream stats |
| [805c8d9aed](https://github.com/airbytehq/airbyte-platform/commit/805c8d9aed) | Jan 25, 2022 | Add FailureReason and AttemptFailureSummary schema | Failure schema |
| [4c83ac1f16](https://github.com/airbytehq/airbyte-platform/commit/4c83ac1f16) | Jan 20, 2022 | Migration: add failureSummary column to Attempts table | Database schema |
| [a0079534fd](https://github.com/airbytehq/airbyte-platform/commit/a0079534fd) | Jan 20, 2022 | Add totalStats and streamStats in Attempts API response | API exposure |
| [01f4675a59](https://github.com/airbytehq/airbyte-platform/commit/01f4675a59) | Feb 4, 2022 | Add AttemptFailureSummary to API response | API exposure |
| [1638d79696](https://github.com/airbytehq/airbyte-platform/commit/1638d79696) | Feb 8, 2022 | Distinguish source/destination/replication failures | Failure origin |
| [191f93cb8d](https://github.com/airbytehq/airbyte-platform/commit/191f93cb8d) | Feb 8, 2022 | Set Attempt to failed status when Job is cancelled | Cancellation handling |

## Business Value

### User Impact
- **Better Debugging**: Users can see exactly which streams failed
- **Partial Success Visibility**: Know when some streams succeeded despite failures
- **Actionable Messages**: User-facing error messages separate from debug info

### Operational Impact
- **Failure Categorization**: Distinguish source vs destination vs platform issues
- **Record Tracking**: Know exactly how much data was processed
- **Historical Analysis**: Query failure patterns over time

### Technical Impact
- **Structured Failure Data**: Consistent schema for all failure types
- **API Completeness**: Full failure context available through API
- **Retry Intelligence**: `retryable` flag enables smarter retry logic

## Lessons Learned

### Failure Origin Distinction
Categorizing failures by origin (source/destination/replication) proved essential:
```java
// Different handling based on origin
switch (failure.getFailureOrigin()) {
  case SOURCE -> notifySourceOwner(failure);
  case DESTINATION -> notifyDestinationOwner(failure);
  case REPLICATION -> alertPlatformTeam(failure);
}
```

### Partial Success Handling
Syncs can partially succeed (some streams complete):
```java
// Don't mark entire job as failed if some streams succeeded
if (completedStreams.size() > 0 && failedStreams.size() > 0) {
  summary.setPartialSuccess(true);
}
```
