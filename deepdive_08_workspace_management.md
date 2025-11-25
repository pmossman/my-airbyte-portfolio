# Workspace Management - Deep Dive

## Overview

This document analyzes Parker Mossman's contributions to the Workspace Management area of the airbyte-platform repository. This work spans from October 2022 to September 2025, encompassing 33 commits that collectively built out Airbyte's workspace CRUD operations, geography/region support, dataplane group assignment, workspace-level permissions, and workspace configuration management.

**Period:** October 10, 2022 - September 9, 2025 (nearly 3 years)
**Total Commits:** 33
**Total Changes:** ~5,500 lines of code
**Key Technologies:** Java, Kotlin, PostgreSQL, JOOQ

---

## Key Architectural Changes

### 1. Permission-Based Workspace Filtering

**Commit:** e86acfe10b - August 28, 2025
**Impact:** 7 files changed, 921 insertions, 53 deletions

#### What Changed

This commit introduced sophisticated permission-based filtering for workspace listing endpoints, ensuring users only see workspaces they have access to. The implementation completely rewrote the organization and workspace listing logic to respect hierarchical permissions.

**Key files modified:**
- `airbyte-config/config-persistence/src/main/kotlin/io/airbyte/config/persistence/OrganizationPersistence.kt`
- `airbyte-config/config-persistence/src/main/kotlin/io/airbyte/config/persistence/WorkspacePersistence.kt`
- `airbyte-config/config-persistence/src/main/kotlin/io/airbyte/config/persistence/PermissionPersistenceHelper.kt`
- `airbyte-commons-server/src/main/kotlin/io/airbyte/commons/server/handlers/WorkspacesHandler.kt`

#### Implementation Details

The core innovation was a two-phase query strategy that separates permission checks from data fetching:

**Phase 1: Get Accessible Organization IDs**

```kotlin
private fun getAccessibleOrganizationIds(
  ctx: DSLContext,
  userId: UUID,
): Set<UUID> {
  val orgLevelIds = getOrganizationLevelPermissionIds(ctx, userId)
  val workspaceLevelIds = getWorkspaceLevelPermissionIds(ctx, userId)
  return orgLevelIds + workspaceLevelIds
}

private fun getOrganizationLevelPermissionIds(
  ctx: DSLContext,
  userId: UUID,
): Set<UUID> =
  ctx
    .selectDistinct(Tables.ORGANIZATION.ID)
    .from(Tables.ORGANIZATION)
    .join(Tables.PERMISSION)
    .on(Tables.ORGANIZATION.ID.eq(Tables.PERMISSION.ORGANIZATION_ID))
    .where(Tables.PERMISSION.USER_ID.eq(userId))
    .and(Tables.PERMISSION.ORGANIZATION_ID.isNotNull())
    .fetch()
    .mapTo(HashSet()) { it.value1() }

private fun getWorkspaceLevelPermissionIds(
  ctx: DSLContext,
  userId: UUID,
): Set<UUID> =
  ctx
    .selectDistinct(Tables.ORGANIZATION.ID)
    .from(Tables.ORGANIZATION)
    .join(Tables.WORKSPACE)
    .on(Tables.ORGANIZATION.ID.eq(Tables.WORKSPACE.ORGANIZATION_ID))
    .join(Tables.PERMISSION)
    .on(Tables.WORKSPACE.ID.eq(Tables.PERMISSION.WORKSPACE_ID))
    .where(Tables.PERMISSION.USER_ID.eq(userId))
    .and(Tables.PERMISSION.WORKSPACE_ID.isNotNull())
    .fetch()
    .mapTo(HashSet()) { it.value1() }
```

**Phase 2: Fetch Organizations by IDs**

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

**Workspace Filtering Query**

For workspace listing within an organization, a sophisticated SQL query handles all permission scenarios:

```sql
WITH
  userHasInstanceAdmin AS (
    SELECT COUNT(*) > 0 AS has_instance_admin
    FROM permission
    WHERE user_id = ? AND permission_type = 'instance_admin'
  ),
  userOrg AS (
    SELECT organization_id
    FROM permission
    WHERE user_id = ? AND permission_type = ANY(?::permission_type[])
  ),
  userWorkspaces AS (
    SELECT workspace.id AS workspace_id FROM userOrg
    JOIN workspace ON workspace.organization_id = userOrg.organization_id
    WHERE workspace.organization_id = ?
    UNION
    SELECT workspace_id FROM permission
    WHERE user_id = ? AND permission_type = ANY(?::permission_type[])
    AND workspace_id IN (SELECT id FROM workspace WHERE organization_id = ?)
  )
SELECT workspace.*
FROM workspace
WHERE (
  workspace.id IN (SELECT workspace_id from userWorkspaces)
  OR (SELECT has_instance_admin FROM userHasInstanceAdmin)
)
AND workspace.organization_id = ?
AND workspace.name ILIKE ?
AND workspace.tombstone = false
ORDER BY workspace.name ASC
```

This query efficiently handles:
- Instance admin users (see all workspaces)
- Organization-level permissions (see all workspaces in the organization)
- Workspace-level permissions (see only specific workspaces)
- Keyword search filtering
- Tombstone exclusion

#### Business Value

This change was critical for security and scalability:

