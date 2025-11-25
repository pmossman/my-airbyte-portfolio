# Database Schema & Migrations - Deep Dive

## Overview

This document analyzes Parker Mossman's contributions to Database Schema & Migrations in the airbyte-platform repository. This work spans from January 2022 to October 2025, encompassing 29 commits that collectively built and evolved Airbyte's database infrastructure, supporting multi-tenant organizations, authentication systems, secret management, payment configurations, and operational monitoring.

**Period:** January 20, 2022 - October 30, 2025 (46 months)
**Total Commits:** 29
**Total Changes:** ~5,400 lines of code
**Key Technologies:** Flyway, JOOQ, Postgres, Kotlin, Micronaut Data

---

## Key Architectural Changes

### 1. Secret Storage Infrastructure

**Commit:** c4dad82dbe - March 3, 2025
**Impact:** 25 files changed, 1,248 insertions, 2 deletions

#### What Changed

This foundational commit introduced a comprehensive three-table architecture for managing external secret storage, enabling Airbyte to support multiple secret backends (AWS Secrets Manager, Google Secret Manager, Azure Key Vault, Vault) with proper scoping and reference tracking.

**Key files:**
- `airbyte-db/db-lib/src/main/java/io/airbyte/db/instance/configs/migrations/V1_1_1_011__AddSecretConfigStorageAndReferenceTables.java` (new, 303 lines)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/SecretStorageRepository.kt` (new)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/SecretConfigRepository.kt` (new)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/SecretReferenceRepository.kt` (new)

#### Implementation Details

The migration created three interconnected tables with sophisticated foreign key relationships:

**1. secret_storage table** - represents external secret storage configurations:

```java
private static void createSecretStorageTable(final DSLContext ctx) {
  final Field<UUID> id = DSL.field("id", SQLDataType.UUID.nullable(false));
  final Field<SecretStorageScopeType> scopeType =
      DSL.field("scope_type", SQLDataType.VARCHAR.asEnumDataType(SecretStorageScopeType.class).nullable(false));
  final Field<UUID> scopeId = DSL.field("scope_id", SQLDataType.UUID.nullable(false));
  final Field<String> descriptor = DSL.field("descriptor", SQLDataType.VARCHAR(256).nullable(false));
  final Field<SecretStorageType> storageType =
      DSL.field("storage_type", SQLDataType.VARCHAR.asEnumDataType(SecretStorageType.class).nullable(false));
  final Field<Boolean> configuredFromEnvironment =
      DSL.field("configured_from_environment", SQLDataType.BOOLEAN.defaultValue(false).nullable(false));
  final Field<Boolean> tombstone = DSL.field("tombstone", SQLDataType.BOOLEAN.defaultValue(false).nullable(false));
  final Field<UUID> createdBy = DSL.field("created_by", SQLDataType.UUID.nullable(false));
  final Field<UUID> updatedBy = DSL.field("updated_by", SQLDataType.UUID.nullable(false));

  ctx.createTableIfNotExists(SECRET_STORAGE_TABLE_NAME)
      .columns(id, scopeType, scopeId, descriptor, storageType, configuredFromEnvironment,
               tombstone, createdBy, updatedBy, createdAt, updatedAt)
      .constraints(
          primaryKey(id),
          unique(scopeId, scopeType, storageType, descriptor))
      .execute();
}
```

**2. secret_config table** - represents individual secrets stored in external storage:

```java
private static void createSecretConfigTable(final DSLContext ctx) {
  final Field<UUID> id = DSL.field("id", SQLDataType.UUID.nullable(false));
  final Field<UUID> secretStorageId = DSL.field("secret_storage_id", SQLDataType.UUID.nullable(false));
  final Field<String> descriptor = DSL.field("descriptor", SQLDataType.VARCHAR(256).nullable(false));
  final Field<String> externalCoordinate = DSL.field("external_coordinate", SQLDataType.VARCHAR(256).nullable(false));

  ctx.createTableIfNotExists(SECRET_CONFIG_TABLE_NAME)
      .columns(id, secretStorageId, descriptor, externalCoordinate, tombstone,
               createdBy, updatedBy, createdAt, updatedAt)
      .constraints(
          primaryKey(id),
          foreignKey(secretStorageId).references(SECRET_STORAGE_TABLE_NAME, "id"),
          unique(secretStorageId, descriptor),
          unique(secretStorageId, externalCoordinate))
      .execute();
}
```

**3. secret_reference table** - tracks where secrets are used in the system:

```java
private static void createSecretReferenceTable(final DSLContext ctx) {
  final Field<UUID> id = DSL.field("id", SQLDataType.UUID.nullable(false));
  final Field<UUID> secretConfigId = DSL.field("secret_config_id", SQLDataType.UUID.nullable(false));
  final Field<SecretReferenceScopeType> scopeType =
      DSL.field("scope_type", SQLDataType.VARCHAR.asEnumDataType(SecretReferenceScopeType.class).nullable(false));
  final Field<UUID> scopeId = DSL.field("scope_id", SQLDataType.UUID.nullable(false));
  final Field<String> hydrationPath = DSL.field("hydration_path", SQLDataType.CLOB.nullable(true));

  ctx.createTableIfNotExists(SECRET_REFERENCE_TABLE_NAME)
      .columns(id, secretConfigId, scopeType, scopeId, hydrationPath, createdAt, updatedAt)
      .constraints(
          primaryKey(id),
          foreignKey(secretConfigId).references(SECRET_CONFIG_TABLE_NAME, "id"))
      .execute();

  // Unique index ensuring only one secret_reference for a given scope and path
  // Coalesce null hydrationPaths to empty strings for uniqueness
  ctx.createUniqueIndexIfNotExists("secret_reference_scope_type_scope_id_hydration_path_idx")
      .on(DSL.table(SECRET_REFERENCE_TABLE_NAME),
          DSL.field("scope_type"),
          DSL.field("scope_id"),
          DSL.field("coalesce(hydration_path, '')"))
      .execute();
}
```

The migration also created three enum types:

- `SecretStorageType`: aws_secrets_manager, google_secret_manager, azure_key_vault, vault, local_testing
- `SecretStorageScopeType`: workspace, organization
- `SecretReferenceScopeType`: actor, secret_storage

#### Business Value

This architecture solved critical security and compliance requirements:

1. **Multi-Tenant Secret Isolation**: Organizations and workspaces can configure their own secret storage backends
2. **Bring Your Own Secrets**: Customers can use their existing secret management infrastructure
3. **Compliance**: Sensitive credentials never stored in Airbyte's database - only references
4. **Flexibility**: Support for multiple secret backends (AWS, GCP, Azure, Vault)
5. **Hydration Path**: The `hydration_path` field enables partial secret injection into configurations
6. **Audit Trail**: `createdBy` and `updatedBy` track who manages secrets

The unique constraint on `(scopeType, scopeId, coalesce(hydration_path, ''))` ensures that each location in a configuration can only reference one secret, preventing ambiguity during secret hydration.

#### Related Commits

- 2bca8c432b (Mar 14, 2025): Added `airbyte_managed` boolean to secret_config table
- Future work: Integration with actual secret storage backends

---

### 2. ActorDefinition Release Management

**Commit:** 5da184895f - February 4, 2022
**Impact:** 16 files changed, 404 insertions, 30 deletions

#### What Changed

Added `release_stage` and `release_date` columns to the `actor_definition` table, enabling lifecycle management for source and destination connectors. This was one of the earliest database migrations in the codebase.

**Key files:**
- `airbyte-db/db-lib/src/main/java/io/airbyte/db/instance/configs/migrations/V0_35_15_001__AddReleaseStageAndReleaseDateToActorDefinition.java` (new, 84 lines)
- `airbyte-config/config-persistence/src/main/java/io/airbyte/config/persistence/DatabaseConfigPersistence.java` (modified)

#### Implementation Details

The migration added two new columns to support connector lifecycle management:

```java
public class V0_35_15_001__AddReleaseStageAndReleaseDateToActorDefinition extends BaseJavaMigration {

  @Override
  public void migrate(final Context context) throws Exception {
    LOGGER.info("Running migration: {}", this.getClass().getSimpleName());
    final DSLContext ctx = DSL.using(context.getConnection());

    addReleaseDateAndReleaseStage(ctx);
  }

