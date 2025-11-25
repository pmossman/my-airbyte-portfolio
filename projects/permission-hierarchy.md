# Permission Hierarchy System

## Overview
- **Time Period:** October 2023 - April 2024 (~6 months)
- **Lines of Code:** ~2,500 additions
- **Files Changed:** 35+ files
- **Key Technologies:** Java, Kotlin, Micronaut Data, JOOQ, Micronaut Security

One-paragraph summary: Designed and implemented a hierarchical permission model where organization-level permissions automatically grant workspace-level access. Includes automatic redundant permission prevention, last-admin protection, and a comprehensive permission hierarchy map that enables scalable multi-tenant access control.

## Problem Statement
The original permission system required explicit permission records for each user-workspace combination. For organizations with hundreds of workspaces, this meant:
- Thousands of permission records per admin
- Manual permission grants for each new workspace
- No automatic inheritance from organization to workspace level
- Risk of permission explosion as the platform scales

## Solution Architecture
Designed a hierarchical permission model with:
1. **Permission Hierarchy Map** - Declarative mapping of which permissions grant what access
2. **Automatic Redundancy Prevention** - Prevents creating workspace permissions that duplicate org-level access
3. **Last Admin Protection** - Prevents accidentally removing all organization admins
4. **Micronaut Data Service** - Modern persistence layer with comprehensive validation

Key design decisions:
- **Compile-time checked hierarchy** - Static map prevents runtime hierarchy errors
- **Transactional permission changes** - Database transactions protect against partial updates
- **Exception-based validation** - Explicit exceptions for redundancy and last-admin scenarios

## Implementation Details

### Permission Hierarchy Map

Declarative mapping of permission inheritance:

```java
protected static final Map<PermissionType, Set<PermissionType>>
    GRANTED_PERMISSION_TYPES_BY_DEFINED_PERMISSION_TYPE = Map.of(
      // Instance admin grants access to all permissions
      PermissionType.INSTANCE_ADMIN, Set.of(PermissionType.values()),

      // Organization admin grants org-level and all workspace-level
      PermissionType.ORGANIZATION_ADMIN, Set.of(
          PermissionType.ORGANIZATION_ADMIN,
          PermissionType.ORGANIZATION_EDITOR,
          PermissionType.ORGANIZATION_READER,
          PermissionType.WORKSPACE_OWNER,
          PermissionType.WORKSPACE_ADMIN,
          PermissionType.WORKSPACE_EDITOR,
          PermissionType.WORKSPACE_READER),

      // Organization editor grants editor-and-below
      PermissionType.ORGANIZATION_EDITOR, Set.of(
          PermissionType.ORGANIZATION_EDITOR,
          PermissionType.ORGANIZATION_READER,
          PermissionType.WORKSPACE_EDITOR,
          PermissionType.WORKSPACE_READER),

      // Organization reader grants read-only access
      PermissionType.ORGANIZATION_READER, Set.of(
          PermissionType.ORGANIZATION_READER,
          PermissionType.WORKSPACE_READER),

      // Workspace-level permissions don't inherit upward
      PermissionType.WORKSPACE_ADMIN, Set.of(
          PermissionType.WORKSPACE_OWNER,
          PermissionType.WORKSPACE_ADMIN,
          PermissionType.WORKSPACE_EDITOR,
          PermissionType.WORKSPACE_READER),

      PermissionType.WORKSPACE_EDITOR, Set.of(
          PermissionType.WORKSPACE_EDITOR,
          PermissionType.WORKSPACE_READER),

      PermissionType.WORKSPACE_READER, Set.of(
          PermissionType.WORKSPACE_READER)
    );

public static boolean definedPermissionGrantsTargetPermission(
    final PermissionType definedPermission,
    final PermissionType targetPermission) {
  return GRANTED_PERMISSION_TYPES_BY_DEFINED_PERMISSION_TYPE
      .get(definedPermission).contains(targetPermission);
}
```

### Micronaut Data Permission Service

```kotlin
interface PermissionService {
  fun getPermissionsForUser(userId: UUID): List<Permission>

  @Throws(RemoveLastOrgAdminPermissionException::class)
  fun deletePermission(permissionId: UUID)

  @Throws(PermissionRedundantException::class)
  fun createPermission(permission: Permission): Permission

  @Throws(RemoveLastOrgAdminPermissionException::class)
  fun updatePermission(permission: Permission)
}

@Singleton
class PermissionServiceImpl(
  private val permissionRepository: PermissionRepository,
  private val workspaceService: WorkspaceService,
) : PermissionService {

  @Transactional("config")
  override fun createPermission(permission: Permission): Permission {
    val existingUserPermissions = getPermissionsForUser(permission.userId).toSet()

    // Throw if new permission would be redundant
    if (isRedundantWorkspacePermission(permission, existingUserPermissions)) {
      throw PermissionRedundantException(
        "Permission type ${permission.permissionType} would be redundant " +
        "for user ${permission.userId}. Preventing creation."
      )
    }

    // Remove any permissions made redundant by the new permission
    deletePermissionsMadeRedundantByPermission(permission, existingUserPermissions)

    return permissionRepository.save(permission.toEntity()).toConfigModel()
  }
}
```

