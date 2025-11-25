# Connection Auto-Disable System

## Overview
- **Time Period:** October - December 2024 (~3 months)
- **Lines of Code:** ~1,500 additions
- **Files Changed:** 25+ files
- **Key Technologies:** Kotlin, Micronaut Data, Event sourcing, Timeline events

One-paragraph summary: Built a comprehensive service layer for automatically disabling connections when billing issues occur, with proper timeline events, type-safe ID wrappers, and integration with Temporal workflows. The system enforces payment compliance while maintaining visibility for users through connection timeline events.

## Problem Statement
When organizations have billing issues (failed payments, expired subscriptions), their data syncs should be disabled to prevent unbilled usage. However, this needed to be done:
- Automatically without manual intervention
- With proper audit trails
- With clear user communication
- Atomically across all connections in an organization

## Solution Architecture
Designed a service layer with clear separation of concerns:

1. **ConnectionService** - Manages individual connection state changes
2. **OrganizationService** - Coordinates organization-wide operations
3. **Timeline Events** - Audit trail for every auto-disable action
4. **Type-Safe IDs** - Prevent UUID confusion between entities

Key design decisions:
- **Event Runner integration** - Notify Temporal of connection state changes
- **Transactional operations** - All-or-nothing disabling
- **Reason tracking** - Frontend shows why connections were disabled
- **Frontend localization** - User-friendly messages for each reason

## Implementation Details

### Type-Safe ID Wrappers

Prevent bugs from mixing up different UUIDs:

```kotlin
@JvmInline
value class ConnectionId(val value: UUID)

@JvmInline
value class OrganizationId(val value: UUID)

@JvmInline
value class WorkspaceId(val value: UUID)

// Compile error: can't pass OrganizationId where ConnectionId expected
fun disableConnection(connectionId: ConnectionId) // type safe!
```

### Connection Service Interface

```kotlin
interface ConnectionService {
  /**
   * Disable connections and record timeline events.
   * If disabled by an automatic process, the reason should be provided
   * so an appropriate timeline event can be recorded.
   *
   * @return the set of connection IDs that were disabled
   */
  fun disableConnections(
    connectionIds: Set<ConnectionId>,
    autoDisabledReason: ConnectionAutoDisabledReason?,
  ): Set<ConnectionId>
}

enum class ConnectionAutoDisabledReason {
  INVALID_PAYMENT_METHOD,  // Payment failed
  UNSUBSCRIBED,            // Subscription ended
  TOO_MANY_FAILURES,       // Too many sync failures
  SCHEMA_BREAKING_CHANGE,  // Source schema changed
}
```

### Connection Service Implementation

```kotlin
@Singleton
open class ConnectionServiceImpl(
  private val connectionRepository: ConnectionRepository,
  private val connectionTimelineEventHelper: ConnectionTimelineEventHelper,
  private val eventRunner: EventRunner,
) : ConnectionService {

  @Transactional("config")
  override fun disableConnections(
    connectionIds: Set<ConnectionId>,
    autoDisabledReason: ConnectionAutoDisabledReason?,
  ): Set<ConnectionId> {
    val disabledIds = connectionRepository.disableConnectionsById(
      connectionIds.map(ConnectionId::value)
    )

    disabledIds.forEach { connectionId ->
      // Log to connection timeline
      connectionTimelineEventHelper.logStatusChangedEventInConnectionTimeline(
        connectionId,
        ConnectionStatus.INACTIVE,
        autoDisabledReason?.name,
        autoDisabledReason != null,
      )

      // Notify Temporal to stop any running syncs
      eventRunner.update(connectionId)
    }

    return disabledIds.map(::ConnectionId).toSet()
  }
}
```

### Organization Service

Coordinates organization-wide operations:

```kotlin
interface OrganizationService {
  fun disableAllConnections(
    organizationId: OrganizationId,
    autoDisableReason: ConnectionAutoDisabledReason?,
  ): Set<ConnectionId>

  fun handlePaymentGracePeriodEnded(organizationId: OrganizationId)
  fun handleUncollectibleInvoice(organizationId: OrganizationId)
}

@Singleton
class OrganizationServiceImpl(
  private val connectionService: ConnectionService,
  private val connectionRepository: ConnectionRepository,
) : OrganizationService {

  @Transactional("config")
  override fun disableAllConnections(
    organizationId: OrganizationId,
    autoDisableReason: ConnectionAutoDisabledReason?,
  ): Set<ConnectionId> {
    // Get all active connections for the organization
    val connectionIds = connectionRepository
      .listConnectionIdsForOrganization(organizationId.value)
      .filter { it.status == ConnectionStatus.ACTIVE }
      .map { ConnectionId(it.id) }
      .toSet()

    if (connectionIds.isEmpty()) {
      logger.info { "No active connections to disable for org $organizationId" }
      return emptySet()
    }

    logger.info { "Disabling ${connectionIds.size} connections for org $organizationId" }
    return connectionService.disableConnections(connectionIds, autoDisableReason)
  }
}
```

### Frontend Localization

User-friendly messages for each disable reason:

```json
{
  "connectionAutoDisabledReason.INVALID_PAYMENT_METHOD":
    "Airbyte disabled this connection because your payment method is invalid.",
  "connectionAutoDisabledReason.UNSUBSCRIBED":
    "Airbyte disabled this connection because your subscription ended.",
  "connectionAutoDisabledReason.TOO_MANY_FAILURES":
    "Airbyte disabled this connection after too many consecutive sync failures.",
  "connectionAutoDisabledReason.SCHEMA_BREAKING_CHANGE":
    "Airbyte disabled this connection due to a breaking schema change."
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [6ecbdcab81](https://github.com/airbytehq/airbyte-platform/commit/6ecbdcab81) | Nov 22, 2024 | ConnectionService and OrganizationService | 16 files, 861 insertions |
| [a2e58f1b60](https://github.com/airbytehq/airbyte-platform/commit/a2e58f1b60) | Oct 4, 2024 | PaymentStatus in delinquency checks | 6 files, 86 insertions |
| [56d17e3e4f](https://github.com/airbytehq/airbyte-platform/commit/56d17e3e4f) | Dec 11, 2024 | Subscription status handling | 6 files, 191 insertions |

## Business Value

### User Impact
- **Clear Communication**: Users see exactly why connections were disabled
- **Timeline History**: Complete audit trail of status changes
- **Self-Service**: Users can re-enable after fixing payment issues

### Business Impact
- **Revenue Protection**: Non-paying customers can't run syncs
- **Automated Enforcement**: No manual intervention required
- **Reduced Support**: Clear messaging reduces "why is my sync disabled?" tickets

### Technical Impact
- **Type Safety**: Value classes prevent UUID mix-ups at compile time
- **Transactional**: All connections disabled atomically or none
- **Testable**: 432 lines of ConnectionService tests, 147 for OrganizationService

## Lessons Learned / Patterns Used

### Value Classes for Type Safety
Zero runtime overhead, compile-time type safety:
```kotlin
@JvmInline
value class ConnectionId(val value: UUID)

// At runtime: just a UUID
// At compile time: distinct type from OrganizationId
```

### Separation of Concerns
- **ConnectionService**: Individual connection operations
- **OrganizationService**: Organization-wide coordination
- **TimelineEventHelper**: Audit trail recording
- **EventRunner**: Temporal notification

### Transactional Boundaries
Using `@Transactional` ensures atomicity:
```kotlin
@Transactional("config")
override fun disableAllConnections(...) {
  // Either all connections are disabled, or none are
  // Timeline events are part of the same transaction
}
```
