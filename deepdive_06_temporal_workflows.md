# Temporal Workflows - Deep Dive

## Overview

This document analyzes Parker Mossman's contributions to Temporal Workflows in the airbyte-platform repository. This work spans from June 2022 to November 2025, encompassing foundational Temporal Cloud infrastructure, workflow implementations, cron job scheduling, and business-critical workflows for billing and domain verification.

**Period:** June 21, 2022 - November 5, 2025 (40 months)
**Total Commits:** 29 analyzed commits
**Total Changes:** ~3,500 lines of code
**Key Technologies:** Temporal, Java, Kotlin, Micronaut, Cron scheduling

---

## Key Architectural Changes

### 1. Temporal Cloud Migration

**Commit:** 9403c28b50 - June 21, 2022
**Impact:** 10 files changed, 223 insertions, 93 deletions

#### What Changed

This foundational commit migrated Airbyte's workflow orchestration from self-hosted Temporal to Temporal Cloud, introducing SSL/TLS certificate authentication and cloud-specific connection patterns.

**Key files:**
- `airbyte-config/src/main/java/io/airbyte/config/Configs.java` (added cloud config)
- `airbyte-config/src/main/java/io/airbyte/config/EnvConfigs.java` (added cloud env vars)
- `airbyte-workers/src/main/java/io/airbyte/workers/temporal/TemporalUtils.java` (major refactor)

#### Implementation Details

The core innovation was dual-mode Temporal client configuration supporting both self-hosted and cloud deployments:

```java
public static WorkflowServiceStubs createTemporalService(final boolean isCloud) {
    final WorkflowServiceStubsOptions options = isCloud ? getCloudTemporalOptions() : getAirbyteTemporalOptions(configs.getTemporalHost());
    final String namespace = isCloud ? configs.getTemporalCloudNamespace() : DEFAULT_NAMESPACE;

    return createTemporalService(options, namespace);
}

private static WorkflowServiceStubsOptions getCloudTemporalOptions() {
    final InputStream clientCert = new ByteArrayInputStream(configs.getTemporalCloudClientCert().getBytes(StandardCharsets.UTF_8));
    final InputStream clientKey = new ByteArrayInputStream(configs.getTemporalCloudClientKey().getBytes(StandardCharsets.UTF_8));
    try {
        return WorkflowServiceStubsOptions.newBuilder()
            .setSslContext(SimpleSslContextBuilder.forPKCS8(clientCert, clientKey).build())
            .setTarget(configs.getTemporalCloudHost())
            .build();
    } catch (final SSLException e) {
        log.error("SSL Exception occurred attempting to establish Temporal Cloud options.");
        throw new RuntimeException(e);
    }
}

@VisibleForTesting
public static WorkflowServiceStubsOptions getAirbyteTemporalOptions(final String temporalHost) {
    return WorkflowServiceStubsOptions.newBuilder()
        .setTarget(temporalHost)
        .build();
}
```

The connection establishment logic was enhanced with namespace-aware waiting:

```java
protected static NamespaceInfo getNamespaceInfo(final WorkflowServiceStubs temporalService, final String namespace) {
    return temporalService.blockingStub()
        .describeNamespace(DescribeNamespaceRequest.newBuilder().setNamespace(namespace).build())
        .getNamespaceInfo();
}
```

#### Business Value

This migration was strategically critical for Airbyte's infrastructure:

1. **Managed Service**: Offloaded operational complexity of running Temporal to Temporal Cloud
2. **Scalability**: Temporal Cloud provided better horizontal scaling for workflow execution
3. **Reliability**: Enterprise-grade SLAs from Temporal Cloud vs self-hosted infrastructure
4. **Security**: Certificate-based authentication protected workflow execution
5. **Cost Optimization**: Reduced infrastructure management overhead

The dual-mode configuration allowed gradual migration without breaking existing deployments.

#### Related Commits

- 884a94ed29 (Apr 8, 2022): Un-revert OSS branch build for Cloud workflow
- 84436b01a0 (Apr 8, 2022): Handle unexpected Temporal state during workflow updates

---

### 2. Cron Schedule Feature Flag Fix

**Commit:** 4ce6bf7717 - October 30, 2023
**Impact:** 5 files changed, 440 insertions, 209 deletions

#### What Changed

Fixed critical bugs in cron-scheduled workflows where feature flags caused schedules to be skipped or executed multiple times. Introduced a dedicated `CronSchedulingHelper` to encapsulate scheduling logic with proper safeguards.