  static void addReleaseDateAndReleaseStage(final DSLContext ctx) {
    ctx.alterTable("actor_definition")
        .addColumnIfNotExists(DSL.field("release_stage", SQLDataType.VARCHAR(256).nullable(true)))
        .execute();

    ctx.alterTable("actor_definition")
        .addColumnIfNotExists(DSL.field("release_date", SQLDataType.DATE.nullable(true)))
        .execute();
  }
}
```

The `DatabaseConfigPersistence` class was updated to read/write these fields:

```java
// Reading actor definitions now includes release metadata
public StandardSourceDefinition getStandardSourceDefinition(final UUID sourceDefinitionId) {
  return database.query(ctx -> ctx
      .select(ACTOR_DEFINITION.asterisk())
      .from(ACTOR_DEFINITION)
      .where(ACTOR_DEFINITION.ID.eq(sourceDefinitionId))
      .fetch())
      .stream()
      .map(record -> {
        final StandardSourceDefinition def = Jsons.deserialize(
            record.get(ACTOR_DEFINITION.SPEC).data(),
            StandardSourceDefinition.class);
        // Populate new fields
        def.setReleaseStage(record.get(ACTOR_DEFINITION.RELEASE_STAGE));
        def.setReleaseDate(record.get(ACTOR_DEFINITION.RELEASE_DATE));
        return def;
      })
      .findFirst()
      .orElseThrow();
}
```

API updates exposed these fields:

```yaml
# config.yaml
SourceDefinitionRead:
  type: object
  properties:
    sourceDefinitionId:
      type: string
      format: uuid
    releaseStage:
      $ref: '#/components/schemas/ReleaseStage'
    releaseDate:
      type: string
      format: date

ReleaseStage:
  type: string
  enum:
    - alpha
    - beta
    - generally_available
    - custom
```

#### Business Value

This change enabled product-critical connector lifecycle management:

1. **Transparency**: Users can see connector maturity level before adoption
2. **Release Planning**: Track when connectors become generally available
3. **Support Policies**: Different SLAs based on release stage
4. **Catalog Filtering**: UI can hide alpha/beta connectors for conservative users
5. **Versioning Strategy**: Foundation for connector version rollouts

The migration handled null values gracefully, allowing existing connectors to continue functioning while new connectors could specify their release stage.

#### Related Commits

- 76da3ccf55 (Feb 4, 2022): Added tombstone field to actor_definitions table

---

### 3. Dataplane Heartbeat Logging

**Commit:** 19029247c8 - October 30, 2025
**Impact:** 8 files changed, 419 insertions, 1 deletion

#### What Changed

Created a comprehensive logging table for tracking dataplane health through heartbeat signals, including version tracking for both control plane and dataplane components.

**Key files:**
- `airbyte-db/db-lib/src/main/kotlin/io/airbyte/db/instance/configs/migrations/V2_1_0_012__CreateDataplaneHeartbeatLogTable.kt` (new, 103 lines)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/DataplaneHeartbeatLogRepository.kt` (new, 43 lines)
- `airbyte-data/src/test/kotlin/io/airbyte/data/repositories/DataplaneHeartbeatLogRepositoryTest.kt` (new, 234 lines)

#### Implementation Details

The Kotlin-based migration created a purpose-built table for operational monitoring:

```kotlin
class V2_1_0_012__CreateDataplaneHeartbeatLogTable : BaseJavaMigration() {

  companion object {
    private const val DATAPLANE_HEARTBEAT_LOG_TABLE = "dataplane_heartbeat_log"
    private const val DATAPLANE_TABLE = "dataplane"

    fun migrate(ctx: DSLContext) {
      createDataplaneHeartbeatLogTable(ctx)
      createQueryIndex(ctx)
      createCleanupIndex(ctx)
    }

    private fun createDataplaneHeartbeatLogTable(ctx: DSLContext) {
      val id = DSL.field(ID_FIELD_NAME, SQLDataType.UUID.nullable(false))
      val dataplaneId = DSL.field(DATAPLANE_ID_FIELD_NAME, SQLDataType.UUID.nullable(false))
      val controlPlaneVersion = DSL.field(CONTROL_PLANE_VERSION_FIELD_NAME,
                                          SQLDataType.VARCHAR(50).nullable(false))
      val dataplaneVersion = DSL.field(DATAPLANE_VERSION_FIELD_NAME,
                                       SQLDataType.VARCHAR(50).nullable(false))
      val createdAt = DSL.field(CREATED_AT_FIELD_NAME,
                               SQLDataType.TIMESTAMPWITHTIMEZONE.nullable(false)
                                 .defaultValue(DSL.currentOffsetDateTime()))

      ctx.createTable(DATAPLANE_HEARTBEAT_LOG_TABLE)
          .columns(id, dataplaneId, controlPlaneVersion, dataplaneVersion, createdAt)
          .constraints(
            DSL.primaryKey(id),
            DSL.foreignKey(dataplaneId).references(DATAPLANE_TABLE, ID_FIELD_NAME)
               .onDeleteCascade())
          .execute()
    }

    private fun createQueryIndex(ctx: DSLContext) {
      // Composite index for health status and history queries
      // created_at DESC matches DISTINCT ON query pattern for optimal performance
      ctx.createIndex("idx_dataplane_heartbeat_log_dataplane_created_at")
          .on(DSL.table(DATAPLANE_HEARTBEAT_LOG_TABLE),
              DSL.field(DATAPLANE_ID_FIELD_NAME),
              DSL.field(CREATED_AT_FIELD_NAME).desc())
          .execute()
    }

    private fun createCleanupIndex(ctx: DSLContext) {
      // Index for efficient deletion of old records by timestamp
      ctx.createIndex("idx_dataplane_heartbeat_log_created_at")
          .on(DATAPLANE_HEARTBEAT_LOG_TABLE, CREATED_AT_FIELD_NAME)
          .execute()
    }
  }
}
```

The repository interface provided efficient queries:

```kotlin
@JdbcRepository(dialect = Dialect.POSTGRES, dataSource = "config")
interface DataplaneHeartbeatLogRepository : PageableRepository<DataplaneHeartbeatLog, UUID> {

  @Query("""
    SELECT DISTINCT ON (dataplane_id) *
    FROM dataplane_heartbeat_log
    WHERE created_at >= :since
    ORDER BY dataplane_id, created_at DESC
  """)
  fun findLatestHeartbeatsSince(since: OffsetDateTime): List<DataplaneHeartbeatLog>

  fun deleteByCreatedAtBefore(cutoff: OffsetDateTime): Int
}
```

#### Business Value

This infrastructure enabled critical operational capabilities:

1. **Health Monitoring**: Track which dataplanes are actively reporting
2. **Version Tracking**: Monitor version skew between control plane and dataplanes
3. **Debugging**: Historical heartbeat data aids incident investigation
4. **Alerting**: Absence of heartbeats triggers automated alerts
5. **Cleanup**: Efficient deletion of old logs prevents table bloat

The dual-index strategy optimizes two distinct query patterns:
- **Query Index**: `(dataplane_id, created_at DESC)` for finding latest heartbeat per dataplane
- **Cleanup Index**: `(created_at)` for efficient deletion of old records

The `DISTINCT ON` query pattern combined with the descending `created_at` index enables O(n) retrieval of latest heartbeats across all dataplanes.

#### Related Commits

- Future work: Integration with monitoring dashboards and alerting systems

---

### 4. AuthRefreshToken Table

**Commit:** 041fa95bfb - July 18, 2024
**Impact:** 12 files changed, 411 insertions, 1 deletion

#### What Changed

Introduced a dedicated table for managing authentication refresh tokens, supporting secure token rotation and session management.

**Key files:**
- `airbyte-db/db-lib/src/main/java/io/airbyte/db/instance/configs/migrations/V0_57_4_010__AddAuthRefreshToken.java` (new, 60 lines)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/AuthRefreshTokenRepository.kt` (new, 13 lines)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/AuthRefreshTokenService.kt` (new, 26 lines)

#### Implementation Details

The migration created a table for storing refresh tokens with expiration tracking:

```java
public class V0_57_4_010__AddAuthRefreshToken extends BaseJavaMigration {

  @Override
  public void migrate(final Context context) throws Exception {
    LOGGER.info("Running migration: {}", this.getClass().getSimpleName());
    final DSLContext ctx = DSL.using(context.getConnection());

    createAuthRefreshTokenTable(ctx);
  }

  static void createAuthRefreshTokenTable(final DSLContext ctx) {
    final Field<UUID> id = DSL.field("id", SQLDataType.UUID.nullable(false));
    final Field<UUID> userId = DSL.field("user_id", SQLDataType.UUID.nullable(false));
    final Field<String> sessionId = DSL.field("session_id", SQLDataType.VARCHAR(256).nullable(false));
    final Field<String> value = DSL.field("value", SQLDataType.VARCHAR(2048).nullable(false));
    final Field<Boolean> revoked = DSL.field("revoked", SQLDataType.BOOLEAN.nullable(false)
                                            .defaultValue(false));
    final Field<OffsetDateTime> expiresAt = DSL.field("expires_at",
                                                      SQLDataType.TIMESTAMPWITHTIMEZONE.nullable(false));
    final Field<OffsetDateTime> createdAt = DSL.field("created_at",
                                                      SQLDataType.TIMESTAMPWITHTIMEZONE.nullable(false)
                                                        .defaultValue(currentOffsetDateTime()));

    ctx.createTableIfNotExists("auth_refresh_token")
        .columns(id, userId, sessionId, value, revoked, expiresAt, createdAt)
        .constraints(
            primaryKey(id),
            unique(value),
            foreignKey(userId).references("user", "id").onDeleteCascade())
        .execute();

    // Index for efficient lookup by user
    ctx.createIndexIfNotExists("auth_refresh_token_user_id_idx")
        .on("auth_refresh_token", "user_id")
        .execute();

    // Index for efficient expiration cleanup
    ctx.createIndexIfNotExists("auth_refresh_token_expires_at_idx")
        .on("auth_refresh_token", "expires_at")
        .execute();
  }
}
```

The repository provided token management operations:

```kotlin
@JdbcRepository(dialect = Dialect.POSTGRES, dataSource = "config")
interface AuthRefreshTokenRepository : CrudRepository<AuthRefreshToken, UUID> {

  fun findByValue(value: String): AuthRefreshToken?

  fun findByUserIdAndRevokedFalse(userId: UUID): List<AuthRefreshToken>

  fun deleteByExpiresAtBeforeAndRevokedTrue(cutoff: OffsetDateTime): Int
}
```

The service layer added business logic:

```kotlin
@Singleton
class AuthRefreshTokenServiceDataImpl(
  private val repository: AuthRefreshTokenRepository
) : AuthRefreshTokenService {

  override fun createRefreshToken(
    userId: UUID,
    sessionId: String,
    expiresAt: OffsetDateTime
  ): AuthRefreshToken {
    val token = AuthRefreshToken(
      userId = userId,
      sessionId = sessionId,
      value = generateSecureToken(),
      expiresAt = expiresAt
    )
    return repository.save(token)
  }

  override fun revokeToken(value: String) {
    repository.findByValue(value)?.let {
      it.revoked = true
      repository.update(it)
    }
  }
}
```

#### Business Value

This table enabled secure authentication flows:

1. **Token Rotation**: Refresh tokens separate from short-lived access tokens
2. **Session Management**: Track active sessions per user
3. **Revocation**: Explicit token revocation for logout/security events
4. **Expiration**: Automatic cleanup of expired tokens
5. **Security**: Unique constraint on token value prevents replay attacks

The dual-index strategy optimizes:
- User lookup for finding all tokens for a user
- Expiration-based cleanup for removing old/revoked tokens

#### Related Commits

- Integration with authentication middleware and token refresh endpoints

---

### 5. User Invitation Expiration and Tracking

**Commit:** 6927c3df7b - March 19, 2024
**Impact:** 14 files changed, 324 insertions, 65 deletions

#### What Changed

Enhanced the user invitation system with expiration dates and tracking of who accepted invitations, adding critical lifecycle management to the invitation workflow.

**Key files:**
- `airbyte-db/db-lib/src/main/java/io/airbyte/db/instance/configs/migrations/V0_50_33_005__AddUserInvitationAcceptedByAndExpiration.java` (new, 77 lines)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/impls/data/UserInvitationServiceDataImpl.kt` (modified)
- `airbyte-server/src/main/java/io/airbyte/server/handlers/UserInvitationHandler.java` (modified)

#### Implementation Details

The migration added two new columns to the `user_invitation` table:

```java
public class V0_50_33_005__AddUserInvitationAcceptedByAndExpiration extends BaseJavaMigration {

  @Override
  public void migrate(final Context context) throws Exception {
    LOGGER.info("Running migration: {}", this.getClass().getSimpleName());
    final DSLContext ctx = DSL.using(context.getConnection());

    addAcceptedByUserIdColumn(ctx);
    addExpiresAtColumn(ctx);
    addExpiredInvitationStatus(ctx);
  }

  static void addAcceptedByUserIdColumn(final DSLContext ctx) {
    ctx.alterTable("user_invitation")
        .addColumnIfNotExists(DSL.field("accepted_by_user_id", SQLDataType.UUID.nullable(true)))
        .execute();

    ctx.alterTable("user_invitation")
        .add(foreignKey(DSL.field("accepted_by_user_id", SQLDataType.UUID))
            .references("user", "id")
            .onDeleteSetNull())
        .execute();
  }

  static void addExpiresAtColumn(final DSLContext ctx) {
    ctx.alterTable("user_invitation")
        .addColumnIfNotExists(DSL.field("expires_at",
                                       SQLDataType.TIMESTAMPWITHTIMEZONE.nullable(true)))
        .execute();
  }

  static void addExpiredInvitationStatus(final DSLContext ctx) {
    ctx.alterType("invitation_status")
        .addValue("expired")
        .execute();
  }
}
```

The service implementation added expiration logic:

```kotlin
@Singleton
class UserInvitationServiceDataImpl(
  private val repository: UserInvitationRepository
) : UserInvitationService {

  override fun acceptUserInvitation(
    inviteCode: String,
    invitedUserId: UUID
  ): UserInvitation {
    val invitation = repository.findByInviteCode(inviteCode)
      ?: throw NotFoundException("Invitation not found")

    // Check expiration
    if (invitation.expiresAt != null &&
        invitation.expiresAt.isBefore(OffsetDateTime.now())) {
      invitation.status = InvitationStatus.EXPIRED
      repository.update(invitation)
      throw ConflictException("Invitation has expired")
    }

    // Check if already accepted
    if (invitation.status == InvitationStatus.ACCEPTED) {
      throw ConflictException("Invitation already accepted by user ${invitation.acceptedByUserId}")
    }

    invitation.status = InvitationStatus.ACCEPTED
    invitation.acceptedByUserId = invitedUserId
    return repository.update(invitation)
  }
}
```

The handler added expiration on creation:

```java
public class UserInvitationHandler {

  private static final Duration DEFAULT_INVITATION_EXPIRATION = Duration.ofDays(7);

  public UserInvitationRead inviteUser(UserInvitationCreateRequestBody request) {
    final UserInvitation invitation = new UserInvitation()
        .withInviteCode(generateInviteCode())
        .withInviterUserId(getCurrentUserId())
        .withInvitedEmail(request.getEmail())
        .withPermissionType(request.getPermissionType())
        .withStatus(InvitationStatus.PENDING)
        .withExpiresAt(OffsetDateTime.now().plus(DEFAULT_INVITATION_EXPIRATION));

    return toApi(userInvitationService.createUserInvitation(invitation));
  }
}
```

#### Business Value

These enhancements addressed critical security and UX gaps:

1. **Security**: Invitations expire, preventing indefinite open access
2. **Audit Trail**: Track who accepted each invitation
3. **User Experience**: Users see clear expiration status
4. **Cleanup**: Expired invitations can be automatically removed
5. **Conflict Detection**: Prevent duplicate acceptances

The `accepted_by_user_id` foreign key with `onDeleteSetNull()` preserves invitation history even if the accepting user is later deleted.

#### Related Commits

- 43cab5966f (Jan 25, 2024): Added declined status to invitation_status enum
- 9dd1b2cb46 (Jan 3, 2024): Migration replacing workspaceId/organizationId with scopeType/scopeId
- e536cd02d0 (Sep 13, 2023): Original user invitation flow database migration

---

### 6. Default User and Organization Records

**Commit:** d43b7795cf - August 22, 2023
**Impact:** 3 files changed, 352 insertions, 1 deletion

#### What Changed

Created a critical data migration that ensures every Airbyte instance has default User and Organization records with the all-zero UUID, establishing a consistent identity foundation.

**Key files:**
- `airbyte-db/db-lib/src/main/java/io/airbyte/db/instance/configs/migrations/V0_50_19_001__CreateDefaultOrganizationAndUser.java` (new, 166 lines)
- `airbyte-db/db-lib/src/test/java/io/airbyte/db/instance/configs/migrations/V0_50_19_001__CreateDefaultOrganizationAndUserTest.java` (new, 185 lines)

#### Implementation Details

This sophisticated migration handles multiple existing database states:

```java
public class V0_50_19_001__CreateDefaultOrganizationAndUser extends BaseJavaMigration {

