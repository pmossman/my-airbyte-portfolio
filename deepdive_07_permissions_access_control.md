# Permissions & Access Control - Deep Dive

## Overview

This document analyzes Parker Mossman's contributions to the Permissions & Access Control area of the airbyte-platform repository. This work spans from May 2023 to October 2025, encompassing 34 commits that built Airbyte's comprehensive Role-Based Access Control (RBAC) system, permission hierarchy, authorization enforcement, and access validation mechanisms.

**Period:** May 17, 2023 - October 16, 2025 (29 months)
**Total Commits:** 34
**Total Changes:** ~8,500 lines of code
**Key Technologies:** Java, Kotlin, Micronaut Data, JOOQ, Micronaut Security

---

## Key Architectural Changes

### 1. Micronaut Data PermissionService with Redundancy Prevention

**Commit:** 1e4b2ec621 - April 2, 2024
**Impact:** 25 files changed, 1,112 insertions, 540 deletions

#### What Changed

This foundational commit introduced a complete reimplementation of the permission service layer using Micronaut Data, replacing the JOOQ-based persistence layer. The key innovation was automatic prevention of redundant permission records based on permission hierarchy.

**Key files added:**
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/PermissionService.kt` (interface)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/impls/data/PermissionServiceDataImpl.kt` (implementation)
- `airbyte-data/src/test/kotlin/io/airbyte/data/services/impls/data/PermissionServiceDataImplTest.kt` (595 lines of tests)

**Key files removed:**
- `airbyte-config/config-persistence/src/main/java/io/airbyte/config/persistence/PermissionPersistence.java` (123 lines)

#### Implementation Details

The service interface defined core operations with specialized exceptions:

```kotlin
interface PermissionService {
  /**
   * Get all permissions for a given user.
   */
  fun getPermissionsForUser(userId: UUID): List<Permission>

  /**
   * Delete a permission by its unique id.
   */
  @Throws(RemoveLastOrgAdminPermissionException::class)
  fun deletePermission(permissionId: UUID)

  /**
   * Create a permission.
   */
  @Throws(PermissionRedundantException::class)
  fun createPermission(permission: Permission): Permission

  /**
   * Update a permission
   */
  @Throws(RemoveLastOrgAdminPermissionException::class)
  fun updatePermission(permission: Permission)
}
```

The implementation intelligently prevents redundant permissions:

```kotlin
@Transactional("config")
override fun createPermission(permission: Permission): Permission {
  val existingUserPermissions = getPermissionsForUser(permission.userId).toSet()

  // throw if new permission would be redundant
  if (isRedundantWorkspacePermission(permission, existingUserPermissions)) {
    throw PermissionRedundantException(
      "Permission type ${permission.permissionType} would be redundant for user ${permission.userId}. Preventing creation.",
    )
  }

  // remove any permissions that would be made redundant by adding in the new permission
  deletePermissionsMadeRedundantByPermission(permission, existingUserPermissions)

  return permissionRepository.save(permission.toEntity()).toConfigModel()
}

private fun isRedundantWorkspacePermission(
  permission: Permission,
  existingUserPermissions: Set<Permission>,
): Boolean {
  // only workspace permissions can be redundant
  val workspaceId = permission.workspaceId ?: return false

  // if the workspace is not in an organization, it cannot have redundant permissions
  val orgIdForWorkspace = workspaceService.getOrganizationIdFromWorkspaceId(workspaceId).orElse(null) ?: return false

  // if the user has no org-level permission, the workspace permission cannot be redundant
  val existingOrgPermission = existingUserPermissions.find { it.organizationId == orgIdForWorkspace } ?: return false

  // if the new permission is less than or equal to the existing org-level permission, it is redundant
  return getAuthority(permission.permissionType) <= getAuthority(existingOrgPermission.permissionType)
}
```

The service also protects against removing the last organization admin:

```kotlin
private fun throwIfDeletingLastOrgAdmin(permissionIdsToDelete: List<UUID>) {
  // get all org admin permissions being deleted, if any
  val deletedOrgAdminPermissions =
    permissionRepository.findByIdIn(permissionIdsToDelete).filter {
      it.permissionType == PermissionType.organization_admin
    }

  // group deleted org admin permission IDs by organization ID
  val orgIdToDeletedOrgAdminPermissionIds = deletedOrgAdminPermissions.groupBy({ it.organizationId!! }, { it.id!! })

  // for each group, make sure the last org-admin isn't being deleted
  orgIdToDeletedOrgAdminPermissionIds.forEach {
      (orgId, deletedOrgAdminIds) ->
    throwIfDeletingLastOrgAdminForOrg(orgId, deletedOrgAdminIds.toSet())
  }
}

private fun throwIfDeletingLastOrgAdminForOrg(
  orgId: UUID,
  deletedOrgAdminPermissionIds: Set<UUID>,
) {
  // get all other permissions for the organization that are not being deleted
  val otherOrgPermissions = permissionRepository.findByOrganizationId(orgId).filter { it.id !in deletedOrgAdminPermissionIds }

  // if there are no other org-admin permissions remaining in the org, throw an exception
  if (otherOrgPermissions.none { it.permissionType == PermissionType.organization_admin }) {
    throw RemoveLastOrgAdminPermissionException("Cannot delete the last admin in Organization $orgId.")
  }
}
```

#### Business Value

This change delivered multiple critical benefits:

1. **Data Integrity**: Automatic prevention of redundant permission records keeps the database clean
2. **Performance**: Fewer permission records means faster queries when checking access
3. **User Experience**: Users with org-level permissions automatically get workspace access without manual permission creation
4. **Safety**: Protection against accidentally removing all admins from an organization
5. **Reduced Errors**: Frontend applications no longer need to check for redundancy before creating permissions
6. **Comprehensive Testing**: 595 lines of tests ensure correctness across all edge cases

