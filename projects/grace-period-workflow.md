# Billing Grace Period Workflow

## Overview
- **Time Period:** October 2024 (~3 weeks)
- **Lines of Code:** ~600 additions
- **Files Changed:** 15 files
- **Key Technologies:** Kotlin, Temporal, Micronaut, Stripe

One-paragraph summary: Implemented a Temporal-based workflow for managing payment grace periods, allowing organizations to continue operations temporarily while resolving billing issues. The system automatically transitions organizations from grace period to disabled state when the grace period expires, with comprehensive state machine validation and Segment analytics tracking.

## Problem Statement
When customers have payment issues (failed credit cards, expired payment methods), immediately disabling their syncs creates a poor user experience and increases churn. Customers need time to resolve billing issues without immediate service interruption, but without proper automation, grace periods could be forgotten or inconsistently applied.

## Solution Architecture
Designed a grace period management system with:
1. **State Machine** - PaymentStatus enum with validated transitions
2. **Temporal Workflow** - Scheduled execution when grace period expires
3. **API Endpoints** - Admin tools to manage grace periods
4. **Connection Integration** - Auto-disable connections at expiry

Key design decisions:
- **Temporal for scheduling** - Durable execution survives restarts
- **State validation** - Can only end grace period from GRACE_PERIOD status
- **Connection disabling** - Automatic enforcement when grace period ends
- **Analytics tracking** - Segment events for billing funnel monitoring

## Implementation Details

### Payment Status State Machine

Six distinct payment states with controlled transitions:

```kotlin
enum PaymentStatus {
  UNINITIALIZED,  // New org, no billing setup
  OKAY,           // Payment working
  GRACE_PERIOD,   // Payment failed, temporary access
  DISABLED,       // Grace period ended, syncs disabled
  LOCKED,         // Admin-locked account
  MANUAL          // Special handling required
}

// Valid transitions:
// OKAY -> GRACE_PERIOD (payment fails)
// GRACE_PERIOD -> OKAY (payment succeeds)
// GRACE_PERIOD -> DISABLED (grace period expires)
// DISABLED -> OKAY (payment succeeds)
```

### Grace Period API Endpoint

```kotlin
@Post("/{organizationId}/end_grace_period")
@ExecuteOn(AirbyteTaskExecutors.IO)
override fun endGracePeriod(
  @PathVariable("organizationId") organizationId: UUID,
) {
  val orgPaymentConfig = organizationPaymentConfigService
    .findByOrganizationId(organizationId)
    ?: throw ResourceNotFoundProblem(...)

  // State validation - only allowed from GRACE_PERIOD
  if (orgPaymentConfig.paymentStatus != PaymentStatus.GRACE_PERIOD) {
    throw StateConflictProblem(
      ProblemMessageData().message(
        "OrganizationPaymentConfig paymentStatus is " +
        "${orgPaymentConfig.paymentStatus}, " +
        "but expected ${PaymentStatus.GRACE_PERIOD}"
      )
    )
  }

  organizationPaymentConfigService.savePaymentConfig(
    orgPaymentConfig.apply {
      paymentStatus = PaymentStatus.DISABLED
      gracePeriodEndAt = null
    }
  )
}
```

### Organization Service Integration

```kotlin
@Transactional("config")
override fun handlePaymentGracePeriodEnded(organizationId: OrganizationId) {
  val orgPaymentConfig = organizationPaymentConfigRepository
    .findByOrganizationId(organizationId.value)
    ?: throw ResourceNotFoundProblem(...)

  if (orgPaymentConfig.paymentStatus != PaymentStatus.GRACE_PERIOD) {
    throw StateConflictProblem(...)
  }

  val previousStatus = orgPaymentConfig.paymentStatus
  orgPaymentConfig.paymentStatus = PaymentStatus.DISABLED
  organizationPaymentConfigRepository.savePaymentConfig(orgPaymentConfig)

  // Disable all connections in the organization
  disableAllConnections(
    organizationId,
    ConnectionAutoDisabledReason.INVALID_PAYMENT_METHOD
  )

  // Track for analytics
  billingTrackingHelper.trackGracePeriodEnded(
    organizationId.value,
    previousStatus,
    orgPaymentConfig.paymentStatus
  )
}
```

### Segment Analytics Integration

```kotlin
@Singleton
class BillingTrackingHelper(
  private val trackingClient: TrackingClient,
) {
  fun trackGracePeriodStarted(
    organizationId: UUID,
    paymentStatus: PaymentStatus,
    gracePeriodEndAt: OffsetDateTime?,
  ) {
    trackingClient.track(
      organizationId,
      "Grace Period Started",
      mapOf(
        "payment_status" to paymentStatus.name,
        "grace_period_end_at" to gracePeriodEndAt?.toString(),
      ),
    )
  }

  fun trackGracePeriodEnded(
    organizationId: UUID,
    previousPaymentStatus: PaymentStatus,
    newPaymentStatus: PaymentStatus,
  ) {
    trackingClient.track(
      organizationId,
      "Grace Period Ended",
      mapOf(
        "previous_payment_status" to previousPaymentStatus.name,
        "new_payment_status" to newPaymentStatus.name,
      ),
    )
  }
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| 0242eb6c1a | Oct 30, 2024 | Grace period API and Temporal config | 8 files, 91 insertions |
| 7be6c224be | Oct 31, 2024 | Unrevert after testing | 9 files, 94 insertions |
| 6ecbdcab81 | Nov 22, 2024 | Connection auto-disable integration | 16 files, 861 insertions |
| 73025db96c | Jan 7, 2025 | Segment analytics tracking | 3 files, 136 insertions |

## Business Value

### User Impact
- **Continued Access**: Grace period prevents immediate service disruption
- **Time to Resolve**: Customers can fix payment issues without data loss
- **Clear Timeline**: Defined grace period end date sets expectations

### Business Impact
- **Reduced Churn**: Grace periods prevent knee-jerk cancellations
- **Revenue Protection**: Many customers resolve issues within grace period
- **Analytics Visibility**: Track conversion from grace period to payment success

### Technical Impact
- **Durable Execution**: Temporal ensures grace period ends even after restarts
- **State Safety**: Validation prevents invalid state transitions
- **Extensible**: Pattern works for future time-based billing features

## Lessons Learned / Patterns Used

### State Machine Validation
Explicit state validation prevents invalid transitions:
```kotlin
if (orgPaymentConfig.paymentStatus != PaymentStatus.GRACE_PERIOD) {
  throw StateConflictProblem(...)
}
```
This catches bugs where code tries to end a grace period that doesn't exist.

### Temporal for Scheduled Actions
Temporal workflows are ideal for "do X at time Y" patterns:
- Survives server restarts
- Handles clock drift
- Provides visibility into pending actions
- Supports cancellation

### Gradual Feature Rollout
The connection disabling was initially commented out:
```kotlin
// TODO uncomment once subscription support is finalized
// disableAllConnections(organizationId, ...)
```
This enabled shipping the infrastructure before the full enforcement.
