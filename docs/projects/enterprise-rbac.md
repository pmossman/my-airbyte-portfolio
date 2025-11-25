# Enterprise RBAC Foundation

## Overview
- **Time Period:** October - December 2023 (~3 months)
- **Lines of Code:** ~3,500 additions
- **Files Changed:** 60+ files
- **Key Technologies:** Java, Kotlin, Micronaut Security, PostgreSQL

One-paragraph summary: Implemented enterprise Role-Based Access Control (RBAC) for the Airbyte platform, replacing the simple instance_admin model with granular permission-based roles. This enabled multi-tenant organizations with proper workspace isolation and role hierarchies.

## Problem Statement
The existing permission model was too simple for enterprise:
- Only had `instance_admin` role (all or nothing)
- No organization-level permissions
- No workspace-level access control
- No role hierarchy or inheritance

## Solution Architecture
Built comprehensive RBAC:

1. **Permission Types** - Organization and workspace-level roles
2. **Role Hierarchy** - Org permissions can grant workspace access
3. **Endpoint Security** - `@Secured` annotations on all endpoints
4. **Permission Validation** - Create/update validation for permissions

## Implementation Details

### Permission Types

```java
public enum PermissionType {
  // Instance level
  INSTANCE_ADMIN,

  // Organization level
  ORGANIZATION_ADMIN,
  ORGANIZATION_EDITOR,
  ORGANIZATION_READER,
  ORGANIZATION_MEMBER,

  // Workspace level
  WORKSPACE_ADMIN,
  WORKSPACE_EDITOR,
  WORKSPACE_READER
}
```

### Permission Hierarchy

```java
@Singleton
public class PermissionHierarchy {
  private static final Map<PermissionType, Set<PermissionType>> HIERARCHY = Map.of(
      INSTANCE_ADMIN, Set.of(ORGANIZATION_ADMIN, WORKSPACE_ADMIN),
      ORGANIZATION_ADMIN, Set.of(ORGANIZATION_EDITOR, WORKSPACE_ADMIN),
      ORGANIZATION_EDITOR, Set.of(ORGANIZATION_READER, WORKSPACE_EDITOR),
      ORGANIZATION_READER, Set.of(ORGANIZATION_MEMBER, WORKSPACE_READER),
      WORKSPACE_ADMIN, Set.of(WORKSPACE_EDITOR),
      WORKSPACE_EDITOR, Set.of(WORKSPACE_READER)
  );

  public boolean hasPermission(PermissionType granted, PermissionType required) {
    if (granted == required) return true;

    Set<PermissionType> implied = HIERARCHY.get(granted);
    if (implied == null) return false;

    return implied.contains(required) ||
        implied.stream().anyMatch(p -> hasPermission(p, required));
  }
}
```

### Secured Endpoint Annotations

```java
@Controller("/api/v1/connections")
public class ConnectionController {

  @Get("/{connectionId}")
  @Secured({WORKSPACE_READER})
  public ConnectionRead getConnection(UUID connectionId) {
    return connectionService.getConnection(connectionId);
  }

  @Post
  @Secured({WORKSPACE_EDITOR})
  public ConnectionRead createConnection(@Body ConnectionCreate create) {
    return connectionService.createConnection(create);
  }

  @Delete("/{connectionId}")
  @Secured({WORKSPACE_ADMIN})
  public void deleteConnection(UUID connectionId) {
    connectionService.deleteConnection(connectionId);
  }
}
```

### Organization-Level Workspace Access

```java
@Singleton
public class WorkspacePermissionService {

  /**
   * Organization-level permissions grant access to all workspaces in the org.
   */
  public boolean hasWorkspaceAccess(UUID userId, UUID workspaceId,
                                     PermissionType requiredPermission) {
    // Direct workspace permission
    Optional<Permission> directPermission = permissionRepository
        .findByUserIdAndWorkspaceId(userId, workspaceId);

    if (directPermission.isPresent()) {
      return hierarchy.hasPermission(
          directPermission.get().getPermissionType(),
          requiredPermission
      );
    }

    // Check organization-level permission
    UUID organizationId = workspaceRepository
        .findById(workspaceId)
        .getOrganizationId();

    Optional<Permission> orgPermission = permissionRepository
        .findByUserIdAndOrganizationId(userId, organizationId);

    if (orgPermission.isPresent()) {
      PermissionType orgType = orgPermission.get().getPermissionType();
      PermissionType impliedWorkspaceType = getImpliedWorkspacePermission(orgType);
      return hierarchy.hasPermission(impliedWorkspaceType, requiredPermission);
    }

    return false;
  }

  private PermissionType getImpliedWorkspacePermission(PermissionType orgType) {
    return switch (orgType) {
      case ORGANIZATION_ADMIN -> WORKSPACE_ADMIN;
      case ORGANIZATION_EDITOR -> WORKSPACE_EDITOR;
      case ORGANIZATION_READER, ORGANIZATION_MEMBER -> WORKSPACE_READER;
      default -> null;
    };
  }
}
```

