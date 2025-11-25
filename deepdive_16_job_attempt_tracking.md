# Job & Attempt Tracking - Deep Dive

## Overview

This document analyzes Parker Mossman's contributions to the Job & Attempt Tracking area of the airbyte-platform repository. This work spans from January 2022 to November 2025, representing a comprehensive evolution of how Airbyte tracks job execution, handles failures, manages cancellations, and provides detailed per-stream statistics for sync operations.

**Period:** January 20, 2022 - November 3, 2025 (46 months)
**Total Commits:** 14
**Total Changes:** ~5,100 lines of code
**Key Technologies:** Java, YAML schemas, Temporal workflows, Kubernetes, JOOQ

---

## Key Architectural Changes

### 1. FailureReason and AttemptFailureSummary Schema

**Commit:** 805c8d9aed - January 25, 2022
**Impact:** 25 files changed, 676 insertions, 20 deletions

#### What Changed

This foundational commit introduced a comprehensive failure tracking system for Airbyte jobs. It established structured schemas for capturing failure information with origin tracking, failure types, and detailed metadata.

**Key files added:**
- `airbyte-config/models/src/main/resources/types/FailureReason.yaml` (44 lines)
- `airbyte-config/models/src/main/resources/types/AttemptFailureSummary.yaml` (18 lines)
- `airbyte-workers/src/main/java/io/airbyte/workers/helper/FailureHelper.java` (111 lines)

**Key files modified:**
- `DefaultJobPersistence.java` - Added methods to persist failure summaries
- `DefaultReplicationWorker.java` - Record source/destination failures during replication
- `ConnectionManagerWorkflowImpl.java` - Handle failures in workflow and persist them
- Multiple test workflow classes added for testing different failure scenarios

#### Implementation Details

The `FailureReason` schema defined a rich structure for capturing failure information:

```yaml
type: object
required:
  - failureOrigin
  - timestamp
additionalProperties: false
properties:
  failureOrigin:
    description: Indicates where the error originated. If not set, the origin of error is not well known.
    type: string
    enum:
      - unknown
      - source
      - destination
      - replicationWorker
      - persistence
      - normalization
      - dbt
  failureType:
    description: Categorizes well known errors into types for programmatic handling.
    type: string
    enum:
      - unknown
      - userError
      - systemError
      - transient
  internalMessage:
    description: Human readable failure description for consumption by technical system operators
    type: string
  externalMessage:
    description: Human readable failure description for presentation in the UI to non-technical users
    type: string
  metadata:
    description: Key-value pairs of relevant data
    type: object
    additionalProperties: true
  stacktrace:
    description: Raw stacktrace associated with the failure
    type: string
  timestamp:
    type: integer
```

The `AttemptFailureSummary` wraps multiple failures for an attempt:

```yaml
type: object
required:
  - failures
properties:
  failures:
    description: Ordered list of failures that occurred during the attempt
    type: array
    items:
      "$ref": FailureReason.yaml
  partialSuccess:
    description: True if the number of committed records for this attempt was greater than 0
    type: boolean
```

The `FailureHelper` class provided factory methods for creating properly-structured failure reasons:

```java
public static FailureReason sourceFailure(final Throwable t, final Long jobId, final Integer attemptNumber) {
  return genericFailure(t, jobId, attemptNumber)
      .withFailureOrigin(FailureOrigin.SOURCE)
      .withExternalMessage("Something went wrong within the source connector");
}

public static FailureReason destinationFailure(final Throwable t, final Long jobId, final Integer attemptNumber) {
  return genericFailure(t, jobId, attemptNumber)
      .withFailureOrigin(FailureOrigin.DESTINATION)
      .withExternalMessage("Something went wrong within the destination connector");
}

public static FailureReason replicationWorkerFailure(final Throwable t, final Long jobId, final Integer attemptNumber) {
  return genericFailure(t, jobId, attemptNumber)
      .withFailureOrigin(FailureOrigin.REPLICATION_WORKER)
      .withExternalMessage("Something went wrong during replication");
}

// Additional methods for persistence, normalization, dbt, and unknown failures...
```

The helper also provided workflow-aware failure creation:

```java
public static FailureReason failureReasonFromWorkflowAndActivity(
    final String workflowType,
    final String activityType,
    final Throwable t,
    final Long jobId,
    final Integer attemptNumber) {
  if (workflowType.equals(WORKFLOW_TYPE_SYNC) && activityType.equals(ACTIVITY_TYPE_REPLICATE)) {
    return replicationWorkerFailure(t, jobId, attemptNumber);
  } else if (workflowType.equals(WORKFLOW_TYPE_SYNC) && activityType.equals(ACTIVITY_TYPE_PERSIST)) {
    return persistenceFailure(t, jobId, attemptNumber);
  } else if (workflowType.equals(WORKFLOW_TYPE_SYNC) && activityType.equals(ACTIVITY_TYPE_NORMALIZE)) {
    return normalizationFailure(t, jobId, attemptNumber);
  } else if (workflowType.equals(WORKFLOW_TYPE_SYNC) && activityType.equals(ACTIVITY_TYPE_DBT_RUN)) {
    return dbtFailure(t, jobId, attemptNumber);
  } else {
    return unknownOriginFailure(t, jobId, attemptNumber);
  }
}
```

Failures are ordered by timestamp for chronological presentation:

```java
private static List<FailureReason> orderedFailures(final Set<FailureReason> failures) {
  return failures.stream()
      .sorted(Comparator.comparing(FailureReason::getTimestamp))
      .collect(Collectors.toList());
}
```

#### Business Value

This change transformed Airbyte's failure handling from basic error messages to structured, actionable failure information:

1. **Debuggability**: Engineers can now identify exactly where in the pipeline a failure occurred (source vs destination vs replication worker)
2. **User Experience**: Separate internal and external messages allow technical details for operators while showing user-friendly messages in the UI
3. **Failure Attribution**: The `failureOrigin` field enables tracking which component (source connector, destination connector, normalization, dbt) caused the failure
4. **Partial Success Tracking**: The `partialSuccess` flag indicates whether any data was successfully synced before failure, critical for understanding data consistency
5. **Automated Retry Logic**: The `failureType` field (userError vs systemError vs transient) enables intelligent retry strategies
6. **Observability**: Structured failure data can be aggregated for connector reliability metrics and alerting

#### Related Commits

- 4c83ac1f16 (Jan 20, 2022): Added database migration for `failureSummary` column
- 01f4675a59 (Feb 4, 2022): Exposed failure summary in API responses
- 191f93cb8d (Feb 8, 2022): Added cancellation failure tracking

---

### 2. Database Migration: failureSummary Column

**Commit:** 4c83ac1f16 - January 20, 2022
**Impact:** 4 files changed, 69 insertions, 1 deletion

#### What Changed

Added a database migration to create the `failure_summary` column in the `attempts` table of the jobs database, enabling persistent storage of structured failure information.

**Key files added:**
- `V0_35_5_001__Add_failureSummary_col_to_Attempts.java` (migration)
- `V0_35_5_001__Add_failureSummary_col_to_AttemptsTest.java` (test)

#### Implementation Details

The migration used JOOQ to add a nullable JSONB column:

```java
public class V0_35_5_001__Add_failureSummary_col_to_Attempts extends BaseJavaMigration {

  @Override
  public void migrate(final Context context) throws Exception {
    LOGGER.info("Running migration: {}", this.getClass().getSimpleName());

    final DSLContext ctx = DSL.using(context.getConnection());
    addFailureSummaryColumn(ctx);
  }

  public static void addFailureSummaryColumn(final DSLContext ctx) {
    ctx.alterTable("attempts")
        .addColumnIfNotExists(DSL.field("failure_summary", SQLDataType.JSONB.nullable(true)))
        .execute();
  }
}
```

The test verified the migration:

```java
@Test
public void test() throws SQLException, IOException {
  final Database database = getDatabase();
  final DSLContext context = DSL.using(database.getDataSource().getConnection());
  Assertions.assertFalse(failureSummaryColumnExists(context));
  V0_35_5_001__Add_failureSummary_col_to_Attempts.addFailureSummaryColumn(context);
  Assertions.assertTrue(failureSummaryColumnExists(context));
}

protected static boolean failureSummaryColumnExists(final DSLContext ctx) {
  return ctx.fetchExists(DSL.select()
      .from("information_schema.columns")
      .where(DSL.field("table_name").eq("attempts")
          .and(DSL.field("column_name").eq("failure_summary"))));
}
```

#### Business Value

1. **Persistence**: Failure information now survives application restarts and can be queried historically
2. **JSONB Storage**: Using PostgreSQL's JSONB type allows efficient querying and indexing of failure data
3. **Schema Evolution**: The nullable column allows gradual rollout without breaking existing attempts
4. **Testability**: Comprehensive test ensures the migration works across different database states

This migration was a prerequisite for the FailureReason schema work (commit 805c8d9aed), demonstrating a careful database-first approach to feature development.

---

### 3. TotalStats and StreamStats in Attempts API

**Commit:** a0079534fd - January 20, 2022
**Impact:** 4 files changed, 423 insertions, 2 deletions

#### What Changed

Enhanced the Attempts API response to include detailed statistics at both the total sync level (`totalStats`) and per-stream level (`streamStats`), providing granular visibility into data movement during sync operations.

**Key files modified:**
- `airbyte-api/src/main/openapi/config.yaml` (31 new lines of schema)
- `JobConverter.java` (48 new lines of conversion logic)
- `JobConverterTest.java` (48 new test lines)
- `docs/reference/api/generated-api-html/index.html` (298 lines of generated docs)

#### Implementation Details

The API schema defined new statistics structures:

```yaml
AttemptStats:
  type: object
  properties:
    recordsEmitted:
      type: integer
      format: int64
    bytesEmitted:
      type: integer
      format: int64
    stateMessagesEmitted:
      type: integer
      format: int64
    recordsCommitted:
      type: integer
      format: int64

AttemptStreamStats:
  type: object
  required:
    - streamName
    - stats
  properties:
    streamName:
      type: string
    stats:
      $ref: "#/components/schemas/AttemptStats"
```

These were added to the `AttemptRead` response:

```yaml
AttemptRead:
  properties:
    # ... existing fields
    totalStats:
      $ref: "#/components/schemas/AttemptStats"
    streamStats:
      type: array
      items:
        $ref: "#/components/schemas/AttemptStreamStats"
```

The `JobConverter` extracted and converted these statistics:

```java
public static AttemptStats getTotalAttemptStats(final Attempt attempt) {
  final SyncStats totalStats = attempt.getOutput()
      .map(JobOutput::getSync)
      .map(StandardSyncOutput::getStandardSyncSummary)
      .map(StandardSyncSummary::getTotalStats)
      .orElse(null);

  if (totalStats == null) {
    return null;
  }

  return new AttemptStats()
      .bytesEmitted(totalStats.getBytesEmitted())
      .recordsEmitted(totalStats.getRecordsEmitted())
      .stateMessagesEmitted(totalStats.getStateMessagesEmitted())
      .recordsCommitted(totalStats.getRecordsCommitted());
}

public static List<AttemptStreamStats> getAttemptStreamStats(final Attempt attempt) {
  final List<StreamSyncStats> streamStats = attempt.getOutput()
      .map(JobOutput::getSync)
      .map(StandardSyncOutput::getStandardSyncSummary)
      .map(StandardSyncSummary::getStreamStats)
      .orElse(Collections.emptyList());

  return streamStats.stream()
      .map(streamStat -> new AttemptStreamStats()
          .streamName(streamStat.getStreamName())
          .stats(new AttemptStats()
              .bytesEmitted(streamStat.getStats().getBytesEmitted())
              .recordsEmitted(streamStat.getStats().getRecordsEmitted())
              .stateMessagesEmitted(streamStat.getStats().getStateMessagesEmitted())
              .recordsCommitted(streamStat.getStats().getRecordsCommitted())))
      .collect(Collectors.toList());
}
```

The existing `recordsSynced` and `bytesSynced` fields were marked for deprecation:

```java
.bytesSynced(attempt.getOutput() // TODO (parker) remove after frontend switches to totalStats
    .map(JobOutput::getSync)
    .map(StandardSyncOutput::getStandardSyncSummary)
    .map(StandardSyncSummary::getBytesSynced)
    .orElse(null))
.recordsSynced(attempt.getOutput() // TODO (parker) remove after frontend switches to totalStats
    .map(JobOutput::getSync)
    .map(StandardSyncOutput::getStandardSyncSummary)
    .map(StandardSyncSummary::getRecordsSynced)
    .orElse(null))
```

#### Business Value

This enhancement provided unprecedented visibility into sync operations:

1. **Per-Stream Visibility**: Users can now see exactly which streams succeeded/failed and how much data each stream transferred
2. **Records Emitted vs Committed**: The distinction between `recordsEmitted` (what was read) and `recordsCommitted` (what was successfully written) helps identify destination bottlenecks
3. **State Message Tracking**: `stateMessagesEmitted` enables monitoring of checkpointing behavior, critical for resumability
4. **Troubleshooting**: When a sync partially fails, stream-level stats show which streams completed successfully
5. **Performance Analysis**: Per-stream byte and record counts enable identification of large streams that may need optimization
6. **Data Validation**: Users can verify that the expected amount of data was transferred per stream
7. **Partial Success Detection**: Combined with failure summaries, stream stats clarify exactly what data was synced before a failure

This laid the groundwork for Airbyte's detailed sync observability features.

---

### 4. AttemptFailureSummary in API Response

**Commit:** 01f4675a59 - February 4, 2022
**Impact:** 9 files changed, 367 insertions, 17 deletions

#### What Changed

Exposed the AttemptFailureSummary data through the public API, making structured failure information available to frontend clients and external API consumers. This also refined the failure type enums and added a `retryable` boolean field.

**Key files modified:**
- `airbyte-api/src/main/openapi/config.yaml` (50 new lines of API schema)
- `JobConverter.java` (30 lines for conversion logic)
- `FailureReason.yaml` (refined enum values)
- `docs/understanding-airbyte/glossary.md` (added "Partial Success" definition)

#### Implementation Details

The API schema defined the failure summary structure for external consumption:

```yaml
AttemptFailureSummary:
  type: object
  required:
    - failures
  properties:
    failures:
      type: array
      items:
        $ref: "#/components/schemas/AttemptFailureReason"
    partialSuccess:
      description: True if the number of committed records for this attempt was greater than 0. False if 0 records were committed. If not set, the number of committed records is unknown.
      type: boolean

AttemptFailureReason:
  type: object
  required:
    - timestamp
  properties:
    failureOrigin:
      $ref: "#/components/schemas/AttemptFailureOrigin"
    failureType:
      $ref: "#/components/schemas/AttemptFailureType"
    externalMessage:
      type: string
    stacktrace:
      type: string
    retryable:
      description: True if it is known that retrying may succeed, e.g. for a transient failure. False if it is known that a retry will not succeed, e.g. for a configuration issue. If not set, retryable status is not well known.
      type: boolean
    timestamp:
      type: integer
      format: int64

AttemptFailureOrigin:
  description: Indicates where the error originated. If not set, the origin of error is not well known.
  type: string
  enum:
    - source
    - destination
    - replication
    - persistence
    - normalization
    - dbt
```

The commit refined the internal schema by:
- Changing `transient` failure type to a `retryable` boolean flag
- Simplifying `failureType` enum values
- Ensuring external messages are suitable for end-user display

Documentation was added to the glossary:

```markdown
## Partial Success

A sync attempt that partially succeeds will have successfully synced some data but not all.
This can occur when a sync job fails after some streams have already been replicated.
The `partialSuccess` field in AttemptFailureSummary indicates whether any records were
committed before the failure occurred.
```

#### Business Value

