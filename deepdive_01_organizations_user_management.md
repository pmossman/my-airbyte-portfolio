# Organizations & User Management - Deep Dive

## Overview

This document analyzes Parker Mossman's contributions to the Organizations & User Management area of the airbyte-platform repository. This work spans from August 2023 to October 2025, encompassing 64 commits that collectively built out Airbyte's multi-tenant organization structure, role-based access control (RBAC) system, user invitation workflows, and SSO integration capabilities.

**Period:** August 24, 2023 - October 27, 2025 (26 months)
**Total Commits:** 64
**Total Changes:** ~17,000 lines of code
**Key Technologies:** Kotlin, Java, Micronaut Data, JOOQ, Keycloak

---

## Key Architectural Changes

### 1. RBAC: Organization-Level Permissions

**Commit:** 630ae7e7c9 - October 16, 2023
**Impact:** 5 files changed, 557 insertions, 27 deletions

#### What Changed

This foundational commit introduced hierarchical permission inheritance, allowing organization-level permissions to grant workspace-level access. The key addition was the `PermissionHelper` class with its permission hierarchy map.

**Key files:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/helpers/PermissionHelper.java` (new)
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/PermissionHandler.java` (modified)

#### Implementation Details

The core innovation was the permission hierarchy defined in `PermissionHelper`:

```java
protected static final Map<PermissionType, Set<PermissionType>> GRANTED_PERMISSION_TYPES_BY_DEFINED_PERMISSION_TYPE = Map.of(
    // Instance admin grants access to all permissions.
    PermissionType.INSTANCE_ADMIN, Set.of(PermissionType.values()),

    // Organization admin grants access to all organization-admin-and-lower permissions, and also all
    // workspace-admin-and-lower permissions for workspaces within the organization.
    PermissionType.ORGANIZATION_ADMIN, Set.of(
        PermissionType.ORGANIZATION_ADMIN,
        PermissionType.ORGANIZATION_EDITOR,
        PermissionType.ORGANIZATION_READER,
        PermissionType.WORKSPACE_OWNER,
        PermissionType.WORKSPACE_ADMIN,
        PermissionType.WORKSPACE_EDITOR,
        PermissionType.WORKSPACE_READER),

    // Organization editor grants access to all organization-editor-and-lower permissions, and also all
    // workspace-editor-and-lower permissions for workspaces within the organization.
    PermissionType.ORGANIZATION_EDITOR, Set.of(
        PermissionType.ORGANIZATION_EDITOR,
        PermissionType.ORGANIZATION_READER,
        PermissionType.WORKSPACE_EDITOR,
        PermissionType.WORKSPACE_READER),

    // ... additional mappings
);
```

This enabled a single check: `definedPermissionGrantsTargetPermission(definedPermission, targetPermission)` to determine if a user's permission level grants them access to a specific operation.

The `PermissionHandler` was enhanced to use this hierarchy when checking permissions, meaning an organization admin automatically had admin access to all workspaces in that organization without needing explicit workspace-level permission records.

#### Business Value

This change was critical for enabling true multi-tenant organization structure in Airbyte. Before this, permissions were flat - you needed explicit permissions for every workspace. After this change:

1. **Scalability**: Organizations could have hundreds of workspaces without creating hundreds of permission records per user
2. **Simplified Management**: Granting organization-level access automatically cascaded to all workspaces
3. **Hierarchical Control**: Enabled proper organizational structure with admins, editors, and readers at different levels
4. **Foundation for SSO**: Set the groundwork for SSO users to be automatically granted organization-level access

#### Related Commits

- 62cb0c0af2 (Oct 18, 2023): Leveraged org-level permissions in workspace listing APIs
- bd94f05b9d (Oct 17, 2023): Excluded workspaces from OrganizationMember users

---

### 2. InstanceConfiguration API with Setup Endpoint

**Commit:** dacfafff41 - August 24, 2023
**Impact:** 70 files changed, 948 insertions, 448 deletions

#### What Changed

Created a unified `InstanceConfigurationHandler` that consolidated instance setup logic and added a `/setup` endpoint for configuring default organization and user information during initial Airbyte deployment.