**Key files added:**
- `airbyte-workers/src/main/java/io/airbyte/workers/helpers/CronSchedulingHelper.java` (new, 52 lines)
- `airbyte-workers/src/test/java/io/airbyte/workers/helpers/CronSchedulingHelperTest.java` (new, 106 lines)

**Key files modified:**
- `airbyte-workers/src/main/java/io/airbyte/workers/temporal/scheduling/activities/ConfigFetchActivityImpl.java`
- `airbyte-featureflag/src/main/kotlin/FlagDefinitions.kt`

#### Implementation Details

The new `CronSchedulingHelper` ensured minimum intervals between cron executions:

```java
/**
 * Static helper class for cron scheduling logic.
 */
public class CronSchedulingHelper {

  protected static final long MS_PER_SECOND = 1000L;
  private static final long MIN_CRON_INTERVAL_SECONDS = 60;

  public static Duration getNextRuntimeBasedOnPreviousJobAndSchedule(
      final Supplier<Long> currentSecondsSupplier,
      final @Nullable JobRead priorJobRead,
      final CronExpression cronExpression) {
    // get the earliest possible next run based on the prior job's start time.
    final Date earliestNextRun = getEarliestNextRun(currentSecondsSupplier, priorJobRead);

    // determine the next cron run according to the earliest possible start time.
    final Date nextRunStartDate = cronExpression.getNextValidTimeAfter(earliestNextRun);

    // calculate the number of seconds between now and the next cron run.
    // this can be negative if the next cron run should have already started.
    final long nextRunStartSeconds = nextRunStartDate.getTime() / MS_PER_SECOND - currentSecondsSupplier.get();

    // max with 0 so that we never return a negative value.
    return Duration.ofSeconds(Math.max(0, nextRunStartSeconds));
  }

  /**
   * Ensure that at least a minimum interval -- one minute -- passes between executions. This prevents
   * us from multiple executions for the same scheduled time, since cron only has a 1-minute
   * resolution.
   */
  private static Date getEarliestNextRun(final Supplier<Long> currentSecondsSupplier, final @Nullable JobRead priorJobRead) {
    final long earliestNextRunSeconds = (priorJobRead == null || priorJobRead.getStartedAt() == null)
        ? currentSecondsSupplier.get()
        : priorJobRead.getStartedAt() + MIN_CRON_INTERVAL_SECONDS;

    return new Date(earliestNextRunSeconds * MS_PER_SECOND);
  }
}
```