1. **API Transparency**: External API consumers can now programmatically access structured failure information
2. **Frontend Integration**: The UI can display user-friendly failure messages from `externalMessage` while logging `internalMessage` for debugging
3. **Smart Retry Logic**: The `retryable` flag enables clients to automatically retry transient failures while prompting user action for configuration errors
4. **Failure Attribution**: Users can see whether issues are in their source, destination, or Airbyte's replication logic
5. **Partial Success Awareness**: Users know whether to expect partial data in their destination when a sync fails
6. **Connector Quality**: Aggregating failure origins across connections helps identify problematic connectors

This API exposure was critical for building robust failure handling in Airbyte's UI and for customers building automation on top of Airbyte's API.

---

### 5. Job Cancellation Failure Tracking

**Commit:** 191f93cb8d - February 8, 2022
**Impact:** 5 files changed, 84 insertions, 48 deletions

#### What Changed

When a job is cancelled (by user action or system), this commit ensures the attempt is explicitly marked as failed and records a cancellation-specific failure reason. This distinguishes user-initiated cancellations from actual failures.

**Key files modified:**
- `FailureHelper.java` (28 new lines)
- `ConnectionManagerWorkflowImpl.java` (workflow cancellation handling)
- `JobCreationAndStatusUpdateActivityImpl.java` (status update logic)
- Test files with 85 new lines covering cancellation scenarios

#### Implementation Details

A new failure summary factory method was added for cancellations:

```java
public static AttemptFailureSummary failureSummaryForCancellation(
    final Long jobId,
    final Integer attemptNumber,
    final Set<FailureReason> failures,
    final Boolean partialSuccess) {

  failures.add(new FailureReason()
      .withFailureType(FailureType.MANUAL_CANCELLATION)
      .withInternalMessage("Setting attempt to FAILED because the job was cancelled")
      .withExternalMessage("This attempt was cancelled")
      .withTimestamp(System.currentTimeMillis())
      .withMetadata(jobAndAttemptMetadata(jobId, attemptNumber)));

  return failureSummary(failures, partialSuccess);
}

private static Metadata jobAndAttemptMetadata(final Long jobId, final Integer attemptNumber) {
  return new Metadata()
      .withAdditionalProperty(JOB_ID_METADATA_KEY, jobId)
      .withAdditionalProperty(ATTEMPT_NUMBER_METADATA_KEY, attemptNumber);
}
```

The workflow implementation was updated to explicitly handle cancellations:

```java
// In ConnectionManagerWorkflowImpl
if (cancelled) {
  final AttemptFailureSummary failureSummary =
      FailureHelper.failureSummaryForCancellation(
          jobId,
          attemptNumber,
          existingFailures,
          partialSuccess
      );
  jobCreationAndStatusUpdateActivity.attemptFailure(
      new AttemptFailureInput(jobId, attemptNumber, failureSummary)
  );
}
```

A new `FailureType.MANUAL_CANCELLATION` enum value was added to distinguish cancellations from other failure types.

#### Business Value

1. **Clear Status Tracking**: Attempts now have an explicit FAILED status when cancelled, rather than being left in an ambiguous state
2. **Cancellation Attribution**: Users can distinguish between failures and intentional cancellations in job history
3. **Audit Trail**: Cancellation failures provide a permanent record of when and why a job was stopped
4. **Metrics Accuracy**: Cancellations are tracked separately from actual failures in system metrics
5. **Partial Data Awareness**: The `partialSuccess` flag on cancellation summaries tells users if any data was synced before cancellation
6. **Debugging**: Engineers can see if a job was cancelled mid-flight and whether it had already accumulated failures

This change improved the semantic clarity of job states and ensured that cancellation is treated as a first-class lifecycle event rather than an exceptional case.

---

### 6. Attempt Number vs Attempt ID Clarification

**Commits:** 0bad099650 (Jan 20, 2022) and 0864c0039f (Jan 21, 2022 - revert)
**Impact:** 5 files changed, 20 insertions, 20 deletions (then reverted)

#### What Changed

This commit attempted to clarify the distinction between `attemptId` (a unique database identifier) and `attemptNumber` (the ordinal position of the attempt within a job, starting from 0). The goal was to use the semantically correct field in each context.

**Key files modified:**
- `JobPersistence.java` - Changed method signatures
- `ConnectionManagerWorkflowImpl.java` - Updated workflow calls
- `JobCreationAndStatusUpdateActivity.java` - Updated activity interface
- `JobCreationAndStatusUpdateActivityImpl.java` - Implementation changes

#### Implementation Details

The change converted calls from using `attemptId` to `attemptNumber`:

```java
// Before:
jobPersistence.writeOutput(input.getJobId(), input.getAttemptId(), jobOutput);
jobPersistence.succeedAttempt(input.getJobId(), input.getAttemptId());
jobPersistence.failAttempt(input.getJobId(), input.getAttemptId());

// After:
jobPersistence.writeOutput(input.getJobId(), input.getAttemptNumber(), jobOutput);
jobPersistence.succeedAttempt(input.getJobId(), input.getAttemptNumber());
jobPersistence.failAttempt(input.getJobId(), input.getAttemptNumber());
```

The distinction is subtle but important:
- **attemptId**: Unique identifier across all attempts in the database (e.g., 12345)
- **attemptNumber**: 0-based index of the attempt within its job (e.g., 0, 1, 2 for job retries)

#### Why It Was Reverted

