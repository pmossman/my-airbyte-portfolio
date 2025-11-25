# Keycloak SSO Foundation

## Overview
- **Time Period:** July - September 2023 (~3 months)
- **Lines of Code:** ~2,500 additions
- **Files Changed:** 45+ files
- **Key Technologies:** Keycloak, Kubernetes, Java, Helm

One-paragraph summary: Established the foundation for enterprise SSO by integrating Keycloak as the identity provider, deploying it to cloud infrastructure, and implementing the initial authentication flow. This laid the groundwork for all subsequent SSO features including SAML, domain verification, and enterprise RBAC.

## Problem Statement
Enterprise customers required:
- Single Sign-On with their corporate identity providers
- Centralized authentication management
- Support for SAML and OAuth protocols
- Seamless integration with existing Airbyte workflows

## Solution Architecture
Built a comprehensive SSO foundation:

1. **Keycloak Deployment** - Kubernetes-based Keycloak cluster
2. **Auth Integration** - Token validation and user provisioning
3. **SSO Configuration** - Per-organization SSO settings
4. **Default Workspace Creation** - Automatic workspace for new SSO users

## Implementation Details

### Keycloak Kubernetes Deployment

```yaml
# Helm values for Keycloak
keycloak:
  replicas: 3
  image:
    repository: quay.io/keycloak/keycloak
    tag: 22.0

  extraEnv:
    - name: KC_CACHE
      value: "ispn"
    - name: KC_CACHE_STACK
      value: "kubernetes"

  resources:
    requests:
      memory: "1Gi"
      cpu: "500m"
    limits:
      memory: "2Gi"
      cpu: "1000m"

  database:
    vendor: postgres
    hostname: keycloak-db
```

### Rolling Update Configuration

```java
// Adjust deployment for zero-downtime updates
@Bean
public DeploymentStrategy keycloakDeploymentStrategy() {
  return new RollingUpdateDeployment()
      .maxUnavailable(1)
      .maxSurge(1);
}
```

### Token Validation

```java
@Singleton
public class KeycloakTokenValidator {
  private final PublicKey publicKey;
  private final String expectedIssuer;

  public DecodedJWT validateToken(String token) {
    try {
      Algorithm algorithm = Algorithm.RSA256((RSAPublicKey) publicKey, null);

      JWTVerifier verifier = JWT.require(algorithm)
          .withIssuer(expectedIssuer)
          .build();

      return verifier.verify(token);
    } catch (JWTVerificationException e) {
      throw new AuthenticationException("Invalid token", e);
    }
  }

  public String extractUserId(DecodedJWT token) {
    return token.getSubject();
  }

  public String extractEmail(DecodedJWT token) {
    return token.getClaim("email").asString();
  }
}
```

### SSO User Provisioning

```java
@Singleton
public class SsoUserService {

  public User getOrCreateByAuthId(String authId, String email, String ssoRealm) {
    // Check if user exists
    Optional<User> existingUser = userRepository.findByAuthId(authId);
    if (existingUser.isPresent()) {
      return existingUser.get();
    }

    // Find organization by SSO realm
    Organization org = organizationRepository.findBySsoRealm(ssoRealm)
        .orElseThrow(() -> new SsoException(
            "No organization found for realm: " + ssoRealm));

    // Create new user
    User newUser = new User()
        .withAuthUserId(authId)
        .withEmail(email)
        .withName(extractNameFromEmail(email));

    userRepository.save(newUser);

    // Assign permissions - first user gets admin
    assignInitialPermissions(newUser, org);

    return newUser;
  }

  private void assignInitialPermissions(User user, Organization org) {
    List<Permission> existingPermissions =
        permissionRepository.findByOrganizationId(org.getId());

    PermissionType permissionType = existingPermissions.isEmpty()
        ? PermissionType.ORGANIZATION_ADMIN
        : PermissionType.ORGANIZATION_MEMBER;

    Permission permission = new Permission()
        .withUserId(user.getId())
        .withOrganizationId(org.getId())
        .withPermissionType(permissionType);

    permissionRepository.save(permission);
  }
}
```

### Default Workspace Creation

