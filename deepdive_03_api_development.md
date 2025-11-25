# API Development - Deep Dive

## Overview

This document analyzes Parker Mossman's contributions to API Development in the airbyte-platform repository. This work spans from December 2021 to November 2025, encompassing 52 commits that collectively built out Airbyte's comprehensive API infrastructure, including internal APIs, public APIs, RESTful endpoints, handler logic, request/response handling, and specialized domain APIs for billing, SSO, secrets management, and operational monitoring.

**Period:** December 20, 2021 - November 5, 2025 (47 months)
**Total Commits:** 52
**Total Changes:** ~12,000+ lines of code
**Key Technologies:** Java, Kotlin, OpenAPI, Micronaut, JOOQ, REST

---

## Key Architectural Changes

### 1. Dataplane Health Monitoring API

**Commit:** c231086441 - November 5, 2025
**Impact:** 10 files changed, 708 insertions, 10 deletions

#### What Changed

Implemented a comprehensive internal API for monitoring dataplane health status based on heartbeat logs. This provides real-time visibility into the operational status of distributed dataplane nodes.

**Key files:**
- `airbyte-api/server-api/src/main/openapi/config.yaml` (added `/v1/dataplanes/health` endpoint)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/DataplaneHealthService.kt` (enhanced)
- `airbyte-domain/models/src/main/kotlin/io/airbyte/domain/models/DataplaneHealthInfo.kt` (new)
- `airbyte-server/src/main/kotlin/io/airbyte/server/apis/controllers/DataplaneController.kt` (enhanced)

#### Implementation Details

The API endpoint definition uses OpenAPI specification:

```yaml
/v1/dataplanes/health:
  post:
    summary: Get health status for dataplanes
    tags:
      - dataplanes
    operationId: listDataplaneHealth
    requestBody:
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/OrganizationIdRequestBody"
      required: true
    responses:
      "200":
        description: Successfully retrieved dataplane health statuses
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/DataplaneHealthListResponse"
```

The health status model defines four states:

```yaml
DataplaneHealthRead:
  type: object
  required:
    - dataplane_id
    - dataplane_name
    - dataplane_group_id
    - organization_id
    - status
  properties:
    status:
      type: string
      enum:
        - HEALTHY
        - DEGRADED
        - UNHEALTHY
        - UNKNOWN
    last_heartbeat_timestamp:
      type: string
      format: date-time
    recent_heartbeats:
      type: array
      items:
        $ref: "#/components/schemas/HeartbeatRecord"
```

The service layer calculates health status based on heartbeat timestamps:

```kotlin
class DataplaneHealthService {
  companion object {
    val HEALTHY_THRESHOLD_DURATION: Duration = Duration.ofSeconds(60)
    val DEGRADED_THRESHOLD_DURATION: Duration = Duration.ofMinutes(5)
    val RETENTION_PERIOD_DURATION: Duration = Duration.ofHours(24)
  }

  fun getDataplaneHealthInfos(dataplaneIds: List<UUID>): List<DataplaneHealthInfo> {
    val now = OffsetDateTime.now()
    val recentHeartbeatStart = now.minus(DEGRADED_THRESHOLD_DURATION)

    val latestHeartbeats = heartbeatLogRepository.findLatestHeartbeatsByDataplaneIds(dataplaneIds)
    val heartbeatMap = latestHeartbeats.associateBy { it.dataplaneId }

    val recentHeartbeatLogs = heartbeatLogRepository.findHeartbeatHistoryForDataplanes(
      dataplaneIds, recentHeartbeatStart, now
    )
    val recentHeartbeatsByDataplane = recentHeartbeatLogs.groupBy { it.dataplaneId }

    return dataplaneIds.map { dataplaneId ->
      val heartbeat = heartbeatMap[dataplaneId]
      val recentLogs = recentHeartbeatsByDataplane[dataplaneId] ?: emptyList()
      calculateHealthStatus(dataplaneId, heartbeat, recentLogs, now)
    }
  }

  private fun calculateHealthStatus(
    dataplaneId: UUID,
    heartbeat: DataplaneHeartbeatLog?,
    recentHeartbeatLogs: List<DataplaneHeartbeatLog>,
    now: OffsetDateTime,
  ): DataplaneHealthInfo {
    if (heartbeat == null || heartbeat.createdAt == null) {
      return DataplaneHealthInfo(
        dataplaneId = dataplaneId,
        status = DataplaneHealthInfo.HealthStatus.UNKNOWN,
        lastHeartbeatTimestamp = null,
        secondsSinceLastHeartbeat = null,
        recentHeartbeats = emptyList(),
        controlPlaneVersion = null,
        dataplaneVersion = null,
      )
    }

    val timeSinceHeartbeat = Duration.between(heartbeat.createdAt, now)
    val secondsSince = timeSinceHeartbeat.seconds

    val status = when {
      timeSinceHeartbeat <= HEALTHY_THRESHOLD_DURATION -> DataplaneHealthInfo.HealthStatus.HEALTHY
      timeSinceHeartbeat <= DEGRADED_THRESHOLD_DURATION -> DataplaneHealthInfo.HealthStatus.DEGRADED
      else -> DataplaneHealthInfo.HealthStatus.UNHEALTHY
    }

    return DataplaneHealthInfo(
      dataplaneId = dataplaneId,
      status = status,
      lastHeartbeatTimestamp = heartbeat.createdAt,
      secondsSinceLastHeartbeat = secondsSince,
      recentHeartbeats = recentHeartbeatLogs.mapNotNull { it.createdAt?.let { ts -> HeartbeatData(ts) } },
      controlPlaneVersion = heartbeat.controlPlaneVersion,
      dataplaneVersion = heartbeat.dataplaneVersion,
    )
  }
}
```

The repository layer includes an efficient batch query:

```kotlin
@Query("""
  SELECT * FROM dataplane_heartbeat_log
  WHERE dataplane_id IN (:dataplaneIds)
  AND created_at >= :startTime
  AND created_at <= :endTime
  ORDER BY dataplane_id, created_at DESC
""")
fun findHeartbeatHistoryForDataplanes(
  dataplaneIds: List<UUID>,
  startTime: OffsetDateTime,
  endTime: OffsetDateTime,
): List<DataplaneHeartbeatLog>
```

#### Business Value

This monitoring API is critical for operational excellence:

1. **Real-time Observability**: Platform teams can quickly identify unhealthy dataplanes
2. **Proactive Alerting**: Status thresholds (60s healthy, 5m degraded) enable automated alerting
3. **Historical Context**: Recent heartbeat history helps diagnose intermittent issues
4. **Version Tracking**: Including control plane and dataplane versions aids in upgrade planning
5. **Multi-tenant Support**: Organization-scoped queries ensure data isolation
6. **Performance**: Batch querying minimizes database load for organizations with many dataplanes

The three-tier health status (HEALTHY/DEGRADED/UNHEALTHY) provides clear operational signals without noise from transient issues.

#### Related Commits

- Multiple heartbeat logging enhancements throughout 2025
- Dataplane initialization and registration APIs

---

### 2. Connection Last Job Per Stream API

**Commit:** 082bd46827 - June 14, 2024
**Impact:** 22 files changed, 980 insertions, 184 deletions

#### What Changed

Implemented a complete feature for retrieving the most recent job information for each stream in a connection. This required building out new repository patterns, service layers, and handler logic to efficiently aggregate job statistics by stream.

**Key files added:**
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/StreamStatsRepository.kt` (new)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/custom/LastJobWithStatsPerStreamRepository.kt` (new)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/StreamStatsService.kt` (new)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/entities/StreamStats.kt` (new)

**Key files modified:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/ConnectionsHandler.java`
- `airbyte-server/src/main/java/io/airbyte/server/apis/ConnectionApiController.java`