1. **Security**: Users can no longer see workspaces they don't have access to, enforcing principle of least privilege
2. **Performance**: Two-phase approach scales better than complex joins, especially for instance admins
3. **Correctness**: Users with workspace-level permissions now see the containing organization (previously missed)
4. **User Experience**: Cleaner workspace lists showing only relevant resources

The extensive test coverage (565 new test lines) ensured correctness across permission hierarchies, org/workspace boundaries, and edge cases like tombstoned resources.

#### Related Commits

- 1fa14d6294 (Aug 27, 2025): Initial workspace filtering implementation (607 lines)
- d2991e202e (Aug 29, 2025): Allow workspace-level users to call organization info endpoints

---

### 2. Workspace Listing Filtered by User Permission

**Commit:** 1fa14d6294 - August 27, 2025
**Impact:** 6 files changed, 607 insertions, 2 deletions

#### What Changed

This commit added permission-based filtering specifically to the `workspaces/list_by_organization_id` endpoint, introducing a new handler method and comprehensive test coverage.

**Key files modified:**
- `airbyte-commons-server/src/main/kotlin/io/airbyte/commons/server/handlers/WorkspacesHandler.kt`
- `airbyte-config/config-persistence/src/main/kotlin/io/airbyte/config/persistence/WorkspacePersistence.kt`
- `airbyte-config/config-persistence/src/test/kotlin/io/airbyte/config/persistence/WorkspacePersistenceTest.kt` (414 new test lines)

#### Implementation Details

Added new handler method:

```kotlin
fun listWorkspacesInOrganizationForUser(
  userId: UUID,
  request: ListWorkspacesInOrganizationRequestBody,
): WorkspaceReadList {
  val nameContains = if (StringUtils.isBlank(request.nameContains))
    Optional.empty()
  else
    Optional.of(request.nameContains)

  val standardWorkspaces =
    if (request.pagination != null) {
      workspacePersistence.listWorkspacesInOrganizationByUserIdPaginated(
        query = ResourcesByOrganizationQueryPaginated(
          organizationId = request.organizationId,
          includeDeleted = false,
          pageSize = request.pagination.pageSize,
          rowOffset = request.pagination.rowOffset,
        ),
        userId = userId,
        keyword = nameContains,
      )
    } else {
      workspacePersistence.listWorkspacesInOrganizationByUserId(
        organizationId = request.organizationId,
        userId = userId,
        keyword = nameContains,
      )
    }

  return WorkspaceReadList().workspaces(
    standardWorkspaces.stream()
      .map { obj: StandardWorkspace -> domainToApiModel(obj) }
      .collect(Collectors.toList())
  )
}
```

The tests cover critical scenarios:
- Workspace listing with keyword search
- Workspace listing without keyword search
- Pagination support
- Organization-level permissions granting access to all workspaces
- Workspace-level permissions granting access to specific workspaces
- Instance admin access to all workspaces
- Exclusion of workspaces from other organizations
- Exclusion of workspaces without permissions

#### Business Value

1. **Fine-Grained Access Control**: Organization members only see workspaces they have explicit access to
2. **Improved UX**: Cleaner, more focused workspace lists
3. **Scalability**: Organizations can have hundreds of workspaces without overwhelming users
4. **Compliance**: Supports regulatory requirements for data access segregation

---

### 3. Dataplane Group Assignment Validation

**Commit:** 205afe57c0 - September 9, 2025
**Impact:** 4 files changed, 425 insertions, 1 deletion

#### What Changed

Implemented validation logic to ensure users can only assign dataplane groups that belong to their organization or are default (globally available) groups. This prevents unauthorized dataplane group assignments.

**Key files modified:**
- `airbyte-commons-server/src/main/kotlin/io/airbyte/commons/server/handlers/WorkspacesHandler.kt`
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/DataplaneGroupService.kt`

#### Implementation Details

**Validation Logic:**

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
  if (dataplaneGroupService.listDefaultDataplaneGroups()
      .map { it.id }
      .contains(dataplaneGroupId.value)) {
    return
  }

  // Finally, since it's not a default, ensure the dataplane group belongs to the target org.
  val dataplaneGroup = dataplaneGroupService.getDataplaneGroup(dataplaneGroupId.value)
  if (dataplaneGroup.organizationId != organizationId.value) {
    throw ForbiddenProblem(
      ProblemMessageData().message(
        "Dataplane group ${dataplaneGroupId.value} does not belong to organization ${organizationId.value}."
      ),
    )
  }
}
```

**Integration with Workspace Create:**

```kotlin
fun createWorkspaceIfNotExist(workspaceCreateWithId: WorkspaceCreateWithId): WorkspaceRead {
  val dataplaneGroupId: UUID

  if (workspaceCreateWithId.dataplaneGroupId == null) {
    // Use default for edition
    val defaultDataplaneGroup =
      dataplaneGroupService.getDefaultDataplaneGroupForAirbyteEdition(airbyteEdition)
    dataplaneGroupId = defaultDataplaneGroup.id
  } else {
    // Validate explicit assignment
    validateDataplaneGroupAssignment(
      DataplaneGroupId(workspaceCreateWithId.dataplaneGroupId),
      OrganizationId(workspaceCreateWithId.organizationId),
    )
    dataplaneGroupId = workspaceCreateWithId.dataplaneGroupId
  }

  // ... workspace creation continues
}
```