This logic prevented double-execution by ensuring:
- At least 60 seconds between cron runs (cron's minimum resolution)
- Next run calculated based on previous job's start time, not completion time
- Negative wait times clamped to zero

#### Business Value

This fix addressed production issues causing:

1. **Reliability**: Eliminated duplicate sync executions that wasted resources
2. **Correctness**: Ensured scheduled syncs ran at intended times, not early/late
3. **Cost Savings**: Prevented unnecessary compute from duplicate runs
4. **User Trust**: Cron schedules now behaved predictably
5. **Code Quality**: Centralized scheduling logic for easier testing and maintenance

The extensive test suite (106 lines) covered edge cases like timezone handling, DST transitions, and back-to-back executions.

#### Related Commits

- a73cf367d5 (Oct 31, 2023): Use createdAt instead of startedAt in cron scheduling
- 3c3b8ee53e (Jul 27, 2023): Bring back negative jitter for non-cron schedules

---

### 3. Schedule Jitter for Load Distribution

**Commit:** 3c3b8ee53e - July 27, 2023
**Impact:** 3 files changed, 82 insertions, 27 deletions

#### What Changed

Re-introduced negative jitter for non-cron schedules to distribute load more evenly across time, while explicitly excluding cron schedules from negative jitter to prevent early execution.

**Key files:**
- `airbyte-workers/src/main/java/io/airbyte/workers/helpers/ScheduleJitterHelper.java`

#### Implementation Details

The jitter system applied frequency-based randomization:

```java
public Duration addJitterBasedOnWaitTime(final Duration waitTime, final ConnectionScheduleType scheduleType) {
    // If the wait time is less than the cutoff, don't add any jitter.
    if (waitTime.toMinutes() <= noJitterCutoffMinutes) {
        log.debug("Wait time {} minutes was less than jitter cutoff of {} minutes. Not adding any jitter.",
                  waitTime.toMinutes(), noJitterCutoffMinutes);
        return waitTime;
    }

    final int jitterSeconds;
    final Random random = new Random();

    // CRON schedules should not have negative jitter included, because then it is possible for the sync
    // to start and finish before the real scheduled time. This can result in a double sync because the
    // next computed wait time will be very short in this scenario.
    final Boolean includeNegativeJitter = !scheduleType.equals(ConnectionScheduleType.CRON);

    switch (determineFrequencyBucket(waitTime)) {
        case HIGH_FREQUENCY_BUCKET -> jitterSeconds = getRandomJitterSeconds(random, highFrequencyJitterAmountMinutes, includeNegativeJitter);
        case MEDIUM_FREQUENCY_BUCKET -> jitterSeconds = getRandomJitterSeconds(random, mediumFrequencyJitterAmountMinutes, includeNegativeJitter);
        case LOW_FREQUENCY_BUCKET -> jitterSeconds = getRandomJitterSeconds(random, lowFrequencyJitterAmountMinutes, includeNegativeJitter);
        case VERY_LOW_FREQUENCY_BUCKET -> jitterSeconds = getRandomJitterSeconds(random, veryLowFrequencyJitterAmountMinutes, includeNegativeJitter);
        default -> jitterSeconds = 0;
    }

    log.debug("Adding {} minutes of jitter to original wait duration of {} minutes",
              jitterSeconds / 60, waitTime.toMinutes());

    Duration newWaitTime = waitTime.plusSeconds(jitterSeconds);

    // If the jitter results in a negative wait time, set it to 0 seconds to keep things sane.
    if (newWaitTime.isNegative()) {
        newWaitTime = Duration.ZERO;
    }

    return newWaitTime;
}

private static int getRandomJitterSeconds(final Random random, final int maximumJitterMinutes, final Boolean includeNegativeJitter) {
    // convert to seconds because fractional minutes are annoying to work with
    final int maximumJitterSeconds = maximumJitterMinutes * 60;

    // random.nextInt is inclusive of 0 and exclusive of the provided value, so we add 1
    int computedJitterSeconds = random.nextInt(maximumJitterSeconds + 1);

    if (includeNegativeJitter) {
        // if negative jitter is included, shift the positive jitter to the left by half of the maximum
        computedJitterSeconds -= maximumJitterSeconds / 2;
    }

    return computedJitterSeconds;
}
```

#### Business Value

This sophisticated jitter system provided:

1. **Load Distribution**: Spread workflow executions across time to avoid thundering herd
2. **System Stability**: Prevented resource exhaustion from synchronized starts
3. **Schedule Type Awareness**: Different behavior for cron vs manual schedules
4. **Frequency Buckets**: More jitter for infrequent jobs, less for frequent ones
5. **Predictability**: Cron schedules never execute early, maintaining user expectations

The distinction between cron and non-cron schedules was critical - cron users expect execution at precise times, while interval-based schedules can tolerate drift.

---

### 4. Unexpected Temporal State Recovery

**Commit:** 84436b01a0 - April 8, 2022
**Impact:** 3 files changed, 126 insertions, 5 deletions

#### What Changed

Added robust recovery logic for when Temporal workflows become unreachable, automatically starting new workflows rather than failing updates.

**Key files:**
- `airbyte-workers/src/main/java/io/airbyte/workers/temporal/TemporalClient.java`

#### Implementation Details

The fix added defensive programming to the update flow:

```java
public void update(final UUID connectionId) {
    final boolean workflowReachable = isWorkflowReachable(getConnectionManagerName(connectionId));

    if (!workflowReachable) {
        // if a workflow is not reachable for update, create a new workflow
        submitConnectionUpdaterAsync(connectionId);
    } else {
        final ConnectionManagerWorkflow connectionManagerWorkflow = getConnectionUpdateWorkflow(connectionId);
        connectionManagerWorkflow.connectionUpdated();
    }
}
```

This pattern gracefully handled:
- Workflows that completed but database still referenced them
- Workflows terminated by Temporal cleanup
- Network partition scenarios where workflow state was lost

#### Business Value

This resilience improvement delivered:

1. **Self-Healing**: System automatically recovered from workflow state mismatches
2. **Reduced Downtime**: No manual intervention needed when workflows became unreachable
3. **User Experience**: Connection updates succeeded even when underlying workflow state was corrupted
4. **Production Stability**: Prevented cascading failures from workflow state issues
5. **Operational Simplicity**: Eliminated common support escalations

The acceptance test coverage (77 new lines) ensured this recovery logic worked end-to-end.

---

### 5. Billing Grace Period Workflow

**Commit:** 0242eb6c1a - October 30, 2024
**Impact:** 8 files changed, 91 insertions, 6 deletions

#### What Changed

Implemented a Temporal-based workflow for managing billing grace periods, allowing organizations to temporarily continue operations while resolving payment issues.

**Key files:**
- `airbyte-server/src/main/kotlin/io/airbyte/server/apis/controllers/OrganizationPaymentConfigController.kt`
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/OrganizationPaymentConfigRepository.kt`
- `airbyte-workers/src/main/java/io/airbyte/workers/temporal/config/TemporalBeanFactory.java`

#### Implementation Details

The controller provided endpoints to manage grace period state:

```kotlin
@RequiresIntent(Intent.ManageOrganizationPaymentConfigs)
@Post("/{organizationId}/end_grace_period")
@ExecuteOn(AirbyteTaskExecutors.IO)
override fun endGracePeriod(
    @PathVariable("organizationId") organizationId: UUID,
) {
    val orgPaymentConfig =
        organizationPaymentConfigService.findByOrganizationId(organizationId) ?: throw ResourceNotFoundProblem(
            ProblemResourceData().resourceId(organizationId.toString()).resourceType(ResourceType.ORGANIZATION_PAYMENT_CONFIG),
        )

    if (orgPaymentConfig.paymentStatus != PaymentStatus.GRACE_PERIOD) {
        throw StateConflictProblem(
            ProblemMessageData().message(
                "OrganizationPaymentConfig paymentStatus is ${orgPaymentConfig.paymentStatus}, but expected ${PaymentStatus.GRACE_PERIOD}",
            ),
        )
    }

    organizationPaymentConfigService.savePaymentConfig(
        orgPaymentConfig.apply {
            paymentStatus = PaymentStatus.DISABLED
            gracePeriodEndAt = null
        },
    )
}
```

The repository added queries for grace period tracking:

```kotlin
@Query("""
    SELECT * FROM organization_payment_config
    WHERE payment_status = 'GRACE_PERIOD'
    AND grace_period_end_at <= :now
""")
fun findExpiredGracePeriods(now: OffsetDateTime): List<OrganizationPaymentConfig>
```

#### Business Value

This workflow enabled critical business operations:

1. **Customer Retention**: Organizations could resolve billing issues without immediate service disruption
2. **Revenue Protection**: Temporary grace reduced churn from payment method failures
3. **Compliance**: Provided documented process for handling delinquent accounts
4. **Operational Control**: Administrators could extend or end grace periods as needed
5. **Automated Enforcement**: Temporal workflow ensured grace periods expired automatically

The state machine pattern (ACTIVE → GRACE_PERIOD → DISABLED) provided clear business logic with proper validation.

#### Related Commits

- 7be6c224be (Oct 31, 2024): Unrevert billing GracePeriod workflow after testing
- a2e58f1b60 (Oct 4, 2024): Consider organization paymentStatus in delinquency cron

---

### 6. Domain Verification Cron Job

**Commit:** af83de265f - November 5, 2025
**Impact:** 16 files changed, 1,436 insertions, 39 deletions

#### What Changed

Implemented a comprehensive domain verification system using DNS TXT records and a sophisticated cron job with exponential backoff. This was the largest single commit in the Temporal workflows domain.

**Key files added:**
- `airbyte-cron/src/main/kotlin/io/airbyte/cron/jobs/DomainVerificationJob.kt` (156 lines)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/DnsVerificationService.kt` (270 lines)
- `airbyte-cron/src/test/kotlin/io/airbyte/cron/jobs/DomainVerificationJobTest.kt` (320 lines)
- `airbyte-data/src/test/kotlin/io/airbyte/data/services/DnsVerificationServiceTest.kt` (192 lines)

#### Implementation Details

The cron job implemented tiered exponential backoff:

```kotlin
/**
 * Cron job that periodically checks pending domain verifications by calling the Airbyte API.
 * This job only contains scheduling logic - the actual DNS lookup and database updates
 * are performed by the API endpoints.
 *
 * Implements tiered exponential backoff to balance responsiveness with load:
 * - First hour (attempts 0-59): Check every 1 minute
 *   - Provides immediate feedback for new domain verifications
 *   - Results in 60 checks in the first hour
 * - After first hour (attempts 60+): Exponential backoff capped at 60 minutes
 *   - Reduces DNS query load for persistent failures
 *   - Backoff schedule: 1min, 2min, 4min, 8min, 16min, 32min, then 60min cap
 */
@Singleton
open class DomainVerificationJob(
    private val airbyteApiClient: AirbyteApiClient,
) {
    companion object {
        const val CHECK_DOMAIN_VERIFICATIONS = "domain-verification-check"
        const val FREQUENT_CHECK_THRESHOLD = 60 // Check every minute for first 60 attempts (1 hour)
        const val INITIAL_BACKOFF_MINUTES = 1L
        const val MAX_BACKOFF_MINUTES = 60L // Cap at 1 hour between checks
    }

    @Trace
    @Instrument(
        start = "DOMAIN_VERIFICATION_RUN",
        end = "DOMAIN_VERIFICATION_DONE",
        duration = "DOMAIN_VERIFICATION_DURATION",
        tags = [Tag(key = MetricTags.CRON_TYPE, value = CHECK_DOMAIN_VERIFICATIONS)],
    )
    @Scheduled(fixedRate = "1m")
    open fun checkPendingDomainVerifications() {
        logger.info { "Starting domain verification check" }

        val pendingVerifications = airbyteApiClient.domainVerificationsApi.listPendingDomainVerifications()
        val verifications = pendingVerifications.domainVerifications ?: emptyList()

        logger.info { "Found ${verifications.size} pending domain verifications" }

        var successCount = 0
        var failureCount = 0

        val now = OffsetDateTime.now()
        val verificationsToCheck = verifications.filter { shouldCheckFrom(it, now) }
        val skippedCount = verifications.size - verificationsToCheck.size

        if (skippedCount > 0) {
            logger.debug { "Skipping $skippedCount verifications (backoff not elapsed)" }
        }

        // Check each pending verification (with exponential backoff)
        verificationsToCheck.forEach { verification ->
            try {
                logger.debug {
                    "Checking domain verification ${verification.id} for domain ${verification.domain} " +
                        "(attempt ${verification.attempts})"
                }

                val requestBody = DomainVerificationIdRequestBody(verification.id)
                val result = airbyteApiClient.domainVerificationsApi.checkDomainVerification(requestBody)

                logger.debug {
                    "Domain verification ${verification.id} check completed with status ${result.status}"
                }

                successCount++
            } catch (e: Exception) {
                logger.error(e) { "Failed to check domain verification ${verification.id}" }
                failureCount++
            }
        }

        logger.info {
            "Domain verification check completed. " +
                "Total pending: ${verifications.size}, " +
                "Checked: ${verificationsToCheck.size} (Success: $successCount, Failures: $failureCount), " +
                "Skipped: $skippedCount"
        }
    }

    /**
     * Determines if enough time has elapsed since the last check based on attempt count.
     */
    private fun shouldCheckFrom(
        verification: DomainVerificationResponse,
        from: OffsetDateTime,
    ): Boolean {
        // If never checked before, check now
        if (verification.lastCheckedAt == null) {
            return true
        }

        val attempts = verification.attempts ?: 0

        // First hour: check every time (every minute)
        if (attempts < FREQUENT_CHECK_THRESHOLD) {
            return true
        }

        // After first hour: apply exponential backoff
        val lastChecked = verification.lastCheckedAt?.let {
            OffsetDateTime.ofInstant(java.time.Instant.ofEpochSecond(it), java.time.ZoneOffset.UTC)
        }
        val minutesSinceLastCheck = Duration.between(lastChecked, from).toMinutes()

        // Calculate backoff based on attempts past the threshold
        val attemptsOverThreshold = attempts - FREQUENT_CHECK_THRESHOLD
        val exponentialDelay = INITIAL_BACKOFF_MINUTES * (2.0.pow(attemptsOverThreshold.toDouble()))
        val backoffMinutes = min(exponentialDelay, MAX_BACKOFF_MINUTES.toDouble()).toLong()

        return minutesSinceLastCheck >= backoffMinutes
    }
}
```

The DNS verification service used Java's JNDI for DNS lookups:

```kotlin
/**
 * Service for verifying domain ownership via DNS TXT records.
 *
 * Uses Java's built-in JNDI (Java Naming and Directory Interface) to perform DNS lookups
 * without requiring external dependencies.
 */
@Singleton
class DnsVerificationService {
    companion object {
        private const val DNS_PROVIDER_URL = "dns:"
        private const val TXT_RECORD_TYPE = "TXT"
        private const val DNS_TIMEOUT_MS = "5000"
        private const val DNS_RETRIES = "1"
    }

    /**
     * Verifies domain ownership by checking if the expected DNS TXT record exists.
     */
    fun checkDomainVerification(
        dnsRecordName: String,
        expectedValue: String,
    ): DnsVerificationResult {
        return try {
            val txtRecords = lookupTxtRecords(dnsRecordName)
            val expectedParsed = parseRfc1464Record(expectedValue)

            if (expectedParsed == null) {
                logger.error { "Expected value is not in valid RFC 1464 attribute=value format: $expectedValue" }
                return DnsVerificationResult.NotFound
            }

            val found =
                txtRecords.any { record ->
                    val recordParsed = parseRfc1464Record(record)
                    recordParsed != null && recordsMatch(expectedParsed, recordParsed)
                }

            when {
                found -> {
                    logger.info { "DNS verification successful for $dnsRecordName" }
                    DnsVerificationResult.Verified
                }
                txtRecords.isEmpty() -> {
                    logger.debug { "No DNS TXT records found for $dnsRecordName" }
                    DnsVerificationResult.NotFound
                }
                else -> {
                    val parsedRecords =
                        txtRecords.mapNotNull { record ->
                            parseRfc1464Record(record)?.let { (attr, value) ->
                                "${normalizeAttributeName(attr)}=${normalizeValue(value)}"
                            }
                        }
                    logger.warn {
                        "DNS TXT record misconfigured for $dnsRecordName. " +
                            "Expected: '${normalizeAttributeName(expectedParsed.first)}=${normalizeValue(expectedParsed.second)}', " +
                            "Found: ${parsedRecords.map { "'$it'" }}"
                    }
                    DnsVerificationResult.Misconfigured(parsedRecords)
                }
            }
        } catch (e: Exception) {
            logger.error(e) { "DNS lookup failed for $dnsRecordName" }
            DnsVerificationResult.NotFound
        }
    }

    /**
     * Looks up all TXT records for the given DNS hostname.
     */
    @InternalForTesting
    internal fun lookupTxtRecords(hostname: String): List<String> {
        val records = mutableListOf<String>()

        try {
            val env =
                Properties().apply {
                    setProperty(Context.INITIAL_CONTEXT_FACTORY, "com.sun.jndi.dns.DnsContextFactory")
                    setProperty(Context.PROVIDER_URL, DNS_PROVIDER_URL)
                    setProperty("com.sun.jndi.dns.timeout.initial", DNS_TIMEOUT_MS)
                    setProperty("com.sun.jndi.dns.timeout.retries", DNS_RETRIES)
                }

            var context: InitialDirContext? = null
            try {
                context = InitialDirContext(env)
                val attributes = context.getAttributes(hostname, arrayOf(TXT_RECORD_TYPE))
                val txtAttribute = attributes.get(TXT_RECORD_TYPE)

                if (txtAttribute != null) {
                    records.addAll(extractRecordValues(txtAttribute))
                }
            } finally {
                context?.close()
            }

            logger.debug { "Found ${records.size} TXT records for $hostname" }
        } catch (e: NamingException) {
            logger.debug { "No TXT records found for $hostname: ${e.message}" }
        } catch (e: Exception) {
            logger.error(e) { "Unexpected error during DNS lookup for $hostname" }
        }

        return records
    }

    /**
     * Parses a TXT record in RFC 1464 attribute=value format.
     *
     * Per RFC 1464:
     * - Format is: attribute=value
     * - The first unquoted "=" is the delimiter
     * - Backtick (`) is used to quote special characters in the attribute name
     * - TXT records without an unquoted "=" are ignored
     * - TXT records starting with "=" (null attribute name) are ignored
     */
    @InternalForTesting
    internal fun parseRfc1464Record(record: String): Pair<String, String>? {
        // Remove surrounding quotes from DNS representation
        val cleanRecord = record.trim().removeSurrounding("\"")

        // Find first unquoted equals sign
        var equalsIndex = -1
        var i = 0

        while (i < cleanRecord.length) {
            when (cleanRecord[i]) {
                '`' -> i++ // Skip next character (it's escaped)
                '=' -> {
                    equalsIndex = i
                    break
                }
            }
            i++
        }

        // Per RFC 1464: ignore records without "=" or starting with "="
        if (equalsIndex <= 0) {
            return null
        }

        val attribute = cleanRecord.take(equalsIndex)
        val value = cleanRecord.substring(equalsIndex + 1)

        return Pair(attribute, value)
    }
}
```

#### Business Value

This sophisticated verification system enabled:

1. **SSO Security**: Verified domain ownership before enabling SSO, preventing unauthorized access
2. **User Experience**: Fast verification in first hour (60 checks) for immediate feedback
3. **Resource Efficiency**: Exponential backoff reduced DNS query load for failed verifications
4. **Standards Compliance**: RFC 1464 parsing handled edge cases in DNS TXT records
5. **Observability**: Comprehensive metrics and logging for debugging verification issues

The two-phase checking strategy (frequent initially, then exponential backoff) balanced user experience with system resources. The RFC 1464 compliance ensured compatibility with various DNS providers.

#### Related Commits

- 1bd22a13f0 (Nov 3, 2025): Added dataplane heartbeat cleanup cron job

---

### 7. Dataplane Heartbeat Cleanup Cron

**Commit:** 1bd22a13f0 - November 3, 2025
**Impact:** 5 files changed, 304 insertions

#### What Changed

Added a cron job to clean up old dataplane heartbeat logs, maintaining a 24-hour retention window to prevent database bloat.

**Key files:**
- `airbyte-cron/src/main/kotlin/io/airbyte/cron/jobs/DataplaneHeartbeatCleanup.kt`
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/DataplaneHeartbeatLogRepository.kt`
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/DataplaneHealthService.kt`

#### Implementation Details

The cron job was simple but effective:

```kotlin
/**
 * Cron job for cleaning up old dataplane heartbeat logs.
 * Runs every hour to maintain a 24-hour retention period.
 */
