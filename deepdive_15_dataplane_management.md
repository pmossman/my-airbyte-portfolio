# Dataplane Management - Deep Dive

## Overview

This document analyzes Parker Mossman's contributions to the Dataplane Management area of the airbyte-platform repository. This work spans from March 2025 to November 2025, encompassing 14 commits that built out Airbyte's infrastructure for managing self-hosted dataplanes, health monitoring systems, and organization-level dataplane access control.

**Period:** March 10, 2025 - November 5, 2025 (8 months)
**Total Commits:** 14
**Total Changes:** ~3,500 lines of code
**Key Technologies:** Kotlin, Micronaut Data, PostgreSQL, JWT Authentication, RBAC

---

## Key Architectural Changes

### 1. Dataplane Health Monitoring with Heartbeat Logging

**Foundation Commit:** 19029247c8 - October 30, 2025
**Service Layer Commit:** 1591a4e44a - November 3, 2025
**Cleanup Cron Commit:** 1bd22a13f0 - November 3, 2025
**Health API Commit:** c231086441 - November 5, 2025
**Combined Impact:** 27 files changed, 1,596 insertions, 17 deletions

#### What Changed

This series of commits introduced a complete health monitoring infrastructure for dataplanes, allowing the control plane to track when dataplanes are active, what versions they're running, and their overall health status.

**Key files added:**
- `/airbyte-db/db-lib/src/main/kotlin/io/airbyte/db/instance/configs/migrations/V2_1_0_012__CreateDataplaneHeartbeatLogTable.kt` (database migration)
- `/airbyte-data/src/main/kotlin/io/airbyte/data/repositories/DataplaneHeartbeatLogRepository.kt` (repository)
- `/airbyte-data/src/main/kotlin/io/airbyte/data/repositories/entities/DataplaneHeartbeatLog.kt` (entity)
- `/airbyte-data/src/main/kotlin/io/airbyte/data/services/DataplaneHealthService.kt` (service layer)
- `/airbyte-cron/src/main/kotlin/io/airbyte/cron/jobs/DataplaneHeartbeatCleanup.kt` (cron job)
- `/airbyte-domain/models/src/main/kotlin/io/airbyte/domain/models/DataplaneHealthInfo.kt` (domain model)

#### Implementation Details

**Database Foundation**

The migration created a dedicated table for heartbeat logs with optimized indexing:

```kotlin
private fun createDataplaneHeartbeatLogTable(ctx: DSLContext) {
  val id = DSL.field(ID_FIELD_NAME, org.jooq.impl.SQLDataType.UUID.nullable(false))
  val dataplaneId = DSL.field(DATAPLANE_ID_FIELD_NAME, org.jooq.impl.SQLDataType.UUID.nullable(false))
  val controlPlaneVersion = DSL.field(CONTROL_PLANE_VERSION_FIELD_NAME, org.jooq.impl.SQLDataType.VARCHAR(50).nullable(false))
  val dataplaneVersion = DSL.field(DATAPLANE_VERSION_FIELD_NAME, org.jooq.impl.SQLDataType.VARCHAR(50).nullable(false))
  val createdAt = DSL.field(
    CREATED_AT_FIELD_NAME,
    org.jooq.impl.SQLDataType.TIMESTAMPWITHTIMEZONE
      .nullable(false)
      .defaultValue(DSL.currentOffsetDateTime())
  )

  ctx
    .createTable(DATAPLANE_HEARTBEAT_LOG_TABLE)
    .columns(id, dataplaneId, controlPlaneVersion, dataplaneVersion, createdAt)
    .constraints(
      DSL.primaryKey(id),
      DSL.foreignKey(dataplaneId).references(DATAPLANE_TABLE, ID_FIELD_NAME).onDeleteCascade(),
    ).execute()
}
```

Two specialized indexes were created for performance:

```kotlin
// Composite index for health status and history queries
// created_at DESC matches our DISTINCT ON query pattern
ctx
  .createIndex("idx_dataplane_heartbeat_log_dataplane_created_at")
  .on(
    DSL.table(DATAPLANE_HEARTBEAT_LOG_TABLE),
    DSL.field(DATAPLANE_ID_FIELD_NAME),
    DSL.field(CREATED_AT_FIELD_NAME).desc(),
  ).execute()

// Index for efficient deletion of old records by timestamp
ctx
  .createIndex("idx_dataplane_heartbeat_log_created_at")
  .on(DATAPLANE_HEARTBEAT_LOG_TABLE, CREATED_AT_FIELD_NAME)
  .execute()
```

**Service Layer with Version Tracking**

The `DataplaneHealthService` provides methods for recording heartbeats, calculating health status, and cleaning up old data:

```kotlin
fun recordHeartbeat(
  dataplaneId: UUID,
  controlPlaneVersion: String? = null,
  dataplaneVersion: String? = null,
) {
  val log = DataplaneHeartbeatLog(
    dataplaneId = dataplaneId,
    controlPlaneVersion = controlPlaneVersion ?: UNKNOWN_VERSION,
    dataplaneVersion = dataplaneVersion ?: UNKNOWN_VERSION,
  )

  heartbeatLogRepository.save(log)
  logger.debug { "Recorded heartbeat for dataplane $dataplaneId" }
}
```

**Health Status Calculation**

The service implements sophisticated health status logic with three thresholds:

```kotlin
companion object {
  const val UNKNOWN_VERSION = "unknown"
  val HEALTHY_THRESHOLD_DURATION: Duration = Duration.ofSeconds(60)
  val DEGRADED_THRESHOLD_DURATION: Duration = Duration.ofMinutes(5)
  val RETENTION_PERIOD_DURATION: Duration = Duration.ofHours(24)
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

  val recentHeartbeats = recentHeartbeatLogs.mapNotNull { log ->
    log.createdAt?.let { timestamp ->
      HeartbeatData(timestamp = timestamp)
    }
  }

  return DataplaneHealthInfo(
    dataplaneId = dataplaneId,
    status = status,
    lastHeartbeatTimestamp = heartbeat.createdAt,
    secondsSinceLastHeartbeat = secondsSince,
    recentHeartbeats = recentHeartbeats,
    controlPlaneVersion = heartbeat.controlPlaneVersion,
    dataplaneVersion = heartbeat.dataplaneVersion,
  )
}
```

**Optimized Cleanup Strategy**

The cleanup logic ensures data retention while preserving the most recent heartbeat for each dataplane:

```kotlin
@Query(
  """
  WITH latest_heartbeats AS (
    SELECT DISTINCT ON (dataplane_id) id
    FROM dataplane_heartbeat_log
    ORDER BY dataplane_id, created_at DESC
  )
  DELETE FROM dataplane_heartbeat_log dhl
  WHERE dhl.created_at < :cutoffTime
    AND NOT EXISTS (
      SELECT 1 FROM latest_heartbeats lh WHERE lh.id = dhl.id
    )
  """,
)
fun deleteOldHeartbeatsExceptLatest(cutoffTime: OffsetDateTime): Int
```

This query uses a CTE with `DISTINCT ON` to identify the latest heartbeat for each dataplane, then deletes all heartbeats older than the cutoff time except those identified as latest. The cron job runs this hourly:

```kotlin
@Singleton
class DataplaneHeartbeatCleanup(
  private val dataplaneHealthService: DataplaneHealthService,
  private val metricClient: MetricClient,
) {
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

**Health Monitoring API**

The internal API endpoint exposes health information for all dataplanes in an organization:

```kotlin
@Post("/health")
@RequiresIntent(Intent.ManageDataplanes)
@ExecuteOn(AirbyteTaskExecutors.IO)
fun listDataplaneHealth(
  @Body request: OrganizationIdRequestBody,
): DataplaneHealthListResponse {
  entitlementService.ensureEntitled(OrganizationId(request.organizationId), SelfManagedRegionsEntitlement)

  val dataplaneGroups = dataplaneGroupService.listDataplaneGroups(listOf(request.organizationId), false)
  val dataplaneGroupMap = dataplaneGroups.associateBy { it.id }

  val dataplanes = dataplaneService.listDataplanes(dataplaneGroups.map { it.id })
  val dataplaneMap = dataplanes.associateBy { it.id }

  val healthInfos = dataplaneHealthService.getDataplaneHealthInfos(dataplanes.map { it.id })

  val dataplaneHealthReads = healthInfos.map { healthInfo ->
    val dataplane = dataplaneMap[healthInfo.dataplaneId]!!
    val dataplaneGroup = dataplaneGroupMap[dataplane.dataplaneGroupId]!!

    DataplaneHealthRead()
      .dataplaneId(healthInfo.dataplaneId)
      .dataplaneName(dataplane.name)
      .dataplaneGroupId(dataplane.dataplaneGroupId)
      .organizationId(dataplaneGroup.organizationId)
      .status(DataplaneHealthRead.StatusEnum.fromValue(healthInfo.status.name))
      .lastHeartbeatTimestamp(healthInfo.lastHeartbeatTimestamp)
      .recentHeartbeats(
        healthInfo.recentHeartbeats.map { hb ->
          HeartbeatRecord().timestamp(hb.timestamp)
        }
      )
      .controlPlaneVersion(healthInfo.controlPlaneVersion)
      .dataplaneVersion(healthInfo.dataplaneVersion)
  }

  return DataplaneHealthListResponse().dataplanes(dataplaneHealthReads)
}
```

#### Business Value

This health monitoring infrastructure provides critical operational capabilities:

1. **Operational Visibility**: Platform operators can see at a glance which dataplanes are healthy, degraded, or unhealthy
2. **Version Tracking**: Both control plane and dataplane versions are tracked, essential for coordinating upgrades
3. **Scalable Design**: The indexing strategy and cleanup cron ensure the system scales to thousands of dataplanes
4. **Historical Context**: Recent heartbeats provide trending information, not just point-in-time status
5. **Automated Maintenance**: The cleanup cron prevents unbounded growth of heartbeat data while preserving important information
6. **Integration Point**: The heartbeat mechanism integrates directly with the existing dataplane heartbeat endpoint used for authentication

The tiered health status (HEALTHY/DEGRADED/UNHEALTHY/UNKNOWN) allows for nuanced monitoring and alerting. A degraded dataplane might trigger investigation, while an unhealthy one could trigger automatic failover.

---

### 2. Workspace Dataplane Group Assignment Validation

**Commit:** 205afe57c0 - September 9, 2025
**Impact:** 4 files changed, 425 insertions, 1 deletion

#### What Changed

Added comprehensive validation to ensure workspaces can only be assigned to dataplane groups that belong to their organization, preventing cross-organization dataplane access and enforcing proper security boundaries.

**Key files modified:**
- `/airbyte-commons-server/src/main/kotlin/io/airbyte/commons/server/handlers/WorkspacesHandler.kt`
- `/airbyte-data/src/main/kotlin/io/airbyte/data/services/DataplaneGroupService.kt`

#### Implementation Details

The validation logic implements a three-tier check during workspace creation and updates:

```kotlin
private fun validateDataplaneGroupAssignment(
  dataplaneGroupId: DataplaneGroupId,
  organizationId: OrganizationId,
) {
  // First, ensure the current user is at least an org editor of the target org.
  roleResolver
    .newRequest()
    .withCurrentUser()
    .withOrg(organizationId.value)
    .requireRole(AuthRoleConstants.ORGANIZATION_EDITOR)

  // Then, check if the dataplaneGroupId is one of the defaults that every org can use.
  if (dataplaneGroupService.listDefaultDataplaneGroups().map { it.id }.contains(dataplaneGroupId.value)) {
    return
  }

  // Finally, since it's not a default, ensure the dataplane group belongs to the target org.
  val dataplaneGroup = dataplaneGroupService.getDataplaneGroup(dataplaneGroupId.value)
  if (dataplaneGroup.organizationId != organizationId.value) {
    throw ForbiddenProblem(
      ProblemMessageData().message("Dataplane group ${dataplaneGroupId.value} does not belong to organization ${organizationId.value}."),
    )
  }
}
```

This validation is invoked during both workspace creation and updates:

```kotlin
@Throws(JsonValidationException::class, IOException::class, ValueConflictKnownException::class, ConfigNotFoundException::class)
fun createWorkspaceIfNotExist(workspaceCreateWithId: WorkspaceCreateWithId): WorkspaceRead {
  // ... setup code ...

  if (workspaceCreateWithId.dataplaneGroupId == null) {
    val defaultDataplaneGroup = dataplaneGroupService.getDefaultDataplaneGroupForAirbyteEdition(airbyteEdition)
    dataplaneGroupId = defaultDataplaneGroup.id
  } else {
    // If an explicit dataplane group ID is provided, ensure it is a valid assignment for the workspace.
    validateDataplaneGroupAssignment(
      DataplaneGroupId(workspaceCreateWithId.dataplaneGroupId),
      OrganizationId(workspaceCreateWithId.organizationId),
    )

    dataplaneGroupId = workspaceCreateWithId.dataplaneGroupId
  }

  // ... continue with workspace creation ...
}
```

And for updates:

```kotlin
if (workspacePatch.dataplaneGroupId != null) {
  validateDataplaneGroupAssignment(
    DataplaneGroupId(workspacePatch.dataplaneGroupId),
    OrganizationId(workspace.organizationId),
  )
  workspace.dataplaneGroupId = workspacePatch.dataplaneGroupId
}
```

The `DataplaneGroupService` interface gained a new method to list default dataplane groups:

```kotlin
/**
 * List all default dataplane groups that are available for general use.
 */
fun listDefaultDataplaneGroups(): List<DataplaneGroup> =
  listDataplaneGroups(listOf(DEFAULT_ORGANIZATION_ID), false)