  private static final UUID DEFAULT_USER_ID = UUID.fromString("00000000-0000-0000-0000-000000000000");
  private static final UUID DEFAULT_ORGANIZATION_ID = UUID.fromString("00000000-0000-0000-0000-000000000000");
  private static final String DEFAULT_USER_NAME = "Default User";
  private static final String DEFAULT_ORGANIZATION_NAME = "Default Organization";
  private static final String DEFAULT_EMAIL = "";

  static void createDefaultUserAndOrganization(final DSLContext ctx) {
    // Guard against duplicate migrations
    if (ctx.fetchExists(select().from(DSL.table(USER_TABLE))
        .where(ID_COLUMN.eq(DEFAULT_USER_ID)))) {
      LOGGER.info("Default user already exists. Skipping this migration.");
      return;
    }

    if (ctx.fetchExists(select().from(DSL.table(ORGANIZATION_TABLE))
        .where(ID_COLUMN.eq(DEFAULT_ORGANIZATION_ID)))) {
      LOGGER.info("Default organization already exists. Skipping this migration.");
      return;
    }

    // Find the default workspace if it exists
    final Optional<UUID> workspaceIdOptional = getDefaultWorkspaceIdOptional(ctx);
    final String email = workspaceIdOptional
        .flatMap(workspaceId -> getWorkspaceEmailOptional(ctx, workspaceId))
        .orElse(DEFAULT_EMAIL);
    final UUID defaultWorkspaceId = workspaceIdOptional.orElse(null);

    // Insert the default User record
    ctx.insertInto(DSL.table(USER_TABLE))
        .columns(ID_COLUMN, EMAIL_COLUMN, NAME_COLUMN, AUTH_USER_ID_COLUMN,
                 DEFAULT_WORKSPACE_ID_COLUMN, STATUS_COLUMN, AUTH_PROVIDER_COLUMN)
        .values(DEFAULT_USER_ID, email, DEFAULT_USER_NAME, DEFAULT_USER_ID.toString(),
                defaultWorkspaceId, DEFAULT_USER_STATUS, DEFAULT_AUTH_PROVIDER)
        .execute();

    // Insert the default Organization record
    ctx.insertInto(DSL.table(ORGANIZATION_TABLE))
        .columns(ID_COLUMN, EMAIL_COLUMN, NAME_COLUMN, USER_ID_COLUMN)
        .values(DEFAULT_ORGANIZATION_ID, email, DEFAULT_ORGANIZATION_NAME, DEFAULT_USER_ID)
        .execute();

    // Update the default workspace to point to the default organization
    if (workspaceIdOptional.isPresent()) {
      LOGGER.info("Updating default workspace with ID {} to belong to default organization",
                  workspaceIdOptional.get());
      ctx.update(DSL.table(WORKSPACE_TABLE))
          .set(ORGANIZATION_ID_COLUMN, DEFAULT_ORGANIZATION_ID)
          .where(ID_COLUMN.eq(workspaceIdOptional.get()))
          .execute();
    }

    // Grant the default user admin permissions on the default organization
    ctx.insertInto(DSL.table(PERMISSION_TABLE))
        .columns(ID_COLUMN, USER_ID_COLUMN, ORGANIZATION_ID_COLUMN, PERMISSION_TYPE_COLUMN)
        .values(UUID.randomUUID(), DEFAULT_USER_ID, DEFAULT_ORGANIZATION_ID,
                PermissionType.ORGANIZATION_ADMIN)
        .execute();
  }

  // Prefer workspace with initialSetupComplete=true, fall back to any workspace
  private static Optional<UUID> getDefaultWorkspaceIdOptional(final DSLContext ctx) {
    final Optional<UUID> setupWorkspaceIdOptional = ctx.select(ID_COLUMN)
        .from(WORKSPACE_TABLE)
        .where(INITIAL_SETUP_COMPLETE_COLUMN.eq(true))
        .and(TOMBSTONE_COLUMN.eq(false))
        .limit(1)
        .fetchOptional(ID_COLUMN);

    return setupWorkspaceIdOptional.isPresent() ? setupWorkspaceIdOptional
        : ctx.select(ID_COLUMN)
            .from(WORKSPACE_TABLE)
            .where(TOMBSTONE_COLUMN.eq(false))
            .limit(1)
            .fetchOptional(ID_COLUMN);
  }
}
```

Comprehensive test coverage validated multiple scenarios:

```java
@Test
void testMigrationBlankDatabase() {
  final DSLContext ctx = getDslContext();
  assertEquals(0, ctx.fetchCount(DSL.table("workspace")));

  V0_50_19_001__CreateDefaultOrganizationAndUser.createDefaultUserAndOrganization(ctx);

  var userRecord = ctx.selectFrom(DSL.table(USER_TABLE))
      .where(DSL.field("id").eq(EXPECTED_DEFAULT_USER_ID))
      .fetchOne();
  assertNotNull(userRecord);
  assertEquals("", userRecord.get(DSL.field("email", String.class)));
  assertEquals("Default User", userRecord.get(DSL.field("name", String.class)));
  assertNull(userRecord.get(DSL.field("default_workspace_id", UUID.class)));
}

@ParameterizedTest
@CsvSource({"true", "false"})
void testMigrationExistingWorkspace(final Boolean initialSetupComplete) {
  // Test handles both setup-complete and non-setup-complete workspaces
  // Validates proper email inheritance and workspace linking
}
```

#### Business Value

This migration was foundational for multi-tenancy:

1. **Predictable IDs**: All-zero UUID is easily identifiable in logs and code
2. **OSS Compatibility**: Single-workspace OSS deployments have consistent structure
3. **Migration Path**: Existing workspaces properly linked to default organization
4. **Idempotency**: Safe to run multiple times without corruption
5. **Email Inheritance**: Intelligently copies workspace email if available

The migration's sophistication in handling edge cases (no workspace, multiple workspaces, already-migrated databases) demonstrates production-grade database work.

#### Related Commits

- e7490ddf1c (May 17, 2023): Added User and Permission tables to OSS ConfigsDb
- dacfafff41 (Aug 24, 2023): InstanceConfiguration API with setup endpoint

---

### 7. Drop User Foreign Keys from Dataplane Tables

**Commit:** fb64ab67d2 - March 26, 2025
**Impact:** 28 files changed, 144 insertions, 204 deletions

#### What Changed

Removed user-related foreign key columns from dataplane infrastructure tables, simplifying the data model and removing unnecessary coupling between user management and dataplane lifecycle.

**Key files:**
- `airbyte-db/db-lib/src/main/java/io/airbyte/db/instance/configs/migrations/V1_1_1_023__DropUserForeignKeysFromDataplaneTables.java` (new, 63 lines)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/entities/Dataplane.kt` (modified)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/entities/DataplaneGroup.kt` (modified)

#### Implementation Details

The migration dropped user tracking columns from three dataplane tables:

```java
public class V1_1_1_023__DropUserForeignKeysFromDataplaneTables extends BaseJavaMigration {

  private static final Table<Record> DATAPLANE_TABLE = DSL.table("dataplane");
  private static final Table<Record> DATAPLANE_GROUP_TABLE = DSL.table("dataplane_group");
  private static final Table<Record> DATAPLANE_CLIENT_CREDENTIALS_TABLE =
      DSL.table("dataplane_client_credentials");

  @Override
  public void migrate(final Context context) throws Exception {
    LOGGER.info("Running migration: {}", this.getClass().getSimpleName());
    final DSLContext ctx = DSL.using(context.getConnection());

    dropDataplaneUpdatedBy(ctx);
    dropDataplaneGroupUpdatedBy(ctx);
    dropDataplaneClientCredentialsCreatedBy(ctx);
  }

