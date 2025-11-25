# Dataplane Health Monitoring

## Overview
- **Time Period:** October - November 2025 (~6 weeks)
- **Lines of Code:** ~1,600 additions
- **Files Changed:** 27 files
- **Key Technologies:** Kotlin, Micronaut Data, PostgreSQL, Cron scheduling

One-paragraph summary: Built a comprehensive health monitoring infrastructure for self-hosted dataplanes, allowing the control plane to track when dataplanes are active, what versions they're running, and their overall health status. Includes heartbeat logging, tiered health status calculation, automated cleanup, and an internal API for health dashboards.

## Problem Statement
As Airbyte expanded to support customer-managed dataplanes (hybrid deployments), there was no way to monitor the health and status of these distributed components. Platform operators needed visibility into which dataplanes were healthy, degraded, or offline to ensure reliable data synchronization.

## Solution Architecture
Designed a four-component health monitoring system:
1. **Database Schema** - Heartbeat log table with optimized indexes
2. **Health Service** - Records heartbeats and calculates health status
3. **Cleanup Cron** - Automated retention management
4. **Health API** - Internal endpoint for health dashboards

Health status uses a tiered model:
- **HEALTHY**: Heartbeat within last 60 seconds
- **DEGRADED**: Heartbeat within last 5 minutes
- **UNHEALTHY**: No heartbeat in 5+ minutes
- **UNKNOWN**: No heartbeat ever recorded

## Implementation Details

### Database Schema with Optimized Indexes

```kotlin
private fun createDataplaneHeartbeatLogTable(ctx: DSLContext) {
  ctx.createTable(DATAPLANE_HEARTBEAT_LOG_TABLE)
    .columns(
      id,           // UUID primary key
      dataplaneId,  // FK to dataplane table
      controlPlaneVersion,  // Version tracking
      dataplaneVersion,
      createdAt     // Auto-populated timestamp
    )
    .constraints(
      DSL.primaryKey(id),
      DSL.foreignKey(dataplaneId)
        .references(DATAPLANE_TABLE, ID_FIELD_NAME)
        .onDeleteCascade(),
    ).execute()
}

// Composite index for health queries (DISTINCT ON pattern)
ctx.createIndex("idx_dataplane_heartbeat_log_dataplane_created_at")
  .on(table, dataplaneId, createdAt.desc())
  .execute()

// Index for cleanup queries
ctx.createIndex("idx_dataplane_heartbeat_log_created_at")
  .on(table, createdAt)
  .execute()
```

### Health Service with Version Tracking

```kotlin
@Singleton
class DataplaneHealthService(
  private val heartbeatLogRepository: DataplaneHeartbeatLogRepository,
) {
  companion object {
    val HEALTHY_THRESHOLD = Duration.ofSeconds(60)
    val DEGRADED_THRESHOLD = Duration.ofMinutes(5)
    val RETENTION_PERIOD = Duration.ofHours(24)
  }

  fun recordHeartbeat(
    dataplaneId: UUID,
    controlPlaneVersion: String?,
    dataplaneVersion: String?,
  ) {
    heartbeatLogRepository.save(
      DataplaneHeartbeatLog(
        dataplaneId = dataplaneId,
        controlPlaneVersion = controlPlaneVersion ?: "unknown",
        dataplaneVersion = dataplaneVersion ?: "unknown",
      )
    )
  }

  private fun calculateHealthStatus(
    heartbeat: DataplaneHeartbeatLog?,
    now: OffsetDateTime,
  ): HealthStatus {
    if (heartbeat?.createdAt == null) return HealthStatus.UNKNOWN

    val timeSince = Duration.between(heartbeat.createdAt, now)
    return when {
      timeSince <= HEALTHY_THRESHOLD -> HealthStatus.HEALTHY
      timeSince <= DEGRADED_THRESHOLD -> HealthStatus.DEGRADED
      else -> HealthStatus.UNHEALTHY
    }
  }
}
```

### Efficient Cleanup with CTE

Cleanup preserves the latest heartbeat for each dataplane:

```kotlin
@Query("""
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
""")
fun deleteOldHeartbeatsExceptLatest(cutoffTime: OffsetDateTime): Int
```

### Health API Endpoint

```kotlin
@Post("/health")
@RequiresIntent(Intent.ManageDataplanes)
@ExecuteOn(AirbyteTaskExecutors.IO)
fun listDataplaneHealth(
  @Body request: OrganizationIdRequestBody,
): DataplaneHealthListResponse {
  entitlementService.ensureEntitled(
    OrganizationId(request.organizationId),
    SelfManagedRegionsEntitlement
  )

  val dataplanes = dataplaneService.listDataplanes(
    dataplaneGroups.map { it.id }
  )

  val healthInfos = dataplaneHealthService.getDataplaneHealthInfos(
    dataplanes.map { it.id }
  )

  return DataplaneHealthListResponse()
    .dataplanes(healthInfos.map { toApiModel(it) })
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [19029247c8](https://github.com/airbytehq/airbyte-platform/commit/19029247c8) | Oct 30, 2025 | Heartbeat log table creation | Database foundation |
| [1591a4e44a](https://github.com/airbytehq/airbyte-platform/commit/1591a4e44a) | Nov 3, 2025 | Health service layer | Service implementation |
| [1bd22a13f0](https://github.com/airbytehq/airbyte-platform/commit/1bd22a13f0) | Nov 3, 2025 | Cleanup cron job | Automated maintenance |
| [c231086441](https://github.com/airbytehq/airbyte-platform/commit/c231086441) | Nov 5, 2025 | Health API endpoint | API exposure |

## Business Value

### User Impact
- **Visibility**: Platform operators see health status at a glance
- **Proactive Alerts**: Degraded status enables early intervention
- **Version Tracking**: Know which dataplanes need upgrades

### Business Impact
- **Hybrid Deployments**: Enables customer-managed dataplane architectures
- **SLA Compliance**: Health monitoring supports uptime guarantees
- **Enterprise Sales**: Required capability for self-managed deployments

### Technical Impact
- **Scalable Design**: DISTINCT ON queries and proper indexes handle thousands of dataplanes
- **Automated Maintenance**: 24-hour retention with hourly cleanup
- **Historical Context**: Recent heartbeats provide trending, not just point-in-time

## Lessons Learned / Patterns Used

### Tiered Health Status
Four-tier model provides nuanced monitoring without over-alerting:
- HEALTHY (60s): Normal operation
- DEGRADED (5min): Investigate but don't page
- UNHEALTHY (5min+): Likely issue, escalate
- UNKNOWN: New dataplane, no data yet

### DISTINCT ON for Latest Records
PostgreSQL's DISTINCT ON efficiently gets latest heartbeat per dataplane:
```sql
SELECT DISTINCT ON (dataplane_id) *
FROM dataplane_heartbeat_log
ORDER BY dataplane_id, created_at DESC
```

### Cleanup with Preservation
CTE-based deletion preserves latest records while cleaning up old data - ensures health status always available even if dataplane stops heartbeating.

### Index Strategy
Two indexes serve different query patterns:
1. Composite (dataplane_id, created_at DESC) - Health queries
2. Single (created_at) - Cleanup queries