```

#### Business Value

This validation enforces critical security boundaries:

1. **Data Isolation**: Prevents workspaces from being assigned to dataplanes in other organizations, ensuring data isolation
2. **Permission Enforcement**: Requires organization editor role to assign custom dataplane groups
3. **Default Safety**: Default dataplane groups (belonging to the system organization) can be used by any organization
4. **Clear Error Messages**: Provides explicit error messages when validation fails, helping users understand permission issues
5. **Defense in Depth**: Adds server-side validation even if client-side checks are bypassed

The three-tier check (permission -> default check -> ownership verification) optimizes for the common case (default groups) while ensuring security for custom groups.

---

### 3. Organization Admin Access to Dataplane APIs

**Commit:** 10a57bfc10 - September 3, 2025
**Impact:** 16 files changed, 292 insertions, 16 deletions

#### What Changed

Extended dataplane and dataplane group management capabilities from instance admins only to include organization admins, enabling proper multi-tenant dataplane management while maintaining security through entitlements and role-based access control.

**Key files modified:**
- `/airbyte-commons-auth/src/main/resources/intents.yaml` (new intents)
- `/airbyte-commons-entitlements/` (new entitlements)
- `/airbyte-commons-server/src/main/kotlin/io/airbyte/commons/server/support/AuthenticationHeaderResolver.kt` (header resolution)
- `/airbyte-server/src/main/kotlin/io/airbyte/server/apis/controllers/DataplaneController.kt` (controller updates)

#### Implementation Details

**New Intent Definitions**

Two new intents were added to support fine-grained dataplane access control:

```yaml
ManageDataplanes:
  name: Manage dataplanes
  description: Create, edit, list, and delete dataplanes
  roles:
    - ORGANIZATION_ADMIN
    - ADMIN
ManageDataplaneGroups:
  name: Manage dataplane groups
  description: Create, edit, list, and delete dataplane groups
  roles:
    - ORGANIZATION_ADMIN
    - ADMIN
```

**Entitlement Framework**

A new entitlement was introduced to gate access to dataplane management:

```kotlin
object ManageDataplanesAndDataplaneGroupsEntitlement : FeatureEntitlement(
  featureId = "feature-platform-manage-dataplanes-and-dataplane-groups",
)
```

The entitlement provider implementations differ by edition:

```kotlin
// Cloud: Feature-flagged
class CloudEntitlementProvider(
  private val featureFlagClient: FeatureFlagClient,
) : EntitlementProvider {
  override fun hasManageDataplanesAndDataplaneGroupsEntitlement(organizationId: OrganizationId): Boolean =
    featureFlagClient.boolVariation(
      AllowDataplaneAndDataplaneGroupManagement,
      Organization(organizationId.value),
    )
}

// Enterprise: Always enabled
class EnterpriseEntitlementProvider : EntitlementProvider {
  // Allow all Enterprise users to manage dataplanes and dataplane groups by default
  override fun hasManageDataplanesAndDataplaneGroupsEntitlement(organizationId: OrganizationId): Boolean = true
}
```

**Organization Resolution from Dataplane IDs**

The authentication system was extended to resolve organization IDs from dataplane and dataplane group IDs:

```kotlin
fun resolveOrganization(properties: Map<String, String>): List<UUID>? {
  // ... existing resolution logic ...

  if (properties.containsKey(DATAPLANE_GROUP_ID_HEADER)) {
    val organizationId = resolveOrganizationIdFromDataplaneGroupHeader(properties[DATAPLANE_GROUP_ID_HEADER])
    if (organizationId != null) {
      return listOf(organizationId)
    }
  } else if (properties.containsKey(DATAPLANE_ID_HEADER)) {
    val organizationId = resolveOrganizationIdFromDataplaneHeader(properties[DATAPLANE_ID_HEADER])
    if (organizationId != null) {
      return listOf(organizationId)
    }
  }

  // ... other resolution methods ...
}

private fun resolveOrganizationIdFromDataplaneGroupHeader(dataplaneGroupHeaderValue: String?): UUID? {
  if (dataplaneGroupHeaderValue == null) {
    return null
  }
  return try {
    val dataplaneGroupId = UUID.fromString(dataplaneGroupHeaderValue)
    dataplaneGroupService.getOrganizationIdFromDataplaneGroup(dataplaneGroupId)
  } catch (e: Exception) {
    log.debug("Unable to resolve organization ID from dataplane group header.", e)
    null
  }
}