  static void dropDataplaneUpdatedBy(final DSLContext ctx) {
    LOGGER.info("Dropping 'updated_by' column from Dataplane table");
    ctx.alterTable(DATAPLANE_TABLE)
        .dropColumnIfExists(DSL.field("updated_by", SQLDataType.UUID))
        .execute();
  }

  static void dropDataplaneGroupUpdatedBy(final DSLContext ctx) {
    LOGGER.info("Dropping 'updated_by' column from DataplaneGroup table");
    ctx.alterTable(DATAPLANE_GROUP_TABLE)
        .dropColumnIfExists(DSL.field("updated_by", SQLDataType.UUID))
        .execute();
  }

  static void dropDataplaneClientCredentialsCreatedBy(final DSLContext ctx) {
    LOGGER.info("Dropping 'created_by' column from DataplaneClientCredentials table");
    ctx.alterTable(DATAPLANE_CLIENT_CREDENTIALS_TABLE)
        .dropColumnIfExists(DSL.field("created_by", SQLDataType.UUID))
        .execute();
  }
}
```

Entity classes were simplified:

```kotlin
// Before
@MappedEntity("dataplane")
data class Dataplane(
  @field:Id var id: UUID? = null,
  var dataplaneGroupId: UUID,
  var name: String,
  var enabled: Boolean = true,
  var updatedBy: UUID,  // REMOVED
  var tombstone: Boolean = false,
  @DateCreated var createdAt: OffsetDateTime? = null,
  @DateUpdated var updatedAt: OffsetDateTime? = null
)

// After
@MappedEntity("dataplane")
data class Dataplane(
  @field:Id var id: UUID? = null,
  var dataplaneGroupId: UUID,
  var name: String,
  var enabled: Boolean = true,
  // updatedBy removed
  var tombstone: Boolean = false,
  @DateCreated var createdAt: OffsetDateTime? = null,
  @DateUpdated var updatedAt: OffsetDateTime? = null
)
```

Service and controller layers were updated to remove user ID parameters:

```kotlin
// Before
interface DataplaneService {
  fun createDataplane(
    dataplaneGroupId: UUID,
    name: String,
    updatedBy: UUID
  ): Dataplane
}

// After
interface DataplaneService {
  fun createDataplane(
    dataplaneGroupId: UUID,
    name: String
  ): Dataplane
}
```

#### Business Value

This cleanup provided several architectural benefits:

1. **Simplified Model**: Removed unnecessary coupling between user and infrastructure lifecycle
2. **Service Accounts**: Dataplane operations often automated, not user-initiated
3. **Cleaner APIs**: Controllers no longer need to track current user for dataplane operations
4. **Audit Alternative**: System-level audit logs provide better tracking than DB columns
5. **Code Reduction**: 204 deletions vs 144 insertions - net reduction in complexity

The migration used `dropColumnIfExists()` for safety, ensuring idempotency in case of re-runs.

#### Related Commits

- Future work: Implement comprehensive audit logging for infrastructure operations

---

### 8. User and Permission Tables for OSS

**Commit:** e7490ddf1c - May 17, 2023
**Impact:** 5 files changed, 309 insertions, 1 deletion

#### What Changed

Brought user and permission management tables from Airbyte Cloud to OSS, enabling authentication and authorization in all Airbyte deployments.

**Key files:**
- `airbyte-db/db-lib/src/main/java/io/airbyte/db/instance/configs/migrations/V0_44_4_001__AddUserAndPermissionTables.java` (new, 260 lines)

#### Implementation Details

This migration created the foundational tables for RBAC:

```java
public class V0_44_4_001__AddUserAndPermissionTables extends BaseJavaMigration {

  @Override
  public void migrate(final Context context) throws Exception {
    final DSLContext ctx = DSL.using(context.getConnection());

    createStatusEnumType(ctx);
    createAuthProviderEnumType(ctx);
    createUserTableAndIndexes(ctx);

    createPermissionTypeEnumType(ctx);
    createPermissionTableAndIndexes(ctx);
  }

  private static void createUserTableAndIndexes(final DSLContext ctx) {
    final Field<UUID> id = DSL.field("id", SQLDataType.UUID.nullable(false));
    final Field<String> name = DSL.field("name", SQLDataType.VARCHAR(256).nullable(false));
    final Field<String> authUserId = DSL.field("auth_user_id", SQLDataType.VARCHAR(256).nullable(false));
    final Field<AuthProvider> authProvider =
        DSL.field("auth_provider", SQLDataType.VARCHAR.asEnumDataType(AuthProvider.class).nullable(false));
    final Field<UUID> defaultWorkspaceId = DSL.field("default_workspace_id", SQLDataType.UUID.nullable(true));
    final Field<Status> status =
        DSL.field("status", SQLDataType.VARCHAR.asEnumDataType(Status.class).nullable(true));
    final Field<String> email = DSL.field("email", SQLDataType.VARCHAR(256).nullable(false));
    final Field<JSONB> uiMetadata = DSL.field("ui_metadata", SQLDataType.JSONB.nullable(true));

    ctx.createTableIfNotExists(USER_TABLE)
        .columns(id, name, authUserId, authProvider, defaultWorkspaceId,
                 status, email, uiMetadata, createdAt, updatedAt)
        .constraints(
            primaryKey(id),
            foreignKey(defaultWorkspaceId).references("workspace", "id").onDeleteSetNull())
        .execute();

    // Composite index for auth provider lookups
    ctx.createIndexIfNotExists("user_auth_provider_auth_user_id_idx")
        .on(USER_TABLE, "auth_provider", "auth_user_id")
        .execute();

    // Index for email lookups
    ctx.createIndexIfNotExists("user_email_idx")
        .on(USER_TABLE, "email")
        .execute();
  }

  private static void createPermissionTableAndIndexes(final DSLContext ctx) {
    final Field<UUID> id = DSL.field("id", SQLDataType.UUID.nullable(false));
    final Field<UUID> userId = DSL.field("user_id", SQLDataType.UUID.nullable(false));
    final Field<UUID> workspaceId = DSL.field("workspace_id", SQLDataType.UUID.nullable(true));
    final Field<PermissionType> permissionType =
        DSL.field("permission_type", SQLDataType.VARCHAR.asEnumDataType(PermissionType.class).nullable(false));

    ctx.createTableIfNotExists(PERMISSION_TABLE)
        .columns(id, userId, workspaceId, permissionType, createdAt, updatedAt)
        .constraints(
            primaryKey(id),
            foreignKey(userId).references(USER_TABLE, "id").onDeleteCascade(),
            foreignKey(workspaceId).references("workspace", "id").onDeleteCascade())
        .execute();

    // Index for finding user's permissions
    ctx.createIndexIfNotExists("permission_user_id_idx")
        .on(PERMISSION_TABLE, "user_id")
        .execute();

    // Index for finding permissions on a workspace
    ctx.createIndexIfNotExists("permission_workspace_id_idx")
        .on(PERMISSION_TABLE, "workspace_id")
        .execute();
  }

  public enum Status implements EnumType {
    INVITED("invited"),
    REGISTERED("registered"),
    DISABLED("disabled");
    // ...enum implementation
  }

  public enum AuthProvider implements EnumType {
    GOOGLE_IDENTITY_PLATFORM("google_identity_platform");
    // ...enum implementation
  }