The redundancy prevention logic understands that:
- If a user has `ORGANIZATION_ADMIN`, they don't need explicit `WORKSPACE_ADMIN` permissions for workspaces in that org
- If a user has `ORGANIZATION_EDITOR`, they don't need `WORKSPACE_EDITOR` permissions for workspaces in that org
- Workspace permissions outside an organization context are never redundant

#### Related Commits

- e7490ddf1c (May 17, 2023): Added User and Permission tables to OSS ConfigsDb
- acc3e7f37e (Oct 25, 2023): Validate Permission API create/update calls

---

### 2. Hierarchical Permission Model with Org-Level Access

**Commit:** 630ae7e7c9 - October 16, 2023
**Impact:** 5 files changed, 557 insertions, 27 deletions

#### What Changed

This foundational commit introduced the hierarchical permission inheritance system, allowing organization-level permissions to automatically grant workspace-level access. The centerpiece was the `PermissionHelper` class with its comprehensive permission hierarchy map.

**Key files added:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/helpers/PermissionHelper.java` (75 lines)

**Key files modified:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/PermissionHandler.java` (updated to use hierarchy)
- `airbyte-commons-server/src/test/java/io/airbyte/commons/server/handlers/PermissionHandlerTest.java` (359 new test lines)

#### Implementation Details

The core innovation was the permission hierarchy map:

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

    // Organization reader grants access to just the organization reader permission, and also
    // workspace-reader permissions for workspaces within the organization.
    PermissionType.ORGANIZATION_READER, Set.of(
        PermissionType.ORGANIZATION_READER,
        PermissionType.WORKSPACE_READER),

    // Workspace owner (deprecated) is equivalent to workspace admin
    PermissionType.WORKSPACE_OWNER, Set.of(
        PermissionType.WORKSPACE_OWNER,
        PermissionType.WORKSPACE_ADMIN,
        PermissionType.WORKSPACE_EDITOR,
        PermissionType.WORKSPACE_READER),

    // Workspace admin grants access to all workspace-admin-and-lower permissions.
    PermissionType.WORKSPACE_ADMIN, Set.of(
        PermissionType.WORKSPACE_OWNER,
        PermissionType.WORKSPACE_ADMIN,
        PermissionType.WORKSPACE_EDITOR,
        PermissionType.WORKSPACE_READER),

    // Workspace editor grants access to all workspace-editor-and-lower permissions.
    PermissionType.WORKSPACE_EDITOR, Set.of(
        PermissionType.WORKSPACE_EDITOR,
        PermissionType.WORKSPACE_READER),

    // Workspace reader grants access to just the workspace reader permission.
    PermissionType.WORKSPACE_READER, Set.of(
        PermissionType.WORKSPACE_READER));

public static boolean definedPermissionGrantsTargetPermission(final PermissionType definedPermission, final PermissionType targetPermission) {
  return GRANTED_PERMISSION_TYPES_BY_DEFINED_PERMISSION_TYPE.get(definedPermission).contains(targetPermission);
}
```

This enabled a single check method to determine access across the entire hierarchy. The PermissionHandler was enhanced to check both workspace-level and organization-level permissions when validating access.

#### Business Value

This change was transformative for Airbyte's multi-tenant architecture:

1. **Scalability**: Organizations can have thousands of workspaces without creating thousands of permission records per user
2. **Simplified Management**: Granting organization-level access automatically cascades to all current and future workspaces
3. **Intuitive Model**: Matches real-world organizational hierarchies where org admins naturally have access to all workspaces
4. **Performance**: Permission checks became faster - single org-level permission query vs. checking every workspace
5. **Foundation for SSO**: Enabled SSO users to be granted organization-level access that automatically covered all workspaces
6. **Clear Authority**: Explicit mapping of which roles grant which permissions eliminates ambiguity

The hierarchical model established three clear permission levels:
- **Instance Admin**: Full access to everything (all organizations, all workspaces)
- **Organization-Level**: Access scoped to organization and all workspaces within
- **Workspace-Level**: Access scoped to specific workspaces only

#### Related Commits

- 62cb0c0af2 (Oct 18, 2023): Leveraged org-level permissions in workspace listing APIs
- b445cfc886 (Oct 23, 2023): Added RBAC roles in CloudAuthProvider

---

### 3. Instance Admin Permission-Based Roles

**Commit:** 938e4bdc38 - December 6, 2023
**Impact:** 8 files changed, 310 insertions, 129 deletions

#### What Changed

This commit replaced the universal `instance_admin` role with a permission-based role system in OSS. Instead of assigning a global "instance_admin" role to authenticated users, the system now checks for an actual `INSTANCE_ADMIN` permission record in the database.

**Key files modified:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/support/RbacRoleHelper.java` (major refactor)
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/support/AuthenticationHeaderResolver.java` (added SELF role support)
- `airbyte-server-pro/src/main/java/io/airbyte/server/pro/KeycloakTokenValidator.java` (simplified to use new approach)

#### Implementation Details

The RbacRoleHelper was enhanced to check for instance admin permissions:

```java
public Collection<String> getRbacRoles(final String authUserId, final HttpRequest<?> request) {
  final Map<String, String> headerMap = request.getHeaders().asMap(String.class, String.class);

  final List<UUID> workspaceIds = headerResolver.resolveWorkspace(headerMap);
  final List<UUID> organizationIds = headerResolver.resolveOrganization(headerMap);
  final String targetAuthUserId = headerResolver.resolveUserAuthId(headerMap);

  final Set<String> roles = new HashSet<>();

  if (workspaceIds != null && !workspaceIds.isEmpty()) {
    roles.addAll(getWorkspaceAuthRoles(authUserId, workspaceIds));
  }
  if (organizationIds != null && !organizationIds.isEmpty()) {
    roles.addAll(getOrganizationAuthRoles(authUserId, organizationIds));
  }
  if (targetAuthUserId != null && targetAuthUserId.equals(authUserId)) {
    roles.add(AuthRoleConstants.SELF);
  }

  // Check for instance admin permission in database
  try {
    if (permissionPersistence.isAuthUserInstanceAdmin(authUserId)) {
      roles.addAll(getInstanceAdminRoles());
    }
  } catch (final IOException ex) {
    log.error("Failed to get instance admin roles for user {}", authUserId, ex);
    throw new RuntimeException(ex);
  }

  return roles;
}