@Singleton
class DataplaneHeartbeatCleanup(
    private val dataplaneHealthService: DataplaneHealthService,
    private val metricClient: MetricClient,
) {
    init {
        log.info { "Creating dataplane heartbeat cleanup job" }
    }

    @Trace(operationName = SCHEDULED_TRACE_OPERATION_NAME)
    @Scheduled(fixedRate = "1h")
    fun cleanupOldHeartbeats() {
        log.info { "Starting dataplane heartbeat cleanup" }

        metricClient.count(
            metric = OssMetricsRegistry.CRON_JOB_RUN_BY_CRON_TYPE,
            attributes = arrayOf(MetricAttribute(MetricTags.CRON_TYPE, "dataplane_heartbeat_cleanup")),
        )

        try {
            val deletedCount = dataplaneHealthService.cleanupOldHeartbeats()
            log.info { "Successfully cleaned up $deletedCount old heartbeat logs" }
        } catch (e: Exception) {
            log.error(e) { "Failed to cleanup old heartbeat logs" }
        }
    }
}
```

#### Business Value

This maintenance job provided:

1. **Database Health**: Prevented unbounded growth of heartbeat logs
2. **Performance**: Kept heartbeat table size manageable for queries
3. **Cost Control**: Reduced database storage costs
4. **Observability Window**: 24-hour retention sufficient for debugging dataplane issues
5. **Reliability**: Hourly cleanup ensured consistent performance

The pattern of scheduled cleanup jobs became a template for other maintenance tasks.

---

### 8. Payment Status in Delinquency Validation

**Commit:** a2e58f1b60 - October 4, 2024
**Impact:** 6 files changed, 86 insertions, 12 deletions

#### What Changed

Enhanced delinquency cron and sync validations to consider organization payment status, preventing operations during grace period or disabled states.

**Key files:**
- `airbyte-api/problems/src/main/kotlin/io/airbyte/api/problems/ResourceType.kt`
- `airbyte-api/problems/src/main/openapi/api-problems.yaml`
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/entities/Workspace.kt`

