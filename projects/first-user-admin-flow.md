# First User Admin & Invitation Flow

## Overview
- **Time Period:** November 2023 - January 2024 (~3 months)
- **Lines of Code:** ~1,200 additions
- **Files Changed:** 20 files
- **Key Technologies:** Java, Kotlin, Keycloak, Email invitations

One-paragraph summary: Implemented the "first user becomes admin" flow where the first person to log into an organization automatically receives admin permissions, along with comprehensive invitation handling that gracefully manages expired invitations and duplicate sign-ups.

## Problem Statement
When organizations are first created, there needs to be a way for someone to become the admin. Also, when users are invited via email:
- Invitations could expire, causing confusing errors
- Users might sign up independently, making invitations invalid
- No automatic permission assignment for first users

## Solution Architecture
1. **First User Detection** - Check if organization has any members
2. **Automatic Admin Grant** - First user gets ORGANIZATION_ADMIN
3. **Invitation Lifecycle** - Graceful handling of expired/used invitations
4. **Duplicate Detection** - Handle users who sign up before accepting invitation

## Implementation Details

### First User Admin Assignment

```java
@Transactional("config")
public void handleUserLogin(UUID userId, UUID organizationId) {
  final List<Permission> existingPermissions =
      permissionRepository.findByOrganizationId(organizationId);

  if (existingPermissions.isEmpty()) {
    // First user in organization - grant admin
    final Permission adminPermission = new Permission()
        .withUserId(userId)
        .withOrganizationId(organizationId)
        .withPermissionType(PermissionType.ORGANIZATION_ADMIN);
    permissionRepository.save(adminPermission);

    log.info("Granted admin to first user {} in org {}", userId, organizationId);
  }
}
```

### Invitation Expiration Handling

```kotlin
fun processInvitation(invitationCode: String, userId: UUID): InvitationResult {
  val invitation = invitationRepository.findByCode(invitationCode)
    ?: return InvitationResult.NotFound

  if (invitation.expiresAt.isBefore(Instant.now())) {
    return InvitationResult.Expired
  }

  if (invitation.acceptedByUserId != null) {
    return InvitationResult.AlreadyAccepted
  }

  // Check if user already has permission via another path
  val existingPermission = permissionRepository.findByUserIdAndOrganizationId(
    userId, invitation.organizationId
  )

  if (existingPermission != null) {
    // Mark invitation as used but don't create duplicate permission
    invitation.acceptedByUserId = userId
    invitationRepository.save(invitation)
    return InvitationResult.AlreadyMember
  }

  // Create permission and mark invitation accepted
  val permission = Permission(
    userId = userId,
    organizationId = invitation.organizationId,
    permissionType = invitation.permissionType,
  )
  permissionRepository.save(permission)

  invitation.acceptedByUserId = userId
  invitationRepository.save(invitation)

  return InvitationResult.Success(permission)
}
```

### Graceful Duplicate Handling

```kotlin
sealed class InvitationResult {
  object NotFound : InvitationResult()
  object Expired : InvitationResult()
  object AlreadyAccepted : InvitationResult()
  object AlreadyMember : InvitationResult()  // User signed up independently
  data class Success(val permission: Permission) : InvitationResult()
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| 06e4e0f8ad | Nov 7, 2023 | First user admin assignment | 4 files, 320 insertions |
| 3e85dc3ce1 | Jan 15, 2024 | Invitation expiration handling | 8 files, 450 insertions |
| b2c3a51d92 | Jan 22, 2024 | Duplicate invitation handling | 6 files, 380 insertions |

## Business Value
- **Seamless Onboarding**: First user automatically becomes admin
- **Graceful Errors**: Expired invitations show helpful messages
- **No Duplicates**: Independent sign-ups don't break invitations
- **Audit Trail**: All invitation states tracked

## Lessons Learned
### Sealed Classes for Result Types
Using sealed classes instead of exceptions enables exhaustive handling:
```kotlin
when (val result = processInvitation(code, userId)) {
  is InvitationResult.Success -> ...
  is InvitationResult.Expired -> ...
  // Compiler ensures all cases handled
}
```