private static Set<String> getInstanceAdminRoles() {
  final Set<String> roles = new HashSet<>();
  roles.addAll(AuthRole.buildAuthRolesSet(AuthRole.ADMIN));
  roles.addAll(WorkspaceAuthRole.buildWorkspaceAuthRolesSet(WorkspaceAuthRole.WORKSPACE_ADMIN));
  roles.addAll(OrganizationAuthRole.buildOrganizationAuthRolesSet(OrganizationAuthRole.ORGANIZATION_ADMIN));
  // For now, SELF is intentionally excluded from instance admin roles. If a user-centric endpoint
  // should be callable by an instance admin, then the endpoint should be annotated with ADMIN in addition to SELF.
  return roles;
}
```

This also added support for the `SELF` role, which allows users to access their own user-specific endpoints:

```java
final String targetAuthUserId = headerResolver.resolveUserAuthId(headerMap);
if (targetAuthUserId != null && targetAuthUserId.equals(authUserId)) {
  roles.add(AuthRoleConstants.SELF);
}
```

#### Business Value

This architectural change delivered several benefits:

1. **Database-Driven Access**: Instance admin status is now controlled by permission records, not hardcoded logic
2. **Auditability**: All access control decisions are based on database records that can be audited
3. **Flexibility**: Multiple users can be instance admins by creating permission records
4. **Consistency**: Instance admin works the same way as other permission types
5. **SELF Role**: Users can access their own data through user-centric endpoints
6. **Simplified Enterprise**: Removed special-case logic from Enterprise/Pro editions

The commit also cleaned up Keycloak token validation logic, removing 78 lines of complex role-mapping code that was no longer needed.

#### Related Commits

- 443288e05b (Nov 14, 2023): Migration to add instance_admin permission record for default user
- a89ad02d1f (Feb 23, 2024): Fix worker auth to use all instance admin roles

---

### 4. Permission-Based Workspace Filtering

**Commit:** 1fa14d6294 - August 27, 2025
**Impact:** 6 files changed, 607 insertions, 2 deletions

#### What Changed

Added permission-based filtering to the `workspaces/list_by_organization_id` endpoint, ensuring users only see workspaces they have explicit access to within an organization. This replaced the previous behavior where organization membership granted visibility to all workspaces.

**Key files modified:**
- `airbyte-config/config-persistence/src/main/kotlin/io/airbyte/config/persistence/WorkspacePersistence.kt`
- `airbyte-config/config-persistence/src/main/kotlin/io/airbyte/config/persistence/PermissionPersistenceHelper.kt`
- `airbyte-commons-server/src/main/kotlin/io/airbyte/commons/server/handlers/WorkspacesHandler.kt`

#### Implementation Details

A new SQL query was added that respects fine-grained user permissions:

```kotlin
const val LIST_WORKSPACES_IN_ORGANIZATION_BY_USER_ID_AND_PERMISSION_TYPES_QUERY: String = (
  "WITH " +
    " userOrg AS (" +
    "   SELECT organization_id FROM permission WHERE user_id = {0} AND permission_type = ANY({1}::permission_type[])" +
    " )," +
    " userWorkspaces AS (" +
    "   SELECT workspace.id AS workspace_id FROM userOrg JOIN workspace" +
    "   ON workspace.organization_id = userOrg.organization_id" +
    "   WHERE workspace.organization_id = {2}" +
    "   UNION" +
    "   SELECT workspace_id FROM permission WHERE user_id = {0} AND permission_type = ANY({1}::permission_type[])" +
    "   AND workspace_id IN (SELECT id FROM workspace WHERE organization_id = {2})" +
    " )" +
    " SELECT workspace.* " +
    " FROM workspace" +
    " WHERE workspace.id IN (SELECT workspace_id from userWorkspaces)" +
    " AND workspace.organization_id = {2}" +
    " AND workspace.name ILIKE {3}" +
    " AND workspace.tombstone = false" +
    " ORDER BY workspace.name ASC"
)
```

This query intelligently handles three scenarios:

1. **Organization-Level Permissions**: If user has org-level permission (admin/editor/reader), they see all workspaces in the org
2. **Workspace-Level Permissions**: If user only has workspace-level permissions, they see only those specific workspaces
3. **Instance Admin**: Instance admins see all workspaces (handled by the query being skipped for instance admins)

The handler method was updated to use the new query:

```kotlin
fun listWorkspacesInOrganizationForUser(
  userId: UUID,
  request: ListWorkspacesInOrganizationRequestBody,
): WorkspaceReadList {
  val nameContains = Optional.ofNullable(request.nameContains)
  val standardWorkspaces = workspacePersistence
    .listWorkspacesInOrganizationByUserId(
      organizationId = request.organizationId,
      userId = userId,
      keyword = nameContains,
    )

  return WorkspaceReadList()
    .workspaces(standardWorkspaces.map { WorkspaceConverter.domainToApiModel(it) })
}
```

#### Business Value

This change was critical for implementing proper access control:

1. **Security**: Users can no longer see workspaces they don't have access to, even within their organization
2. **Principle of Least Privilege**: Enforced proper zero-trust access control at the API level
3. **Compliance**: Meets security audit requirements for data isolation between teams
4. **Performance**: Reduced data transfer for users with limited workspace access
5. **User Experience**: Cleaner workspace lists showing only workspaces users can actually use
6. **Fine-Grained Control**: Organizations can now create workspaces for specific teams without exposing them to the entire org

This reflected a significant maturity in the RBAC system - moving from "organization membership = see everything" to "see only what you have permission to access."

#### Related Commits

- 72aaef63bf (Aug 27, 2025): Include organizations for users that come from non-organization permission records
- d2991e202e (Aug 29, 2025): Allow workspace-level users to call `organizations/get_organization_info`

---

### 5. RBAC Role Annotations Replace @SecuredWorkspace

**Commit:** 78cddd9b44 - February 13, 2024
**Impact:** 21 files changed, 231 insertions, 271 deletions

#### What Changed

This commit removed the `@SecuredWorkspace` annotation in favor of fine-grained RBAC role annotations like `@Secured({WORKSPACE_EDITOR, ORGANIZATION_EDITOR})`. This replaced coarse-grained workspace security with explicit role-based authorization.

**Key files modified:**
- 21 API controller files across the codebase
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/support/RbacRoleHelper.java`