### Redundancy Detection

```kotlin
private fun isRedundantWorkspacePermission(
  permission: Permission,
  existingUserPermissions: Set<Permission>,
): Boolean {
  // Only workspace permissions can be redundant
  val workspaceId = permission.workspaceId ?: return false

  // If the workspace is not in an organization, it can't have redundant perms
  val orgIdForWorkspace = workspaceService
    .getOrganizationIdFromWorkspaceId(workspaceId)
    .orElse(null) ?: return false

  // If the user has no org-level permission, can't be redundant
  val existingOrgPermission = existingUserPermissions
    .find { it.organizationId == orgIdForWorkspace } ?: return false

  // Redundant if new permission <= existing org-level permission
  return getAuthority(permission.permissionType) <=
         getAuthority(existingOrgPermission.permissionType)
}

private fun getAuthority(permissionType: PermissionType): Int = when (permissionType) {
  PermissionType.ORGANIZATION_ADMIN -> 100
  PermissionType.ORGANIZATION_EDITOR -> 80
  PermissionType.ORGANIZATION_READER -> 60
  PermissionType.WORKSPACE_ADMIN -> 50
  PermissionType.WORKSPACE_EDITOR -> 40
  PermissionType.WORKSPACE_READER -> 20
  else -> 0
}
```

### Last Admin Protection

```kotlin
private fun throwIfDeletingLastOrgAdmin(permissionIdsToDelete: List<UUID>) {
  val deletedOrgAdminPermissions = permissionRepository
    .findByIdIn(permissionIdsToDelete)
    .filter { it.permissionType == PermissionType.organization_admin }

  val orgIdToDeletedOrgAdminIds = deletedOrgAdminPermissions
    .groupBy({ it.organizationId!! }, { it.id!! })

  orgIdToDeletedOrgAdminIds.forEach { (orgId, deletedIds) ->
    throwIfDeletingLastOrgAdminForOrg(orgId, deletedIds.toSet())
  }
}

private fun throwIfDeletingLastOrgAdminForOrg(
  orgId: UUID,
  deletedOrgAdminPermissionIds: Set<UUID>,
) {
  val otherOrgPermissions = permissionRepository
    .findByOrganizationId(orgId)
    .filter { it.id !in deletedOrgAdminPermissionIds }

  if (otherOrgPermissions.none { it.permissionType == PermissionType.organization_admin }) {
    throw RemoveLastOrgAdminPermissionException(
      "Cannot delete the last admin in Organization $orgId."
    )
  }
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| 630ae7e7c9 | Oct 16, 2023 | Hierarchical permission model | 5 files, 557 insertions |
| 1e4b2ec621 | Apr 2, 2024 | Micronaut Data PermissionService | 25 files, 1,112 insertions |
| 938e4bdc38 | Dec 6, 2023 | Instance admin permission-based roles | 8 files, 310 insertions |
| 78cddd9b44 | Feb 13, 2024 | RBAC role annotations | 21 files, 231 insertions |

## Business Value

### User Impact
- **Intuitive Access**: Org admins automatically get workspace access
- **Reduced Complexity**: No need to grant per-workspace permissions
- **Safety**: Can't accidentally remove last organization admin

### Business Impact
- **Enterprise Scale**: Supports organizations with hundreds of workspaces
- **Reduced Support**: Automatic inheritance eliminates permission requests
- **Compliance**: Proper RBAC for SOC 2 and similar frameworks

### Technical Impact
- **Data Integrity**: No redundant permission records in database
- **Performance**: Fewer records = faster permission queries
- **Type Safety**: Compile-time checked permission hierarchy

## Lessons Learned / Patterns Used

### Static Hierarchy Map
Compile-time defined hierarchy prevents runtime errors:
```java
// Hierarchy is defined once, checked at compile time
GRANTED_PERMISSION_TYPES_BY_DEFINED_PERMISSION_TYPE.get(permission).contains(target)
```

### Exception-Based Validation
Explicit exceptions for business rule violations:
```kotlin
class PermissionRedundantException(message: String) : Exception(message)
class RemoveLastOrgAdminPermissionException(message: String) : Exception(message)
```
These exceptions are caught at the API layer and converted to proper HTTP responses.

### Authority Levels for Comparison
Numeric authority levels enable simple comparison:
```kotlin
// Higher number = more authority
// Easy to check if one permission implies another
return getAuthority(newPerm) <= getAuthority(existingPerm)
```