**Integration with Workspace Update:**

```kotlin
if (workspacePatch.dataplaneGroupId != null) {
  validateDataplaneGroupAssignment(
    DataplaneGroupId(workspacePatch.dataplaneGroupId),
    OrganizationId(workspace.organizationId),
  )
  workspace.dataplaneGroupId = workspacePatch.dataplaneGroupId
}
```

**New DataplaneGroupService Method:**

```kotlin
interface DataplaneGroupService {
  // ... existing methods

  /**
   * List all default dataplane groups that are available for general use.
   */
  fun listDefaultDataplaneGroups(): List<DataplaneGroup> =
    listDataplaneGroups(listOf(DEFAULT_ORGANIZATION_ID), false)
}
```

#### Business Value

This validation addresses critical security and operational concerns:

1. **Security**: Prevents users from assigning workspaces to dataplane groups they don't control
2. **Multi-Tenancy**: Enforces organizational boundaries for cloud infrastructure resources
3. **Access Control**: Requires organization editor role to modify dataplane assignments
4. **Flexibility**: Default dataplane groups remain available to all organizations
5. **Error Prevention**: Clear error messages when invalid assignments are attempted

The implementation includes 325 lines of tests covering:
- Creating workspaces with explicit dataplane groups (requires org editor)
- Updating workspace dataplane groups (requires org editor)
- Default dataplane groups (no additional validation required)
- Attempting to assign dataplane groups from wrong organization (throws ForbiddenProblem)

---

### 4. Geography Support for Workspaces and Connections

**Commit:** fb9efb378d - October 10, 2022
**Impact:** 25 files changed, 498 insertions, 108 deletions

#### What Changed

This foundational commit added geography/region support to workspaces and connections, allowing Airbyte to run data syncs in specific geographic regions for data sovereignty compliance.

**Key files added/modified:**
- `airbyte-config/config-models/src/main/resources/types/Geography.yaml` (new)
- `airbyte-api/src/main/openapi/config.yaml` (added Geography to multiple schemas)
- `airbyte-config/config-persistence/src/main/java/io/airbyte/config/persistence/DbConverter.java`
- `airbyte-server/src/main/java/io/airbyte/server/handlers/WorkspacesHandler.java`
- `airbyte-server/src/main/java/io/airbyte/server/handlers/WebBackendGeographiesHandler.java` (new)

#### Implementation Details

**Geography Enum Definition:**

```yaml
---
"$schema": http://json-schema.org/draft-07/schema#
title: Geography
description: Geography Setting
type: string
enum:
  - auto
  - us
  - eu
```

**StandardWorkspace Schema Update:**

```yaml
required:
  - workspaceId
  - name
  - slug
  - initialSetupComplete
  - defaultGeography  # NEW
properties:
  # ... existing properties
  defaultGeography:
    "$ref": Geography.yaml
```

**StandardSync (Connection) Schema Update:**

```yaml
required:
  - connectionId
  - catalog
  - manual
  - namespaceDefinition
  - geography  # NEW
properties:
  # ... existing properties
  geography:
    "$ref": Geography.yaml
```

**Database Persistence:**

```java
public static StandardWorkspace buildStandardWorkspace(final Record record) {
  return new StandardWorkspace()
      .withWorkspaceId(record.get(Tables.WORKSPACE.ID))
      .withName(record.get(Tables.WORKSPACE.NAME))
      .withSlug(record.get(Tables.WORKSPACE.SLUG))
      // ... other fields
      .withDefaultGeography(
        Enums.toEnum(
          record.get(WORKSPACE.GEOGRAPHY, String.class),
          Geography.class
        ).orElseThrow()
      );
}

public static StandardSync buildStandardSync(final Record record) {
  return new StandardSync()
      .withConnectionId(record.get(CONNECTION.ID))
      .withSourceId(record.get(CONNECTION.SOURCE_ID))
      .withDestinationId(record.get(CONNECTION.DESTINATION_ID))
      // ... other fields
      .withGeography(
        Enums.toEnum(
          record.get(CONNECTION.GEOGRAPHY, String.class),
          Geography.class
        ).orElseThrow()
      );
}
```

**API Endpoint for Listing Geographies:**

```yaml
/v1/web_backend/geographies/list:
  post:
    tags:
      - web_backend
    description: Returns all available geographies in which a data sync can run.
    summary: |
      Returns available geographies can be selected to run data syncs in a
      particular geography. The 'auto' entry indicates that the sync will be
      automatically assigned to a geography according to the platform default
      behavior. Entries other than 'auto' are two-letter country codes that
      follow the ISO 3166-1 alpha-2 standard.
    operationId: webBackendListGeographies
    responses:
      "200":
        description: Successful operation
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/WebBackendGeographiesListResult"
```

**Workspace Creation with Geography:**

```java
final StandardWorkspace workspace = new StandardWorkspace()
    .withWorkspaceId(uuidSupplier.get())
    .withName(workspaceCreate.getName())
    .withSlug(generateUniqueSlug(workspaceCreate.getName()))
    .withInitialSetupComplete(false)
    .withDisplaySetupWizard(true)
    .withTombstone(false)
    .withDefaultGeography(Geography.AUTO);  // NEW
```