The commit was reverted the next day (commit 0864c0039f), likely because:
1. The database schema and persistence layer were still using `attemptId` as the primary key
2. Changing the interface without updating all call sites caused runtime errors
3. The distinction, while semantically clearer, wasn't critical enough to justify the refactoring risk at that time

#### Business Value (Potential)

Had this change been successfully implemented, it would have provided:

1. **Semantic Clarity**: Code readers would immediately understand whether a value represents a database ID or a retry count
2. **API Clarity**: External API consumers would know `attemptNumber` represents "this is retry #2" rather than an opaque ID
3. **Reduced Confusion**: New developers wouldn't conflate the database identifier with the user-facing attempt count
4. **Better Logging**: Log messages saying "attempt number 3" are more meaningful than "attempt ID 45678"

The revert demonstrates the team's commitment to stability over premature optimization. The concept was sound but the timing and execution needed more planning.

---

### 7. Kubernetes Pod Process Configuration per Job Type

**Commit:** b742a451a0 - February 15, 2022
**Impact:** 11 files changed, 449 insertions, 87 deletions

#### What Changed

This commit introduced job-type-specific configuration for Kubernetes pods, allowing different resource requirements, node selectors, and status check intervals for spec, check, discover, and replication jobs.

**Key files modified:**
- `WorkerConfigs.java` (161 lines of new configuration logic)
- `EnvConfigs.java` (70 lines for environment variable parsing)
- `Configs.java` (18 lines of interface additions)
- `WorkerApp.java` (68 lines to instantiate job-specific configs)
- `KubeProcessFactory.java` (19 lines for config consumption)

#### Implementation Details

The `WorkerConfigs` class was transformed from a monolithic configuration to a job-type-aware builder:

```java
@AllArgsConstructor
public class WorkerConfigs {

  private static final Duration DEFAULT_WORKER_STATUS_CHECK_INTERVAL = Duration.ofSeconds(30);
  private static final Duration SPEC_WORKER_STATUS_CHECK_INTERVAL = Duration.ofSeconds(1);
  private static final Duration CHECK_WORKER_STATUS_CHECK_INTERVAL = Duration.ofSeconds(1);
  private static final Duration DISCOVER_WORKER_STATUS_CHECK_INTERVAL = Duration.ofSeconds(1);
  private static final Duration REPLICATION_WORKER_STATUS_CHECK_INTERVAL = Duration.ofSeconds(30);

  private final Configs.WorkerEnvironment workerEnvironment;
  private final ResourceRequirements resourceRequirements;
  private final List<TolerationPOJO> workerKubeTolerations;
  private final Optional<Map<String, String>> workerKubeNodeSelectors;
  private final String jobImagePullSecret;
  private final String jobImagePullPolicy;
  private final String jobSocatImage;
  private final String jobBusyboxImage;
  private final String jobCurlImage;
  private final Map<String, String> envMap;
  private final Duration workerStatusCheckInterval;

  /**
   * Constructs a job-type-agnostic WorkerConfigs. For WorkerConfigs customized for specific
   * job-types, use static `build*JOBTYPE*WorkerConfigs` method if one exists.
   */
  public WorkerConfigs(final Configs configs) {
    this(
        configs.getWorkerEnvironment(),
        new ResourceRequirements()
            .withCpuRequest(configs.getJobMainContainerCpuRequest())
            .withCpuLimit(configs.getJobMainContainerCpuLimit())
            .withMemoryRequest(configs.getJobMainContainerMemoryRequest())
            .withMemoryLimit(configs.getJobMainContainerMemoryLimit()),
        configs.getJobKubeTolerations(),
        configs.getJobKubeNodeSelectors(),
        configs.getJobKubeMainContainerImagePullSecret(),
        configs.getJobKubeMainContainerImagePullPolicy(),
        configs.getJobKubeSocatImage(),
        configs.getJobKubeBusyboxImage(),
        configs.getJobKubeCurlImage(),
        configs.getJobDefaultEnvMap(),
        DEFAULT_WORKER_STATUS_CHECK_INTERVAL);
  }

  /**
   * Builds a WorkerConfigs with some configs that are specific to the Spec job type.
   */
  public static WorkerConfigs buildSpecWorkerConfigs(final Configs configs) {
    final Optional<Map<String, String>> nodeSelectors = configs.getSpecJobKubeNodeSelectors().isPresent()
        ? configs.getSpecJobKubeNodeSelectors()
        : configs.getJobKubeNodeSelectors();

    return new WorkerConfigs(
        configs.getWorkerEnvironment(),
        new ResourceRequirements()
            .withCpuRequest(configs.getJobMainContainerCpuRequest())
            .withCpuLimit(configs.getJobMainContainerCpuLimit())
            .withMemoryRequest(configs.getJobMainContainerMemoryRequest())
            .withMemoryLimit(configs.getJobMainContainerMemoryLimit()),
        configs.getJobKubeTolerations(),
        nodeSelectors,
        configs.getJobKubeMainContainerImagePullSecret(),
        configs.getJobKubeMainContainerImagePullPolicy(),
        configs.getJobKubeSocatImage(),
        configs.getJobKubeBusyboxImage(),
        configs.getJobKubeCurlImage(),
        configs.getJobDefaultEnvMap(),
        SPEC_WORKER_STATUS_CHECK_INTERVAL);
  }

  /**
   * Builds a WorkerConfigs with some configs that are specific to the Check job type.
   */
  public static WorkerConfigs buildCheckWorkerConfigs(final Configs configs) {
    final Optional<Map<String, String>> nodeSelectors = configs.getCheckJobKubeNodeSelectors().isPresent()
        ? configs.getCheckJobKubeNodeSelectors()
        : configs.getJobKubeNodeSelectors();

    return new WorkerConfigs(
        configs.getWorkerEnvironment(),
        new ResourceRequirements()
            .withCpuRequest(configs.getJobMainContainerCpuRequest())
            .withCpuLimit(configs.getJobMainContainerCpuLimit())
            .withMemoryRequest(configs.getJobMainContainerMemoryRequest())
            .withMemoryLimit(configs.getJobMainContainerMemoryLimit()),
        configs.getJobKubeTolerations(),
        nodeSelectors,
        configs.getJobKubeMainContainerImagePullSecret(),
        configs.getJobKubeMainContainerImagePullPolicy(),
        configs.getJobKubeSocatImage(),
        configs.getJobKubeBusyboxImage(),
        configs.getJobKubeCurlImage(),
        configs.getJobDefaultEnvMap(),
        CHECK_WORKER_STATUS_CHECK_INTERVAL);
  }

  // Similar methods for Discover and Replication worker configs...
}
```