#### Implementation Details

The workspace entity gained payment status awareness:

```kotlin
@MappedEntity("workspace")
data class Workspace(
    @field:Id
    val id: UUID,
    val name: String,
    val organizationId: UUID,
    val tombstone: Boolean = false,
    // Payment status from organization cascades to workspace validations
    @Transient
    val organizationPaymentStatus: PaymentStatus? = null,
) {
    fun isPaymentDisabled(): Boolean {
        return organizationPaymentStatus == PaymentStatus.DISABLED
    }

    fun isInGracePeriod(): Boolean {
        return organizationPaymentStatus == PaymentStatus.GRACE_PERIOD
    }
}
```

#### Business Value

This integration ensured:

1. **Revenue Protection**: Prevented service usage by delinquent accounts
2. **Consistent Enforcement**: Payment status checked throughout the system
3. **Grace Period Support**: Allowed continued operation during temporary payment issues
4. **Clear Error Messages**: Users understood why operations were blocked
5. **Audit Trail**: Payment status changes logged for compliance

---

## Technical Evolution

The commits tell a story of Temporal workflow maturation across multiple dimensions:

### 1. Infrastructure Foundation (2022)

The work began in mid-2022 with establishing robust Temporal infrastructure:

- **June 2022**: Migrated to Temporal Cloud with SSL/TLS authentication (9403c28b50)
- **April 2022**: Added workflow state recovery for unreachable workflows (84436b01a0)
- **March 2022**: Fixed double-calling of delete activities (672b347aca)