#### Business Value

This feature enabled critical compliance and performance capabilities:

1. **Data Sovereignty**: Organizations can ensure data stays within specific geographic boundaries (EU GDPR compliance, etc.)
2. **Performance**: Sync jobs run closer to data sources/destinations
3. **Regulatory Compliance**: Meet legal requirements for data residency
4. **Flexibility**: 'auto' option allows platform to optimize geography selection
5. **User Control**: Workspace-level default with connection-level override capability

The implementation touched 25 files, updating:
- API schemas for workspace and connection create/update/read operations
- Database persistence layer for reading/writing geography values
- Bootloader to set default geography for initial workspace
- Test fixtures throughout the codebase
- Frontend-facing API endpoints

---

### 5. Cloud-Specific Default Geography Fix

**Commit:** 8b94df3d9d - March 20, 2025
**Impact:** 5 files changed, 42 insertions, 19 deletions

#### What Changed

Fixed a critical bug where Cloud deployments weren't consistently setting the default geography to `US` instead of `AUTO`. This commit centralized geography fixing logic to ensure consistency across all workspace persistence paths.

**Key files modified:**
- `airbyte-commons-server/src/main/kotlin/io/airbyte/commons/server/handlers/helpers/WorkspaceHelpers.kt` (new helper)
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/WorkspacesHandler.java`
- `airbyte-commons-server/src/main/kotlin/io/airbyte/commons/server/handlers/ResourceBootstrapHandler.kt`

#### Implementation Details

**Centralized Geography Fixing Logic:**

```kotlin
/**
 * If the airbyte edition is cloud and the workspace's default geography is AUTO or null,
 * set it to US. If not cloud, set a null default geography to AUTO.
 * This can be removed once default dataplane groups are fully implemented.
 */
fun getWorkspaceWithFixedGeography(
  workspace: StandardWorkspace,
  airbyteEdition: Configs.AirbyteEdition,
): StandardWorkspace {
  workspace.defaultGeography = getDefaultGeographyForAirbyteEdition(
    airbyteEdition,
    workspace.defaultGeography
  )
  return workspace
}

private fun getDefaultGeographyForAirbyteEdition(
  airbyteEdition: Configs.AirbyteEdition,
  geography: Geography?,
): Geography {
  if (airbyteEdition == Configs.AirbyteEdition.CLOUD &&
      (geography == Geography.AUTO || geography == null)) {
    return Geography.US
  } else if (geography == null) {
    return Geography.AUTO
  }
  return geography
}
```

**Application to All Persistence Paths:**

```java
// Workspace update
workspaceService.writeStandardWorkspaceNoSecrets(
  getWorkspaceWithFixedGeography(workspace, airbyteEdition)
);

// Workspace creation with secrets
workspaceService.writeWorkspaceWithSecrets(
  getWorkspaceWithFixedGeography(workspace, airbyteEdition)
);

// Organization update
workspaceService.writeStandardWorkspaceNoSecrets(
  getWorkspaceWithFixedGeography(persistedWorkspace, airbyteEdition)
);
```

**Removed Inconsistent Logic:**

```java
// BEFORE - only applied at creation, not updates
private Geography getDefaultGeographyForAirbyteEdition(final Geography geography) {
  if (airbyteEdition.equals(Configs.AirbyteEdition.CLOUD) && geography == Geography.AUTO) {
    return Geography.US;
  }
  return geography;
}

// AFTER - applied consistently everywhere via helper
```

#### Business Value

This seemingly small fix had significant impact:

1. **Consistency**: Cloud workspaces always use `US` geography unless explicitly overridden
2. **Performance**: Avoids routing Cloud workspaces through auto-selection logic
3. **Correctness**: Fixes bug where updates could revert geography back to AUTO
4. **Maintainability**: Single source of truth for geography logic
5. **Future-Proofing**: Documented as temporary until dataplane groups fully implemented

The commit note "Co-authored-by: jonsspaghetti" indicates this was a collaborative bug fix, likely discovered in production.

---

### 6. SecretStorage API Endpoints by Workspace

**Commit:** 1332a12ed6 - March 18, 2025
**Impact:** 32 files changed, 386 insertions, 62 deletions

#### What Changed

Introduced new API endpoints for fetching secret storage configurations by workspace ID, enabling per-workspace secret management configuration. This involved significant refactoring to introduce a domain layer and move secret-related models out of config-models.

**Key files added:**
- `airbyte-domain/models/src/main/kotlin/io/airbyte/domain/models/IdTypes.kt` (new)
- `airbyte-domain/models/src/main/kotlin/io/airbyte/domain/models/SecretStorage.kt` (moved)
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/secrets/SecretStorageService.kt` (new)
- `airbyte-server/src/main/kotlin/io/airbyte/server/apis/controllers/SecretStorageApiController.kt` (new)

#### Implementation Details

**New Domain Models with Type-Safe IDs:**

```kotlin
// airbyte-domain/models/src/main/kotlin/io/airbyte/domain/models/IdTypes.kt
@JvmInline
value class WorkspaceId(val value: UUID) {
  override fun toString(): String = value.toString()
}

@JvmInline
value class SecretStorageId(val value: UUID) {
  override fun toString(): String = value.toString()
}

@JvmInline
value class OrganizationId(val value: UUID) {
  override fun toString(): String = value.toString()
}
```