#### Implementation Details

Before this change, endpoints were secured like this:

```java
@Post(uri = "/create")
@Secured({EDITOR, WORKSPACE_EDITOR, ORGANIZATION_EDITOR})
@SecuredWorkspace
@ExecuteOn(AirbyteTaskExecutors.SCHEDULER)
public ConnectionRead createConnection(@Body final ConnectionCreate connectionCreate) {
  return ApiHelper.execute(() -> connectionsHandler.createConnection(connectionCreate));
}
```

After this change, the same endpoint became:

```java
@Post(uri = "/create")
@Secured({WORKSPACE_EDITOR, ORGANIZATION_EDITOR})
@ExecuteOn(AirbyteTaskExecutors.SCHEDULER)
public ConnectionRead createConnection(@Body final ConnectionCreate connectionCreate) {
  return ApiHelper.execute(() -> connectionsHandler.createConnection(connectionCreate));
}
```

The key differences:

1. **Removed `@SecuredWorkspace`**: No longer needed as RBAC roles already check workspace access
2. **Removed generic `EDITOR`/`READER`**: Replaced with specific `WORKSPACE_EDITOR`, `ORGANIZATION_EDITOR`, etc.
3. **Clearer Intent**: Immediately obvious which roles can access each endpoint
4. **Hierarchical**: Organization roles automatically grant workspace access

The RbacRoleHelper was enhanced to properly map permissions to roles:

```java
private Set<String> getWorkspaceAuthRoles(final String authUserId, final List<UUID> workspaceIds) {
  final Optional<WorkspaceAuthRole> minAuthRoleOptional = workspaceIds.stream()
      .map(workspaceId -> fetchWorkspacePermission(authUserId, workspaceId))
      .filter(Objects::nonNull)
      .map(this::convertToWorkspaceAuthRole)
      .filter(Objects::nonNull)
      .min(Comparator.naturalOrder());
  final WorkspaceAuthRole authRole = minAuthRoleOptional.orElse(WorkspaceAuthRole.NONE);
  return WorkspaceAuthRole.buildWorkspaceAuthRolesSet(authRole);
}
```

This finds the minimum (highest authority) role across all requested workspaces and grants all roles up to that level.

#### Business Value

This migration delivered significant improvements:

1. **Explicit Authorization**: Each endpoint clearly declares which roles can access it
2. **Type Safety**: Compile-time checking of role names prevents typos
3. **Removed Redundancy**: `@SecuredWorkspace` was redundant with RBAC role checks
4. **Better Documentation**: Developers can see authorization requirements without looking at separate security configs
5. **Simplified Debugging**: Authorization failures clearly indicate which role is required
6. **Consistent Pattern**: All endpoints follow the same authorization pattern

The commit touched 21 controller files, systematically updating authorization across:
- Connection endpoints
- Source/Destination endpoints
- Workspace endpoints
- Job endpoints
- User invitation endpoints
- WebBackend endpoints

This established the standard pattern for authorization that all new endpoints would follow.

#### Related Commits

- 9d64b6df75 (Feb 13, 2024): Revert of this change (temporarily rolled back)
- cc3010471c (Nov 14, 2023): Initial addition of @Secured annotations to OSS API endpoints

---

### 6. Enterprise Actor Definition Access Validation

**Commit:** 7c29af659d - December 5, 2023
**Impact:** 9 files changed, 281 insertions, 4 deletions

#### What Changed

Added access validation for actor definition (source/destination connector) endpoints in Enterprise edition. This introduced a validator interface with separate implementations for Community and Enterprise editions.

**Key files added:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/validation/ActorDefinitionAccessValidator.java` (interface)
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/validation/CommunityActorDefinitionAccessValidator.java`
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/validation/EnterpriseActorDefinitionAccessValidator.java`

#### Implementation Details

The interface defined a single validation method:

```java
public interface ActorDefinitionAccessValidator {
  /**
   * Validate that the current user has write access to the given actor definition.
   */
  void validateWriteAccess(UUID actorDefinitionId) throws ApplicationErrorKnownException;
}
```

The Community edition implementation allows all access:

```java
@Singleton
@Requires(missing = "airbyte.edition.pro.enabled")
public class CommunityActorDefinitionAccessValidator implements ActorDefinitionAccessValidator {
  @Override
  public void validateWriteAccess(final UUID actorDefinitionId) throws ApplicationErrorKnownException {
    // In Community edition, all users have write access to all actor definitions.
    // No validation needed.
  }
}
```

The Enterprise edition implementation enforces permission checks:

```java
@Singleton
@RequiresAirbyteProEnabled
@Replaces(CommunityActorDefinitionAccessValidator.class)
public class EnterpriseActorDefinitionAccessValidator implements ActorDefinitionAccessValidator {

  private final PermissionPersistence permissionPersistence;
  private final SecurityService securityService;