  public enum PermissionType implements EnumType {
    INSTANCE_ADMIN("instance_admin"),
    WORKSPACE_OWNER("workspace_owner");
    // ...enum implementation (later expanded)
  }
}
```

#### Business Value

This migration was a watershed moment for Airbyte OSS:

1. **Unified Codebase**: OSS and Cloud now share authentication infrastructure
2. **Multi-User Support**: OSS deployments can have multiple users
3. **Permission Control**: Foundation for workspace-level access control
4. **Cloud Parity**: Features developed for Cloud now available in OSS
5. **Migration Path**: Existing OSS users seamlessly upgrade

The dual foreign key cascades ensure data integrity:
- Deleting a user cascades to their permissions
- Deleting a workspace cascades to workspace permissions
- But deleting a user's default workspace only sets it to null

#### Related Commits

- d43b7795cf (Aug 22, 2023): Migration to add default User and Organization records
- 1d635f6c67 (Nov 3, 2023): Added uniqueness constraint on permission table

---

### 9. User Invitation Flow Tables

**Commit:** e536cd02d0 - September 13, 2023
**Impact:** 6 files changed, 345 insertions, 1 deletion

#### What Changed

Created comprehensive infrastructure for user invitations, SSO configuration, and organization email domain management - three interconnected features supporting enterprise user onboarding.

**Key files:**
- `airbyte-db/db-lib/src/main/java/io/airbyte/db/instance/configs/migrations/V0_50_24_001__Add_UserInvitation_OrganizationEmailDomain_SsoConfig_Tables.java` (new, 241 lines)

#### Implementation Details

This migration created three tables with sophisticated constraints:

**1. user_invitation table:**

```java
private static void createUserInvitationTableAndIndexes(final DSLContext ctx) {
  final Field<UUID> id = DSL.field("id", SQLDataType.UUID.nullable(false));
  final Field<String> inviteCode = DSL.field("invite_code", SQLDataType.VARCHAR(256).nullable(false));
  final Field<UUID> inviterUserId = DSL.field("inviter_user_id", SQLDataType.UUID.nullable(false));
  final Field<String> invitedEmail = DSL.field("invited_email", SQLDataType.VARCHAR(256).nullable(false));
  final Field<UUID> workspaceId = DSL.field("workspace_id", SQLDataType.UUID.nullable(true));
  final Field<UUID> organizationId = DSL.field("organization_id", SQLDataType.UUID.nullable(true));
  final Field<PermissionType> permissionType =
      DSL.field("permission_type", SQLDataType.VARCHAR.asEnumDataType(PermissionType.class).nullable(false));
  final Field<InvitationStatus> status =
      DSL.field("status", SQLDataType.VARCHAR.asEnumDataType(InvitationStatus.class).nullable(false));

  ctx.createTableIfNotExists(USER_INVITATION_TABLE)
      .columns(id, inviteCode, inviterUserId, invitedEmail, workspaceId,
               organizationId, permissionType, status, createdAt, updatedAt)
      .constraints(
          primaryKey(id),
          unique(inviteCode),  // Invite codes must be unique
          foreignKey(inviterUserId).references(USER_TABLE, "id").onDeleteNoAction(),  // Preserve invitation history
          foreignKey(workspaceId).references(WORKSPACE_TABLE, "id").onDeleteCascade(),
          foreignKey(organizationId).references(ORGANIZATION_TABLE, "id").onDeleteCascade())
      .execute();

  // Multi-column indexes for efficient queries
  ctx.createIndexIfNotExists("user_invitation_invite_code_idx")
      .on(USER_INVITATION_TABLE, "invite_code").execute();
  ctx.createIndexIfNotExists("user_invitation_invited_email_idx")
      .on(USER_INVITATION_TABLE, "invited_email").execute();
  ctx.createIndexIfNotExists("user_invitation_workspace_id_idx")
      .on(USER_INVITATION_TABLE, "workspace_id").execute();
  ctx.createIndexIfNotExists("user_invitation_organization_id_idx")
      .on(USER_INVITATION_TABLE, "organization_id").execute();
}
```

**2. organization_email_domain table:**

```java
private static void createOrganizationEmailDomainTableAndIndexes(final DSLContext ctx) {
  final Field<UUID> id = DSL.field("id", SQLDataType.UUID.nullable(false));
  final Field<UUID> organizationId = DSL.field("organization_id", SQLDataType.UUID.nullable(false));
  final Field<String> emailDomain = DSL.field("email_domain", SQLDataType.VARCHAR(256).nullable(false));

  ctx.createTableIfNotExists(ORGANIZATION_EMAIL_DOMAIN_TABLE)
      .columns(id, organizationId, emailDomain, createdAt)
      .constraints(
          primaryKey(id),
          unique(emailDomain),  // Domain can only belong to one organization
          foreignKey(organizationId).references(ORGANIZATION_TABLE, "id").onDeleteCascade())
      .execute();

  ctx.createIndexIfNotExists("organization_email_domain_email_domain_idx")
      .on("organization_email_domain", "email_domain").execute();
  ctx.createIndexIfNotExists("organization_email_domain_organization_id_idx")
      .on("organization_email_domain", "organization_id").execute();
}
```

**3. sso_config table:**

```java
private static void createSsoConfigTableAndIndexes(final DSLContext ctx) {
  final Field<UUID> id = DSL.field("id", SQLDataType.UUID.nullable(false));
  final Field<UUID> organizationId = DSL.field("organization_id", SQLDataType.UUID.nullable(false));
  final Field<String> keycloakRealm = DSL.field("keycloak_realm", SQLDataType.VARCHAR(256).nullable(false));

  ctx.createTableIfNotExists(SSO_CONFIG_TABLE)
      .columns(id, organizationId, keycloakRealm, createdAt, updatedAt)
      .constraints(
          primaryKey(id),
          unique(organizationId),     // One SSO config per organization
          unique(keycloakRealm),      // Keycloak realms globally unique
          foreignKey(organizationId).references(ORGANIZATION_TABLE, "id").onDeleteCascade())
      .execute();

  ctx.createIndexIfNotExists("sso_config_organization_id_idx")
      .on(SSO_CONFIG_TABLE, "organization_id").execute();
  ctx.createIndexIfNotExists("sso_config_keycloak_realm_idx")
      .on(SSO_CONFIG_TABLE, "keycloak_realm").execute();
}
```

**InvitationStatus enum:**

```java
public enum InvitationStatus implements EnumType {
  PENDING("pending"),
  ACCEPTED("accepted"),
  CANCELLED("cancelled");
  // Later extended with DECLINED and EXPIRED
}
```

#### Business Value

This comprehensive migration enabled enterprise-grade user management:

1. **Flexible Invitations**: Support both workspace and organization-level invites
2. **Email Domain Claiming**: Organizations can claim domains for auto-join
3. **SSO Integration**: Foundation for Keycloak-based single sign-on
4. **Security**: Unique invite codes, proper foreign key constraints
5. **Audit Trail**: Track who invited whom, when accepted

The foreign key strategy is particularly sophisticated:
- `inviterUserId` uses `onDeleteNoAction()` to preserve invitation history
- `workspaceId`/`organizationId` use `onDeleteCascade()` for cleanup
- Email domain unique constraint prevents domain conflicts

#### Related Commits

- 6927c3df7b (Mar 19, 2024): Added expiration and accepted_by_user_id tracking
- 43cab5966f (Jan 25, 2024): Added declined status to invitation_status enum
- 9dd1b2cb46 (Jan 3, 2024): Replaced workspaceId/organizationId with scopeType/scopeId

---

### 10. Permission Table Uniqueness Constraints

**Commit:** 1d635f6c67 - November 3, 2023
**Impact:** 5 files changed, 275 insertions, 10 deletions

#### What Changed

Added critical uniqueness constraints to the permission table, preventing duplicate permission records for the same user/resource combination.

**Key files:**
- `airbyte-db/db-lib/src/main/java/io/airbyte/db/instance/configs/migrations/V0_50_33_002__AlterPermissionTableToPreventMultiplePermissionsForSameResource.java` (new, 65 lines)
- `airbyte-db/db-lib/src/test/java/io/airbyte/db/instance/configs/migrations/V0_50_33_002__AlterPermissionTableToPreventMultiplePermissionsForSameResourceTest.java` (new, 203 lines)

#### Implementation Details

The migration added composite unique constraints preventing duplicate permissions:

```java
public class V0_50_33_002__AlterPermissionTableToPreventMultiplePermissionsForSameResource
    extends BaseJavaMigration {

  @Override
  public void migrate(final Context context) throws Exception {
    LOGGER.info("Running migration: {}", this.getClass().getSimpleName());
    final DSLContext ctx = DSL.using(context.getConnection());

    addUniqueConstraints(ctx);
  }

  static void addUniqueConstraints(final DSLContext ctx) {
    // Prevent duplicate workspace permissions
    ctx.alterTable("permission")
        .add(DSL.constraint("permission_user_id_workspace_id_key")
            .unique(DSL.field("user_id"), DSL.field("workspace_id")))
        .execute();

    // Prevent duplicate organization permissions
    ctx.alterTable("permission")
        .add(DSL.constraint("permission_user_id_organization_id_key")
            .unique(DSL.field("user_id"), DSL.field("organization_id")))
        .execute();
  }
}
```

Updated schema dump shows the constraints:

```sql
create table "public"."permission" (
  "id" uuid not null,
  "user_id" uuid not null,
  "workspace_id" uuid,
  "organization_id" uuid,
  "permission_type" "public"."permission_type" not null,
  "created_at" timestamp(6) with time zone not null default current_timestamp,
  "updated_at" timestamp(6) with time zone not null default current_timestamp,
  constraint "permission_pkey" primary key ("id"),
  constraint "permission_user_id_workspace_id_key" unique ("user_id", "workspace_id"),
  constraint "permission_user_id_organization_id_key" unique ("user_id", "organization_id")
);
```

Comprehensive test coverage validated the constraints:

```java
@Test
void testUniqueConstraintPreventsMultipleWorkspacePermissions() {
  final DSLContext ctx = getDslContext();
  final UUID userId = UUID.randomUUID();
  final UUID workspaceId = UUID.randomUUID();

  // First permission succeeds
  insertPermission(ctx, userId, workspaceId, null, PermissionType.WORKSPACE_ADMIN);

  // Second permission for same user/workspace fails
  assertThrows(DataIntegrityViolationException.class, () ->
      insertPermission(ctx, userId, workspaceId, null, PermissionType.WORKSPACE_READER)
  );
}