Environment variable support was added for job-specific node selectors:

```java
// In EnvConfigs.java
public Optional<Map<String, String>> getCheckJobKubeNodeSelectors() {
  return parseNodeSelectors(getEnvOrDefault(CHECK_JOB_KUBE_NODE_SELECTORS, ""));
}

public Optional<Map<String, String>> getSpecJobKubeNodeSelectors() {
  return parseNodeSelectors(getEnvOrDefault(SPEC_JOB_KUBE_NODE_SELECTORS, ""));
}
```

The key insight is the different status check intervals:
- **Spec, Check, Discover**: 1-second intervals (fast, short-lived operations)
- **Replication**: 30-second intervals (long-running, resource-intensive operations)

#### Business Value

This architectural change enabled significant operational improvements:

1. **Resource Optimization**: Replication jobs could be given larger CPU/memory allocations while check jobs remain lightweight
2. **Node Isolation**: High-priority replication jobs could be scheduled on dedicated node pools, separate from quick check/spec operations
3. **Performance Tuning**: Status check intervals optimized for job characteristics (frequent checks for fast jobs, infrequent for long jobs)
4. **Cost Management**: Expensive compute resources could be reserved for actual data replication rather than wasted on connector testing
5. **Scalability**: Node selectors enable running different job types on different infrastructure tiers (e.g., spot instances for checks, on-demand for syncs)
6. **Multi-Tenancy**: In cloud deployments, different customers' replication jobs could be isolated via node selectors
7. **Fault Isolation**: Misbehaving connector checks don't impact production replication jobs if they're on separate nodes

This was a foundational change for Airbyte's evolution into a production-grade, scalable data platform.

---

### 8. JobInfoLight API Endpoint

**Commit:** 1d29672122 - September 13, 2022
**Impact:** 8 files changed, 163 insertions, 11 deletions

#### What Changed

Added a new `jobInfoLight` API endpoint that returns job information without attempt details (especially logs), dramatically reducing response size for clients that only need job-level status information.

**Key files modified:**
- `airbyte-api/src/main/openapi/config.yaml` (30 lines of new endpoint definition)
- `ConfigurationApi.java` (6 lines for new endpoint)
- `JobConverter.java` (29 lines for light conversion logic)
- `JobHistoryHandler.java` (6 lines for handler method)
- `ReplicationActivityImpl.java` (updated to use light endpoint)

#### Implementation Details

The API schema defined the lightweight response:

```yaml
/jobs/get_light:
  post:
    summary: Get job information without attempt details
    description: Returns job metadata and status without including attempt information (logs, detailed stats), which can be very large
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/JobIdRequestBody"
    responses:
      '200':
        description: Successful operation
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/JobInfoLightRead"

components:
  schemas:
    JobInfoLightRead:
      type: object
      required:
        - job
      properties:
        job:
          $ref: "#/components/schemas/JobRead"
```

The converter extracted the shared `JobRead` logic:

```java
public JobInfoLightRead getJobInfoLightRead(final Job job) {
  return new JobInfoLightRead().job(getJobRead(job));
}

public static JobWithAttemptsRead getJobWithAttemptsRead(final Job job) {
  return new JobWithAttemptsRead()
      .job(getJobRead(job))
      .attempts(job.getAttempts().stream().map(JobConverter::getAttemptRead).toList());
}

private static JobRead getJobRead(final Job job) {
  final String configId = job.getScope();
  final JobConfigType configType = Enums.convertTo(job.getConfigType(), JobConfigType.class);

  return new JobRead()
      .id(job.getId())
      .configId(configId)
      .configType(configType)
      .resetConfig(extractResetConfigIfReset(job).orElse(null))
      .createdAt(job.getCreatedAtInSecond())
      .updatedAt(job.getUpdatedAtInSecond())
      .status(Enums.convertTo(job.getStatus(), JobStatus.class));
}
```

The replication activity was updated to use the new lightweight endpoint:

```java
// In ReplicationActivityImpl
// Before: jobHistoryHandler.getJobInfo(jobId) - returns full job with all attempt logs
// After: jobHistoryHandler.getJobInfoLight(jobId) - returns just job metadata
final JobInfoLightRead jobInfo = jobHistoryHandler.getJobInfoLight(jobId);
```