#### Implementation Details

The handler orchestrates multiple data layer calls and performs memoization to optimize performance:

```java
public class ConnectionsHandler {
  public List<ConnectionLastJobPerStreamReadItem> getConnectionLastJobPerStream(
    final ConnectionLastJobPerStreamRequestBody req
  ) {
    ApmTraceUtils.addTagsToTrace(Map.of(MetricTags.CONNECTION_ID, req.getConnectionId().toString()));

    final var streamDescriptors = req.getStreams().stream().map(stream ->
      new io.airbyte.config.StreamDescriptor()
        .withName(stream.getStreamName())
        .withNamespace(stream.getStreamNamespace())
    ).toList();

    // Step 1: Determine the latest job ID with stats for each stream
    final Map<io.airbyte.config.StreamDescriptor, Long> streamToLastJobIdWithStats =
        streamStatsService.getLastJobIdWithStatsByStream(req.getConnectionId(), streamDescriptors);

    // Step 2: Retrieve the full job information for those job IDs
    List<Job> jobs;
    try {
      jobs = jobPersistence.listJobsLight(new HashSet<>(streamToLastJobIdWithStats.values()));
    } catch (IOException e) {
      throw new UnexpectedProblem("Failed to retrieve the latest job per stream",
        new ProblemMessageData().message(e.getMessage()));
    }

    // Step 3: Hydrate jobs with their aggregated stats
    final Map<Long, JobWithAttemptsRead> jobIdToJobRead =
      StatsAggregationHelper.getJobIdToJobWithAttemptsReadMap(jobs, jobPersistence);

    // Step 4: Build a map of stream descriptor to job read
    final Map<io.airbyte.config.StreamDescriptor, JobWithAttemptsRead> streamToJobRead =
      streamToLastJobIdWithStats.entrySet().stream()
        .collect(Collectors.toMap(Entry::getKey, entry -> jobIdToJobRead.get(entry.getValue())));

    // Step 5: Memoize the process of building a stat-by-stream map for each job
    final Map<Long, Map<io.airbyte.config.StreamDescriptor, StreamStats>> memo = new HashMap<>();

    // Step 6: Convert the hydrated jobs to the response format
    return streamToJobRead.entrySet().stream()
        .map(entry -> buildLastJobPerStreamReadItem(entry.getKey(), entry.getValue().getJob(), memo))
        .collect(Collectors.toList());
  }

  /**
   * Build a ConnectionLastJobPerStreamReadItem from a stream descriptor and a job read.
   * This method memoizes the stat-by-stream map for each job to avoid redundant computation
   * in the case where multiple streams are associated with the same job.
   */
  private ConnectionLastJobPerStreamReadItem buildLastJobPerStreamReadItem(
    final io.airbyte.config.StreamDescriptor streamDescriptor,
    final JobRead jobRead,
    final Map<Long, Map<io.airbyte.config.StreamDescriptor, StreamStats>> memo
  ) {
    // If this is the first time encountering the job, compute the stat-by-stream map for it
    memo.putIfAbsent(jobRead.getId(), buildStreamStatsMap(jobRead));

    // Retrieve the stat for the stream of interest from the memo
    final Optional<StreamStats> statsForThisStream =
      Optional.of(memo.get(jobRead.getId()).get(streamDescriptor));

    return new ConnectionLastJobPerStreamReadItem()
        .streamName(streamDescriptor.getName())
        .streamNamespace(streamDescriptor.getNamespace())
        .jobId(jobRead.getId())
        .configType(jobRead.getConfigType())
        .jobStatus(jobRead.getStatus())
        .startedAt(jobRead.getStartedAt())
        .endedAt(jobRead.getUpdatedAt())
        .bytesCommitted(statsForThisStream.map(StreamStats::getBytesCommitted).orElse(null))
        .recordsCommitted(statsForThisStream.map(StreamStats::getRecordsCommitted).orElse(null));
  }

  /**
   * Build a map of stream descriptor to stream stats for a given job.
   * This is only called at most once per job, because the result is memoized.
   */
  private Map<io.airbyte.config.StreamDescriptor, StreamStats> buildStreamStatsMap(final JobRead jobRead) {
    final Map<io.airbyte.config.StreamDescriptor, StreamStats> map = new HashMap<>();
    for (final StreamStats stat : jobRead.getStreamAggregatedStats()) {
      final var streamDescriptor = new io.airbyte.config.StreamDescriptor()
          .withName(stat.getStreamName())
          .withNamespace(stat.getStreamNamespace());
      map.put(streamDescriptor, stat);
    }
    return map;
  }
}
```

The data layer introduces Micronaut Data entities for Jobs and Attempts:

```kotlin
@MappedEntity("attempts")
open class Attempt(
  @field:Id
  @AutoPopulated
  var id: Long? = null,
  var jobId: Long? = null,
  var attemptNumber: Long? = null,
  var logPath: String? = null,
  var output: JsonNode? = null,
  var status: AttemptStatus? = null,
  @DateCreated
  var createdAt: OffsetDateTime? = null,
  @DateUpdated
  var updatedAt: OffsetDateTime? = null,
  var endedAt: OffsetDateTime? = null,
  var temporalWorkflowId: String? = null,
  var failureSummary: JsonNode? = null,
  var processingTaskQueue: String? = null,
)

@JdbcRepository(dialect = Dialect.POSTGRES, dataSource = "config")
interface AttemptsRepository : PageableRepository<Attempt, Long>
```

#### Business Value

This API enables sophisticated job monitoring and troubleshooting:

1. **Stream-Level Granularity**: Users can see job outcomes per stream, not just connection-wide
2. **Performance Insights**: Per-stream bytes/records committed helps identify problematic streams
3. **Efficient Queries**: Memoization ensures O(1) lookup per stream even when many streams share a job
4. **API Simplicity**: Clients specify streams of interest and receive focused results
5. **Reduced Data Transfer**: Only requested streams are included in the response
6. **Troubleshooting**: When connections fail, users can quickly identify which streams had issues

The multi-stage query pattern (get job IDs → fetch jobs → hydrate stats → memoize) balances performance with data richness.

#### Related Commits

- 53d0fb82d2 (June 3, 2024): API spec and mock response for the endpoint
- Multiple stream stats tracking enhancements

---

### 3. SSO Token Validation API

**Commit:** 1afd3bf944 - October 7, 2025
**Impact:** 10 files changed, 536 insertions, 157 deletions

#### What Changed

Implemented a dedicated API endpoint for validating SSO access tokens against organization realms. This involved refactoring token validation logic from the authentication layer into a reusable service and exposing it as an explicit API.