private fun resolveOrganizationIdFromDataplaneHeader(dataplaneHeaderValue: String?): UUID? {
  if (dataplaneHeaderValue == null) {
    return null
  }
  return try {
    val dataplaneId = UUID.fromString(dataplaneHeaderValue)
    val dataplaneGroupId = dataplaneService.getDataplane(dataplaneId).dataplaneGroupId
    dataplaneGroupService.getOrganizationIdFromDataplaneGroup(dataplaneGroupId)
  } catch (e: Exception) {
    log.debug("Unable to resolve organization ID from dataplane header.", e)
    null
  }
}
```

**Controller Authorization Updates**

All dataplane controller methods were updated to use intent-based authorization and entitlement checks:

```kotlin
@Post("/create")
@RequiresIntent(Intent.ManageDataplanes)
@ExecuteOn(AirbyteTaskExecutors.IO)
override fun createDataplane(
  @Body dataplaneCreateRequestBody: DataplaneCreateRequestBody,
): DataplaneCreateResponse {
  ensureManageDataplanesAndDataplaneGroupsEntitlement(DataplaneGroupId(dataplaneCreateRequestBody.dataplaneGroupId))

  val dataplane = Dataplane().apply {
    id = UUID.randomUUID()
    dataplaneGroupId = dataplaneCreateRequestBody.dataplaneGroupId
    name = dataplaneCreateRequestBody.name
    enabled = false
  }

  val serviceAccountId = dataplaneService.createDataplane(dataplane)
  val accessToken = dataplaneService.getAccessToken(serviceAccountId)

  return DataplaneCreateResponse().apply {
    dataplaneId = dataplane.id
    this.accessToken = AccessToken().apply {
      token = accessToken.token
      tokenId = accessToken.tokenId
    }
  }
}

private fun ensureManageDataplanesAndDataplaneGroupsEntitlement(dataplaneGroupId: DataplaneGroupId) {
  val orgId = OrganizationId(dataplaneGroupService.getOrganizationIdFromDataplaneGroup(dataplaneGroupId.value))
  entitlementService.ensureEntitled(orgId, ManageDataplanesAndDataplaneGroupsEntitlement)
}

private fun ensureManageDataplanesAndDataplaneGroupsEntitlement(dataplaneId: DataplaneId) {
  val dataplaneGroupId = dataplaneService.getDataplane(dataplaneId.value.toString()).dataplaneGroupId
  val orgId = OrganizationId(dataplaneGroupService.getOrganizationIdFromDataplaneGroup(dataplaneGroupId))
  entitlementService.ensureEntitled(orgId, ManageDataplanesAndDataplaneGroupsEntitlement)
}
```

**Snake Case Field Support**

Because dataplane APIs used snake_case (inconsistent with the rest of the API), special authentication field mappings were added:

```kotlin
enum class AuthenticationId(
  val fieldName: String,
  val httpHeader: String,
) {
  // ... existing mappings ...

  /**
   * The dataplane and dataplane group APIs use snake case for their request body field names,
   * which is inconsistent with the rest of the API. Unfortunately, this is already part of the
   * public API interface, so for now we have to support it in order to avoid breaking changes.
   */
  DATAPLANE_GROUP_ID_SNAKE_CASE(AuthenticationFields.DATAPLANE_GROUP_ID_SNAKE_CASE_FIELD_NAME, AuthenticationHttpHeaders.DATAPLANE_GROUP_ID_HEADER),
  DATAPLANE_ID_SNAKE_CASE(AuthenticationFields.DATAPLANE_ID_SNAKE_CASE_FIELD_NAME, AuthenticationHttpHeaders.DATAPLANE_ID_HEADER),
  ORGANIZATION_ID_SNAKE_CASE(AuthenticationFields.ORGANIZATION_ID_SNAKE_CASE_FIELD_NAME, AuthenticationHttpHeaders.ORGANIZATION_ID_HEADER),
}
```

#### Business Value

This change enabled proper multi-tenant dataplane management:

1. **Delegation of Authority**: Organization admins can manage their own dataplanes without instance admin involvement
2. **Scalability**: Reduces bottlenecks by distributing dataplane management responsibilities
3. **Security**: Maintains strict boundaries through entitlements and intent-based authorization
4. **Flexibility**: Feature flags allow gradual rollout in Cloud, while Enterprise gets full access
5. **Auditability**: Intent-based authorization provides clear audit trails for dataplane operations

The dual-layer security (intent + entitlement) ensures that:
- Only authorized roles can access dataplane APIs
- Only entitled organizations (paying for the feature) can actually use them
- Organization boundaries are enforced through automatic organization ID resolution

---

### 4. Public API Region Filtering for Dataplanes

**Commit:** 786d8fb13b - September 11, 2025
**Impact:** 10 files changed, 368 insertions, 39 deletions

#### What Changed

Enhanced the public dataplane list endpoint to support optional region filtering and organization admin callers, transforming it from an instance-admin-only endpoint to a multi-tenant API with sophisticated access control.

**Key files modified:**
- `/airbyte-api/server-api/src/main/openapi/config.yaml` (API spec)
- `/airbyte-data/src/main/kotlin/io/airbyte/data/repositories/DataplaneRepository.kt` (new queries)
- `/airbyte-data/src/main/kotlin/io/airbyte/data/services/DataplaneService.kt` (service interface)
- `/airbyte-server/src/main/kotlin/io/airbyte/server/apis/publicapi/controllers/DataplaneController.kt` (controller)
- `/airbyte-server/src/main/kotlin/io/airbyte/server/apis/publicapi/services/DataplaneService.kt` (service implementation)

#### Implementation Details

**Enhanced API Specification**

The public API endpoint was updated to support optional region filtering:

```yaml
/v1/dataplanes:
  get:
    summary: List dataplanes
    description: List dataplanes accessible to the current user
    parameters:
      - name: regionIds
        description: The UUIDs of the regions to filter by. If provided, only dataplanes belonging to these regions will be returned. Empty list will retrieve all dataplanes accessible to the current user.
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