### Permission Validation

```java
@Singleton
public class PermissionValidator {

  public void validatePermissionCreate(PermissionCreate create) {
    // Can't have both workspace and organization
    if (create.getWorkspaceId() != null && create.getOrganizationId() != null) {
      throw new BadRequestException(
          "Permission cannot have both workspace and organization");
    }

    // Must have one
    if (create.getWorkspaceId() == null && create.getOrganizationId() == null) {
      throw new BadRequestException(
          "Permission must have workspace or organization");
    }

    // Validate permission type matches scope
    if (create.getWorkspaceId() != null) {
      if (!isWorkspacePermission(create.getPermissionType())) {
        throw new BadRequestException(
            "Workspace permission must use workspace permission type");
      }
    }

    // Check for duplicates
    if (permissionRepository.exists(
        create.getUserId(),
        create.getWorkspaceId(),
        create.getOrganizationId())) {
      throw new ConflictException("Permission already exists");
    }
  }
}
```

### Workspace Listing with Permissions

```java
public List<WorkspaceRead> listWorkspacesByUser(UUID userId) {
  // Get workspaces from direct permissions
  Set<UUID> directWorkspaceIds = permissionRepository
      .findWorkspaceIdsByUserId(userId);

  // Get workspaces from organization memberships
  Set<UUID> orgWorkspaceIds = permissionRepository
      .findOrganizationIdsByUserId(userId)
      .stream()
      .flatMap(orgId -> workspaceRepository
          .findByOrganizationId(orgId)
          .stream()
          .map(Workspace::getId))
      .collect(Collectors.toSet());

  // Combine and deduplicate
  Set<UUID> allWorkspaceIds = new HashSet<>();
  allWorkspaceIds.addAll(directWorkspaceIds);
  allWorkspaceIds.addAll(orgWorkspaceIds);

  return workspaceRepository.findByIds(allWorkspaceIds)
      .stream()
      .map(this::toWorkspaceRead)
      .toList();
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [630ae7e7c9](https://github.com/airbytehq/airbyte-platform/commit/630ae7e7c9) | Oct 16, 2023 | RBAC: Org-level permissions grant workspace-level access | Core hierarchy |
| [cc3010471c](https://github.com/airbytehq/airbyte-platform/commit/cc3010471c) | Nov 14, 2023 | RBAC: Incrementally add @Secured annotations to OSS API endpoints | Endpoint security |
| [938e4bdc38](https://github.com/airbytehq/airbyte-platform/commit/938e4bdc38) | Dec 6, 2023 | Enterprise RBAC: Replace instance_admin with permission-based roles | Role replacement |
| [7c29af659d](https://github.com/airbytehq/airbyte-platform/commit/7c29af659d) | Dec 5, 2023 | Enterprise RBAC: Actor Definition Endpoint Access Validation | Connector access |
| [acc3e7f37e](https://github.com/airbytehq/airbyte-platform/commit/acc3e7f37e) | Oct 25, 2023 | [RBAC] Validate Permission API create/update calls | Validation |
| [62cb0c0af2](https://github.com/airbytehq/airbyte-platform/commit/62cb0c0af2) | Oct 18, 2023 | Cloud listWorkspacesByUser leverages Organization-level permissions | Workspace listing |

## Business Value

### Enterprise Enablement
- **Multi-Tenancy**: Proper isolation between organizations
- **Role Granularity**: Different access levels for different users
- **Compliance**: Audit-ready permission model

### Security Impact
- **Least Privilege**: Users only access what they need
- **Workspace Isolation**: No cross-workspace data leaks
- **Admin Separation**: Not everyone needs admin rights

### Operational Impact
- **Self-Service**: Users can manage their own teams
- **Delegation**: Admins can delegate workspace management
- **Scalability**: Hierarchical model scales to many users

## Lessons Learned

### Incremental Rollout
Add `@Secured` annotations incrementally:
```java
// Phase 1: Add annotation but allow all
@Secured({WORKSPACE_READER, INSTANCE_ADMIN})

// Phase 2: Remove instance_admin fallback
@Secured({WORKSPACE_READER})
```

### Permission Inheritance
Organization permissions simplify management:
```
User has ORGANIZATION_ADMIN
  → Automatically has WORKSPACE_ADMIN on all org workspaces
  → No need to manage per-workspace permissions
```

### Validation is Critical
Prevent invalid permission states:
```java
// Bad: workspace permission on organization scope
Permission p = new Permission()
    .withOrganizationId(orgId)
    .withPermissionType(WORKSPACE_ADMIN);  // Invalid!

// Validation catches this before saving
```