**Key files:**
- `airbyte-api/server-api/src/main/openapi/config.yaml` (added `/v1/sso_config/validate_token` endpoint)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/impls/keycloak/AirbyteKeycloakClient.kt` (enhanced)
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/sso/SsoConfigDomainService.kt` (enhanced)
- `airbyte-commons-server/src/main/kotlin/io/airbyte/commons/server/authorization/KeycloakTokenValidator.kt` (refactored)

#### Implementation Details

The OpenAPI spec defines a simple validation endpoint:

```yaml
/v1/sso_config/validate_token:
  post:
    summary: Validate an access token against an organization's SSO realm
    tags:
      - sso_config
    operationId: validateSsoToken
    requestBody:
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/ValidateSSOTokenRequestBody"
      required: true
    responses:
      "204":
        description: Token is valid
      "401":
        description: Token is invalid or validation failed
      "422":
        $ref: "#/components/responses/InvalidInputResponse"

ValidateSSOTokenRequestBody:
  type: object
  required:
    - organizationId
    - accessToken
  properties:
    organizationId:
      type: string
      format: uuid
    accessToken:
      type: string
```

The Keycloak client handles actual validation:

```kotlin
class AirbyteKeycloakClient {
  /**
   * Validates an access token by calling the Keycloak userinfo endpoint for the appropriate realm.
   * Throws InvalidTokenException if the token is invalid or expired.
   */
  fun validateToken(token: String) {
    val realm: String
    try {
      val jwtAttributes = tokenToAttributes(token)
      realm = jwtAttributes[JWT_SSO_REALM] as String?
        ?: throw InvalidTokenException("No realm found in token")
    } catch (e: Exception) {
      throw InvalidTokenException("Failed to parse token", e)
    }

    val userInfoEndpoint = keycloakConfiguration.getKeycloakUserInfoEndpointForRealm(realm)

    val request = Request.Builder()
      .addHeader(HttpHeaders.CONTENT_TYPE, "application/json")
      .addHeader(HttpHeaders.AUTHORIZATION, "Bearer $token")
      .url(userInfoEndpoint)
      .get()
      .build()

    try {
      client.newCall(request).execute().use { response ->
        if (!response.isSuccessful) {
          throw InvalidTokenException("Token validation failed with status ${response.code}")
        }

        val responseBody = response.body?.string()
          ?: throw InvalidTokenException("Empty response from userinfo endpoint")

        val userInfo = objectMapper.readTree(responseBody)
        val sub = userInfo.path("sub").asText()

        if (sub.isBlank()) {
          throw InvalidTokenException("No sub claim in userinfo response")
        }
      }
    } catch (e: IOException) {
      throw InvalidTokenException("Failed to validate token", e)
    }
  }
}

class InvalidTokenException(message: String, cause: Throwable? = null) :
  RuntimeException(message, cause)
```

The token validator was refactored to use the client:

```kotlin
class KeycloakTokenValidator(
  private val airbyteKeycloakClient: AirbyteKeycloakClient,
  private val authenticationFactory: JwtAuthenticationFactory,
  private val metricClient: Optional<MetricClient>,
) : TokenValidator<HttpRequest<*>> {

  override fun validateToken(
    token: String,
    request: HttpRequest<*>,
  ): Publisher<Authentication> =
    try {
      airbyteKeycloakClient.validateToken(token)
      log.debug { "Token is valid, will now getAuthentication for token" }
      Mono.just(getAuthentication(token, request))
    } catch (e: Exception) {
      // Pass to the next validator, if one exists
      log.debug(e) { "Token validation failed, passing to next validator" }
      metricClient.ifPresent { m ->
        m.count(
          OssMetricsRegistry.KEYCLOAK_TOKEN_VALIDATION,
          1L,
          AUTHENTICATION_FAILURE_METRIC_ATTRIBUTE,
          MetricAttribute(AUTHENTICATION_REQUEST_URI_ATTRIBUTE_KEY, request.uri.path),
        )
      }
      Mono.empty()
    }
}
```

A structured error response provides debugging information:

```yaml
SSOTokenValidationProblemResponse:
  type: object
  properties:
    status:
      type: integer
      default: 401
    type:
      type: string
      default: error:sso-token-validation
    title:
      type: string
      default: SSO token validation failed
    detail:
      type: string
      default: The provided SSO access token is invalid or expired
    data:
      $ref: "#/components/schemas/ProblemSSOTokenValidationData"

ProblemSSOTokenValidationData:
  type: object
  required:
    - organizationId
  properties:
    organizationId:
      type: string
      format: uuid
    errorMessage:
      type: string
```

#### Business Value

This API addresses several enterprise SSO requirements:

1. **Explicit Validation**: Frontend apps can validate tokens before making authenticated requests
2. **Error Clarity**: Structured error responses help debug SSO configuration issues
3. **Code Reuse**: Refactoring shared the validation logic between authentication and API layers
4. **Testing**: Exposed endpoint enables integration testing of SSO configuration
5. **Multi-realm Support**: Automatically detects the realm from the token
6. **Security**: HTTP-only validation prevents token exposure in client-side JavaScript

The refactoring improved code quality by consolidating HTTP client configuration and eliminating duplicate userinfo endpoint calls.

#### Related Commits

- 83bfb7b0ef (Oct 9, 2025): Consolidated SSO API problems and error handling
- Multiple SSO configuration and realm management commits

---

### 4. Public API Dataplane Endpoints with Org Admin Support

**Commit:** 786d8fb13b - September 11, 2025
**Impact:** 10 files changed, 368 insertions, 39 deletions

#### What Changed

Enhanced the public API `GET /public/v1/dataplanes` endpoint to support organization admin callers and added optional region filtering. This required significant repository query enhancements and permission logic updates.

**Key files:**
- `airbyte-api/server-api/src/main/openapi/config.yaml` (enhanced endpoint)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/DataplaneRepository.kt` (new queries)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/DataplaneService.kt` (enhanced)
- `airbyte-server/src/main/kotlin/io/airbyte/server/apis/publicapi/controllers/DataplaneController.kt` (enhanced)

#### Implementation Details

The API spec added query parameters for filtering:

```yaml
/public/v1/dataplanes:
  get:
    summary: List dataplanes
    description: List dataplanes accessible to the current user
    parameters:
      - name: regionIds
        description: |
          The UUIDs of the regions to filter by. If provided, only dataplanes belonging to
          these regions will be returned. Empty list will retrieve all dataplanes accessible
          to the current user.
        schema:
          type: array
          items:
            format: uuid
            type: string
        in: query
        required: false
    responses:
      "200":
        description: List dataplanes accessible to the current user
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/DataplanesResponse"
```

The repository added complex queries for multi-organization access:

```kotlin
@JdbcRepository(dialect = Dialect.POSTGRES, dataSource = "config")
interface DataplaneRepository : PageableRepository<Dataplane, UUID> {

  @Query("""
    SELECT d.* FROM dataplane d
    WHERE d.dataplane_group_id IN (:dataplaneGroupIds)
    AND (:withTombstone = true OR d.tombstone = false)
    ORDER BY d.updated_at DESC
  """)
  fun findAllByDataplaneGroupIds(
    dataplaneGroupIds: List<UUID>,
    withTombstone: Boolean,
  ): List<Dataplane>

  @Query("""
    SELECT d.* FROM dataplane d
    INNER JOIN dataplane_group dg ON d.dataplane_group_id = dg.id
    WHERE (:withTombstone = true OR d.tombstone = false)
    AND dg.organization_id IN (:organizationIds)
    ORDER BY d.updated_at DESC
  """)
  fun findAllByOrganizationIds(
    organizationIds: List<UUID>,
    withTombstone: Boolean,
  ): List<Dataplane>
}
```

The service layer delegates to appropriate repository methods:

```kotlin
open class DataplaneServiceDataImpl(
  private val repository: DataplaneRepository,
) : DataplaneService {

  override fun listDataplanes(
    dataplaneGroupIds: List<UUID>,
    withTombstone: Boolean,
  ): List<Dataplane> {
    if (dataplaneGroupIds.isEmpty()) {
      return emptyList()
    }
    return repository
      .findAllByDataplaneGroupIds(dataplaneGroupIds, withTombstone)
      .map { it.toConfigModel() }
  }

  override fun listDataplanesForOrganizations(
    organizationIds: List<UUID>,
    withTombstone: Boolean,
  ): List<Dataplane> =
    repository
      .findAllByOrganizationIds(organizationIds, withTombstone)
      .map { it.toConfigModel() }
}
```

Comprehensive tests verify the query logic:

```kotlin
@Nested
inner class FindAllByOrganizationIdsTests {
  @ParameterizedTest
  @ValueSource(booleans = [true, false])
  fun `returns dataplanes for multiple organizations`(withTombstone: Boolean) {
    val org1 = UUID.randomUUID()
    val org2 = UUID.randomUUID()
    val otherOrg = UUID.randomUUID()

    val group1 = createDataplaneGroup(org1, "Group 1")
    val group2 = createDataplaneGroup(org2, "Group 2")
    val otherGroup = createDataplaneGroup(otherOrg, "Other Group")

    val dp1 = createDataplane(group1.id!!, "DP1", tombstone = false)
    val dp2 = createDataplane(group1.id!!, "DP2", tombstone = true)
    val dp3 = createDataplane(group2.id!!, "DP3", tombstone = false)
    val dp4 = createDataplane(otherGroup.id!!, "DP4", tombstone = false)

    val result = dataplaneRepository.findAllByOrganizationIds(
      listOf(org1, org2),
      withTombstone
    )

    if (withTombstone) {
      assertEquals(3, result.size)
      assertThat(result).extracting("name").containsExactlyInAnyOrder("DP1", "DP2", "DP3")
    } else {
      assertEquals(2, result.size)
      assertThat(result).extracting("name").containsExactlyInAnyOrder("DP1", "DP3")
    }
  }
}
```

#### Business Value

This enhancement enables enterprise multi-tenancy patterns:

1. **Organization Admin Access**: Org admins can manage dataplanes without instance-admin privileges
2. **Regional Filtering**: Clients can request only dataplanes in specific regions, reducing payload size
3. **Performance**: Batch queries avoid N+1 patterns when listing resources across organizations
4. **Authorization**: Query-level filtering ensures users only see authorized dataplanes
5. **Scalability**: Efficient JOIN operations scale to organizations with hundreds of dataplanes
6. **Public API Consistency**: Same permission model applies to public and internal APIs

The parameterized withTombstone flag enables both "active only" and "show deleted" views without duplicating query logic.

#### Related Commits

- 6a1b4fb12e (Sep 5, 2025): Allow org admins to call public dataplane/region CRUD endpoints
- 10a57bfc10 (Sep 3, 2025): Allow org admins to call dataplane group endpoints
- ec8bf14a5c (Sep 5, 2025): Fix to pass correct ID types in controllers

---

### 5. SecretStorage API Endpoints

**Commit:** 1332a12ed6 - March 18, 2025
**Impact:** 32 files changed, 386 insertions, 62 deletions

#### What Changed

Implemented new API endpoints for fetching SecretStorage configurations by ID and by workspace ID. This required creating a new domain services layer, refactoring ID type handling, and establishing patterns for secret management APIs.

**Key files added:**
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/secrets/SecretStorageService.kt` (new)
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/secrets/SecretConfigService.kt` (new)
- `airbyte-domain/models/src/main/kotlin/io/airbyte/domain/models/IdTypes.kt` (new)
- `airbyte-server/src/main/kotlin/io/airbyte/server/apis/controllers/SecretStorageApiController.kt` (new)

**Key refactorings:**
- Moved ID type definitions from `airbyte-config` to `airbyte-domain/models` module
- Created domain service abstractions for secret management operations
- Consolidated secret-related models into domain layer

#### Implementation Details

The OpenAPI spec defines retrieval endpoints:

```yaml
/v1/secret_storage/get:
  post:
    tags:
      - secret_storage
    summary: Get secret storage by its id
    operationId: getSecretStorage
    requestBody:
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/SecretStorageIdRequestBody"
      required: true
    responses:
      "200":
        description: Successful operation
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/SecretStorageRead"
      "404":
        $ref: "#/components/responses/NotFoundResponse"

SecretStorageRead:
  description: Object representing a secret storage
  required:
    - id
    - secretStorageType
    - isConfiguredFromEnvironment
    - scopeType
    - scopeId
  properties:
    id:
      $ref: "#/components/schemas/SecretStorageId"
    secretStorageType:
      $ref: "#/components/schemas/SecretStorageType"
    isConfiguredFromEnvironment:
      type: boolean
    scopeType:
      $ref: "#/components/schemas/ScopeType"
    scopeId:
      $ref: "#/components/schemas/ScopeId"
    config:
      $ref: "#/components/schemas/SecretPersistenceConfigurationJson"

SecretStorageType:
  type: string
  enum:
    - local_testing
    - google_secret_manager
    - vault
    - aws_secrets_manager
    - azure_key_vault
```

Type-safe ID wrappers prevent mixing UUID types:

```kotlin
package io.airbyte.domain.models

import java.util.UUID

/**
 * This file contains type-safe wrappers around UUIDs for various entities in the system.
 * These are used to prevent bugs where the wrong UUID is passed to a function.
 */

@JvmInline
value class SecretStorageId(val value: UUID)

@JvmInline
value class SecretConfigId(val value: UUID)

@JvmInline
value class ConnectionId(val value: UUID)

@JvmInline
value class OrganizationId(val value: UUID)
```

The domain service provides high-level operations:

```kotlin
@Singleton
class SecretStorageService(
  private val secretStorageServiceData: io.airbyte.data.services.SecretStorageService,
  private val secretConfigService: SecretConfigService,
) {
  /**
   * Get a secret storage configuration by its ID.
   * Returns null if not found.
   */
  fun getSecretStorage(id: SecretStorageId): SecretStorage? =
    secretStorageServiceData.findById(id)

  /**
   * List all secret storage configurations for a workspace.
   */
  fun listSecretStoragesForWorkspace(workspaceId: UUID): List<SecretStorage> =
    secretStorageServiceData.listByScopeTypeAndScopeId(
      SecretStorageScopeType.WORKSPACE,
      workspaceId
    )

  /**
   * List all secret storage configurations for an organization.
   */
  fun listSecretStoragesForOrganization(organizationId: UUID): List<SecretStorage> =
    secretStorageServiceData.listByScopeTypeAndScopeId(
      SecretStorageScopeType.ORGANIZATION,
      organizationId
    )
}
```

