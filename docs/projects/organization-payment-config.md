# Organization Payment Config

## Overview
- **Time Period:** August 2024 (~2 weeks)
- **Lines of Code:** ~600 additions
- **Files Changed:** 18 files
- **Key Technologies:** Kotlin, Micronaut Data, JOOQ, PostgreSQL

One-paragraph summary: Created the foundational OrganizationPaymentConfig table and data layer for organization-level billing, replacing the previous workspace-level billing model. Includes six payment states, usage category overrides, and proper audit timestamps.

## Problem Statement
The original billing system was workspace-level, requiring separate billing setup for each workspace. Enterprise customers needed organization-level billing where one payment method covers all workspaces.

## Solution Architecture
1. **Payment Status State Machine** - Six states for billing lifecycle
2. **Usage Category Overrides** - Mark orgs as free/internal
3. **Stripe Integration** - payment_provider_id links to Stripe customers
4. **Grace Period Support** - grace_period_end_at enables time-based recovery

## Implementation Details

### Database Migration

```java
public enum PaymentStatus implements EnumType {
  UNINITIALIZED("uninitialized"),
  OKAY("okay"),
  GRACE_PERIOD("grace_period"),
  DISABLED("disabled"),
  LOCKED("locked"),
  MANUAL("manual");
}

ctx.createTableIfNotExists("organization_payment_config")
  .column("organization_id", UUID.class)
  .column("payment_provider_id", VARCHAR(256))
  .column("payment_status", PaymentStatus.class)
  .column("grace_period_end_at", TIMESTAMP_WITH_TIMEZONE)
  .column("usage_category_override", UsageCategoryOverride.class)
  .column("created_at", TIMESTAMP_WITH_TIMEZONE)
  .column("updated_at", TIMESTAMP_WITH_TIMEZONE)
  .constraints(
    primaryKey("organization_id"),
    unique("payment_provider_id"),
    foreignKey("organization_id").references("organization", "id")
  )
  .execute();
```

### Micronaut Data Entity

```kotlin
@MappedEntity("organization_payment_config")
open class OrganizationPaymentConfig(
  @field:Id
  var organizationId: UUID? = null,
  var paymentProviderId: String? = null,
  var paymentStatus: PaymentStatus = PaymentStatus.UNINITIALIZED,
  var gracePeriodEndAt: OffsetDateTime? = null,
  var usageCategoryOverride: UsageCategoryOverride? = null,
  @DateCreated
  var createdAt: OffsetDateTime? = null,
  @DateUpdated
  var updatedAt: OffsetDateTime? = null,
)
```

### Repository

```kotlin
@JdbcRepository(dialect = Dialect.POSTGRES, dataSource = "config")
interface OrganizationPaymentConfigRepository :
    PageableRepository<OrganizationPaymentConfig, UUID> {
  fun findByPaymentProviderId(paymentProviderId: String): OrganizationPaymentConfig?
  fun findByOrganizationId(organizationId: UUID): OrganizationPaymentConfig?
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [e4f94d20c1](https://github.com/airbytehq/airbyte-platform/commit/e4f94d20c1) | Aug 23, 2024 | Create table migration | 5 files, 197 insertions |
| [e9be1e7095](https://github.com/airbytehq/airbyte-platform/commit/e9be1e7095) | Aug 23, 2024 | Micronaut Data layer | 13 files, 312 insertions |
| [1367d672d5](https://github.com/airbytehq/airbyte-platform/commit/1367d672d5) | Dec 9, 2024 | Remove legacy workspace billing | Cleanup |

## Business Value
- **Organization-Level Billing**: Single payment method for all workspaces
- **State Tracking**: Clear visibility into payment lifecycle
- **Grace Periods**: Time for customers to fix payment issues
- **Usage Overrides**: Support for free tier and internal usage
- **Audit Trail**: Automatic timestamps for compliance