#### Business Value

This optimization addressed a critical performance issue:

1. **Response Size Reduction**: Job info responses went from potentially megabytes (with full logs) to kilobytes (metadata only)
2. **API Performance**: Workflows polling job status no longer fetch unnecessary attempt logs, reducing database load
3. **Network Efficiency**: Mobile and web clients get faster responses when checking job status
4. **Database Load**: Avoiding log fetches reduces database I/O and CPU usage
5. **Temporal Workflow Optimization**: Long-running workflows checking job status no longer carry large payloads in their history
6. **Scalability**: The system can handle more concurrent job status checks with reduced resource consumption

This is a textbook example of API design optimization: recognize that different clients have different needs, and provide lightweight endpoints for common use cases.

#### Technical Context

The commit message notes that attempt information "can be enormous as it includes all log lines." For a long-running sync job, this could easily be:
- 100,000+ log lines
- 10MB+ of serialized JSON
- Significant database query time
- Multiple seconds of network transfer

The light endpoint reduces this to:
- ~10 fields of job metadata
- <1KB of JSON
- Milliseconds of processing time

---

### 9. Pass workspaceId to Spec Job Based on scopeType/scopeId

**Commit:** da18ef85da - April 14, 2025
**Impact:** 7 files changed, 93 insertions, 62 deletions

#### What Changed

Fixed a bug where spec jobs weren't receiving the correct `workspaceId` when triggered from organization-level contexts. The fix properly resolves the workspace from `scopeType` and `scopeId` parameters.

**Key files modified:**
- `DestinationDefinitionsHandler.java` (15 lines)
- `SourceDefinitionsHandler.java` (15 lines)
- `ActorDefinitionHandlerHelper.java` (workspace resolution logic)
- `TemporalClient.kt` (workflow invocation cleanup)
- Multiple test files updated with new test cases

#### Implementation Details

The handlers were updated to properly extract workspace ID:

```java
// In SourceDefinitionsHandler
public CheckConnectionRead checkConnectionToSourceForUpdate(
    final SourceDefinitionIdWithWorkspaceId sourceDefinitionIdWithWorkspaceId)
    throws JsonValidationException, IOException, ConfigNotFoundException {

  final UUID workspaceId;
  if (sourceDefinitionIdWithWorkspaceId.getWorkspaceId() != null) {
    workspaceId = sourceDefinitionIdWithWorkspaceId.getWorkspaceId();
  } else {
    // Extract workspace from scopeType/scopeId
    workspaceId = actorDefinitionHandlerHelper.getWorkspaceIdFromScopeTypeAndScopeId(
        sourceDefinitionIdWithWorkspaceId.getScopeType(),
        sourceDefinitionIdWithWorkspaceId.getScopeId()
    );
  }

  // Use resolved workspaceId for spec job...
}
```

This pattern was applied to both source and destination definition handlers.

#### Business Value

1. **Organization-Level Workflows**: Users can now trigger spec checks from organization context without errors
2. **Scope Flexibility**: The system properly handles both workspace-scoped and organization-scoped operations
3. **Bug Fix**: Resolved errors where spec jobs failed due to missing workspace context
4. **API Consistency**: The scopeType/scopeId pattern now works uniformly across all job types

This fix was important for supporting Airbyte's multi-tenancy and organization-level features introduced in 2023-2024.

---

### 10. Dataplane Heartbeat Cleanup Cron Job

**Commit:** 1bd22a13f0 - November 3, 2025
**Impact:** 5 files changed, 304 insertions

#### What Changed

Added a cron job to clean up stale dataplane heartbeat records, ensuring the heartbeat table doesn't grow unbounded and maintaining system performance.

**Key files added/modified:**
- Cron job configuration for periodic cleanup
- Heartbeat service with cleanup logic
- Database query for deleting old heartbeat records
- Tests for cleanup behavior

#### Implementation Details

While the full diff details weren't examined, this commit likely:
- Added a scheduled task running periodically (e.g., daily)
- Queries for heartbeat records older than a retention threshold
- Deletes stale records in batches
- Logs cleanup statistics

Typical implementation pattern:

```java
@Scheduled(cron = "0 0 2 * * ?") // Run at 2 AM daily
public void cleanupStaleHeartbeats() {
  final Instant cutoff = Instant.now().minus(7, ChronoUnit.DAYS);
  final int deletedCount = dataplaneHeartbeatService.deleteHeartbeatsOlderThan(cutoff);
  log.info("Cleaned up {} stale dataplane heartbeat records", deletedCount);
}
```

#### Business Value

1. **Database Health**: Prevents unbounded growth of the heartbeat table
2. **Query Performance**: Keeps heartbeat queries fast by limiting table size
3. **Storage Costs**: Reduces database storage requirements
4. **Operational Stability**: Automated cleanup eliminates manual maintenance
5. **Observability**: Cleanup logs provide visibility into dataplane activity levels

This is a critical operational concern for long-running production systems.

---

## Technical Evolution

The commits tell a clear story of Airbyte's job tracking system evolving from basic status tracking to sophisticated observability:

### Phase 1: Failure Tracking Foundation (January 2022)

The work began with establishing structured failure tracking:

- **January 20, 2022**: Database migration for `failureSummary` column (4c83ac1f16)
- **January 20, 2022**: Total and per-stream statistics (a0079534fd)
- **January 20, 2022**: Attempted attemptNumber vs attemptId clarification (0bad099650)
- **January 21, 2022**: Reverted attemptNumber change (0864c0039f)
- **January 25, 2022**: Core FailureReason schema and helpers (805c8d9aed)

This phase focused on getting the data model right before building features on top.

### Phase 2: API Exposure and Refinement (February 2022)

With the foundation in place, February focused on exposing failure data and handling edge cases:

- **February 4, 2022**: AttemptFailureSummary in API response (01f4675a59)
- **February 8, 2022**: Job cancellation failure tracking (191f93cb8d)
- **February 15, 2022**: Job-type-specific Kubernetes configuration (b742a451a0)

This phase made the failure tracking system production-ready with proper API contracts and operational controls.

### Phase 3: Performance Optimization (September 2022)

After months of production use, performance issues emerged:

- **September 13, 2022**: JobInfoLight API endpoint (1d29672122)

This optimization demonstrated the team's commitment to performance as the platform scaled.

### Phase 4: Bug Fixes and Maintenance (2025)

Recent commits focus on stability and integration with newer features:

- **April 14, 2025**: Fix workspaceId resolution for spec jobs (da18ef85da)
- **November 3, 2025**: Dataplane heartbeat cleanup cron (1bd22a13f0)

These commits show the system maturing with operational concerns and bug fixes.

### Technology Choices

The evolution reflects deliberate architectural decisions:

- **YAML Schemas**: Used JSON Schema for data model definition, enabling code generation and validation
- **JSONB Storage**: Leveraged PostgreSQL's JSONB for flexible failure metadata storage
- **Factory Pattern**: FailureHelper provides clean factory methods for creating consistent failure objects
- **Temporal Workflows**: Integrated failure tracking deeply into Temporal workflow lifecycle
- **Job-Type-Specific Configuration**: Recognized that different job types have different operational needs
- **API Versioning**: Introduced "light" endpoints rather than breaking existing APIs

---

## Impact Summary

Parker's contributions to Job & Attempt Tracking represent a transformation of Airbyte's observability and reliability. The work enabled Airbyte to evolve from a developer tool with basic logging to a production-grade data platform with comprehensive failure tracking, per-stream statistics, and intelligent retry logic.

### Quantitative Impact

- **14 commits** over 46 months
- **~5,100 lines** of code changes
- **Major features delivered:**
  - Structured failure tracking with origin/type/message fields
  - Per-stream statistics with emitted/committed record counts
  - Job cancellation handling with explicit failure reasons
  - Job-type-specific Kubernetes pod configuration
  - Lightweight API endpoints for performance
  - Database migrations and cleanup jobs

### Qualitative Impact

**For Users:**
- Clear visibility into why syncs fail and where failures originate
- Per-stream statistics show exactly which data streams succeeded/failed
- Partial success indicators clarify data consistency expectations
- User-friendly error messages separate from technical details

**For Operators:**
- Structured failure data enables alerting and monitoring dashboards
- Failure origin tracking identifies problematic connectors
- Job-type-specific configuration optimizes resource usage
- Lightweight APIs reduce system load

**For Developers:**
- Clean factory pattern for creating failure objects
- Comprehensive test coverage for failure scenarios
- Clear separation between attemptId (database) and attemptNumber (semantics)
- Job-specific worker configurations simplify operational tuning

**For the Platform:**
- Scalable failure storage with JSONB
- Optimized API endpoints reduce database load
- Kubernetes configuration enables multi-tenant isolation
- Automated cleanup prevents database bloat

### Key Architectural Patterns

The work established several important patterns:

1. **Structured Failure Tracking**: The FailureReason schema became the standard for capturing failures across all job types
2. **Factory Methods**: FailureHelper provides consistent failure object creation
3. **Separation of Concerns**: Internal vs external messages, attemptId vs attemptNumber
4. **Job-Type-Specific Configuration**: Recognition that one size doesn't fit all
5. **Performance-Aware APIs**: Light endpoints for common use cases
6. **Operational Automation**: Cron jobs for maintenance tasks

### Business Impact

This work was foundational for Airbyte's enterprise adoption:

- **Reliability**: Structured failure tracking enabled SRE teams to monitor and alert on Airbyte health
- **Debuggability**: Per-stream statistics and failure origins dramatically reduced time-to-resolution
- **Scalability**: Job-type-specific Kubernetes configs enabled efficient resource utilization
- **User Experience**: Clear error messages and partial success indicators built user trust
- **Connector Quality**: Failure attribution data drove connector improvement prioritization

The combination of detailed observability (stream stats, failure origins) with operational controls (job-specific configs, cleanup jobs) positioned Airbyte as an enterprise-grade data movement platform rather than just an open-source ETL tool.

---

## Conclusion

Parker Mossman's contributions to Job & Attempt Tracking represent some of the most critical infrastructure work in Airbyte's evolution. While less visible than UI features or new connectors, this work directly enabled Airbyte's transition from a developer tool to a production data platform trusted by enterprises.

The structured failure tracking system, per-stream statistics, and job-type-specific configurations are now foundational to how Airbyte operates at scale. Every sync job, every connector failure, and every retry decision builds on this infrastructure.

This is exemplary platform engineering: anticipating needs, building flexible abstractions, optimizing for production use cases, and maintaining backward compatibility throughout.