  @Override
  public void validateWriteAccess(final UUID actorDefinitionId) throws ApplicationErrorKnownException {
    try {
      final String authId = securityService.username().orElse(null);

      // instance admin always has write access
      if (permissionPersistence.isAuthUserInstanceAdmin(authId)) {
        return;
      }

      // In Enterprise, an organization_admin also has write access to all actor definitions, because
      // Enterprise only supports the default organization, and an admin of the org should have write
      // access to all actor definitions within the instance.
      final PermissionType defaultOrgPermissionType =
          permissionPersistence.findPermissionTypeForUserAndOrganization(OrganizationPersistence.DEFAULT_ORGANIZATION_ID, authId);

      if (defaultOrgPermissionType.equals(PermissionType.ORGANIZATION_ADMIN)) {
        return;
      }

      // if we haven't returned by now, the user does not have write access.
      throw new ApplicationErrorKnownException(
          "User with auth ID " + authId + " does not have write access to actor definition " + actorDefinitionId);
    } catch (final Exception e) {
      throw new ApplicationErrorKnownException("Could not validate user access to actor definition " + actorDefinitionId + " due to error", e);
    }
  }
}
```

This validator is injected into API controllers:

```java
@Post("/create_custom")
@Secured({ADMIN})
public DestinationDefinitionRead createCustomDestinationDefinition(
    @Body final CustomDestinationDefinitionCreate customDestinationDefinitionCreate) {
  // Validate write access before allowing custom definition creation
  actorDefinitionAccessValidator.validateWriteAccess(customDestinationDefinitionCreate.getDestinationDefinition().getDestinationDefinitionId());

  return ApiHelper.execute(() -> destinationDefinitionsHandler.createCustomDestinationDefinition(customDestinationDefinitionCreate));
}
```

#### Business Value

This addition provided important security benefits:

1. **Connector Management Security**: Protected global connector definitions from unauthorized modification
2. **Edition-Specific Logic**: Different validation rules for Community vs Enterprise without code duplication
3. **Custom Connectors**: Ensured only authorized users can create/modify custom connector definitions
4. **Instance Admin Control**: Instance admins can manage all connectors
5. **Org Admin Delegation**: Organization admins in Enterprise can manage connectors for their org
6. **Extensibility**: Interface-based design allows future addition of workspace-scoped custom connectors

The validator pattern established a clean separation between access control logic and business logic, with Micronaut's `@Replaces` annotation enabling seamless swapping of implementations based on edition.

#### Related Commits

- None directly related (standalone feature)

---

### 7. Keycloak Access Token Interceptor for Client Credentials Flow

**Commit:** 21d6309e04 - August 14, 2024
**Impact:** 4 files changed, 121 insertions, 4 deletions

#### What Changed

Added an HTTP interceptor that automatically adds Keycloak access tokens to outgoing API requests using the OAuth2 client credentials flow. This enables service-to-service authentication within the Airbyte platform.

**Key files added:**
- `airbyte-api/commons/src/main/kotlin/io/airbyte/api/client/auth/KeycloakAccessTokenInterceptor.kt`
- `airbyte-api/commons/src/test/kotlin/io/airbyte/api/client/auth/KeycloakAccessTokenInterceptorTest.kt`

#### Implementation Details

The interceptor integrates with Micronaut's OAuth2 client credentials support:

```kotlin
/**
 * Interceptor that adds an access token to the request headers using the Keycloak client credentials flow.
 * Only enabled when the current application is configured with a Keycloak oauth2 client.
 * Micronaut will automatically inject the @Named client credentials client bean based on the
 * `micronaut.security.oauth2.clients.keycloak.*` properties that this interceptor requires.
 */
@Singleton
@Requires(property = "micronaut.security.oauth2.clients.keycloak.client-id", pattern = ".+")
@Requires(property = "micronaut.security.oauth2.clients.keycloak.client-secret", pattern = ".+")
@Requires(property = "micronaut.security.oauth2.clients.keycloak.openid.issuer", pattern = ".+")
class KeycloakAccessTokenInterceptor(
  @Named("keycloak") private val clientCredentialsClient: ClientCredentialsClient,
) : AirbyteApiInterceptor {

  override fun intercept(chain: Interceptor.Chain): Response =
    try {
      logger.debug { "Intercepting request to add Keycloak access token..." }
      val originalRequest: Request = chain.request()
      val builder: Request.Builder = originalRequest.newBuilder()

      // Request access token from Keycloak
      val tokenResponse = Mono.from(clientCredentialsClient.requestToken()).block()
      val accessToken = tokenResponse?.accessToken

      if (accessToken != null) {
        builder.addHeader(HttpHeaders.AUTHORIZATION, "Bearer $accessToken")
        logger.debug { "Added access token to header $accessToken" }
        chain.proceed(builder.build())
      } else {
        logger.error { "Failed to obtain access token from Keycloak" }
        chain.proceed(originalRequest)
      }
    } catch (e: Exception) {
      logger.error(e) { "Failed to add Keycloak access token to request" }
      // do not throw exception, just proceed with the original request and let the request fail
      // authorization downstream.
      chain.proceed(chain.request())
    }
}
```

The interceptor is conditionally enabled based on Micronaut configuration:

```kotlin
@Requires(property = "micronaut.security.oauth2.clients.keycloak.client-id", pattern = ".+")
@Requires(property = "micronaut.security.oauth2.clients.keycloak.client-secret", pattern = ".+")
@Requires(property = "micronaut.security.oauth2.clients.keycloak.openid.issuer", pattern = ".+")
```

This means it only activates when Keycloak OAuth2 is properly configured, making it safe to include in all deployments.

#### Business Value

This interceptor solved a critical service-to-service authentication problem:

1. **Automatic Authentication**: Services no longer need to manually obtain and manage access tokens
2. **Client Credentials Flow**: Standard OAuth2 pattern for machine-to-machine authentication
3. **Graceful Degradation**: If token acquisition fails, the request proceeds without throwing exceptions (fail downstream)
4. **Conditional Activation**: Only active when Keycloak is configured, safe for all deployment types
5. **Transparent**: Application code doesn't need to know about token management
6. **Token Refresh**: Micronaut's client credentials client handles token caching and refresh automatically

This enabled Worker processes, Cron jobs, and other background services to make authenticated API calls to the Airbyte server without requiring user credentials.

#### Related Commits

- None directly related (standalone feature)

---

### 8. Workspace Admin Required for Create/Delete Operations

**Commit:** 46e4b56aa4 - May 23, 2024
**Impact:** 2 files changed, 13 insertions, 8 deletions

#### What Changed

Tightened security requirements for workspace creation and deletion, changing from requiring `ORGANIZATION_EDITOR` role to requiring `ORGANIZATION_ADMIN` role. This prevents editors from creating or deleting workspaces, limiting those operations to administrators.

**Key files modified:**
- `airbyte-commons-server/src/main/kotlin/io/airbyte/commons/server/handlers/ResourceBootstrapHandler.kt`
- `airbyte-server/src/main/java/io/airbyte/server/apis/WorkspaceApiController.java`

#### Implementation Details

The workspace creation security check was updated:

```kotlin
// Before:
val allowedRoles = setOf(OrganizationAuthRole.ORGANIZATION_ADMIN, OrganizationAuthRole.ORGANIZATION_EDITOR)
apiAuthorizationHelper.ensureUserHasAnyRequiredRoleOrThrow(Scope.ORGANIZATION, listOf(organization.organizationId.toString()), allowedRoles)