**Key files added:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/InstanceConfigurationHandler.java` (new, 170 lines)
- `airbyte-api/src/main/openapi/config.yaml` (updated with new endpoints)

**Key files removed:**
- `DefaultInstanceConfigurationHandler.java`
- `ProInstanceConfigurationHandler.java`

#### Implementation Details

The new unified handler consolidated instance configuration logic:

```java
public InstanceConfigurationResponse getInstanceConfiguration() throws IOException, ConfigNotFoundException {
    final StandardWorkspace defaultWorkspace = getDefaultWorkspace();

    return new InstanceConfigurationResponse()
        .webappUrl(webappUrl)
        .edition(Enums.convertTo(airbyteEdition, EditionEnum.class))
        .licenseType(getLicenseType())
        .auth(getAuthConfiguration())
        .initialSetupComplete(defaultWorkspace.getInitialSetupComplete())
        .defaultUserId(getDefaultUserId())
        .defaultOrganizationId(getDefaultOrganizationId())
        .defaultWorkspaceId(defaultWorkspace.getWorkspaceId());
}
```

The `/setup` endpoint enabled initialization:

```java
public InstanceConfigurationResponse setupInstanceConfiguration(final InstanceConfigurationSetupRequestBody requestBody)
      throws IOException, JsonValidationException, ConfigNotFoundException {

    // Update the default organization and user with the provided information
    updateDefaultOrganization(requestBody);
    updateDefaultUser(requestBody);

    // Update the underlying workspace to mark the initial setup as complete
    workspacesHandler.updateWorkspace(new WorkspaceUpdate()
        .workspaceId(requestBody.getWorkspaceId())
        .email(requestBody.getEmail())
        .displaySetupWizard(requestBody.getDisplaySetupWizard())
        .anonymousDataCollection(requestBody.getAnonymousDataCollection())
        .initialSetupComplete(requestBody.getInitialSetupComplete()));

    return getInstanceConfiguration();
}
```

#### Business Value

This change addressed a critical onboarding gap:

1. **Unified Setup Flow**: OSS and Pro editions now shared the same setup API, reducing code duplication
2. **Better UX**: The webapp could complete setup by calling a single endpoint with user-provided organization name, user name, and email
3. **Default Resources**: Established the pattern of "default" organization and user that exists in every Airbyte instance
4. **Migration Foundation**: Set up the structure for migrating user data from Firebase to Airbyte-managed authentication

The commit also introduced significant frontend changes, moving authentication service logic from Cloud-specific packages to core services, laying groundwork for unified authentication across OSS and Cloud deployments.

#### Related Commits

- d43b7795cf (Aug 22, 2023): Added migration to create default User and Organization records
- e7490ddf1c (May 17, 2023): Added User and Permission tables to OSS ConfigsDb

---

### 3. User Invitation API

**Commit:** 5cc95d28b6 - January 25, 2024
**Impact:** 27 files changed, 1,191 insertions, 15 deletions

#### What Changed

Implemented a complete user invitation system allowing users to invite others to workspaces or organizations. This introduced the `UserInvitation` model, database table, service layer, and API endpoints.

**Key files added:**
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/UserInvitationService.kt` (interface)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/impls/data/UserInvitationServiceDataImpl.kt` (implementation)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/UserInvitationRepository.kt` (repository)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/entities/UserInvitation.kt` (entity)
- `airbyte-server/src/main/java/io/airbyte/server/apis/UserInvitationApiController.java` (API controller)
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/UserInvitationHandler.java` (business logic)

#### Implementation Details

The service interface defined the core operations:

```kotlin
interface UserInvitationService {
  /**
   * Get a user invitation by its unique invite code.
   */
  fun getUserInvitationByInviteCode(inviteCode: String): UserInvitation

  /**
   * Create a new user invitation.
   */
  fun createUserInvitation(invitation: UserInvitation): UserInvitation

  /**
   * Accept a user invitation and create resulting permission record.
   */
  fun acceptUserInvitation(
    inviteCode: String,
    invitedUserId: UUID,
  ): UserInvitation

  /**
   * Decline a user invitation.
   */
  fun declineUserInvitation(
    inviteCode: String,
    invitedUserId: UUID,
  ): UserInvitation

  /**
   * Cancel a user invitation.
   */
  fun cancelUserInvitation(inviteCode: String): UserInvitation
}
```