**Repository-Level Queries**

New repository methods support querying by multiple dataplane groups and by organization IDs:

```kotlin
@Query(
  """
  SELECT d.* FROM dataplane d
  WHERE d.dataplane_group_id IN (:dataplaneGroupIds)
  AND (:withTombstone = true OR d.tombstone = false)
  ORDER BY d.updated_at DESC
  """,
)
fun findAllByDataplaneGroupIds(
  dataplaneGroupIds: List<UUID>,
  withTombstone: Boolean,
): List<Dataplane>

@Query(
  """
  SELECT d.* FROM dataplane d
  INNER JOIN dataplane_group dg ON d.dataplane_group_id = dg.id
  WHERE (:withTombstone = true OR d.tombstone = false)
  AND dg.organization_id IN (:organizationIds)
  ORDER BY d.updated_at DESC
  """,
)
fun findAllByOrganizationIds(
  organizationIds: List<UUID>,
  withTombstone: Boolean,
): List<Dataplane>
```

**Service Layer Implementation**

The service layer provides multiple query paths depending on the caller's role and parameters:

```kotlin
override fun controllerListDataplanes(regionIds: List<UUID>?): Response {
  val userId = currentUserService.getCurrentUser().userId
  val result = trackingHelper.callWithTracker(
    {
      runCatching {
        if (!regionIds.isNullOrEmpty()) {
          // Explicit region filter provided
          dataplaneDataService.listDataplanes(regionIds, withTombstone = false)
        } else if (permissionHandler.isUserInstanceAdmin(userId)) {
          // Instance admin: get all dataplanes
          dataplaneDataService.listDataplanes(withTombstone = false)
        } else {
          // Org admin: get dataplanes for all organizations in which the user has access
          dataplaneDataService.listDataplanesForOrganizations(
            organizationIds = getOrgIdsWithDataplaneAccessForUser(userId),
            withTombstone = false,
          )
        }
      }.onFailure {
        log.error(it) { "Error listing dataplanes" }
        ConfigClientErrorHandler.handleError(it)
      }.getOrNull()
    },
    DATAPLANES_PATH,
    GET,
    userId,
  )
  return Response.ok().entity(result?.map(DataplaneResponseMapper::from)).build()
}

private fun getOrgIdsWithDataplaneAccessForUser(userId: UUID): List<UUID> {
  val userPermissions = permissionHandler.listPermissionsForUser(userId)
  // Require that a user is an org admin to get dataplane access for that org
  return userPermissions
    .filter { it.permissionType == Permission.PermissionType.ORGANIZATION_ADMIN }
    .map { it.organizationId }
}
```

**Controller-Level Authorization**

The controller enforces that users have organization admin access for all queried regions:

```kotlin
@ExecuteOn(AirbyteTaskExecutors.PUBLIC_API)
override fun publicListDataplanes(regionIds: List<UUID>?): Response {
  if (!regionIds.isNullOrEmpty()) {
    roleResolver
      .newRequest()
      .withCurrentUser()
      .apply {
        regionIds.forEach { withOrg(regionService.getOrganizationIdFromRegion(it)) }
      }.requireRole(AuthRoleConstants.ORGANIZATION_ADMIN)
  }
  return dataplaneService.controllerListDataplanes(regionIds)
}
```

#### Business Value

This enhancement provides flexible, secure dataplane discovery:

1. **Multi-Tenant Support**: Organization admins can list their own dataplanes without seeing others'
2. **Region-Based Filtering**: Callers can narrow results to specific regions for performance and clarity
3. **Backward Compatibility**: Instance admins still get all dataplanes when no filter is provided
4. **Security**: Pre-flight authorization checks ensure users have access to requested regions
5. **Performance**: Repository queries are optimized with proper joins and ordering

