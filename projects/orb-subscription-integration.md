# Orb Subscription Integration

## Overview
- **Time Period:** December 2024 (~3 weeks)
- **Lines of Code:** ~500 additions
- **Files Changed:** 10 files
- **Key Technologies:** Kotlin, Orb API, Webhooks, Micronaut

One-paragraph summary: Implemented webhook processing for Orb subscription lifecycle events (subscription started, subscription ended), enabling Airbyte to respond to subscription changes in real-time. Includes idempotent processing, state validation, and gradual rollout capability for connection disabling.

## Problem Statement
Airbyte needed to track customer subscription status from Orb (the billing/metering platform) to:
- Know when customers become paying subscribers
- Know when subscriptions end
- Potentially disable connections when subscriptions end
- Provide accurate subscription status in the UI

## Solution Architecture
Designed a webhook-driven subscription sync system:

1. **Webhook Endpoint** - Receives Orb subscription events
2. **OrganizationService** - Handles subscription lifecycle
3. **State Machine** - Tracks subscription status transitions
4. **Idempotent Processing** - Safely handles duplicate webhooks

Key design decisions:
- **Separate from payment status** - Subscription status != payment status
- **Idempotent handlers** - Duplicate webhooks safely ignored
- **Gradual enforcement** - Connection disabling can be enabled later
- **State validation** - Can only end a subscription that's active

## Implementation Details

### Subscription Status State Machine

Three distinct subscription states:

```kotlin
enum class SubscriptionStatus {
  PRE_SUBSCRIPTION,  // New org, no subscription yet
  SUBSCRIBED,        // Active subscription
  UNSUBSCRIBED       // Subscription ended
}

// Valid transitions:
// PRE_SUBSCRIPTION -> SUBSCRIBED (first subscription)
// SUBSCRIBED -> UNSUBSCRIBED (subscription ends)
// UNSUBSCRIBED -> SUBSCRIBED (re-subscribe)
```

### Subscription Started Handler

Idempotent handling of subscription start:

```kotlin
override fun handleSubscriptionStarted(organizationId: OrganizationId) {
  val orgPaymentConfig = organizationPaymentConfigRepository
    .findByOrganizationId(organizationId.value)
    ?: throw ResourceNotFoundProblem(...)

  val currentSubscriptionStatus = orgPaymentConfig.subscriptionStatus

  // Idempotent: already subscribed = no-op
  if (currentSubscriptionStatus == SubscriptionStatus.SUBSCRIBED) {
    logger.warn {
      "Received subscription started event for org ${orgPaymentConfig.organizationId} " +
      "that is already subscribed. Ignoring..."
    }
    return
  }

  orgPaymentConfig.subscriptionStatus = SubscriptionStatus.SUBSCRIBED
  organizationPaymentConfigRepository.savePaymentConfig(orgPaymentConfig)

  logger.info {
    "Organization ${orgPaymentConfig.organizationId} successfully updated " +
    "from $currentSubscriptionStatus to ${orgPaymentConfig.subscriptionStatus}"
  }
}
```

### Subscription Ended Handler

State-validated subscription ending:

```kotlin
@Transactional("config")
override fun handleSubscriptionEnded(organizationId: OrganizationId) {
  val orgPaymentConfig = organizationPaymentConfigRepository
    .findByOrganizationId(organizationId.value)
    ?: throw ResourceNotFoundProblem(...)

  when (val currentStatus = orgPaymentConfig.subscriptionStatus) {
    // Invalid states for ending subscription
    SubscriptionStatus.UNSUBSCRIBED,
    SubscriptionStatus.PRE_SUBSCRIPTION -> {
      logger.warn {
        "Received subscription ended event for org $organizationId " +
        "that is not currently subscribed. Ignoring..."
      }
      return
    }

    // Valid transition
    SubscriptionStatus.SUBSCRIBED -> {
      orgPaymentConfig.subscriptionStatus = SubscriptionStatus.UNSUBSCRIBED
      organizationPaymentConfigRepository.savePaymentConfig(orgPaymentConfig)

      logger.info {
        "Organization $organizationId successfully updated from " +
        "$currentStatus to ${orgPaymentConfig.subscriptionStatus}"
      }

      // TODO: uncomment once subscription support is finalized
      // disableAllConnections(organizationId, ConnectionAutoDisabledReason.UNSUBSCRIBED)
      // logger.info { "Successfully disabled all syncs for unsubscribed org $organizationId" }
    }
  }
}
```

### Database Migration

Added subscription_status column:

```java
public enum SubscriptionStatus implements EnumType {
  PRE_SUBSCRIPTION("pre_subscription"),
  UNSUBSCRIBED("unsubscribed"),
  SUBSCRIBED("subscribed");
}

ctx.createType(SubscriptionStatus.NAME)
    .asEnum(...)
    .execute();

ctx.alterTable("organization_payment_config")
    .addColumnIfNotExists(
      DSL.field("subscription_status",
        SQLDataType.VARCHAR.asEnumDataType(SubscriptionStatus.class)
          .nullable(false)
          .defaultValue(SubscriptionStatus.PRE_SUBSCRIPTION))
    )
    .execute();
```

### Frontend Localization

```json
{
  "connectionAutoDisabledReason.UNSUBSCRIBED":
    "Airbyte disabled this connection because your Airbyte subscription ended."
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| 8d2a7a3be8 | Dec 2, 2024 | Add subscription_status column | 3 files, 86 insertions |
| 56d17e3e4f | Dec 11, 2024 | Subscription webhook handlers | 6 files, 191 insertions |
| 235018ee8d | Dec 17, 2024 | Consider subscription_status in sync validation | Integration |

## Business Value

### User Impact
- **Real-Time Status**: Subscription status updates immediately
- **Clear Messaging**: Users understand subscription state
- **Graceful Transitions**: Proper handling of subscription lifecycle

### Business Impact
- **Accurate Tracking**: Know exactly who is subscribed
- **Revenue Alignment**: Subscription status matches Orb data
- **Future Enforcement**: Infrastructure ready for subscription-based access control

### Technical Impact
- **Idempotent Processing**: Safe webhook retry handling
- **State Machine**: Clear subscription lifecycle
- **Separated Concerns**: Subscription status independent from payment status

## Lessons Learned / Patterns Used

### Idempotent Webhook Handling
Always check current state before processing:
```kotlin
if (currentSubscriptionStatus == SubscriptionStatus.SUBSCRIBED) {
  logger.warn { "Already subscribed. Ignoring duplicate webhook..." }
  return
}
```

### Payment vs Subscription Status
Two independent state machines:
- **PaymentStatus**: Can the customer pay? (OK, grace period, disabled)
- **SubscriptionStatus**: Is there an active subscription? (pre, subscribed, unsubscribed)

A customer can be SUBSCRIBED but in GRACE_PERIOD (subscription active, payment failing).

### Gradual Enforcement
Commenting out enforcement enables safe rollout:
```kotlin
// TODO: uncomment once subscription support is finalized
// disableAllConnections(...)
```
Infrastructure is ready, enforcement can be enabled with a single uncomment.