The entity used Micronaut Data annotations:

```kotlin
@MappedEntity("user_invitation")
open class UserInvitation(
  @field:Id
  var id: UUID? = null,
  var inviteCode: String,
  var inviterUserId: UUID,
  var invitedEmail: String,
  var scopeId: UUID,
  var scopeType: ScopeType,
  var permissionType: PermissionType,
  var status: InvitationStatus,
  var acceptedByUserId: UUID? = null,
  var expiresAt: java.time.OffsetDateTime? = null,
  @DateCreated
  var createdAt: java.time.OffsetDateTime? = null,
  @DateUpdated
  var updatedAt: java.time.OffsetDateTime? = null,
)
```

The invitation supported both workspace-level and organization-level invitations through the `scopeType` field (introduced in the database schema).

#### Business Value

This feature enabled collaborative use of Airbyte:

1. **User Onboarding**: Organizations could invite new users without requiring admin intervention
2. **Flexible Scoping**: Invitations could grant access at workspace or organization level
3. **Security**: Invitations had unique codes, expiration dates, and could be cancelled
4. **Permission Control**: Inviters could specify exact permission level (reader, editor, admin)
5. **Audit Trail**: Complete tracking of who invited whom, when accepted, etc.

The API exposed create, get, accept, decline, and cancel operations, giving full lifecycle management of invitations.

#### Related Commits

- e536cd02d0 (Sep 13, 2023): Database migration for user invitation table
- 73350c09b2 (Mar 14, 2024): Auto-add permission for existing users within org
- bd12d7c050 (Mar 25, 2024): Implemented /cancel endpoint and blocked duplicates
- cc2f032d8f (Mar 12, 2024): Added /list_pending endpoint
- 6927c3df7b (Mar 19, 2024): Added expiration and accepted_by_user_id tracking
- 9dd1b2cb46 (Jan 3, 2024): Migration to replace workspaceId/organizationId with scopeType/scopeId

---

### 4. Micronaut Data for Organizations

**Commit:** 242fefb266 - August 20, 2024
**Impact:** 13 files changed, 580 insertions, 52 deletions

#### What Changed

This was the first major step in migrating from JOOQ-based persistence to Micronaut Data. It introduced entity classes, repositories, and a service implementation for Organizations while keeping the existing JOOQ implementation.

**Key files added:**
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/entities/Organization.kt` (entity)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/OrganizationRepository.kt` (repository)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/impls/data/OrganizationServiceDataImpl.kt` (new implementation)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/impls/data/mappers/OrganizationMapper.kt` (mapper)

#### Implementation Details

The Micronaut Data entity used annotations for ORM mapping:

```kotlin
@MappedEntity("organization")
open class Organization(
  @field:Id
  var id: UUID? = null,
  var name: String,
  var userId: UUID? = null,
  var email: String,
  var pba: Boolean = false,
  var orgLevelBilling: Boolean = false,
  var tombstone: Boolean = false,
  @DateCreated
  var createdAt: java.time.OffsetDateTime? = null,
  @DateUpdated
  var updatedAt: java.time.OffsetDateTime? = null,
) {
  @PrePersist
  fun prePersist() {
    if (id == null) {
      id = UUID.randomUUID()
    }
  }
}
```

The repository extended Micronaut Data's `PageableRepository`:

```kotlin
@JdbcRepository(dialect = Dialect.POSTGRES)
interface OrganizationRepository : PageableRepository<Organization, UUID> {
  @Query("""
    SELECT organization.* from organization
    INNER JOIN workspace
    ON organization.id = workspace.organization_id
    WHERE workspace.id = :workspaceId
    """)
  fun findByWorkspaceId(workspaceId: UUID): Optional<Organization>
}
```

The service implementation provided a bridge between the Micronaut Data repository and the existing `OrganizationService` interface.

#### Business Value