The three-path query logic (explicit regions, instance admin, org admin) ensures optimal database queries for each scenario while maintaining security boundaries.

---

### 5. Configurable Default Dataplane Group

**Commit:** 089aa511f7 - September 18, 2025
**Impact:** 28 files changed, 193 insertions, 149 deletions

#### What Changed

Refactored the default dataplane group selection logic to be configurable based on Airbyte edition (Community, Pro, Enterprise), replacing hardcoded UUIDs with environment-aware configuration.

**Key files modified:**
- `/airbyte-data/src/main/kotlin/io/airbyte/data/services/DataplaneGroupService.kt`
- Configuration files across the codebase

#### Implementation Details

The `DataplaneGroupService` interface gained a method to get the edition-specific default:

```kotlin
/**
 * Get the default dataplane group for a given Airbyte edition.
 * For Community edition, this returns the OSS default group.
 * For Pro and Enterprise editions, this returns the Pro default group.
 */
fun getDefaultDataplaneGroupForAirbyteEdition(airbyteEdition: AirbyteEdition): DataplaneGroup
```

This method replaced scattered hardcoded references to specific dataplane group IDs throughout the codebase, centralizing the edition-specific logic in one place.

Previously, code would reference specific UUIDs like:

```kotlin
// Before: Hardcoded UUID
val defaultGroupId = UUID.fromString("4c3b5b5c-5c5c-5c5c-5c5c-5c5c5c5c5c5c")
```

After refactoring:

```kotlin
// After: Edition-aware
val defaultGroup = dataplaneGroupService.getDefaultDataplaneGroupForAirbyteEdition(airbyteEdition)
val defaultGroupId = defaultGroup.id
```

#### Business Value

This change provided flexibility and maintainability:

1. **Edition-Specific Defaults**: Different Airbyte editions can have different default dataplane groups
2. **Configuration Over Code**: Reduces need for code changes when default groups change
3. **Testability**: Easier to test with mock editions and dataplane groups
4. **Maintainability**: Single source of truth for default dataplane group selection
5. **Clear Intent**: Method name makes the purpose explicit vs. magic UUIDs

---

### 6. Dataplane Authentication Improvements

**Commit:** d8607a7a56 - April 9, 2025
**Impact:** 21 files changed, 462 insertions, 367 deletions

**Commit:** a3ee769c5a - March 11, 2025
**Impact:** 9 files changed, 43 insertions, 13 deletions

**Commit:** 7f04b9dc0f - March 10, 2025
**Impact:** 7 files changed, 27 insertions, 12 deletions

#### What Changed

A series of commits that refined dataplane authentication, moving from workload-specific bearer token interceptors to dataplane-specific JWT token generation using Micronaut's native JWT support.

#### Implementation Details

The key change was enabling Micronaut JWT token generators specifically for dataplane authentication in Cloud deployments. This involved:

1. **Interceptor Refinement**: Changed from `WorkloadBearerInterceptor` to `DataplaneInterceptor`, providing more granular control over dataplane-specific authentication flows

2. **JWT Generation**: Leveraged Micronaut's built-in JWT token generation rather than custom token creation, improving security and reducing custom code

3. **Cloud-Specific Configuration**: Made these changes conditional for Cloud deployments, preserving existing authentication for other editions

The commits show careful iteration - the feature was enabled, reverted due to issues, then re-enabled with fixes, demonstrating production-cautious deployment practices.

#### Business Value

1. **Security**: Using framework-provided JWT generation reduces risk of custom implementation bugs
2. **Maintainability**: Less custom authentication code to maintain
3. **Standards Compliance**: Micronaut JWT follows industry standards for token format and validation
4. **Performance**: Framework-level token generation is optimized

---

### 7. Database Schema Evolution

**Commit:** fb64ab67d2 - March 26, 2025
**Impact:** 28 files changed, 144 insertions, 204 deletions

#### What Changed

Removed user foreign key columns from dataplane tables, reflecting the evolution from user-owned dataplanes to organization-owned dataplanes.

#### Implementation Details

This migration removed `user_id` foreign key constraints and columns from dataplane-related tables, as dataplanes became organization-scoped resources rather than user-scoped. This aligned with the broader multi-tenant architecture where organizations (not individual users) own infrastructure resources.

#### Business Value

1. **Architectural Alignment**: Dataplanes as organization resources matches the multi-tenant model
2. **Permission Simplification**: Organization-level permissions are sufficient for dataplane management
3. **Data Model Clarity**: Removes ambiguity about dataplane ownership
4. **Migration Safety**: Careful schema evolution without data loss