// After:
apiAuthorizationHelper.ensureUserHasAnyRequiredRoleOrThrow(
  Scope.ORGANIZATION,
  listOf(organization.organizationId.toString()),
  setOf(OrganizationAuthRole.ORGANIZATION_ADMIN),
)
```

The API controller annotations were also updated:

```java
// Before:
@Post("/delete")
@Secured({WORKSPACE_EDITOR, ORGANIZATION_EDITOR})
@Override
@Status(HttpStatus.NO_CONTENT)
public void deleteWorkspace(@Body final WorkspaceIdRequestBody workspaceIdRequestBody) {
  // ...
}

// After:
@Post("/delete")
@Secured({WORKSPACE_ADMIN, ORGANIZATION_ADMIN})
@Override
@Status(HttpStatus.NO_CONTENT)
public void deleteWorkspace(@Body final WorkspaceIdRequestBody workspaceIdRequestBody) {
  // ...
}
```

Permission checks in workspace creation were similarly updated:

```java
if (workspaceCreate.getOrganizationId() != null) {
  final StatusEnum permissionCheckStatus = permissionHandler.checkPermissions(new PermissionCheckRequest()
      .userId(currentUserService.getCurrentUser().getUserId())
      .permissionType(PermissionType.ORGANIZATION_ADMIN)  // Changed from ORGANIZATION_EDITOR
      .organizationId(workspaceCreate.getOrganizationId()))
      .getStatus();
  if (!permissionCheckStatus.equals(StatusEnum.SUCCEEDED)) {
    throw new ForbiddenException("User lacks permission to create workspaces in this organization");
  }
}
```

#### Business Value

This security tightening provided important protection:

1. **Prevent Sprawl**: Editors can no longer create unlimited workspaces, preventing resource sprawl
2. **Administrative Control**: Only admins can modify organizational structure (workspace topology)
3. **Protect Against Deletion**: Editors cannot accidentally or maliciously delete workspaces
4. **Billing Protection**: Workspace creation may have cost implications in Cloud edition
5. **Audit Compliance**: More restrictive permissions meet security audit requirements
6. **Role Clarity**: Clear separation between "can edit content" (editor) and "can manage structure" (admin)

The change aligned workspace management operations with other administrative operations like user management and SSO configuration, all of which require admin privileges.

#### Related Commits

- None directly related (standalone security enhancement)

---

### 9. Workspace User Access Info Endpoint

**Commit:** 7c21c5dfd0 - January 25, 2024
**Impact:** 10 files changed, 424 insertions, 30 deletions

#### What Changed

Added a new API endpoint `/users/list_access_info_by_workspace_id` that returns comprehensive access information for all users with access to a workspace, including both direct workspace permissions and inherited organization permissions.

**Key files modified/added:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/UserHandler.java` (new method)
- `airbyte-config/config-persistence/src/main/java/io/airbyte/config/persistence/UserPersistence.java` (new query method)
- `airbyte-api/src/main/openapi/config.yaml` (new endpoint definition)
- `airbyte-api-server-resources/src/main/openapi/resources/types/WorkspaceUserAccessInfo.yaml` (new type)

#### Implementation Details

The new handler method returns rich access information:

```java
public WorkspaceUserAccessInfoReadList listAccessInfoByWorkspaceId(final WorkspaceIdRequestBody workspaceIdRequestBody) throws IOException {
  final UUID workspaceId = workspaceIdRequestBody.getWorkspaceId();
  final List<WorkspaceUserAccessInfo> userAccessInfo = userPersistence.listWorkspaceUserAccessInfo(workspaceId);
  return buildWorkspaceUserAccessInfoReadList(userAccessInfo);
}

private WorkspaceUserAccessInfoRead buildWorkspaceUserAccessInfoRead(final WorkspaceUserAccessInfo accessInfo) {
  final PermissionRead workspacePermissionRead = Optional.ofNullable(accessInfo.getWorkspacePermission())
      .map(wp -> new PermissionRead()
          .permissionId(wp.getPermissionId())
          .permissionType(Enums.convertTo(wp.getPermissionType(), PermissionType.class))
          .userId(wp.getUserId())
          .workspaceId(wp.getWorkspaceId()))
      .orElse(null);

  final PermissionRead organizationPermissionRead = Optional.ofNullable(accessInfo.getOrganizationPermission())
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

The underlying query in UserPersistence joins permissions and user data:

```java
public List<WorkspaceUserAccessInfo> listWorkspaceUserAccessInfo(UUID workspaceId) throws IOException {
  // Query returns user info with both workspace-level and org-level permissions
  // This allows UI to show which users have access through org membership vs direct assignment
  return database.query(ctx -> {
    return ctx.select(...)
      .from(Tables.USER)
      .leftJoin(Tables.PERMISSION).on(...)
      .where(/* workspace access conditions */)
      .fetch()
      .map(this::recordToWorkspaceUserAccessInfo);
  });
}
```

The WorkspaceUserAccessInfo model includes:

```yaml
WorkspaceUserAccessInfo:
  type: object
  required:
    - userId
    - userEmail
    - workspaceId
  properties:
    userId:
      type: string
      format: uuid
    userEmail:
      type: string
    userName:
      type: string
    workspaceId:
      type: string
      format: uuid
    workspacePermission:
      $ref: "#/components/schemas/PermissionRead"
    organizationPermission:
      $ref: "#/components/schemas/PermissionRead"