This migration was strategically important:

1. **Modern ORM**: Micronaut Data provides compile-time query validation and better type safety than JOOQ
2. **Reduced Boilerplate**: Entity-based approach eliminated hundreds of lines of manual SQL construction
3. **Incremental Migration**: By keeping both implementations, the team could migrate gradually without breaking changes
4. **Performance**: Micronaut Data's query optimization and connection pooling improved database performance
5. **Developer Experience**: Cleaner, more maintainable code with less ceremony

This commit established the pattern for migrating other persistence layers (Workspace, Permission, etc.) to Micronaut Data.

#### Related Commits

- 6d977582ff (Oct 27, 2025): Completed migration by removing OrganizationPersistence entirely

---

### 5. Filter Workspaces by Permission

**Commit:** 1fa14d6294 - August 27, 2025
**Impact:** 6 files changed, 607 insertions, 2 deletions

#### What Changed

Added permission-based filtering to the `workspaces/list_by_organization_id` endpoint, ensuring users only see workspaces they have access to within an organization.

**Key files modified:**
- `airbyte-commons-server/src/main/kotlin/io/airbyte/commons/server/handlers/WorkspacesHandler.kt`
- `airbyte-config/config-persistence/src/main/kotlin/io/airbyte/config/persistence/WorkspacePersistence.kt`
- `airbyte-config/config-persistence/src/main/kotlin/io/airbyte/config/persistence/PermissionPersistenceHelper.kt`

#### Implementation Details

Added a new query that respects user permissions when listing workspaces:

```sql
WITH
  userHasInstanceAdmin AS (
    SELECT COUNT(*) > 0 AS has_instance_admin FROM permission WHERE user_id = {0} AND permission_type = 'instance_admin'
  ),
  userOrg AS (
    SELECT organization_id FROM permission WHERE user_id = {0} AND permission_type = ANY({1}::permission_type[])
  ),
  userWorkspaces AS (
    SELECT workspace.id AS workspace_id FROM userOrg JOIN workspace
    ON workspace.organization_id = userOrg.organization_id
    WHERE workspace.organization_id = {2}
    UNION
    SELECT workspace_id FROM permission WHERE user_id = {0} AND permission_type = ANY({1}::permission_type[])
    AND workspace_id IN (SELECT id FROM workspace WHERE organization_id = {2})
  )
SELECT workspace.*
FROM workspace
WHERE (
  workspace.id IN (SELECT workspace_id from userWorkspaces)
  OR (SELECT has_instance_admin FROM userHasInstanceAdmin)
)
AND workspace.organization_id = {2}
AND workspace.name ILIKE {3}
AND workspace.tombstone = false
ORDER BY workspace.name ASC
```

This query intelligently handles:
- Instance admins (see all workspaces)
- Organization-level permissions (see all workspaces in org)
- Workspace-level permissions (see only specific workspaces)

The handler added a new method:

```kotlin
fun listWorkspacesInOrganizationForUser(
  userId: UUID,
  request: ListWorkspacesInOrganizationRequestBody,
): WorkspaceReadList {
  val standardWorkspaces = workspacePersistence
    .listWorkspacesInOrganizationByUserId(
      organizationId = request.organizationId,
      userId = userId,
      keyword = nameContains,
    )
  // ... mapping and return
}
```

#### Business Value

This was critical for security and user experience:

1. **Security**: Users could no longer see workspaces they didn't have access to, even within their organization
2. **Principle of Least Privilege**: Enforced proper access control at the API level
3. **Performance**: Optimized query reduced data transfer for users with limited access
4. **User Experience**: Cleaner workspace lists showing only relevant workspaces

This change reflected a maturing of the RBAC system from "organization membership = see everything" to proper fine-grained access control.

#### Related Commits

- e86acfe10b (Aug 28, 2025): Unreverted and finalized the changes after testing

---

### 6. Unrevert Organization/Workspace List Optimizations

**Commit:** e86acfe10b - August 28, 2025
**Impact:** 7 files changed, 921 insertions, 53 deletions

#### What Changed