Domain models encapsulate business rules:

```kotlin
data class SecretStorage(
  val id: SecretStorageId?,
  val secretStorageType: SecretStorageType,
  val isConfiguredFromEnvironment: Boolean,
  val scopeType: SecretStorageScopeType,
  val scopeId: UUID,
  val config: JsonNode?,
  val createdAt: OffsetDateTime?,
  val updatedAt: OffsetDateTime?,
) {
  fun isAwsSecretsManager(): Boolean =
    secretStorageType == SecretStorageType.AWS_SECRETS_MANAGER

  fun isGoogleSecretManager(): Boolean =
    secretStorageType == SecretStorageType.GOOGLE_SECRET_MANAGER

  fun isVault(): Boolean =
    secretStorageType == SecretStorageType.VAULT
}

enum class SecretStorageType {
  LOCAL_TESTING,
  GOOGLE_SECRET_MANAGER,
  VAULT,
  AWS_SECRETS_MANAGER,
  AZURE_KEY_VAULT
}

enum class SecretStorageScopeType {
  WORKSPACE,
  ORGANIZATION,
  INSTANCE
}
```

Mappers translate between data and domain layers:

```kotlin
fun EntitySecretStorage.toConfigModel(): ModelSecretStorage =
  ModelSecretStorage(
    id = this.id?.let { SecretStorageId(it) },
    secretStorageType = this.secretStorageType,
    isConfiguredFromEnvironment = this.isConfiguredFromEnvironment,
    scopeType = this.scopeType,
    scopeId = this.scopeId,
    config = this.config,
    createdAt = this.createdAt,
    updatedAt = this.updatedAt,
  )

fun ModelSecretStorage.toEntity(): EntitySecretStorage =
  EntitySecretStorage(
    id = this.id?.value,
    secretStorageType = this.secretStorageType,
    isConfiguredFromEnvironment = this.isConfiguredFromEnvironment,
    scopeType = this.scopeType,
    scopeId = this.scopeId,
    config = this.config,
  )
```

Authorization uses the new intents system:

```yaml
# intents.yaml
intents:
  ManageSecretStorages:
    name: Manage secret storages
    description: Ability to manage secret storages
    roles:
      - ADMIN
```

#### Business Value

This API enables enterprise secret management:

1. **Visibility**: Organizations can audit which secret storage backends are configured
2. **Type Safety**: Inline value classes prevent ID confusion bugs at compile time
3. **Layered Architecture**: Domain services abstract business logic from data access
4. **Multi-Backend Support**: Enumeration supports AWS, GCP, Azure, and Vault
5. **Scope-Based Access**: Secrets can be configured at instance, org, or workspace levels
6. **Environment Detection**: `isConfiguredFromEnvironment` flag aids in configuration troubleshooting
7. **Audit Trail**: Created/updated timestamps support compliance requirements

The domain layer introduction established a pattern for future API development, separating business rules from persistence concerns.

#### Related Commits

- 98137c70d8 (Mar 25, 2025): Moved secret writing from JOOQ layer to handler layer
- Multiple secret management and encryption enhancements

---

### 6. CurrentUser Service for API Request Context

**Commit:** 0252d08de9 - January 8, 2024
**Impact:** 7 files changed, 270 insertions

#### What Changed

Created a service abstraction for retrieving the authenticated User associated with the current API request. This used Micronaut's `@RequestScope` to cache the user lookup per request and provided different implementations for Community vs Enterprise editions.

**Key files added:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/support/CurrentUserService.java` (interface)
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/support/CommunityCurrentUserService.java` (OSS impl)
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/support/SecurityAwareCurrentUserService.java` (Cloud impl)

#### Implementation Details

The interface defines a simple contract:

```java
/**
 * Interface for retrieving the User associated with the current request.
 */
public interface CurrentUserService {
  User getCurrentUser();
}
```

The Community implementation always returns the default user:

```java
/**
 * Implementation of {@link CurrentUserService} that uses the default user from the
 * {@link UserPersistence}. Community edition of Airbyte doesn't surface the concept
 * of real users, so this implementation simply returns the default user that ships
 * with the application.
 *
 * `@RequestScope` means one bean is created per request, so the default user is
 * cached for any subsequent calls to getCurrentUser() within the same request.
 */
@Slf4j
@RequestScope
public class CommunityCurrentUserService implements CurrentUserService {

  private final UserPersistence userPersistence;
  private User retrievedDefaultUser;

  public CommunityCurrentUserService(final UserPersistence userPersistence) {
    this.userPersistence = userPersistence;
  }

  @Override
  public User getCurrentUser() {
    if (this.retrievedDefaultUser == null) {
      try {
        this.retrievedDefaultUser = userPersistence.getDefaultUser().orElseThrow();
        log.debug("Setting current user for request to retrieved default user: {}",
          retrievedDefaultUser);
      } catch (final Exception e) {
        throw new RuntimeException("Could not get the current user due to an internal error.", e);
      }
    }
    return this.retrievedDefaultUser;
  }
}
```

The Security-aware implementation extracts the user from the authentication context:

```java
/**
 * Interface for retrieving the current Airbyte User associated with the current request.
 * Replaces the {@link CommunityCurrentUserService} when micronaut.security is enabled,
 * ie in Enterprise and Cloud.
 *
 * `@RequestScope` means one bean is created per request, so the current user is cached
 * for any subsequent calls to getCurrentUser() within the same request.
 */
@RequestScope
@Requires(property = "micronaut.security.enabled", value = "true")
@Replaces(CommunityCurrentUserService.class)
@Slf4j
public class SecurityAwareCurrentUserService implements CurrentUserService {

  private final UserPersistence userPersistence;
  private final SecurityService securityService;
  private User retrievedCurrentUser;

  public SecurityAwareCurrentUserService(
    final UserPersistence userPersistence,
    final SecurityService securityService
  ) {
    this.userPersistence = userPersistence;
    this.securityService = securityService;
  }

  @Override
  public User getCurrentUser() {
    if (this.retrievedCurrentUser == null) {
      try {
        final String authUserId = securityService.username().orElseThrow();
        this.retrievedCurrentUser = userPersistence.getUserByAuthId(authUserId).orElseThrow();
        log.debug("Setting current user for request to: {}", retrievedCurrentUser);
      } catch (final Exception e) {
        throw new RuntimeException(
          "Could not get the current Airbyte user due to an internal error.", e);
      }
    }
    return this.retrievedCurrentUser;
  }
}
```

Tests verify caching behavior:

```java
@MicronautTest
@Requires(env = {Environment.TEST})
@Property(name = "micronaut.security.enabled", value = "true")
public class SecurityAwareCurrentUserServiceTest {

  @Inject
  SecurityAwareCurrentUserService currentUserService;

  @Inject
  SecurityService securityService;

  @Inject
  UserPersistence userPersistence;