This phase focused on getting the foundational orchestration layer stable and production-ready.

### 2. Scheduling Sophistication (2023)

Throughout 2023, scheduling logic became more sophisticated:

- **October 2023**: Fixed cron schedule bugs with feature flags (4ce6bf7717)
- **October 2023**: Used createdAt instead of startedAt for accuracy (a73cf367d5)
- **August 2023**: Excluded tombstoned workspaces from billing cron (6ec4a7345a)
- **August 2023**: Introduced retries for RefreshSchema activity (daee0c27a0)
- **August 2023**: Reduced RefreshSchema timeout from 2 hours to 10 minutes (7fb9d06fe3)
- **July 2023**: Brought back negative jitter for load distribution (3c3b8ee53e)

This phase addressed production pain points around cron reliability and resource management.

### 3. Business Logic Workflows (2024-2025)

Recent work implemented business-critical workflows:

- **January 2025**: Added foundation for billing ingestion via Temporal (1d75edc40d)
- **October 2024**: Billing grace period workflow implementation (0242eb6c1a, 7be6c224be)
- **October 2024**: Payment status integration with delinquency checks (a2e58f1b60)
- **November 2025**: Domain verification cron with exponential backoff (af83de265f)
- **November 2025**: Dataplane heartbeat cleanup cron (1bd22a13f0)