This commit re-introduced and finalized major optimizations to `organizations/list_by_user_id` and `workspaces/list_by_organization_id` endpoints. These changes had been previously reverted due to performance concerns but were brought back with improvements.

**Key files modified:**
- `airbyte-config/config-persistence/src/main/kotlin/io/airbyte/config/persistence/OrganizationPersistence.kt`
- `airbyte-config/config-persistence/src/main/kotlin/io/airbyte/config/persistence/WorkspacePersistence.kt`

#### Implementation Details

The organization listing was completely rewritten to be more efficient:

```kotlin
private fun getOrganizationsForUser(
  ctx: DSLContext,
  userId: UUID,
  keyword: Optional<String>,
  pagination: PaginationParams?,
): org.jooq.Result<Record> {
  val accessibleOrgIds =
    if (hasInstanceAdminPermission(ctx, userId)) {
      getAllOrganizationIds(ctx)
    } else {
      getAccessibleOrganizationIds(ctx, userId)
    }

  if (accessibleOrgIds.isEmpty()) {
    return ctx.newResult()
  }

  val query = organizationsByIdWithKeyword(ctx, accessibleOrgIds, keyword)

  return if (pagination != null) {
    query.limit(pagination.limit).offset(pagination.offset).fetch()
  } else {
    query.fetch()
  }
}
```

This broke down into helper methods:

```kotlin
private fun hasInstanceAdminPermission(ctx: DSLContext, userId: UUID): Boolean =
  ctx
    .selectCount()
    .from(Tables.PERMISSION)
    .where(Tables.PERMISSION.USER_ID.eq(userId))
    .and(Tables.PERMISSION.PERMISSION_TYPE.eq(PermissionType.instance_admin))
    .fetchOne(0, Int::class.java)!! > 0

private fun getAccessibleOrganizationIds(ctx: DSLContext, userId: UUID): Set<UUID> {
  val orgLevelIds = getOrganizationLevelPermissionIds(ctx, userId)
  val workspaceLevelIds = getWorkspaceLevelPermissionIds(ctx, userId)
  return orgLevelIds + workspaceLevelIds
}
```

The key optimization was separating the permission check from the organization data fetch, and special-casing instance admins to avoid expensive permission joins.

#### Business Value

1. **Performance**: For instance admins, eliminated expensive permission joins by detecting admin status first
2. **Correctness**: Users with workspace-level permissions now see the containing organization (previously missed)
3. **Scalability**: Two-phase approach (get accessible IDs, then fetch data) scales better with large datasets
4. **Code Quality**: Decomposed complex query logic into testable helper methods

The extensive test coverage (565 new test lines in `WorkspacePersistenceTest.kt`) ensured correctness across all permission scenarios.

#### Related Commits

- 1fa14d6294 (Aug 27, 2025): Initial workspace filtering implementation
- 72aaef63bf (Aug 27, 2025): Include orgs from non-org permission records
- ae43accad5 (Sep 2, 2025): Optimize organizations/list for instanceAdmin users

---

### 7. Draft SSO Config with Realm Cleanup

**Commit:** 866d7bae4d - October 8, 2025
**Impact:** 3 files changed, 582 insertions, 136 deletions

#### What Changed

Significantly improved the SSO configuration workflow by properly handling draft configs, Keycloak realm cleanup on failures, and user preservation when updating SSO settings.

**Key files modified:**
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/impls/keycloak/AirbyteKeycloakClient.kt`
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/sso/SsoConfigDomainService.kt`

#### Implementation Details

The Keycloak client was enhanced with failure recovery:

```kotlin
fun createOidcSsoConfig(request: SsoConfig) {
  keycloakAdminClient.realms().create(
    RealmRepresentation().apply {
      realm = request.companyIdentifier
      isEnabled = true
      registrationEmailAsUsername = true
    },
  )

  try {
    val idpDiscoveryResult = importIdpConfig(request.companyIdentifier, request.discoveryUrl)
    val idp = IdentityProviderRepresentation().apply {
      alias = DEFAULT_IDP_ALIAS
      providerId = "oidc"
      config = mapOf(
        "clientId" to request.clientId,
        "clientSecret" to request.clientSecret,
        "authorizationUrl" to idpDiscoveryResult["authorizationUrl"],
        "tokenUrl" to idpDiscoveryResult["tokenUrl"],
        "clientAuthMethod" to CLIENT_AUTH_METHOD,
        "defaultScope" to DEFAULT_SCOPE,
      )
    }
    createIdpForRealm(request.companyIdentifier, idp)
    createClientForRealm(request.companyIdentifier, airbyteWebappClient)
  } catch (e: Exception) {
    try {
      deleteRealm(request.companyIdentifier)
    } catch (cleanupEx: Exception) {
      logger.error(cleanupEx) { "Failed to cleanup Keycloak realm ${request.companyIdentifier} after configuration failure" }
    }
    throw e
  }
}
```

The domain service gained sophisticated draft handling:

```kotlin
private fun createDraftSsoConfig(config: SsoConfig) {
  validateDiscoveryUrl(config)

  val existingConfig = ssoConfigService.getSsoConfig(config.organizationId)

  when {
    existingConfig == null -> createNewDraftSsoConfig(config)

    existingConfig.keycloakRealm != config.companyIdentifier -> {
      deleteSsoConfig(config.organizationId, existingConfig.keycloakRealm)
      createNewDraftSsoConfig(config)
    }

    airbyteKeycloakClient.realmExists(config.companyIdentifier) -> {
      updateExistingKeycloakRealmConfig(config)
    }

    else -> {
      logger.info { "Realm ${config.companyIdentifier} does not exist but DB record does, recreating realm" }
      createKeycloakRealmWithErrorHandling(config)
    }
  }
}
```

A new method preserved users when updating IDP settings:

```kotlin
fun replaceOidcIdpConfig(ssoConfig: SsoConfig) {
  val realm = keycloakAdminClient.realms().realm(ssoConfig.companyIdentifier)
  val existingIdp = realm
    .identityProviders()
    .findAll()
    .filter { it.alias == DEFAULT_IDP_ALIAS }
    .getOrNull(0)

  val idpDiscoveryResult = importIdpConfig(ssoConfig.companyIdentifier, ssoConfig.discoveryUrl)
  val idpConfig = mapOf(
    "clientId" to ssoConfig.clientId,
    "clientSecret" to ssoConfig.clientSecret,
    "authorizationUrl" to idpDiscoveryResult["authorizationUrl"],
    "tokenUrl" to idpDiscoveryResult["tokenUrl"],
    // ...
  )

  if (existingIdp != null) {
    // Update existing IDP to preserve user links
    existingIdp.config = idpConfig
    realm.identityProviders().get(DEFAULT_IDP_ALIAS).update(existingIdp)
  } else {
    // Create new IDP
    createIdpForRealm(ssoConfig.companyIdentifier, idp)
  }
}
```

#### Business Value

This fix addressed critical production issues:

1. **Data Integrity**: Proper cleanup prevented orphaned Keycloak realms when configuration failed
2. **User Preservation**: Updating draft configs no longer deleted user accounts, preventing data loss
3. **Robustness**: Transaction boundary documentation explained why Keycloak operations aren't wrapped in DB transactions
4. **Better Error Handling**: Graceful degradation when database and Keycloak get out of sync
5. **Iteration Support**: Organizations could iterate on draft SSO configs without losing progress

The comment explaining transaction boundaries was particularly valuable:

```kotlin
/**
 * Transaction Boundary: This method is NOT marked @Transactional because it performs external
 * Keycloak operations that cannot be rolled back via database transactions. Instead, we create
 * Keycloak resources first, then database records. If database operations fail, we manually
 * clean up the Keycloak resources. This ensures proper cleanup without holding database
 * transactions open during external API calls.
 */
```

#### Related Commits

- 6103a25502 (Oct 19, 2023): First SSO user gets OrganizationAdmin role
- a497898732 (Oct 19, 2023): Include optional SsoRealm in OrganizationRead
- 02d96c8167 (Oct 23, 2025): Block SSO activation if domain in use by another org

---

### 8. OrganizationPersistence to OrganizationService Migration