```java
// Ensure SSO users have a workspace to land in
public Workspace ensureDefaultWorkspace(User user, Organization org) {
  // Check if user already has workspace access
  List<Workspace> userWorkspaces = workspaceRepository
      .findByOrganizationId(org.getId());

  if (!userWorkspaces.isEmpty()) {
    return userWorkspaces.get(0);
  }

  // Create default workspace for the organization
  Workspace defaultWorkspace = new Workspace()
      .withOrganizationId(org.getId())
      .withName(org.getName() + " Workspace")
      .withSlug(generateSlug(org.getName()));

  return workspaceRepository.save(defaultWorkspace);
}
```

### SSO Configuration API

```java
@Controller("/api/v1/sso_config")
public class SsoConfigController {

  @Post
  public SsoConfigRead createSsoConfig(@Body SsoConfigCreate create) {
    SsoConfig config = new SsoConfig()
        .withOrganizationId(create.getOrganizationId())
        .withKeycloakRealm(create.getKeycloakRealm())
        .withIdpType(create.getIdpType())  // SAML, OIDC
        .withIdpMetadataUrl(create.getIdpMetadataUrl());

    return toRead(ssoConfigRepository.save(config));
  }

  @Get("/{organizationId}")
  public SsoConfigRead getSsoConfig(UUID organizationId) {
    return ssoConfigRepository.findByOrganizationId(organizationId)
        .map(this::toRead)
        .orElseThrow(() -> new NotFoundException("SSO not configured"));
  }
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [d8d0540629](https://github.com/airbytehq/airbyte-platform/commit/d8d0540629) | Sep 29, 2023 | Include Keycloak in Cloud Deploys, fix cloud auth for keycloak tokens | Deployment |
| [bdac4015b9](https://github.com/airbytehq/airbyte-platform/commit/bdac4015b9) | Jul 21, 2023 | Add keycloak and keycloak-setup entries to docker-compose.build.yaml | Build setup |
| [118dd2aab2](https://github.com/airbytehq/airbyte-platform/commit/118dd2aab2) | Sep 6, 2023 | Keycloak users default to instance_admin until Airbyte User created | Permission bridge |
| [8c643c4e62](https://github.com/airbytehq/airbyte-platform/commit/8c643c4e62) | Oct 23, 2023 | [Cloud SSO] Default Workspace Creation for new users | User experience |
| [6103a25502](https://github.com/airbytehq/airbyte-platform/commit/6103a25502) | Oct 19, 2023 | SSO: First user signed up in Org gets OrganizationAdmin | First user flow |
| [18bf4b6030](https://github.com/airbytehq/airbyte-platform/commit/18bf4b6030) | Oct 30, 2023 | Add more keycloak replicas with RollingUpdate | High availability |
| [b0640f43f8](https://github.com/airbytehq/airbyte-platform/commit/b0640f43f8) | Nov 1, 2023 | Set kubernetes cache-stack mode for keycloak server | Clustering |

## Business Value

### Enterprise Enablement
- **SSO Support**: Enterprise customers can use their IdP
- **Compliance**: Meet security requirements for SSO
- **User Management**: Centralized through corporate IdP

### Security Impact
- **Token-Based Auth**: Secure JWT validation
- **No Password Storage**: Airbyte doesn't store passwords
- **Session Management**: Keycloak handles session lifecycle

### Operational Impact
- **High Availability**: Multi-replica Keycloak deployment
- **Zero Downtime**: Rolling updates for Keycloak changes
- **Scalability**: Kubernetes-native clustering

## Lessons Learned

### Keycloak Clustering
Kubernetes cache stack essential for multi-replica:
```yaml
KC_CACHE: "ispn"
KC_CACHE_STACK: "kubernetes"
```

### Graceful User Provisioning
Handle the transition from Keycloak-only to full Airbyte user:
```java
// Bridge permission: trust Keycloak user until Airbyte user exists
if (!airbyteUserExists(keycloakUser)) {
  grantTemporaryInstanceAdmin(keycloakUser);
}
```

### First User Special Case
First user in an org needs admin rights:
```java
boolean isFirstUser = existingPermissions.isEmpty();
PermissionType type = isFirstUser
    ? ORGANIZATION_ADMIN
    : ORGANIZATION_MEMBER;
```
