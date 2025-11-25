# Workspace Permission-Based Filtering

## Overview
- **Time Period:** August 2025 (~2 weeks)
- **Lines of Code:** ~700 additions
- **Files Changed:** 10 files
- **Key Technologies:** Kotlin, PostgreSQL, Micronaut Data

One-paragraph summary: Implemented fine-grained permission-based filtering for workspace listings, ensuring users only see workspaces they have explicit access to within an organization. This replaced the previous behavior where organization membership granted visibility to all workspaces, implementing true zero-trust access control.

## Problem Statement
The previous workspace listing behavior had a security gap:
- Organization members could see ALL workspaces in their organization
- No way to restrict visibility to specific workspaces
- Violated principle of least privilege
- Prevented creating team-specific workspaces

Enterprise customers needed workspace isolation within organizations.

## Solution Architecture
Designed a permission-aware query system:

1. **Hybrid Query** - Combines org-level and workspace-level permissions
2. **CTE-Based SQL** - Efficient query using Common Table Expressions
3. **Instance Admin Bypass** - Admins see everything
4. **Search Integration** - Permission filtering works with name search

Key design decisions:
- **SQL-level filtering** - Permissions checked in query, not app code
- **Union approach** - Combines org-granted and workspace-granted access
- **Performance optimized** - Proper indexes for permission queries

## Implementation Details

### Permission-Aware Query

SQL using CTEs for clarity and performance:

```kotlin
const val LIST_WORKSPACES_IN_ORGANIZATION_BY_USER_ID_AND_PERMISSION_TYPES_QUERY: String = (
  "WITH " +
    // Workspaces accessible via org-level permission
    " userOrg AS (" +
    "   SELECT organization_id FROM permission " +
    "   WHERE user_id = {0} " +
    "   AND permission_type = ANY({1}::permission_type[])" +
    " )," +
    // Combine org-granted + workspace-granted access
    " userWorkspaces AS (" +
    "   SELECT workspace.id AS workspace_id FROM userOrg " +
    "   JOIN workspace ON workspace.organization_id = userOrg.organization_id" +
    "   WHERE workspace.organization_id = {2}" +
    "   UNION" +
    "   SELECT workspace_id FROM permission " +
    "   WHERE user_id = {0} " +
    "   AND permission_type = ANY({1}::permission_type[])" +
    "   AND workspace_id IN (SELECT id FROM workspace WHERE organization_id = {2})" +
    " )" +
    // Select from accessible workspaces
    " SELECT workspace.* " +
    " FROM workspace" +
    " WHERE workspace.id IN (SELECT workspace_id from userWorkspaces)" +
    " AND workspace.organization_id = {2}" +
    " AND workspace.name ILIKE {3}" +
    " AND workspace.tombstone = false" +
    " ORDER BY workspace.name ASC"
)
```

### Handler Implementation

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

### Permission Helper Integration

```kotlin
object PermissionPersistenceHelper {
  /**
   * Get permission types that grant the specified minimum access level.
   */
  fun getPermissionTypesForMinimumLevel(
    minimumLevel: PermissionType
  ): List<PermissionType> {
    return when (minimumLevel) {
      PermissionType.ORGANIZATION_READER -> listOf(
        PermissionType.ORGANIZATION_ADMIN,
        PermissionType.ORGANIZATION_EDITOR,
        PermissionType.ORGANIZATION_READER,
      )
      PermissionType.WORKSPACE_READER -> listOf(
        PermissionType.ORGANIZATION_ADMIN,
        PermissionType.ORGANIZATION_EDITOR,
        PermissionType.ORGANIZATION_READER,
        PermissionType.WORKSPACE_ADMIN,
        PermissionType.WORKSPACE_EDITOR,
        PermissionType.WORKSPACE_READER,
      )
      // ... other levels
    }
  }
}
```

### Instance Admin Bypass

Instance admins bypass permission filtering:

```kotlin
fun listWorkspacesInOrganization(
  request: ListWorkspacesInOrganizationRequestBody,
  currentUser: User,
): WorkspaceReadList {
  // Instance admins see all workspaces
  if (permissionService.isInstanceAdmin(currentUser.userId)) {
    return workspacePersistence.listAllInOrganization(request.organizationId)
  }

  // Regular users get permission-filtered list
  return listWorkspacesInOrganizationForUser(currentUser.userId, request)
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [1fa14d6294](https://github.com/airbytehq/airbyte-platform/commit/1fa14d6294) | Aug 27, 2025 | Permission-based workspace filtering | 6 files, 607 insertions |
| [72aaef63bf](https://github.com/airbytehq/airbyte-platform/commit/72aaef63bf) | Aug 27, 2025 | Include orgs from non-org permissions | Edge case fix |
| [d2991e202e](https://github.com/airbytehq/airbyte-platform/commit/d2991e202e) | Aug 29, 2025 | Allow workspace users to call org info | API access |

## Business Value

### User Impact
- **Privacy**: Users can't see workspaces they shouldn't access
- **Clean UI**: Workspace lists show only relevant workspaces
- **Team Isolation**: Teams can have private workspaces

### Business Impact
- **Enterprise Security**: Meets security audit requirements
- **Compliance**: Proper data isolation for SOC 2 / ISO 27001
- **Multi-Team Support**: Large organizations can use Airbyte securely

### Technical Impact
- **Query-Level Security**: Permissions enforced at database level
- **Performance**: Optimized query with proper indexes
- **Maintainability**: Clear SQL logic in CTEs

## Lessons Learned / Patterns Used

### Union for Hybrid Access
Combining two access paths:
```sql
-- Path 1: Org-level permission grants access to all workspaces
SELECT workspace_id FROM workspaces WHERE org_id IN (user_org_permissions)
UNION
-- Path 2: Workspace-level permission grants specific access
SELECT workspace_id FROM permissions WHERE user_id = :user
```

### CTE for Readability
Breaking complex queries into named steps:
```sql
WITH
  userOrg AS (...),        -- Org-level access
  userWorkspaces AS (...)  -- Combined workspace access
SELECT * FROM workspace WHERE id IN (userWorkspaces)
```

### SQL-Level Security
Filtering in the database query, not application code:
- Prevents data leakage from missing filters
- Better performance (no over-fetching)
- Audit trail of what was queried