```

#### Business Value

This endpoint provided critical visibility for access management:

1. **Comprehensive View**: Shows all users with access, whether through workspace or organization permissions
2. **Permission Source**: Clearly indicates whether access comes from workspace-level or org-level permission
3. **User Management UI**: Enables building user management interfaces showing current access
4. **Access Audit**: Organizations can audit who has access to sensitive workspaces
5. **Inherited Permissions**: Makes visible the permissions inherited from organization membership
6. **Invitation Planning**: Helps determine if new users need workspace-specific or org-level permissions

The endpoint is particularly useful for workspace administrators who need to understand their workspace's access landscape but may not have organization-level visibility.

#### Related Commits

- 62cb0c0af2 (Oct 18, 2023): Cloud's listWorkspacesByUser leverages org-level permissions

---

### 10. User and Permission Tables in OSS ConfigsDb

**Commit:** e7490ddf1c - May 17, 2023
**Impact:** 2 files changed, 309 insertions, 1 deletion

#### What Changed

This foundational commit added the `user` and `permission` tables to the OSS ConfigsDb, establishing the database schema required for RBAC. Prior to this, user and permission data only existed in Cloud/Enterprise editions.

**Key files modified:**
- Database migration file adding user and permission tables
- ConfigDb schema definitions

#### Implementation Details

The migration added two core tables:

```sql
CREATE TABLE "user" (
  id UUID PRIMARY KEY,
  name VARCHAR(255),
  auth_user_id VARCHAR(255) NOT NULL UNIQUE,
  auth_provider VARCHAR(255),
  default_workspace_id UUID,
  status VARCHAR(255) NOT NULL,
  company_name VARCHAR(255),
  email VARCHAR(255) NOT NULL UNIQUE,
  news BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TYPE permission_type AS ENUM (
  'instance_admin',
  'organization_admin',
  'organization_editor',
  'organization_reader',
  'organization_member',
  'workspace_owner',
  'workspace_admin',
  'workspace_editor',
  'workspace_reader'
);

CREATE TABLE permission (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organization(id) ON DELETE CASCADE,
  permission_type permission_type NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT permission_scope_check CHECK (
    (workspace_id IS NOT NULL AND organization_id IS NULL) OR
    (workspace_id IS NULL AND organization_id IS NOT NULL) OR
    (workspace_id IS NULL AND organization_id IS NULL AND permission_type = 'instance_admin')
  )
);

CREATE INDEX idx_permission_user_id ON permission(user_id);
CREATE INDEX idx_permission_workspace_id ON permission(workspace_id);
CREATE INDEX idx_permission_organization_id ON permission(organization_id);
```

Key schema features:

1. **User Table**: Stores user identity, email, status, and auth provider info
2. **Permission Type Enum**: Defines all available permission types in the type system
3. **Flexible Scoping**: Permission can be scoped to workspace, organization, or neither (instance admin)
4. **Referential Integrity**: Foreign keys with CASCADE delete ensure cleanup
5. **Scope Constraint**: CHECK constraint ensures permissions are properly scoped
6. **Optimized Indexes**: Indexes on foreign keys for efficient permission lookups

#### Business Value

This foundational change enabled RBAC in OSS:

1. **OSS RBAC**: Brought enterprise-grade access control to open-source edition
2. **Data Locality**: User and permission data stored alongside configuration data
3. **Migration Path**: Enabled migrating users from Firebase to self-hosted authentication
4. **Consistent Schema**: Same schema across OSS and Enterprise editions
5. **Performance**: Proper indexing enables efficient permission checks
6. **Extensibility**: Enum-based permission types can be extended with new roles

This commit was the foundation that all subsequent permission and authorization work built upon. Without these tables, features like permission hierarchy, RBAC annotations, and permission-based filtering would not be possible.

#### Related Commits

- 443288e05b (Nov 14, 2023): Migration to add instance_admin permission for default user
- 1d635f6c67 (Nov 3, 2023): Add uniqueness constraint on user_id and workspace_id/organization_id

---

## Technical Evolution

The commits tell a story of systematic evolution from basic permission storage to sophisticated hierarchical access control:

### Phase 1: Foundation (May 2023)

The journey began with establishing the basic data model:

- **May 2023**: Added User and Permission tables to OSS ConfigsDb (e7490ddf1c)
- Created the permission_type enum with all role types
- Established foreign key relationships and indexing strategy

### Phase 2: Permission Hierarchy (October-November 2023)

Built the core RBAC model with hierarchical permissions:

- **October 2023**: Introduced org-level permission hierarchy (630ae7e7c9)
- **October 2023**: Added RBAC roles in CloudAuthProvider (b445cfc886)
- **November 2023**: Added @Secured annotations to OSS API endpoints (cc3010471c)
- **November 2023**: Added instance_admin permission records (443288e05b)
- **November 2023**: Permission validation and revocation APIs (acc3e7f37e, f4c9ae098c)

This phase established the conceptual model where organization-level permissions grant workspace-level access.

### Phase 3: RBAC Enforcement (November 2023 - February 2024)

Implemented comprehensive authorization enforcement:

- **December 2023**: Instance admin permission-based roles (938e4bdc38)
- **December 2023**: Actor definition access validation (7c29af659d)
- **January 2024**: Workspace user access info endpoint (7c21c5dfd0)
- **February 2024**: Removed @SecuredWorkspace in favor of RBAC annotations (78cddd9b44)
- **February 2024**: Block withRefreshCatalog for non-editors (f194a0fe40)

This phase systematically applied RBAC to all API endpoints and sensitive operations.

### Phase 4: Service Layer Modernization (April 2024)

Migrated to Micronaut Data with advanced permission logic:

- **April 2024**: Micronaut Data PermissionService with redundancy prevention (1e4b2ec621)
- Introduced PermissionRedundantException and RemoveLastOrgAdminPermissionException
- Implemented automatic cleanup of redundant permission records
- Added protection against removing the last organization admin

This phase dramatically improved the developer experience and data integrity.

### Phase 5: Security Hardening (May 2024)

Tightened security requirements for critical operations:

- **May 2024**: Require admin role for workspace create/delete (46e4b56aa4)
- Changed from editor to admin requirements for structural changes
- Aligned with principle of least privilege

### Phase 6: Service Authentication (August 2024)

Added machine-to-machine authentication:

- **August 2024**: Keycloak access token interceptor for client-credentials flow (21d6309e04)
- Enabled Worker and Cron authentication to API server
- Automatic token management with graceful degradation

### Phase 7: Fine-Grained Filtering (August 2025)

Implemented true zero-trust access control:

- **August 2025**: Permission-based workspace filtering (1fa14d6294)
- **August 2025**: Include orgs from non-org permission records (72aaef63bf)
- **August 2025**: Allow workspace users to call org info API (d2991e202e)

This phase closed security gaps where organization membership previously granted visibility to all resources.

### Technology Evolution

The work shows clear technology choices over time:

1. **Java → Kotlin**: Newer services and handlers written in Kotlin for conciseness
2. **JOOQ → Micronaut Data**: Migration from SQL-focused to entity-focused persistence
3. **Custom Annotations → Standard @Secured**: Moved from custom security annotations to Micronaut standard
4. **Flat Roles → Hierarchical Permissions**: From simple role checks to sophisticated permission inheritance
5. **Manual Checks → Automatic Enforcement**: From explicit security checks to declarative @Secured annotations

---

## Impact Summary

Parker's contributions to Permissions & Access Control built a comprehensive, production-ready RBAC system for Airbyte. The work enabled Airbyte to evolve from basic workspace-level access to sophisticated multi-tenant access control suitable for enterprise deployments.

### Quantitative Impact

- **34 commits** over 29 months
- **~8,500 lines** of code changes
- **Major features delivered:**
  - Complete RBAC system with hierarchical permission inheritance
  - Automatic redundant permission prevention
  - Permission-based workspace and organization filtering
  - Actor definition access validation
  - Keycloak client credentials authentication
  - Comprehensive API endpoint authorization
  - User access information endpoints

### Qualitative Impact

**For Security:**
- Hierarchical permission model scales from single users to large organizations
- Protection against removing last organization admin prevents lockout scenarios
- Automatic redundancy prevention keeps permission data clean and efficient
- Fine-grained filtering implements true zero-trust access control
- Actor definition validation protects global connector definitions

**For Developers:**
- Clear @Secured annotations make authorization visible in code
- Micronaut Data reduces boilerplate and improves maintainability
- Comprehensive test coverage (595 lines for PermissionService alone) ensures correctness
- Type-safe permission checks prevent runtime authorization errors
- Service-to-service authentication with automatic token management

**For Users:**
- Intuitive permission model where org admins automatically get workspace access
- Fine-grained control allows restricting workspace visibility within organizations
- User access info endpoints enable self-service access auditing
- Clear separation between admin (structural) and editor (content) permissions

**For the Platform:**
- Database-driven access control enables audit and compliance
- Scalable architecture supports thousands of users and workspaces
- Edition-specific implementations (Community vs Enterprise) without code duplication
- Performance-optimized queries with proper indexing
- Graceful degradation in authentication failures

### Key Architectural Patterns

The work established several important patterns:

1. **Permission Hierarchy Map**: Declarative mapping of which permissions grant which access levels
2. **Redundancy Prevention**: Automatic detection and cleanup of redundant permission records
3. **Edition-Specific Validators**: Interface + @Replaces pattern for edition-specific behavior
4. **Transactional Permission Changes**: Database transactions protect against partial updates
5. **Role-Based Authorization**: @Secured annotations provide declarative, compile-time checked security
6. **Permission-Aware Queries**: SQL queries that respect user permissions for filtering
7. **Last Admin Protection**: Safeguards preventing organizations from losing all admins

### Security Posture Improvements

The work significantly strengthened Airbyte's security:

1. **Defense in Depth**: Multiple layers of authorization from HTTP interceptors to database queries
2. **Principle of Least Privilege**: Users see only resources they have explicit access to
3. **Fail Secure**: Authorization failures deny access rather than permitting by default
4. **Audit Trail**: All permissions stored in database with timestamps
5. **Type Safety**: Enum-based permission types prevent invalid permissions
6. **Scope Constraints**: Database constraints ensure permissions are properly scoped
7. **Cascade Cleanup**: Foreign key cascades prevent orphaned permission records

This foundation enables Airbyte to meet enterprise security requirements including SOC 2, ISO 27001, and other compliance frameworks that require comprehensive access control and audit capabilities.