**Commit:** 6d977582ff - October 27, 2025 (2nd attempt)
**Impact:** 37 files changed, 1,269 insertions, 1,268 deletions

#### What Changed

Completed the migration from JOOQ-based `OrganizationPersistence` to Micronaut Data-based `OrganizationService`, removing over 500 lines of legacy persistence code and replacing it with modern repository-based queries.

**Key files deleted:**
- `airbyte-config/config-persistence/src/main/java/io/airbyte/config/persistence/OrganizationPersistence.kt` (531 lines removed)
- `airbyte-config/config-persistence/src/test/java/io/airbyte/config/persistence/OrganizationPersistenceTest.kt` (538 lines removed)

**Key files added/modified:**
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/OrganizationRepository.kt` (169 lines added)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/impls/data/OrganizationServiceDataImpl.kt` (enhanced)
- `airbyte-data/src/test/kotlin/io/airbyte/data/repositories/OrganizationRepositoryTest.kt` (380 lines added)

#### Implementation Details

The repository gained sophisticated query methods using Micronaut Data's `@Query` annotation:

```kotlin
@Query(
  """
  SELECT
    organization.id,
    organization.name,
    organization.user_id,
    organization.email,
    organization.tombstone,
    organization.created_at,
    organization.updated_at,
    sso_config.keycloak_realm
  FROM organization
  LEFT JOIN sso_config ON organization.id = sso_config.organization_id
  WHERE (EXISTS (
      SELECT 1 FROM permission
      WHERE permission.user_id = :userId
      AND permission.organization_id = organization.id
  ) OR EXISTS (
      SELECT 1 FROM workspace
      INNER JOIN permission ON workspace.id = permission.workspace_id
      WHERE permission.user_id = :userId
      AND workspace.organization_id = organization.id
  ) OR EXISTS (
      SELECT 1 FROM permission
      WHERE permission.user_id = :userId
      AND permission.permission_type = 'instance_admin'
  ))
  AND (:includeDeleted = true OR organization.tombstone = false)
  AND (:keyword IS NULL OR organization.name ILIKE CONCAT('%', :keyword, '%'))
  ORDER BY organization.name ASC
  """,
)
fun findByUserIdWithSsoRealm(
  userId: UUID,
  keyword: String?,
  includeDeleted: Boolean,
): List<OrganizationWithSsoRealm>
```

This single query replaced multiple JOOQ-based methods with complex logic. The repository now provides:
- `findByWorkspaceId`
- `findByConnectionId`
- `findBySsoConfigRealm`
- `findByUserIdWithSsoRealm` (with pagination variant)
- `findAllWithSsoRealm` (for instance admins)

A new entity type was introduced to handle the join with SSO config:

```kotlin
@MappedEntity("organization")
data class OrganizationWithSsoRealm(
  @field:Id
  val id: UUID,
  val name: String,
  val userId: UUID?,
  val email: String,
  val tombstone: Boolean,
  @DateCreated
  val createdAt: java.time.OffsetDateTime?,
  @DateUpdated
  val updatedAt: java.time.OffsetDateTime?,
  val keycloakRealm: String?,
)
```

All usages across handlers and tests were updated to use the service:

```kotlin
// Before:
val org = organizationPersistence.getOrganization(orgId)

// After:
val org = organizationService.getOrganization(orgId)
```

#### Business Value

This migration delivered significant long-term benefits:

1. **Code Reduction**: Eliminated ~1,000 lines of complex persistence code
2. **Type Safety**: Compile-time query validation caught errors that would have been runtime failures
3. **Performance**: Optimized queries using database-specific features (instance admin check)
4. **Maintainability**: Queries are co-located with repository interface, easier to understand
5. **Consistency**: Aligned with Micronaut Data patterns used elsewhere in the codebase
6. **Testing**: Micronaut Test framework provided better test support than manual JOOQ mocking

The migration was attempted twice (commits 57945df747 and 4f7d9b0e3a show the first attempt and its revert), indicating careful testing and iteration to get it right.

#### Related Commits