@Test
void testUniqueConstraintPreventsMultipleOrganizationPermissions() {
  final DSLContext ctx = getDslContext();
  final UUID userId = UUID.randomUUID();
  final UUID organizationId = UUID.randomUUID();

  // First permission succeeds
  insertPermission(ctx, userId, null, organizationId, PermissionType.ORGANIZATION_ADMIN);

  // Second permission for same user/organization fails
  assertThrows(DataIntegrityViolationException.class, () ->
      insertPermission(ctx, userId, null, organizationId, PermissionType.ORGANIZATION_READER)
  );
}

@Test
void testDifferentUsersCanHavePermissionsOnSameResource() {
  // Test passes - different users can have permissions on same workspace
  final UUID workspaceId = UUID.randomUUID();
  insertPermission(ctx, UUID.randomUUID(), workspaceId, null, PermissionType.WORKSPACE_ADMIN);
  insertPermission(ctx, UUID.randomUUID(), workspaceId, null, PermissionType.WORKSPACE_READER);
}
```

#### Business Value

This constraint was critical for data integrity:

1. **Prevents Duplicates**: No conflicting permission records for same user/resource
2. **Simplifies Queries**: Application code can assume at most one permission per user/resource
3. **Permission Updates**: Updating permissions requires UPDATE not INSERT (cleaner semantics)
4. **Database Enforcement**: Constraint at DB level, not just application logic
5. **Error Prevention**: Catches bugs where code tries to create duplicate permissions

The dual constraints (workspace and organization) handle the two scoping levels independently while still allowing users to have both workspace-level and organization-level permissions.

#### Related Commits

- bd41ede717 (Nov 1, 2023): Dropped resource_scope enum (simplifying permission model)

---

### 11. OrganizationPaymentConfig Table

**Commit:** e4f94d20c1 - August 23, 2024
**Impact:** 5 files changed, 197 insertions, 7 deletions

#### What Changed

Created a table for managing organization-level payment configuration, including payment status, grace periods, and usage category overrides for billing.

**Key files:**
- `airbyte-db/db-lib/src/main/java/io/airbyte/db/instance/configs/migrations/V0_57_4_017__CreateOrganizationPaymentConfigTable.java` (new, 172 lines)

#### Implementation Details

The migration created enums and a table for payment configuration:

```java
public class V0_57_4_017__CreateOrganizationPaymentConfigTable extends BaseJavaMigration {

  @Override
  public void migrate(final Context context) throws Exception {
    final DSLContext ctx = DSL.using(context.getConnection());

    createPaymentStatusEnumType(ctx);
    createUsageCategoryOverrideEnumType(ctx);
    createOrganizationPaymentConfigTableAndIndexes(ctx);
  }

  static void createOrganizationPaymentConfigTableAndIndexes(final DSLContext ctx) {
    final Field<UUID> organizationId = DSL.field("organization_id", SQLDataType.UUID.nullable(false));
    final Field<String> paymentProviderId = DSL.field("payment_provider_id",
                                                      SQLDataType.VARCHAR(256).nullable(true));
    final Field<PaymentStatus> paymentStatus = DSL.field("payment_status",
        SQLDataType.VARCHAR.asEnumDataType(PaymentStatus.class).nullable(false)
          .defaultValue(PaymentStatus.UNINITIALIZED));
    final Field<OffsetDateTime> gracePeriodEndAt = DSL.field("grace_period_end_at",
                                                             SQLDataType.TIMESTAMPWITHTIMEZONE.nullable(true));
    final Field<UsageCategoryOverride> usageCategoryOverride =
        DSL.field("usage_category_override",
                 SQLDataType.VARCHAR.asEnumDataType(UsageCategoryOverride.class).nullable(true));

    ctx.createTableIfNotExists(ORGANIZATION_PAYMENT_CONFIG_TABLE)
        .column(organizationId)
        .column(paymentProviderId)
        .column(paymentStatus)
        .column(gracePeriodEndAt)
        .column(usageCategoryOverride)
        .column(createdAt)
        .column(updatedAt)
        .constraints(
            primaryKey(organizationId),  // One config per organization
            unique(paymentProviderId),   // Provider IDs globally unique
            foreignKey(organizationId).references("organization", "id").onDeleteCascade())
        .execute();

    // Index for provider lookups
    ctx.createIndexIfNotExists("organization_payment_config_payment_provider_id_idx")
        .on(ORGANIZATION_PAYMENT_CONFIG_TABLE, "payment_provider_id")
        .execute();

    // Index for grace period expiration queries
    ctx.createIndexIfNotExists("organization_payment_config_grace_period_end_at_idx")
        .on(ORGANIZATION_PAYMENT_CONFIG_TABLE, "grace_period_end_at")
        .execute();

    // Index for payment status queries
    ctx.createIndexIfNotExists("organization_payment_config_payment_status_idx")
        .on(ORGANIZATION_PAYMENT_CONFIG_TABLE, "payment_status")
        .execute();
  }

  public enum PaymentStatus implements EnumType {
    UNINITIALIZED("uninitialized"),  // No payment method configured
    OKAY("okay"),                     // Payment current
    GRACE_PERIOD("grace_period"),    // Payment failed, in grace period
    DISABLED("disabled"),             // Grace period expired, services disabled
    LOCKED("locked"),                 // Account locked for non-payment
    MANUAL("manual");                 // Manual billing arrangement
    // ...enum implementation
  }

  public enum UsageCategoryOverride implements EnumType {
    FREE("free"),       // Free tier override
    INTERNAL("internal"); // Internal Airbyte use
    // ...enum implementation
  }
}
```

#### Business Value

This table enabled sophisticated billing workflows:

1. **Payment Lifecycle**: Track progression from okay → grace_period → disabled → locked
2. **Grace Periods**: Configurable grace period before disabling services
3. **Provider Integration**: Link to external payment provider (Stripe, Orb, etc.)
4. **Usage Overrides**: Mark organizations as free or internal
5. **Automated Workflows**: Indexes enable efficient queries for grace period expiration

The three indexes support distinct operational patterns:
- Provider ID lookups for webhook processing
- Grace period queries for automated enforcement
- Payment status filtering for reporting/monitoring

#### Related Commits

- 8d2a7a3be8 (Dec 2, 2024): Added subscription_status column to organization_payment_config
- 1367d672d5 (Dec 9, 2024): Dropped user_payment_account tables (consolidating on organization-level billing)

---

### 12. Jobs Table Updated_At Index

**Commit:** 070fff8f1f - September 23, 2024
**Impact:** 3 files changed, 37 insertions, 1 deletion

#### What Changed

Added a critical performance index on the `updated_at` column of the jobs table, enabling efficient queries for recently updated jobs. Used `CREATE INDEX CONCURRENTLY` to avoid locking.

**Key files:**
- `airbyte-db/db-lib/src/main/java/io/airbyte/db/instance/jobs/migrations/V0_64_7_002__CreateJobsUpdatedAtIndex.java` (new, 35 lines)

#### Implementation Details

This migration demonstrated production-grade database operations:

```java
public class V0_64_7_002__CreateJobsUpdatedAtIndex extends BaseJavaMigration {