This phase elevated Temporal from infrastructure to core business logic.

### Technology Choices

The evolution shows deliberate technology decisions:

- **Java → Kotlin**: Newer cron jobs written in Kotlin for conciseness and null safety
- **Polling → Event-Driven**: Moved from polling patterns to Temporal's event-driven workflows
- **Manual Scheduling → Cron Expressions**: Leveraged Quartz cron expressions for complex schedules
- **Monolithic → Distributed**: Temporal workflows enabled distributed state management
- **Implicit → Explicit**: Jitter, backoff, and retry logic made explicit and configurable

### Operational Maturity

The progression shows increasing operational sophistication:

1. **Observability**: Every cron job gained metrics, tracing, and structured logging
2. **Error Handling**: Evolved from fail-fast to graceful degradation with retries
3. **Load Management**: Jitter and backoff strategies prevented resource exhaustion
4. **State Recovery**: Workflows self-heal from unexpected Temporal state
5. **Testing**: Comprehensive test suites for scheduling edge cases

---

## Impact Summary

Parker's contributions to Temporal Workflows represent the evolution of Airbyte's orchestration layer from basic workflow execution to a sophisticated, business-critical scheduling and state management platform.

### Quantitative Impact

- **29 commits** over 40 months
- **~3,500 lines** of code changes
- **Major features delivered:**
  - Temporal Cloud migration with SSL/TLS authentication
  - Cron scheduling with jitter and exponential backoff
  - Billing grace period workflow
  - Domain verification system with RFC 1464 compliance
  - Workflow state recovery and self-healing
  - Multiple maintenance cron jobs