---

## Technical Evolution

The commits tell a story of building production-ready infrastructure for self-hosted dataplane management:

### Phase 1: Authentication Foundation (March 2025)

The work began with establishing proper authentication mechanisms for dataplanes using Micronaut JWT tokens. This foundation was critical for secure communication between control plane and dataplanes.

### Phase 2: Access Control Expansion (September 2025)

Three months of production use revealed the need for organization-level dataplane management:
- Added ManageDataplanes and ManageDataplaneGroups intents
- Extended access from instance admins to organization admins
- Implemented entitlement checks for feature gating
- Enhanced public API with region filtering

### Phase 3: Validation and Security (September 2025)

As multi-tenant use grew, security validation became critical:
- Workspace-dataplane group assignment validation
- Cross-organization boundary enforcement
- Default vs. custom dataplane group handling

### Phase 4: Operational Excellence (October-November 2025)

The final phase focused on operational visibility and maintenance:
- Complete heartbeat logging infrastructure
- Health status calculation with multiple tiers
- Automated cleanup cron jobs
- Internal health monitoring API

### Technology Choices

The implementation shows consistent architectural patterns:

- **Micronaut Data**: Used for all new repository queries with compile-time validation
- **Intent-Based Authorization**: Consistent use of `@RequiresIntent` for access control
- **Entitlement Layer**: Separates feature access from role authorization
- **Kotlin**: All new code in Kotlin for null safety and conciseness
- **Optimized Queries**: Strategic use of `DISTINCT ON`, CTEs, and indexes for performance

---

## Impact Summary

Parker's contributions to Dataplane Management represent a complete implementation of self-hosted infrastructure management for Airbyte. The work enabled Airbyte to evolve from a centralized deployment model to a distributed architecture supporting customer-managed dataplanes.

### Quantitative Impact

- **14 commits** over 8 months
- **~3,500 lines** of code changes
- **Major features delivered:**
  - Complete health monitoring infrastructure with 4-tier status
  - Organization-scoped dataplane access control
  - Workspace-dataplane group validation
  - Public API enhancements for multi-tenant dataplane discovery
  - Automated heartbeat cleanup with 24-hour retention
  - Version tracking for control plane and dataplane

### Qualitative Impact

**For Platform Operators:**
- Real-time visibility into dataplane health across all organizations
- Historical heartbeat data for troubleshooting
- Version tracking for coordinated upgrade planning
- Automated maintenance reduces operational overhead

**For Organization Admins:**
- Self-service dataplane management without instance admin involvement
- Region-based dataplane filtering for large deployments
- Clear error messages for permission and assignment issues

**For Developers:**
- Clean service layer abstractions for health monitoring
- Comprehensive test coverage (240+ test lines for repositories)
- Optimized database queries with strategic indexing
- Well-documented transaction boundaries and cleanup strategies

**For the Platform:**
- Scalable multi-tenant dataplane architecture
- Production-hardened with automated cleanup
- Performance-optimized queries (DISTINCT ON for latest heartbeats)
- Extensible health status model supports future monitoring enhancements

### Key Architectural Patterns

The work established several important patterns:

1. **Tiered Health Status**: HEALTHY/DEGRADED/UNHEALTHY/UNKNOWN provides nuanced monitoring without over-alerting
2. **Cleanup With Preservation**: CTE-based cleanup deletes old data while preserving latest records
3. **Multi-Path Query Optimization**: Different code paths for instance admin vs org admin vs region-filtered queries
4. **Intent + Entitlement**: Dual-layer authorization separates role-based access from feature enablement
5. **Edition-Aware Configuration**: Default dataplane group selection based on Airbyte edition
6. **Version Tracking**: Both control plane and dataplane versions recorded for upgrade coordination
7. **Strategic Indexing**: Composite indexes optimized for `DISTINCT ON` query patterns

### Infrastructure Capabilities

This foundation enables several critical capabilities:

1. **Hybrid Deployments**: Organizations can run workloads on Airbyte-hosted dataplanes or their own infrastructure
2. **Geographic Distribution**: Dataplanes can be deployed in customer-specific regions for data residency
3. **Failure Detection**: Automated health monitoring enables proactive incident response
4. **Capacity Planning**: Historical heartbeat data informs infrastructure scaling decisions
5. **Version Coordination**: Version tracking enables coordinated upgrades across control plane and dataplanes
6. **Secure Multi-Tenancy**: Organization boundaries are enforced throughout the dataplane lifecycle

This work represents a fundamental shift in Airbyte's architecture from a monolithic deployment to a distributed, multi-tenant platform supporting customer-controlled infrastructure while maintaining centralized management and monitoring.