- 242fefb266 (Aug 20, 2024): Initial Micronaut Data entities/repositories for Organizations
- 57945df747 (Oct 17, 2025): First migration attempt
- 4f7d9b0e3a (Oct 17, 2025): Revert of first attempt

---

## Technical Evolution

The commits tell a story of systematic platform maturation across multiple dimensions:

### 1. Permission Model Evolution (2023)

The work began in late 2023 with establishing the foundation of the RBAC system:

- **October 2023**: Introduced org-level permission hierarchy (630ae7e7c9)
- **October 2023**: SSO users get automatic OrganizationAdmin role (6103a25502)
- **November 2023**: Added permission revocation endpoints (f4c9ae098c)

This phase focused on getting the permission model right before building features on top of it.

### 2. User Management Features (2024)

With permissions established, 2024 focused on user-facing features:

- **January 2024**: User invitation API (5cc95d28b6)
- **March 2024**: Invitation expiration, cancellation, and duplicate prevention (bd12d7c050, cc2f032d8f, 6927c3df7b)
- **January 2024**: CurrentUser service for API request context (0252d08de9)

This phase enabled collaborative workflows and proper user lifecycle management.

### 3. Data Layer Modernization (2024-2025)

Starting mid-2024, the architecture shifted toward modern ORM patterns:

- **August 2024**: Introduced Micronaut Data entities for Organizations (242fefb266)
- **August 2025**: Optimized permission-based queries (1fa14d6294, e86acfe10b)
- **October 2025**: Completed OrganizationPersistence migration (6d977582ff)

This phase reduced technical debt and improved performance through better data access patterns.

### 4. SSO Robustness (2025)

The most recent work focused on production-hardening SSO:

- **October 2025**: Draft SSO config improvements (866d7bae4d)
- **October 2025**: Domain conflict prevention (02d96c8167)
- **September 2025**: Realm existence checks and error handling

This phase addressed edge cases and failure scenarios discovered in production use.

### Technology Choices

The evolution shows deliberate technology decisions:

- **JOOQ → Micronaut Data**: Migration from SQL-focused to entity-focused persistence
- **Java → Kotlin**: Newer code increasingly in Kotlin for conciseness and null safety
- **Monolithic → Layered**: Clear separation of repositories, services, handlers, and controllers
- **Manual SQL → Query DSL**: Compile-time validated queries replace string-based SQL

---

## Impact Summary

Parker's contributions to Organizations & User Management represent a complete implementation of multi-tenancy and access control for Airbyte. The work enabled Airbyte to evolve from a single-user tool to an enterprise platform supporting multiple organizations, workspaces, and user roles.

### Quantitative Impact

- **64 commits** over 26 months
- **~17,000 lines** of code changes
- **Major features delivered:**
  - Complete RBAC system with hierarchical permissions
  - User invitation workflow with expiration and lifecycle management
  - SSO integration with Keycloak
  - Organization and workspace management APIs
  - Instance configuration and setup APIs

### Qualitative Impact

**For Users:**
- Organizations can invite and manage team members
- Fine-grained access control protects sensitive resources
- SSO enables enterprise authentication requirements
- Intuitive permission model (org admins automatically get workspace access)

**For Developers:**
- Clean service layer abstractions
- Comprehensive test coverage (380+ lines of repository tests alone)
- Modern ORM reduces boilerplate
- Well-documented transaction boundaries and edge cases

**For the Platform:**
- Scalable multi-tenant architecture
- Production-hardened error handling
- Performance-optimized queries (instance admin special-casing)
- Extensible permission model supports future role types

### Key Architectural Patterns

The work established several important patterns:

1. **Permission Hierarchy Map**: Declarative permission relationships enable easy reasoning about access
2. **Two-Phase Queries**: Separate permission checks from data fetching for better performance
3. **External API Compensation**: Manual cleanup when external services (Keycloak) can't participate in DB transactions
4. **Scope Abstraction**: Generic scopeType/scopeId pattern allows features to work at org or workspace level
5. **Service Layer Abstraction**: Dual implementations (JOOQ and Micronaut Data) enable gradual migration

This foundation enables Airbyte to support enterprise customers with complex organizational structures, compliance requirements, and security policies.