**SecretStorage Domain Model:**

```kotlin
data class SecretStorage(
  val id: SecretStorageId? = null,
  val workspaceId: WorkspaceId,
  val type: SecretStorageType,
  val config: SecretConfig,
  val createdAt: OffsetDateTime? = null,
  val updatedAt: OffsetDateTime? = null,
)

enum class SecretStorageType {
  GOOGLE_SM,
  AWS_SM,
  VAULT,
  TESTING_CONFIG_DB_TABLE
}
```

**Domain Service Interface:**

```kotlin
interface SecretStorageService {
  /**
   * Get the secret storage configuration for a workspace.
   * Returns null if no secret storage is configured for the workspace.
   */
  fun getSecretStorageForWorkspace(workspaceId: WorkspaceId): SecretStorage?

  /**
   * Get a secret storage configuration by its ID.
   */
  fun getSecretStorage(secretStorageId: SecretStorageId): SecretStorage

  /**
   * Create or update a secret storage configuration for a workspace.
   */
  fun upsertSecretStorage(secretStorage: SecretStorage): SecretStorage

  /**
   * Delete a secret storage configuration.
   */
  fun deleteSecretStorage(secretStorageId: SecretStorageId)
}
```

**API Controller:**

```kotlin
@Controller("/api/v1/secret_storage")
class SecretStorageApiController(
  private val secretStorageService: SecretStorageService,
) {

  @Post("/get_by_workspace_id")
  fun getSecretStorageByWorkspaceId(
    @Body request: WorkspaceIdRequestBody
  ): SecretStorageRead? {
    val workspaceId = WorkspaceId(request.workspaceId)
    val secretStorage = secretStorageService.getSecretStorageForWorkspace(workspaceId)
    return secretStorage?.let { toApiModel(it) }
  }

  @Post("/get")
  fun getSecretStorage(
    @Body request: SecretStorageIdRequestBody
  ): SecretStorageRead {
    val secretStorageId = SecretStorageId(request.secretStorageId)
    val secretStorage = secretStorageService.getSecretStorage(secretStorageId)
    return toApiModel(secretStorage)
  }
}
```

**OpenAPI Specification Addition:**

```yaml
/v1/secret_storage/get_by_workspace_id:
  post:
    summary: Get secret storage configuration for a workspace
    operationId: getSecretStorageByWorkspaceId
    requestBody:
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/WorkspaceIdRequestBody"
    responses:
      "200":
        description: Secret storage configuration
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/SecretStorageRead"
```

#### Business Value

This refactoring delivered multiple benefits:

1. **Per-Workspace Secret Management**: Different workspaces can use different secret backends (AWS Secrets Manager, Google Secret Manager, Vault)
2. **Type Safety**: Value classes prevent mixing up UUIDs for different entity types
3. **Domain-Driven Design**: Secrets logic moved to dedicated domain layer, improving separation of concerns
4. **API Flexibility**: New endpoints enable secret storage configuration via API
5. **Enterprise Features**: Supports enterprise customers who want workspace-specific secret backends

The large file count (32 files) reflects the architectural significance - this established the pattern for domain services and type-safe IDs that other features would follow.

---

### 7. Users Access Info by Workspace ID

**Commit:** 7c21c5dfd0 - January 25, 2024
**Impact:** 10 files changed, 424 insertions, 30 deletions

#### What Changed

Added a new API endpoint `/users/list_access_info_by_workspace_id` that returns comprehensive information about all users who have access to a specific workspace, including both workspace-level and organization-level permissions.

**Key files added:**
- `airbyte-config/config-models/src/main/resources/types/WorkspaceUserAccessInfo.yaml` (new)
- API endpoint in `config.yaml`

**Key files modified:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/UserHandler.java`
- `airbyte-config/config-persistence/src/main/java/io/airbyte/config/persistence/PermissionPersistence.java`

#### Implementation Details

**WorkspaceUserAccessInfo Model:**

```yaml
---
"$schema": http://json-schema.org/draft-07/schema#
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
    description: Workspace-level permission that grants the user access, if any
    "$ref": Permission.yaml
  organizationPermission:
    description: Organization-level permission that grants the user access, if any
    "$ref": Permission.yaml
```

**Handler Implementation:**

```java
public WorkspaceUserAccessInfoReadList listAccessInfoByWorkspaceId(
    final WorkspaceIdRequestBody workspaceIdRequestBody) throws IOException {
  final UUID workspaceId = workspaceIdRequestBody.getWorkspaceId();
  final List<WorkspaceUserAccessInfo> userAccessInfo =
    userPersistence.listWorkspaceUserAccessInfo(workspaceId);
  return buildWorkspaceUserAccessInfoReadList(userAccessInfo);
}