  @BeforeEach
  void setUp() {
    // Set up a mock request context, details don't matter, just needed to make
    // the @RequestScope work on the SecurityAwareCurrentUserService
    ServerRequestContext.set(HttpRequest.GET("/"));
  }

  @Test
  void testGetCurrentUser() throws IOException {
    final String authUserId = "testUser";
    final User expectedUser = new User().withAuthUserId(authUserId);

    when(securityService.username()).thenReturn(Optional.of(authUserId));
    when(userPersistence.getUserByAuthId(authUserId)).thenReturn(Optional.of(expectedUser));

    // First call - should fetch from userPersistence
    final User user1 = currentUserService.getCurrentUser();
    assertEquals(expectedUser, user1);

    // Second call - should use cached user
    final User user2 = currentUserService.getCurrentUser();
    assertEquals(expectedUser, user2);

    // Verify that getUserByAuthId is called only once due to caching
    verify(userPersistence, times(1)).getUserByAuthId(authUserId);
  }
}
```

#### Business Value

This service provides critical infrastructure for user-aware APIs:

1. **Performance**: Request-scoped caching eliminates redundant database lookups per request
2. **Clean APIs**: Handlers can inject `CurrentUserService` instead of parsing authentication headers
3. **Edition-Aware**: Automatically selects the right implementation based on deployment type
4. **Testability**: Interface enables easy mocking in unit tests
5. **Type Safety**: Returns strongly-typed `User` object, not raw authentication data
6. **Error Handling**: Consistent exception handling across all user lookup scenarios

The `@RequestScope` annotation is key—it creates one bean instance per HTTP request, enabling field-level caching without thread safety concerns.

#### Related Commits

- 7c21c5dfd0 (Jan 25, 2024): Used CurrentUser service in workspace access info endpoint
- Multiple handler refactorings to use CurrentUserService

---

### 7. Workspace User Access Info API

**Commit:** 7c21c5dfd0 - January 25, 2024
**Impact:** 10 files changed, 424 insertions, 30 deletions

#### What Changed

Implemented an API endpoint for listing all users with access to a workspace, including detailed information about the permission grants (workspace-level vs organization-level) that provide that access.

**Key files:**
- `airbyte-api/src/main/openapi/config.yaml` (added `/v1/users/list_access_info_by_workspace_id` endpoint)
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/UserHandler.java` (enhanced)
- `airbyte-config/config-persistence/src/main/java/io/airbyte/config/persistence/PermissionPersistenceHelper.java` (enhanced)
- `airbyte-config/config-persistence/src/main/java/io/airbyte/config/persistence/UserPersistence.java` (enhanced)

#### Implementation Details

The API response model provides comprehensive access information:

```yaml
WorkspaceUserAccessInfoRead:
  description: |
    Information summarizing a user's access to a workspace. Includes the workspace-level
    and/or organization-level permission object that grants the user access to the workspace
    in question, as well as basic user information to facilitate access management of users
    in the workspace.
  type: object
  required:
    - userId
    - userEmail
    - userName
    - workspaceId
  properties:
    userId:
      $ref: "#/components/schemas/UserId"
    userEmail:
      type: string
      format: email
    userName:
      type: string
    workspaceId:
      $ref: "#/components/schemas/WorkspaceId"
    workspacePermission:
      $ref: "#/components/schemas/PermissionRead"
    organizationPermission:
      $ref: "#/components/schemas/PermissionRead"

WorkspaceUserAccessInfoReadList:
  type: object
  required:
    - usersWithAccess
  properties:
    usersWithAccess:
      type: array
      items:
        $ref: "#/components/schemas/WorkspaceUserAccessInfoRead"
```

The handler builds the response from persistence layer data:

```java
public class UserHandler {
  public WorkspaceUserAccessInfoReadList listAccessInfoByWorkspaceId(
    final WorkspaceIdRequestBody workspaceIdRequestBody
  ) throws IOException {
    final UUID workspaceId = workspaceIdRequestBody.getWorkspaceId();
    final List<WorkspaceUserAccessInfo> userAccessInfo =
      userPersistence.listWorkspaceUserAccessInfo(workspaceId);
    return buildWorkspaceUserAccessInfoReadList(userAccessInfo);
  }

  private WorkspaceUserAccessInfoReadList buildWorkspaceUserAccessInfoReadList(
    final List<WorkspaceUserAccessInfo> accessInfos
  ) {
    return new WorkspaceUserAccessInfoReadList()
        .usersWithAccess(
          accessInfos.stream()
            .map(this::buildWorkspaceUserAccessInfoRead)
            .collect(Collectors.toList())
        );
  }

  private WorkspaceUserAccessInfoRead buildWorkspaceUserAccessInfoRead(
    final WorkspaceUserAccessInfo accessInfo
  ) {
    final PermissionRead workspacePermissionRead =
      Optional.ofNullable(accessInfo.getWorkspacePermission())
        .map(wp -> new PermissionRead()
            .permissionId(wp.getPermissionId())
            .permissionType(Enums.convertTo(wp.getPermissionType(), PermissionType.class))
            .userId(wp.getUserId())
            .workspaceId(wp.getWorkspaceId()))
        .orElse(null);

    final PermissionRead organizationPermissionRead =
      Optional.ofNullable(accessInfo.getOrganizationPermission())
        .map(op -> new PermissionRead()
            .permissionId(op.getPermissionId())
            .permissionType(Enums.convertTo(op.getPermissionType(), PermissionType.class))
            .userId(op.getUserId())
            .organizationId(op.getOrganizationId()))
        .orElse(null);

    return new WorkspaceUserAccessInfoRead()
        .userId(accessInfo.getUserId())
        .userEmail(accessInfo.getUserEmail())
        .userName(accessInfo.getUserName())
        .workspaceId(accessInfo.getWorkspaceId())
        .workspacePermission(workspacePermissionRead)
        .organizationPermission(organizationPermissionRead);
  }
}
```

The persistence layer uses a sophisticated query with column aliasing:

```java
public class PermissionPersistenceHelper {
  // The following constants are used to alias columns in the below query to avoid
  // ambiguity when joining the same table multiple times.
  public static final String WORKSPACE_PERMISSION_ID_ALIAS = "workspace_perm_id";
  public static final String WORKSPACE_PERMISSION_TYPE_ALIAS = "workspace_perm_type";
  public static final String WORKSPACE_PERMISSION_WORKSPACE_ID_ALIAS = "workspace_perm_workspace_id";
  public static final String ORG_PERMISSION_ID_ALIAS = "org_perm_id";
  public static final String ORG_PERMISSION_TYPE_ALIAS = "org_perm_type";
  public static final String ORG_PERMISSION_ORG_ID_ALIAS = "org_perm_org_id";

  public static final String LIST_USERS_BY_WORKSPACE_ID_AND_PERMISSION_TYPES_QUERY =
      "WITH "
          + " workspaceOrg AS ("
          + "  SELECT organization_id FROM workspace WHERE workspace.id = {0}"
          + " ),"
          + " usersInOrgWithPerm AS ("
          + "   SELECT permission.user_id,"
          + "          permission.organization_id AS " + ORG_PERMISSION_ORG_ID_ALIAS + ","
          + "          permission.id AS " + ORG_PERMISSION_ID_ALIAS + ","
          + "          permission.permission_type AS " + ORG_PERMISSION_TYPE_ALIAS
          + "   FROM permission"
          + "   JOIN workspaceOrg ON permission.organization_id = workspaceOrg.organization_id"
          + "   WHERE permission_type = ANY({1}::permission_type[])"
          + " ),"
          + " usersInWorkspaceWithPerm AS ("
          + "   SELECT permission.user_id,"
          + "          permission.workspace_id AS " + WORKSPACE_PERMISSION_WORKSPACE_ID_ALIAS + ","
          + "          permission.id AS " + WORKSPACE_PERMISSION_ID_ALIAS + ","
          + "          permission.permission_type AS " + WORKSPACE_PERMISSION_TYPE_ALIAS
          + "   FROM permission WHERE workspace_id = {0} "
          + "   AND permission_type = ANY({1}::permission_type[])"
          + " )"
          + " SELECT \"user\".*,"
          + "        usersInWorkspaceWithPerm." + WORKSPACE_PERMISSION_ID_ALIAS + ","
          + "        usersInWorkspaceWithPerm." + WORKSPACE_PERMISSION_TYPE_ALIAS + ","
          + "        usersInWorkspaceWithPerm." + WORKSPACE_PERMISSION_WORKSPACE_ID_ALIAS + ","
          + "        usersInOrgWithPerm." + ORG_PERMISSION_ID_ALIAS + ","
          + "        usersInOrgWithPerm." + ORG_PERMISSION_TYPE_ALIAS + ","
          + "        usersInOrgWithPerm." + ORG_PERMISSION_ORG_ID_ALIAS + ","
          + "        {0} AS workspace_id"
          + " FROM \"user\""
          + " LEFT JOIN usersInWorkspaceWithPerm ON \"user\".id = usersInWorkspaceWithPerm.user_id"
          + " LEFT JOIN usersInOrgWithPerm ON \"user\".id = usersInOrgWithPerm.user_id"
          + " WHERE (usersInWorkspaceWithPerm.user_id IS NOT NULL OR usersInOrgWithPerm.user_id IS NOT NULL)"
          + " AND \"user\".status = 'enabled'";
}
```

The domain model captures the access information:

```yaml
# WorkspaceUserAccessInfo.yaml
title: WorkspaceUserAccessInfo
description: Info summarizing a user's access to a workspace
type: object
required:
  - userId
  - userEmail
  - userName
  - workspaceId
properties:
  userId:
    type: string
    format: uuid
  userEmail:
    type: string
    format: email
  userName:
    type: string
  workspaceId:
    type: string
    format: uuid
  workspacePermission:
    description: Workspace-level permission that grants the user access to the workspace, if any
    "$ref": Permission.yaml
  organizationPermission:
    description: Organization-level permission that grants the user access to the workspace, if any
    "$ref": Permission.yaml
```

#### Business Value

This API enables sophisticated access management UIs:

1. **Comprehensive View**: Shows all users with access and why they have it
2. **Permission Source Clarity**: Distinguishes workspace vs organization permission grants
3. **Access Auditing**: Organizations can audit who has access to sensitive workspaces
4. **UI Support**: Frontend can render permission management interfaces with full context
5. **Efficient Query**: Single database query returns all necessary data
6. **Filtered Results**: Only returns enabled users, hiding disabled/deleted accounts

The column aliasing technique prevents ambiguity when joining the permission table twice (once for workspace permissions, once for organization permissions).

#### Related Commits

- 0252d08de9 (Jan 8, 2024): Added CurrentUserService used by this endpoint
- Multiple RBAC and permission management enhancements

---

### 8. Billing Checkout Session API

**Commit:** 9966400f1d - September 27, 2024
**Impact:** 7 files changed, 240 insertions, 182 deletions

#### What Changed

Added a new `/api/v1/billing/complete_checkout_session` endpoint and refactored Stripe webhook processing. This separated checkout completion logic from webhook handling and improved webhook authentication.

**Key files:**
- `airbyte-api/server-api/src/main/openapi/config.yaml` (added endpoint)
- `airbyte-server/src/main/kotlin/io/airbyte/server/apis/controllers/BillingController.kt` (enhanced)
- `airbyte-commons-server/src/main/java/io/airbyte/server/scheduling/AirbyteTaskExecutors.java` (enhanced)

#### Implementation Details

The OpenAPI spec defines the completion endpoint:

```yaml
/v1/billing/complete_checkout_session:
  post:
    summary: Complete a Stripe checkout session
    tags:
      - billing
    operationId: completeCheckoutSession
    requestBody:
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/CompleteCheckoutSessionRequestBody"
      required: true
    responses:
      "204":
        description: Checkout session completed successfully
      "400":
        description: Invalid session ID or session already completed
      "422":
        $ref: "#/components/responses/InvalidInputResponse"

CompleteCheckoutSessionRequestBody:
  type: object
  required:
    - sessionId
  properties:
    sessionId:
      type: string
      description: The Stripe checkout session ID to complete
```

The controller handles the business logic:

```kotlin
@Controller("/v1/billing")
class BillingController(
  private val billingService: BillingService,
  private val stripeWebhookHandler: StripeWebhookHandler,
  private val executorService: ExecutorService,
) {

  @Post("/complete_checkout_session")
  @Secured(SecurityRule.IS_AUTHENTICATED)
  fun completeCheckoutSession(
    @Body request: CompleteCheckoutSessionRequestBody
  ): HttpResponse<Void> {
    try {
      val session = billingService.getCheckoutSession(request.sessionId)

      if (session.status == "complete") {
        // Session already processed
        return HttpResponse.noContent()
      }

      if (session.status != "open") {
        throw BadRequestException("Checkout session is not in a valid state")
      }

      // Process the session asynchronously to avoid blocking the API response
      executorService.submit {
        try {
          stripeWebhookHandler.handleCheckoutSessionCompleted(session)
        } catch (e: Exception) {
          log.error(e) { "Failed to process checkout session ${request.sessionId}" }
        }
      }

      return HttpResponse.noContent()
    } catch (e: StripeException) {
      throw UnexpectedProblem("Failed to retrieve checkout session",
        ProblemMessageData().message(e.message))
    }
  }
}
```

The executor service configuration ensures non-blocking processing:

```java
@Factory
public class AirbyteTaskExecutors {

  @Singleton
  @Named("billingExecutor")
  public ExecutorService billingExecutor() {
    return Executors.newFixedThreadPool(
      4, // Allow up to 4 concurrent billing operations
      new ThreadFactoryBuilder()
        .setNameFormat("billing-executor-%d")
        .build()
    );
  }
}
```

Application configuration defines webhook settings:

```yaml
# application.yml
airbyte:
  billing:
    stripe:
      webhook-secret: ${STRIPE_WEBHOOK_SECRET}
      checkout-webhook-secret: ${STRIPE_CHECKOUT_WEBHOOK_SECRET:${STRIPE_WEBHOOK_SECRET}}
```

#### Business Value

This refactoring improves the billing integration:

1. **Explicit Completion**: Frontend can explicitly trigger checkout completion
2. **Webhook Independence**: No longer fully dependent on webhook delivery
3. **Idempotency**: Safely handles multiple calls with the same session ID
4. **Async Processing**: Doesn't block API response while updating subscription state
5. **Separate Secrets**: Dedicated webhook signing secrets for checkout vs general webhooks
6. **Error Isolation**: Failures in checkout processing don't impact API availability
7. **Observability**: Named executor threads aid in debugging billing issues

The async executor pattern prevents slow Stripe API calls from blocking Micronaut's request threads.

#### Related Commits

- 3e8e204487 (Oct 17, 2024): Moved Stripe webhook to single endpoint with dedicated secret
- c685f6c4a0 (Oct 17, 2024): Prevented ESP from rejecting webhook endpoint
- 9a95174326 (Sep 9, 2024): Added workspace usage endpoint

---

## Technical Evolution

The commits tell a story of API maturity and architectural sophistication over nearly four years:

### Phase 1: Foundation APIs (2021-2022)

Early work focused on core operational APIs:

- **December 2021**: Delete API endpoints for actor definitions (9dfd0daf0a)
- **January 2022**: Enhanced attempt statistics in API responses (a0079534fd)
- **February 2022**: Added failure summaries to API responses (01f4675a59)
- **September 2022**: JobInfoLight API for performance optimization (1d29672122)
- **October 2022**: Geography support in workspace and connection APIs (fb9efb378d)

This phase established patterns for RESTful endpoint design, request/response models, and handler architecture.

### Phase 2: RBAC and User Management APIs (2023-2024)

The focus shifted to authentication, authorization, and user management:

- **August 2023**: Instance configuration API with setup endpoint (dacfafff41, 6b4546f400)
- **October 2023**: RBAC annotations on API endpoints (cc3010471c, 7c87a04c25, dc675b8704)
- **November 2023**: Permission CRUD APIs (f4c9ae098c, 3e95a71e43, 4efe207a80)
- **January 2024**: CurrentUser service for request context (0252d08de9)
- **January 2024**: User invitation APIs (5cc95d28b6)
- **January 2024**: Workspace user access info API (7c21c5dfd0)

This phase introduced security-first API design with proper authorization checks and user context propagation.

### Phase 3: Domain-Specific APIs (2024-2025)

Recent work focused on specialized domain APIs:

- **March 2024**: User invitation enhancements (cc2f032d8f, d5197c4517, 73350c09b2)
- **June 2024**: Connection last job per stream API (082bd46827, 53d0fb82d2)
- **September 2024**: Billing and payment APIs (9a95174326, 9966400f1d)
- **March 2025**: Secret storage APIs (1332a12ed6)
- **September 2025**: Public API enhancements for dataplane (786d8fb13b, 6a1b4fb12e, 10a57bfc10)
- **October 2025**: SSO token validation API (1afd3bf944, 83bfb7b0ef)
- **November 2025**: Dataplane health monitoring API (c231086441)

This phase demonstrated domain expertise with specialized APIs for billing, secrets, SSO, and operational monitoring.

### Key Architectural Patterns

Several patterns emerged and matured over time:

#### 1. Layered Architecture

```
Controller (API contract)
  → Handler (business logic)
    → Service (domain operations)
      → Repository (data access)
```

Each layer has clear responsibilities and dependencies flow inward.

#### 2. OpenAPI-First Design

All endpoints start with OpenAPI specs defining:
- Request/response schemas
- HTTP methods and paths
- Error responses
- Authentication requirements

#### 3. Type-Safe Domain Models

Progression from raw UUIDs to inline value classes:

```kotlin
// Early: UUID mixups possible
fun getConnection(id: UUID): Connection

// Later: Type-safe, compiler-enforced
fun getConnection(id: ConnectionId): Connection
```

#### 4. Request-Scoped Services

Using Micronaut's `@RequestScope` for performance:

```kotlin
@RequestScope
class CurrentUserService {
  private var cachedUser: User? = null

  fun getCurrentUser(): User {
    if (cachedUser == null) {
      cachedUser = fetchUserFromDatabase()
    }
    return cachedUser!!
  }
}
```

#### 5. Async Processing

Separating API response from long-running operations:

```kotlin
@Post("/trigger")
fun triggerOperation(): HttpResponse<Void> {
  executorService.submit {
    performLongRunningOperation()
  }
  return HttpResponse.accepted() // Return immediately
}
```

#### 6. Structured Error Responses

Evolution from generic errors to domain-specific problems:

```yaml
SSOTokenValidationProblemResponse:
  properties:
    status: 401
    type: error:sso-token-validation
    title: SSO token validation failed
    data:
      organizationId: <uuid>
      errorMessage: <details>
```

### Technology Evolution

The stack matured alongside the APIs:

- **OpenAPI 3.0**: Consistent API documentation and code generation
- **Micronaut**: Moved from Spring to Micronaut for better performance
- **Kotlin**: Newer code increasingly in Kotlin for conciseness
- **Micronaut Data**: Replaced manual JOOQ queries with declarative repositories
- **@RequestScope**: Leveraged for per-request caching
- **Structured Logging**: Kotlin logging with contextual information

---

## Impact Summary

Parker's API development work represents a comprehensive implementation of Airbyte's RESTful interface layer. The work enabled Airbyte to evolve from a UI-driven application to a platform with rich programmatic access.

### Quantitative Impact

- **52 commits** over 47 months
- **~12,000+ lines** of code changes
- **Major API categories delivered:**
  - User management APIs (invitations, access info, RBAC)
  - Operational APIs (dataplane health, job stats)
  - Billing APIs (checkout, usage tracking)
  - Secret management APIs (storage configuration)
  - SSO APIs (token validation, configuration)
  - Public APIs (dataplanes, regions)

### Qualitative Impact

**For API Consumers:**
- Comprehensive REST APIs for all platform operations
- Consistent request/response patterns across endpoints
- Structured error responses aid debugging
- OpenAPI specs enable code generation in any language
- Public API provides stable interface for integrations

**For Developers:**
- Clear layering separates concerns (controller/handler/service/repository)
- Type-safe domain models prevent UUID confusion bugs
- Request-scoped services optimize performance automatically
- Async executors prevent blocking API threads
- Comprehensive test coverage (unit, integration)

**For the Platform:**
- Scalable architecture supports high request volumes
- Security-first design with proper authorization
- Multi-tenant support at API layer
- Monitoring APIs enable operational excellence
- Billing integration supports commercial model

### Key API Patterns Established

The work established several important patterns:

1. **OpenAPI-First Design**: Specs drive implementation, not the reverse
2. **Domain Services Layer**: Business logic abstracted from persistence
3. **Type-Safe IDs**: Inline value classes prevent ID confusion
4. **Request-Scoped Caching**: Optimize database queries per request
5. **Async Processing**: Separate API response from long-running ops
6. **Structured Errors**: Domain-specific error responses with context
7. **Batch Queries**: Optimize N+1 patterns with single queries
8. **Column Aliasing**: Handle complex JOINs without ambiguity

This foundation enables Airbyte to support enterprise customers with complex integration requirements, operational monitoring needs, and programmatic access patterns.