### Qualitative Impact

**For Operations:**
- Self-hosted Temporal eliminated, reducing infrastructure burden
- Automated cleanup jobs prevent database bloat
- Workflow recovery reduces manual intervention
- Comprehensive observability enables debugging

**For Business:**
- Grace period workflow enables customer retention during payment issues
- Domain verification secures SSO implementations
- Cron reliability ensures scheduled syncs execute correctly
- Load distribution via jitter prevents resource exhaustion

**For Developers:**
- Clean separation of concerns (scheduling vs business logic)
- Reusable patterns for cron jobs and workflows
- Extensive test coverage documents edge cases
- Well-documented backoff and retry strategies

**For the Platform:**
- Scalable workflow orchestration via Temporal Cloud
- Sophisticated scheduling handles hundreds of connections
- Self-healing workflows improve reliability
- Extensible framework supports new business workflows

### Key Architectural Patterns

The work established several important patterns:

1. **Dual-Mode Configuration**: Support both cloud and self-hosted Temporal seamlessly
2. **Tiered Backoff**: Aggressive checking initially, exponential backoff for failures
3. **Schedule Type Awareness**: Different jitter strategies for cron vs interval schedules
4. **State Recovery**: Check workflow reachability before operations, start new if needed
5. **Separation of Concerns**: Cron job schedules work, API endpoints do work
6. **RFC Compliance**: DNS verification follows standards for maximum compatibility
7. **Metric-First Design**: Every cron job emits metrics for observability

### Production Lessons

Several patterns emerged from production experience:

1. **Cron Minimum Interval**: 60-second floor prevents double-execution
2. **Negative Jitter Exclusion**: Cron schedules should never execute early
3. **Exponential Backoff Caps**: Unlimited backoff leads to infinite delays
4. **Workflow Reachability Checks**: Always verify workflow exists before signaling
5. **Cleanup Job Frequency**: Hourly cleanup sufficient for most maintenance tasks

This foundation enables Airbyte to build increasingly sophisticated business logic as Temporal workflows, knowing the orchestration layer is robust and production-proven.