private WorkspaceUserAccessInfoRead buildWorkspaceUserAccessInfoRead(
    final WorkspaceUserAccessInfo accessInfo) {

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
```

**API Endpoint:**

```yaml
/v1/users/list_access_info_by_workspace_id:
  post:
    tags:
      - user
    summary: List user access info for a particular workspace.
    operationId: listAccessInfoByWorkspaceId
    requestBody:
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/WorkspaceIdRequestBody"
    responses:
      "200":
        description: Successful operation
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/WorkspaceUserAccessInfoReadList"
```

#### Business Value

This endpoint enables critical workspace management capabilities:

1. **Access Management UI**: Frontend can display all users with access to a workspace
2. **Permission Transparency**: Shows both direct (workspace-level) and inherited (organization-level) permissions
3. **Audit Capabilities**: Administrators can see exactly who has access and why
4. **Permission Type Visibility**: Distinguishes between different permission levels (admin, editor, reader)
5. **Compliance**: Supports access review requirements for security audits

The dual permission display (workspace + organization) is particularly valuable because it makes the permission hierarchy transparent to administrators. They can see if someone has access via direct workspace permissions or via their organization role.

---

### 8. Default Workspace Creation for SSO Users

**Commit:** 8c643c4e62 - October 23, 2023
**Impact:** 4 files changed, 212 insertions, 47 deletions

#### What Changed

Implemented automatic default workspace creation when new users authenticate via SSO. This ensures every user has a workspace to work in from their first login, with appropriate permissions assigned based on whether they're the first user in their organization.

**Key files modified:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/UserHandler.java`
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/WorkspacesHandler.java`

#### Implementation Details

**User Creation Flow:**

```java
public UserGetOrCreateByAuthIdResponse getOrCreateUserByAuthId(
    final UserAuthIdRequestBody userAuthIdRequestBody)
    throws JsonValidationException, ConfigNotFoundException, IOException {

  final Optional<User> existingUser =
    userPersistence.getUserByAuthId(userAuthIdRequestBody.getAuthUserId());

  if (existingUser.isPresent()) {
    return new UserGetOrCreateByAuthIdResponse()
        .userRead(buildUserRead(existingUser.get()))
        .newUserCreated(false);
  }

  final User incomingJwtUser = resolveIncomingJwtUser(userAuthIdRequestBody);
  final UserRead createdUser = createUserFromIncomingUser(incomingJwtUser, userAuthIdRequestBody);

  handleUserPermissionsAndWorkspace(createdUser);

  // Refresh the user from DB in case anything changed during permission/workspace modification
  final User updatedUser = userPersistence.getUser(createdUser.getUserId())
      .orElseThrow(() -> new ConfigNotFoundException(ConfigSchema.USER, createdUser.getUserId()));

  return new UserGetOrCreateByAuthIdResponse()
      .userRead(buildUserRead(updatedUser))
      .newUserCreated(true);
}
```

**Permission and Workspace Handling:**

```java
private void handleUserPermissionsAndWorkspace(final UserRead createdUser)
    throws IOException, JsonValidationException, ConfigNotFoundException {

  createInstanceAdminPermissionIfInitialUser(createdUser);
  final Optional<Organization> ssoOrg = getSsoOrganizationIfExists(createdUser.getUserId());

  if (ssoOrg.isPresent()) {
    handleSsoUser(createdUser, ssoOrg.get());
  } else {
    handleNonSsoUser(createdUser);
  }
}

private void handleSsoUser(final UserRead user, final Organization organization)
    throws IOException, JsonValidationException, ConfigNotFoundException {

  final boolean isFirstOrgUser =
    permissionPersistence.listPermissionsForOrganization(organization.getOrganizationId())
      .isEmpty();

  if (isFirstOrgUser) {
    // First user in org becomes admin
    final WorkspaceRead defaultWorkspace =
      createDefaultWorkspaceforUser(user, Optional.of(organization));
    createPermissionForUserAndWorkspace(
      user.getUserId(),
      defaultWorkspace.getWorkspaceId(),
      PermissionType.WORKSPACE_ADMIN
    );
    createPermissionForUserAndOrg(
      user.getUserId(),
      organization.getOrganizationId(),
      PermissionType.ORGANIZATION_ADMIN
    );
  } else {
    // Subsequent users are members
    createPermissionForUserAndOrg(
      user.getUserId(),
      organization.getOrganizationId(),
      PermissionType.ORGANIZATION_MEMBER
    );
  }
}

private void handleNonSsoUser(final UserRead user)
    throws JsonValidationException, ConfigNotFoundException, IOException {

  final WorkspaceRead defaultWorkspace =
    createDefaultWorkspaceforUser(user, Optional.empty());
  createPermissionForUserAndWorkspace(
    user.getUserId(),
    defaultWorkspace.getWorkspaceId(),
    PermissionType.WORKSPACE_ADMIN
  );
}
```

**Default Workspace Creation:**

```java
public WorkspaceRead createDefaultWorkspaceForUser(
    final UserRead user,
    final Optional<Organization> organization)
    throws IOException, JsonValidationException {

  if (user.getDefaultWorkspaceId() != null) {
    throw new IllegalArgumentException(
      String.format("User %s already has a default workspace %s",
        user.getUserId(), user.getDefaultWorkspaceId())
    );
  }

  final String companyName = user.getCompanyName();
  final String email = user.getEmail();
  final Boolean news = user.getNews();

  final WorkspaceCreate workspaceCreate = new WorkspaceCreate()
      .name(getDefaultWorkspaceName(organization, companyName, email))
      .organizationId(organization.map(Organization::getOrganizationId).orElse(null))
      .email(email)
      .news(news)
      .anonymousDataCollection(false)
      .securityUpdates(false)
      .displaySetupWizard(true);

  return createWorkspace(workspaceCreate);
}

private String getDefaultWorkspaceName(
    final Optional<Organization> organization,
    final String companyName,
    final String email) {

  String defaultWorkspaceName = "";

  if (organization.isPresent()) {
    // Use organization name as default workspace name
    defaultWorkspaceName = organization.get().getName().trim();
  }

  // If organization name is not available or empty, use user's company name
  if (defaultWorkspaceName.isEmpty() && companyName != null) {
    defaultWorkspaceName = companyName.trim();
  }

  // If company name is still empty, use user's email
  if (defaultWorkspaceName.isEmpty()) {
    defaultWorkspaceName = email;
  }

  return defaultWorkspaceName;
}
```

#### Business Value

This feature dramatically improved the SSO user onboarding experience:

1. **Zero-Friction Onboarding**: New SSO users immediately have a workspace to use
2. **Smart Permissions**: First org user becomes admin, subsequent users become members
3. **Intuitive Naming**: Workspace named after organization or user's company
4. **Self-Service**: No admin intervention required for new users to start working
5. **Enterprise-Ready**: Proper multi-tenant setup for SSO organizations

The differentiation between first user (admin) and subsequent users (members) is particularly elegant - it ensures the first person from a company can set things up, while later users can't accidentally gain excessive permissions.

---

### 9. Instance Configuration API Workspace Selection

**Commit:** 6b4546f400 - August 31, 2023
**Impact:** 6 files changed, 153 insertions, 99 deletions

#### What Changed

Fixed instance configuration API to properly select the default workspace from the default organization, and removed the requirement for `workspaceId` in the setup request body. This change made instance setup cleaner and more intuitive.

**Key files modified:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/InstanceConfigurationHandler.java`
- `airbyte-api/src/main/openapi/config.yaml`

#### Implementation Details

**API Schema Change:**

```yaml
# BEFORE
InstanceConfigurationSetupRequestBody:
  type: object
  required:
    - workspaceId  # REMOVED
    - email
    - anonymousDataCollection
    - initialSetupComplete
    - displaySetupWizard

# AFTER
InstanceConfigurationSetupRequestBody:
  type: object
  required:
    - email
    - anonymousDataCollection
    - initialSetupComplete
    - displaySetupWizard
```

**Handler Refactoring:**

```java
public InstanceConfigurationResponse getInstanceConfiguration() throws IOException {
  final UUID defaultOrganizationId = getDefaultOrganizationId();
  final StandardWorkspace defaultWorkspace = getDefaultWorkspace(defaultOrganizationId);

  return new InstanceConfigurationResponse()
      .webappUrl(webappUrl)
      .edition(Enums.convertTo(airbyteEdition, EditionEnum.class))
      .licenseType(getLicenseType())
      .auth(getAuthConfiguration())
      .initialSetupComplete(defaultWorkspace.getInitialSetupComplete())
      .defaultUserId(getDefaultUserId())
      .defaultOrganizationId(defaultOrganizationId)
      .defaultWorkspaceId(defaultWorkspace.getWorkspaceId());
}

public InstanceConfigurationResponse setupInstanceConfiguration(
    final InstanceConfigurationSetupRequestBody requestBody)
    throws IOException, JsonValidationException, ConfigNotFoundException {

  final UUID defaultOrganizationId = getDefaultOrganizationId();
  final StandardWorkspace defaultWorkspace = getDefaultWorkspace(defaultOrganizationId);

  // Update the default organization and user with the provided information
  updateDefaultOrganization(requestBody);
  updateDefaultUser(requestBody);

  // Update the underlying workspace to mark the initial setup as complete
  workspacesHandler.updateWorkspace(new WorkspaceUpdate()
      .workspaceId(defaultWorkspace.getWorkspaceId())  // Automatically determined
      .email(requestBody.getEmail())
      .displaySetupWizard(requestBody.getDisplaySetupWizard())
      .anonymousDataCollection(requestBody.getAnonymousDataCollection())
      .initialSetupComplete(requestBody.getInitialSetupComplete()));

  return getInstanceConfiguration();
}
```

**Default Workspace Selection:**

```java
// Historically, instance setup for an OSS installation of Airbyte was stored
// on the one and only workspace that was created for the instance. Now that
// OSS supports multiple workspaces, we use the default Organization ID to
// select a workspace to use for instance setup. This is a hack.
// TODO persist instance configuration to a separate resource, rather than
// using a workspace.
private StandardWorkspace getDefaultWorkspace(final UUID organizationId) throws IOException {
  return workspacePersistence.getDefaultWorkspaceForOrganization(organizationId);
}

private UUID getDefaultOrganizationId() throws IOException {
  return organizationPersistence.getDefaultOrganization()
      .orElseThrow(() -> new IllegalStateException("Default organization does not exist."))
      .getOrganizationId();
}
```

#### Business Value

This refactoring delivered clearer semantics and better user experience:

1. **Simplified API**: Callers no longer need to know which workspace to use for setup
2. **Correct Abstraction**: Instance configuration should be organization-level, not workspace-level
3. **Less Error-Prone**: Removes opportunity for users to pass wrong workspace ID
4. **Migration Path**: Documents that instance config should eventually move away from workspace storage
5. **OSS Support**: Works correctly now that OSS supports multiple workspaces

The comment explicitly documenting this as a "hack" and including a TODO is excellent engineering practice - it acknowledges technical debt while providing a workable solution.

---

## Technical Evolution

The commits tell a story of systematic workspace management maturation across multiple dimensions:

### Phase 1: Foundation - Geography Support (2022)

- **October 2022**: Added geography support for workspaces and connections (fb9efb378d)

This phase established the foundation for data sovereignty and regional compliance, critical for enterprise adoption.

### Phase 2: Configuration & Setup (2023)

- **August 2023**: Fixed instance configuration workspace selection (6b4546f400)
- **October 2023**: Automated default workspace creation for SSO users (8c643c4e62)
- **November 2023**: Added organization info API endpoint (4efe207a80)

This phase focused on improving setup workflows and SSO integration.

### Phase 3: Access Control & Permissions (2024)

- **January 2024**: Added users access info by workspace endpoint (7c21c5dfd0)
- **May 2024**: Required admin role for workspace create/delete (46e4b56aa4)

This phase strengthened access control and audit capabilities.

### Phase 4: Cloud Hardening (2025 Q1)

- **March 2025**: Fixed Cloud-specific default geography (8b94df3d9d)
- **March 2025**: Added SecretStorage workspace-level APIs (1332a12ed6)
- **April 2025**: Fixed workspaceId handling in spec jobs (da18ef85da)

This phase addressed production issues and enabled per-workspace secrets management.

### Phase 5: Permission-Based Filtering (2025 Q3)

- **August 2025**: Implemented workspace filtering by user permission (1fa14d6294, e86acfe10b)
- **August 2025**: Allowed workspace-level users to access org info (d2991e202e)
- **September 2025**: Validated dataplane group assignments (205afe57c0)

This phase delivered fine-grained access control and multi-tenant security.

### Technology Choices

The evolution shows deliberate architectural decisions:

- **Java → Kotlin**: Later workspace code increasingly in Kotlin for null safety and expressiveness
- **Monolithic → Layered**: Clear separation of persistence, service, handler, and controller layers
- **Type Safety**: Introduction of value classes (WorkspaceId, OrganizationId) in domain layer
- **Permission Hierarchy**: SQL CTEs for efficient permission-based filtering
- **Domain-Driven Design**: SecretStorage refactoring established domain service pattern

---

## Impact Summary

Parker's contributions to Workspace Management represent the implementation of a complete multi-tenant workspace system for Airbyte, enabling the platform to support enterprise customers with complex organizational structures, compliance requirements, and security policies.

### Quantitative Impact

- **33 commits** over nearly 3 years
- **~5,500 lines** of code changes
- **Major features delivered:**
  - Geography/region support for data sovereignty
  - Permission-based workspace filtering
  - Dataplane group validation
  - Workspace-level secret storage
  - Default workspace creation for SSO users
  - Comprehensive workspace access management APIs

### Qualitative Impact

**For Users:**
- Seamless onboarding with automatic workspace creation
- Fine-grained visibility (only see workspaces they can access)
- Geographic control over where data syncs execute
- Clear understanding of who has access to their workspaces
- Self-service workspace management

**For Developers:**
- Clean layered architecture (persistence → service → handler → controller)
- Type-safe IDs prevent mixing workspace/organization/user UUIDs
- Comprehensive test coverage (414 lines in WorkspacePersistenceTest alone)
- Well-documented edge cases and TODOs
- Reusable permission filtering patterns

**For the Platform:**
- Scalable multi-tenant workspace architecture
- Production-hardened geography handling
- Security-focused dataplane group validation
- Audit-ready access info endpoints
- Extensible secret storage per workspace

### Key Architectural Patterns

The work established several important patterns:

1. **Two-Phase Permission Queries**: Separate "get accessible IDs" from "fetch data" for performance
2. **Geography Fixing Helper**: Centralized logic to handle Cloud vs OSS geography defaults
3. **Value Class IDs**: Type-safe UUIDs prevent passing wrong entity IDs
4. **Default Resource Selection**: Organization-based selection of default workspace
5. **Permission-Aware Listing**: Every list endpoint respects user permissions
6. **SSO Auto-Provisioning**: Automatic resource creation for authenticated users

### Security Improvements

1. **Workspace Visibility**: Users can't see workspaces they don't have access to
2. **Dataplane Validation**: Prevents unauthorized dataplane group assignments
3. **Role Requirements**: Workspace create/delete requires admin permissions
4. **Permission Transparency**: Access info endpoint shows exactly who has access and why
5. **Organization Boundaries**: Geography and dataplane groups respect org boundaries

### Compliance Enablement

1. **Data Sovereignty**: Geography support enables GDPR and other regional compliance
2. **Access Auditing**: Detailed permission tracking for security audits
3. **Workspace Isolation**: Per-workspace secret storage supports multi-tenant compliance
4. **Permission Hierarchy**: Clear chain of authority for access control
5. **Tombstone Support**: Soft delete for compliance retention requirements

This foundation enables Airbyte to support enterprise customers with complex compliance requirements, multi-region deployments, and sophisticated access control needs while maintaining a clean, maintainable codebase.