  private static final String JOBS_UPDATED_AT_IDX = "jobs_updated_at_idx";

  @Override
  public void migrate(final Context context) throws Exception {
    LOGGER.info("Running migration: {}", this.getClass().getSimpleName());
    final DSLContext ctx = DSL.using(context.getConnection());

    // CONCURRENTLY prevents table locking, critical for production
    ctx.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS " + JOBS_UPDATED_AT_IDX +
              " ON jobs(updated_at)")
        .execute();
  }

  // Disable transaction wrapping for concurrent index creation
  @Override
  public boolean canExecuteInTransaction() {
    return false;
  }
}
```

Updated schema dump:

```sql
-- Existing indexes
create index "jobs_config_type_idx" on "public"."jobs"("config_type" asc);
create index "jobs_scope_idx" on "public"."jobs"("scope" asc);
create index "jobs_status_idx" on "public"."jobs"("status" asc);

-- New index
create index "jobs_updated_at_idx" on "public"."jobs"("updated_at" asc);

-- Composite indexes
create index "scope_created_at_idx" on "public"."jobs"("scope" asc, "created_at" desc);
create index "scope_non_terminal_status_idx" on "public"."jobs"("scope" asc, "status" asc)
  where ((status <> ALL (ARRAY['failed'::job_status, 'succeeded'::job_status, 'cancelled'::job_status])));
```

#### Business Value

This index solved critical production performance issues:

1. **Recent Jobs Queries**: Efficient retrieval of recently updated jobs
2. **Monitoring**: Dashboard queries for active job status
3. **Cleanup**: Finding old jobs for archival/deletion
4. **Zero Downtime**: CONCURRENTLY prevents locking during index creation
5. **Production Safe**: `canExecuteInTransaction() = false` prevents deadlocks

The `CREATE INDEX CONCURRENTLY` approach is essential for large production tables where a regular index creation would lock writes for hours.

#### Related Commits

- 4c83ac1f16 (Jan 20, 2022): Added failureSummary column to Attempts table

---

## Technical Evolution

The commits reveal a clear evolution in database management practices and architectural maturity:

### 1. Early Schema Foundations (2022)

The earliest work focused on connector lifecycle management:

- **February 2022**: ActorDefinition release_stage and release_date columns (5da184895f)
- **February 2022**: ActorDefinition tombstone field (76da3ccf55)
- **January 2022**: Attempts table failureSummary column (4c83ac1f16)

This phase established patterns for managing connector metadata and job tracking.

### 2. Multi-Tenant User Management (2023)

2023 saw the introduction of comprehensive authentication and authorization:

- **May 2023**: User and Permission tables to OSS (e7490ddf1c)
- **August 2023**: Default User and Organization migration (d43b7795cf)
- **September 2023**: User invitation, SSO, and organization email domain tables (e536cd02d0)
- **November 2023**: Permission table uniqueness constraints (1d635f6c67)

This phase brought Cloud-level multi-tenancy to OSS deployments.

### 3. Payment and Billing Infrastructure (2024)

2024 focused on commercial capabilities:

- **July 2024**: AuthRefreshToken table (041fa95bfb)
- **August 2024**: OrganizationPaymentConfig table (e4f94d20c1)
- **September 2024**: Jobs updated_at index (070fff8f1f)
- **December 2024**: Added subscription_status column (8d2a7a3be8)
- **December 2024**: Dropped user_payment_account tables (1367d672d5)

This phase built comprehensive billing infrastructure and consolidated on organization-level payment.

### 4. Security and Secrets Management (2025)

2025 brought enterprise-grade security features:

- **March 2025**: Secret storage, config, and reference tables (c4dad82dbe)
- **March 2025**: Airbyte_managed boolean for secrets (2bca8c432b)
- **March 2025**: Dropped user FKs from dataplane tables (fb64ab67d2)
- **October 2025**: Dataplane heartbeat logging (19029247c8)

This phase enabled bring-your-own-secrets and improved operational monitoring.

### Technology and Patterns Evolution

The work shows clear patterns in database migration practices:

**Migration Safety:**
- Use of `IF NOT EXISTS` clauses for idempotency
- `dropColumnIfExists()` for safe cleanup migrations
- `CREATE INDEX CONCURRENTLY` for zero-downtime index creation
- `canExecuteInTransaction() = false` for operations requiring no transaction

**Testing Discipline:**
- Comprehensive test coverage (234-line test for heartbeat repository)
- Parameterized tests for multiple scenarios
- Test isolation with proper setup/teardown

**Foreign Key Strategy:**
- `onDeleteCascade()` for dependent data (workspace permissions)
- `onDeleteSetNull()` for optional references (user's default workspace)
- `onDeleteNoAction()` for audit trail preservation (invitation inviter)

**Indexing Strategy:**
- Single-column indexes for primary lookups (email, invite_code)
- Composite indexes for query patterns (dataplane_id, created_at DESC)
- Partial indexes for filtered queries (non-terminal job statuses)

**Data Integrity:**
- Unique constraints preventing duplicates (invite codes, email domains)
- Composite unique constraints (user_id, workspace_id)
- NOT NULL with defaults for required fields
- Enum types for controlled vocabularies

---

## Impact Summary

Parker's contributions to Database Schema & Migrations represent the foundational infrastructure enabling Airbyte's evolution from an OSS data integration tool to an enterprise-grade, multi-tenant platform with comprehensive security, billing, and operational monitoring.

### Quantitative Impact

- **29 commits** over 46 months (Jan 2022 - Oct 2025)
- **~5,400 lines** of migration code and tests
- **Major schema additions:**
  - User and Permission tables (multi-tenant RBAC)
  - User invitation workflow (3 tables)
  - Secret management infrastructure (3 tables)
  - Payment configuration tables (2 tables)
  - Operational monitoring (heartbeat logging)
  - Authentication (refresh tokens)

### Qualitative Impact

**For Platform Reliability:**
- Zero-downtime migrations using `CREATE INDEX CONCURRENTLY`
- Idempotent migrations safe to re-run
- Comprehensive foreign key constraints ensuring referential integrity
- Strategic indexes optimizing critical query patterns

**For Security:**
- Secret storage infrastructure supporting external secret backends
- Refresh token management for secure authentication
- Audit trail preservation through careful foreign key design
- Unique constraints preventing duplicate permissions

**For Multi-Tenancy:**
- Organization and workspace scoping throughout
- Permission inheritance from organization to workspace level
- Email domain claiming for organization auto-join
- SSO configuration per organization

**For Billing:**
- Organization-level payment configuration
- Payment lifecycle tracking (okay → grace_period → disabled → locked)
- Usage category overrides for free/internal accounts
- Grace period automation through indexed queries

**For Operations:**
- Dataplane heartbeat logging for health monitoring
- Version tracking for control plane and dataplane components
- Jobs updated_at index for monitoring active jobs
- Efficient cleanup of old data through timestamp indexes

### Key Architectural Patterns

The migrations established several critical patterns:

1. **Scope Abstraction**: Generic scopeType/scopeId pattern used across invitations, secrets, and storage
2. **Soft Deletes**: Tombstone columns preserve data while hiding it from queries
3. **Audit Metadata**: createdBy/updatedBy, createdAt/updatedAt on all mutable tables
4. **Unique Identifiers**: Strategic use of UUIDs vs natural keys (invite codes)
5. **Cascading Deletes**: Thoughtful cascade strategies based on data relationships
6. **Enum Types**: Database-level enums for type safety and constraint enforcement

### Migration Quality

The migrations demonstrate production-grade database engineering:

- **Comprehensive Testing**: 185+ line test suites for critical migrations
- **Edge Case Handling**: Tests for blank databases, existing data, duplicate runs
- **Documentation**: Clear comments explaining transaction boundaries and constraints
- **Performance**: Strategic indexing matching query patterns
- **Safety**: Concurrent index creation, IF NOT EXISTS clauses, safe defaults

This body of work represents the database foundation upon which Airbyte's entire multi-tenant, enterprise platform is built. The careful attention to data integrity, performance, and migration safety enabled Airbyte to scale from a simple OSS tool to a production-grade data platform serving enterprise customers.
