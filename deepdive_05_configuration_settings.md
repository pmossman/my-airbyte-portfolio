# Configuration & Settings - Deep Dive

## Overview

This document analyzes Parker Mossman's contributions to the Configuration & Settings area of the airbyte-platform repository. This work spans from February 2022 to October 2025, encompassing 45 commits that collectively transformed Airbyte's configuration management from a file-based system to a modern, cloud-native configuration architecture with environment variable support, secrets management, SSO configuration, and dynamic runtime configuration.

**Period:** February 15, 2022 - October 16, 2025 (44 months)
**Total Commits:** 45
**Total Changes:** ~15,000 lines of code
**Key Technologies:** Kotlin, Java, Micronaut, Keycloak, application.yml, Secret Management

---

## Key Architectural Changes

### 1. Secrets Management with SecretConfig and SecretReferences

**Commit:** 123718be02 - April 11, 2025
**Impact:** 72 files changed, 2,371 insertions, 955 deletions

#### What Changed

This massive refactoring fundamentally changed how Airbyte handles secrets in actor configurations. Previously, secrets were directly embedded in configuration JSON. This commit introduced a dual-tracking system where secrets are extracted from configs, stored separately, and referenced via coordinates and IDs.

**Key files:**
- `airbyte-config/config-secrets/src/main/kotlin/secrets/SecretsHelpers.kt` (387 additions)
- `airbyte-config/config-secrets/src/main/kotlin/secrets/SecretsRepositoryWriter.kt` (241 additions)
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/SourceHandler.java` (189 changes)
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/DestinationHandler.java` (158 changes)
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/secrets/SecretReferenceService.kt` (144 additions)

#### Implementation Details

The core innovation was introducing `ConfigWithProcessedSecrets` and dual-writing both secret coordinates and reference IDs:

```kotlin
// New constants for tracking secrets
private const val SECRET_STORAGE_ID_FIELD = "_secret_storage_id"
private const val SECRET_REF_ID_FIELD = "_secret_reference_id"

// The prefix used to recognize secret references in a config
internal const val SECRET_REF_PREFIX = "secret_coordinate::"

/**
 * Used to separate secrets out of some configuration. This will output a partial config that
 * includes pointers to secrets instead of actual secret values and a map that can be used to update
 * the secret persistence.
 */
fun splitConfig(
  secretBaseId: UUID,
  fullConfig: ConfigWithProcessedSecrets,
  secretPersistence: SecretPersistence,
  secretBasePrefix: String = AirbyteManagedSecretCoordinate.DEFAULT_SECRET_BASE_PREFIX,
): SplitSecretConfig =
  internalSplitAndUpdateConfig(
    uuidSupplier = { UUID.randomUUID() },
    secretBaseId = secretBaseId,
    secretReader = secretPersistence,
    persistedPartialConfig = null,
    newFullConfig = fullConfig,
    secretBasePrefix = secretBasePrefix,
  )
```

The key change was that configs now include BOTH:
1. **Secret Coordinates**: The legacy format for backwards compatibility (`{"_secret": "airbyte_workspace_1234_secret_5678"}`)
2. **Secret Reference IDs**: New UUID-based references that link to `secret_config` and `secret_reference` tables

This dual-write approach enabled:

```kotlin
// In SecretReferenceService.kt
fun saveSecretConfigsAndReferencesFromActorConfig(
  actorConfigId: UUID,
  actorConfigWithSecrets: JsonNode,
  runtimeSecretPersistence: SecretPersistence,
  secretStorageId: SecretStorageId?,
): Unit {
  // Process the config to extract secrets
  val processedConfig = SecretReferenceHelpers.processConfigSecrets(
    actorConfigWithSecrets,
    connectorSpec,
    secretStorageId
  )

  // Write secret configs to database
  processedConfig.secretConfigs.forEach { secretConfig ->
    secretConfigService.createSecretConfig(secretConfig)
  }

  // Write secret references to database
  processedConfig.secretReferences.forEach { secretReference ->
    secretReferenceService.createSecretReference(secretReference)
  }
}
```

The `JsonPaths` utility was added to traverse JSON configurations and locate secret fields:

```java
public class JsonPaths {
  /**
   * Returns a list of expanded JSON paths for the given node, handling arrays properly.
   * For example, {"items": [{"name": "a"}, {"name": "b"}]} would produce:
   * ["/items/0/name", "/items/1/name"]
   */
  public static List<String> getExpandedPaths(JsonNode node) {
    List<String> paths = new ArrayList<>();
    collectPaths(node, "", paths);
    return paths;
  }
}
```

#### Business Value

This change was critical for enterprise secret management:

1. **Bring Your Own Secret Manager**: Users can now reference secrets in external secret managers (AWS Secrets Manager, GCP Secret Manager, etc.) using the `secret_coordinate::` prefix
2. **Database Tracking**: The new `secret_config` and `secret_reference` tables provide full audit trail of which configs use which secrets
3. **Migration Path**: Dual-writing both coordinates and IDs enabled gradual migration without breaking existing configs
4. **Type Safety**: The new domain models (`SecretConfig`, `SecretReference`, `SecretStorage`) provide compile-time validation
5. **Airbyte-Managed vs. External**: Clear distinction between Airbyte-managed secrets and customer-managed secrets

The removal of `SecretsRepositoryWriter` from service constructors indicated a shift from service-level secret handling to handler-level processing, giving better control over when secrets are extracted and stored.

#### Related Commits

- 2e601f1aff (Apr 23, 2025): Dual-write secret reference IDs alongside coordinates
- 2bca8c432b (Mar 14, 2025): Add airbyte_managed boolean to secret_config table
- dd0a053964 (Mar 13, 2025): Move IdTypes.kt to airbyte-config module

---

### 2. Deprecate airbyte.yml: Migrate to application.yml

**Commit:** f2d22f8931 - May 2, 2024
**Impact:** 28 files changed, 492 insertions, 217 deletions

#### What Changed

This commit deprecated the legacy `airbyte.yml` configuration file in favor of standard Micronaut `application.yml` properties. It migrated OIDC configuration, initial user setup, and license key configuration to use environment variables and application.yml-based injection.

**Key files added:**
- `airbyte-commons-auth/src/main/kotlin/io/airbyte/commons/auth/config/OidcConfigFactory.kt` (87 lines)
- `airbyte-commons-auth/src/main/kotlin/io/airbyte/commons/auth/config/InitialUserConfigFactory.kt` (65 lines)
- `airbyte-commons-license/src/main/java/io/airbyte/commons/license/LicenceKeyFactory.java` (31 lines)

**Key files migrated:**
- `airbyte-commons-auth/src/main/java/io/airbyte/commons/auth/config/OidcConfigFactory.java` (deleted, 61 lines)
- `airbyte-commons-auth/src/main/java/io/airbyte/commons/auth/config/InitialUserConfiguration.java` (deleted, 26 lines)

#### Implementation Details

The migration introduced a priority system for configuration sources, with environment variables taking precedence over `airbyte.yml`:

```kotlin
@Factory
class OidcConfigFactory {
  /**
   * Returns the OidcConfig with values from the environment, if present. This is the preferred way
   * to configure the oidc identity provider and should take precedence over `airbyte.yml`.
   */
  @Singleton
  @Primary
  @Requires(property = "airbyte.auth.identity-provider.type", value = "oidc")
  fun defaultOidcConfig(
    @Value("\${airbyte.auth.identity-provider.oidc.domain}") domain: String?,
    @Value("\${airbyte.auth.identity-provider.oidc.app-name}") appName: String?,
    @Value("\${airbyte.auth.identity-provider.oidc.client-id}") clientId: String?,
    @Value("\${airbyte.auth.identity-provider.oidc.client-secret}") clientSecret: String?,
  ): OidcConfig {
    if (domain.isNullOrEmpty() || appName.isNullOrEmpty() ||
        clientId.isNullOrEmpty() || clientSecret.isNullOrEmpty()) {
      throw IllegalStateException(
        "Missing required OIDC configuration. Please ensure all of the following properties are set: " +
          "airbyte.auth.identity-provider.oidc.domain, " +
          "airbyte.auth.identity-provider.oidc.app-name, " +
          "airbyte.auth.identity-provider.oidc.client-id, " +
          "airbyte.auth.identity-provider.oidc.client-secret",
      )
    }

    return OidcConfig(domain, appName, clientId, clientSecret)
  }

  /**
   * Returns the OidcConfig with values from the single-idp-style `airbyte.yml` config, if present.
   * This is for backwards compatibility.
   */
  @Singleton
  @Requires(property = "airbyte-yml.auth.identity-provider.type", value = "oidc")
  fun airbyteYmlSingleOidcConfig(
    @Value("\${airbyte-yml.auth.identity-provider.oidc.domain}") domain: String?,
    @Value("\${airbyte-yml.auth.identity-provider.oidc.app-name}") appName: String?,
    @Value("\${airbyte-yml.auth.identity-provider.oidc.client-id}") clientId: String?,
    @Value("\${airbyte-yml.auth.identity-provider.oidc.client-secret}") clientSecret: String?,
  ): OidcConfig {
    // ... validation
    return OidcConfig(domain, appName, clientId, clientSecret)
  }

  /**
   * Returns the OidcConfig with values from the list-style `airbyte.yml` config, if present.
   * This is for backwards compatibility.
   */
  @Singleton
  @Requires(missingProperty = "airbyte-yml.auth.identity-provider")
  @Requires(property = "airbyte-yml.auth.identity-providers")
  fun airbyteYmlListOidcConfig(idpConfigList: List<IdentityProviderConfiguration>?): OidcConfig {
    if (idpConfigList.isNullOrEmpty()) {
      throw IllegalStateException(
        "Missing required OIDC configuration. Please ensure all of the following properties are set: airbyte-yml.auth.identity-providers",
      )
    }
    if (idpConfigList.size > 1) {
      throw IllegalStateException("Only one identity provider is supported. Found ${idpConfigList.size} identity providers.")
    }

    return idpConfigList.first().toOidcConfig()
  }
}

data class OidcConfig(
  val domain: String,
  val appName: String,
  val clientId: String,
  val clientSecret: String,
)
```

The `@Primary` annotation on `defaultOidcConfig` ensured that environment-based configuration took precedence. The `@Requires` annotations created conditional beans that only loaded when specific properties were present.

Similarly, the initial user configuration was migrated:

```kotlin
@Factory
class InitialUserConfigFactory {
  @Singleton
  @Primary
  @Requires(property = "airbyte.auth.initial-user.email")
  fun defaultInitialUserConfig(
    @Value("\${airbyte.auth.initial-user.email}") email: String,
    @Value("\${airbyte.auth.initial-user.first-name}") firstName: String?,
    @Value("\${airbyte.auth.initial-user.last-name}") lastName: String?,
  ): InitialUserConfig {
    return InitialUserConfig(email, firstName, lastName)
  }

  @Singleton
  @Requires(missingProperty = "airbyte.auth.initial-user.email")
  @Requires(property = "airbyte-yml.auth.initial-user.email")
  fun airbyteYmlInitialUserConfig(
    @Value("\${airbyte-yml.auth.initial-user.email}") email: String,
    @Value("\${airbyte-yml.auth.initial-user.first-name}") firstName: String?,
    @Value("\${airbyte-yml.auth.initial-user.last-name}") lastName: String?,
  ): InitialUserConfig {
    return InitialUserConfig(email, firstName, lastName)
  }
}
```

License key configuration followed the same pattern:

```java
@Factory
public class LicenceKeyFactory {
  @Singleton
  @Primary
  @Requires(property = "airbyte.license-key")
  public String defaultLicenseKey(@Value("${airbyte.license-key}") final String licenseKey) {
    return licenseKey;
  }

  @Singleton
  @Requires(missingProperty = "airbyte.license-key")
  @Requires(property = "airbyte-yml.license-key")
  public String airbyteYmlLicenseKey(@Value("${airbyte-yml.license-key}") final String licenseKey) {
    return licenseKey;
  }
}
```

#### Business Value

This migration delivered significant operational benefits:

1. **12-Factor App Compliance**: Environment variable-based configuration aligned with cloud-native best practices
2. **Kubernetes-Friendly**: ConfigMaps and Secrets could directly inject configuration without custom file mounting
3. **Backwards Compatibility**: Existing `airbyte.yml` deployments continued working through fallback beans
4. **Type Safety**: Micronaut's compile-time injection validation caught configuration errors early
5. **Simplified Deployment**: Helm charts could use standard Kubernetes patterns instead of custom volume mounts
6. **Better Defaults**: Missing optional values handled gracefully with nullable types

The addition of application.yml entries in airbyte-server and airbyte-keycloak-setup showed the new configuration structure:

```yaml
# airbyte-server/src/main/resources/application.yml
airbyte:
  auth:
    identity-provider:
      type: ${AUTH_IDENTITY_PROVIDER_TYPE:}
      oidc:
        domain: ${AUTH_IDENTITY_PROVIDER_OIDC_DOMAIN:}
        app-name: ${AUTH_IDENTITY_PROVIDER_OIDC_APP_NAME:}
        client-id: ${AUTH_IDENTITY_PROVIDER_OIDC_CLIENT_ID:}
        client-secret: ${AUTH_IDENTITY_PROVIDER_OIDC_CLIENT_SECRET:}
    initial-user:
      email: ${INITIAL_USER_EMAIL:}
      first-name: ${INITIAL_USER_FIRST_NAME:}
      last-name: ${INITIAL_USER_LAST_NAME:}
  license-key: ${AIRBYTE_LICENSE_KEY:}
```

#### Related Commits

- 359badef5f (May 28, 2024): Introduced AuthConfigs and @RequiresAuthMode annotation
- 2ab27f1189 (Apr 22, 2024): Keycloak Setup always updates realm configuration
- 07c05cfc1f (Apr 25, 2024): Remove OidcConfiguration log line from Keycloak Setup

---

### 3. AuthConfigs and @RequiresAuthMode Annotation

**Commit:** 359badef5f - May 28, 2024
**Impact:** 21 files changed, 486 insertions, 348 deletions

#### What Changed

This refactoring introduced a unified `AuthConfigs` data class and a custom Micronaut condition annotation `@RequiresAuthMode` that allows beans to be conditionally loaded based on the authentication mode (OIDC, SIMPLE, or NONE).

**Key files added:**
- `airbyte-commons-auth/src/main/kotlin/io/airbyte/commons/auth/config/AuthConfigs.kt` (81 lines)
- `airbyte-commons-auth/src/main/kotlin/io/airbyte/commons/auth/RequiresAuthMode.kt` (43 lines)
- `airbyte-commons-auth/src/main/kotlin/io/airbyte/commons/auth/config/AirbyteKeycloakConfiguration.kt` (34 lines, migrated from Java)
- `airbyte-commons-auth/src/main/kotlin/io/airbyte/commons/auth/config/IdentityProviderConfiguration.kt` (25 lines, migrated from Java)

**Key files removed:**
- `airbyte-commons-auth/src/main/java/io/airbyte/commons/auth/config/AirbyteKeycloakConfiguration.java` (53 lines)
- `airbyte-commons-auth/src/main/java/io/airbyte/commons/auth/config/IdentityProviderConfiguration.java` (41 lines)
- `airbyte-commons-server/src/main/kotlin/io/airbyte/commons/server/config/ConfigFactories.kt` (32 lines)

#### Implementation Details

The `AuthConfigs` data class unified all authentication configuration in one place:

```kotlin
/**
 * Data class representing the AuthConfigs for an Airbyte instance. This includes the [AuthMode] and
 * optional sub-configurations like [OidcConfig] and [AirbyteKeycloakConfiguration].
 */
data class AuthConfigs(
  val authMode: AuthMode,
  val keycloakConfig: AirbyteKeycloakConfiguration? = null,
  val oidcConfig: OidcConfig? = null,
  val initialUserConfig: InitialUserConfig? = null,
)

/**
 * Enum representing the different authentication modes that Airbyte can be configured to use.
 * Note that `SIMPLE` refers to the single-user username/password authentication mode that Community
 * edition uses, while `OIDC` refers to the OpenID Connect authentication mode that Enterprise and
 * Cloud use. `NONE` is used when authentication is disabled completely.
 */
enum class AuthMode {
  OIDC,
  SIMPLE,
  NONE,
}
```

The `AuthMode` is determined by deployment mode and edition:

```kotlin
@Factory
class AuthModeFactory(
  val deploymentMode: DeploymentMode,
  val airbyteEdition: Configs.AirbyteEdition,
) {
  /**
   * When the Micronaut environment is set to `community-auth`, the `SIMPLE` auth mode is used
   * regardless of the deployment mode or other configurations. This bean replaces the
   * [defaultAuthMode] when the `community-auth` environment is active.
   */
  @Singleton
  @Requires(env = ["community-auth"])
  @Primary
  fun communityAuthMode(): AuthMode {
    return AuthMode.SIMPLE
  }

  /**
   * The default auth mode is determined by the deployment mode and edition.
   */
  @Singleton
  fun defaultAuthMode(): AuthMode {
    return when {
      deploymentMode == DeploymentMode.CLOUD -> AuthMode.OIDC
      airbyteEdition == Configs.AirbyteEdition.PRO -> AuthMode.OIDC
      deploymentMode == DeploymentMode.OSS -> AuthMode.NONE
      else -> throw IllegalStateException("Unknown or unspecified deployment mode: $deploymentMode")
    }
  }
}
```

The factory then assembles the complete AuthConfigs:

```kotlin
@Factory
class AuthConfigFactory(
  val authMode: AuthMode,
  val keycloakConfig: AirbyteKeycloakConfiguration? = null,
  val oidcConfig: OidcConfig? = null,
  val initialUserConfig: InitialUserConfig? = null,
) {
  @Singleton
  fun authConfig(): AuthConfigs {
    return AuthConfigs(authMode, keycloakConfig, oidcConfig, initialUserConfig)
  }
}
```

The killer feature was the `@RequiresAuthMode` annotation:

```kotlin
/**
 * Annotation used to mark a bean that requires a specific [AuthMode] to be active in order to be loaded.
 *
 * Example usage:
 * ```
 * @RequiresAuthMode(AuthMode.OIDC)
 * @Singleton
 * class AuthServiceOidcImpl : AuthService {
 *  // ...
 *  }
 *  ```
 */
@Requires(condition = AuthModeCondition::class)
@Retention(AnnotationRetention.RUNTIME)
@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION)
annotation class RequiresAuthMode(val value: AuthMode)

/**
 * Condition that powers the [RequiresAuthMode] annotation.
 */
class AuthModeCondition : Condition {
  override fun matches(context: ConditionContext<*>): Boolean {
    val annotationMetadata =
      context.component.annotationMetadata
        ?: throw IllegalStateException("AuthModeCondition can only be used with annotated beans.")

    val authModeFromAnnotation =
      annotationMetadata.enumValue(RequiresAuthMode::class.java, AuthMode::class.java)
        .orElseThrow { IllegalStateException("RequiresAuthMode annotation must have a value in order to be used with AuthModeCondition.") }

    val currentAuthMode = context.getBean(AuthConfigs::class.java).authMode

    return authModeFromAnnotation == currentAuthMode
  }
}
```

This enabled clean separation of authentication implementations:

```kotlin
// Before: Manual checks in code
if (authMode == AuthMode.OIDC) {
  return oidcAuthProvider
} else {
  return simpleAuthProvider
}

// After: Declarative bean loading
@RequiresAuthMode(AuthMode.OIDC)
@Singleton
class OidcAuthProvider : AuthProvider {
  // OIDC implementation
}

@RequiresAuthMode(AuthMode.SIMPLE)
@Singleton
class SimpleAuthProvider : AuthProvider {
  // Simple auth implementation
}
```

#### Business Value

This architectural improvement delivered:

1. **Cleaner Code**: Removed scattered if/else authentication mode checks throughout the codebase
2. **Compile-Time Safety**: Micronaut validates bean wiring at compile time, catching configuration errors early
3. **Easier Testing**: Tests can activate specific auth modes by setting environment
4. **Better Modularity**: Authentication implementations are completely isolated from each other
5. **Documentation as Code**: The `AuthConfigs` data class serves as living documentation of what configuration exists
6. **Extensibility**: Adding new auth modes requires minimal changes to existing code

The migration from Java to Kotlin for authentication configuration classes also brought null-safety and data class benefits.

#### Related Commits

- f2d22f8931 (May 2, 2024): Deprecated airbyte.yml configuration
- dacfafff41 (Aug 24, 2023): Added InstanceConfiguration API with setup endpoint

---

### 4. Keycloak Setup: Always Update Realm Configuration

**Commit:** 2ab27f1189 - April 22, 2024
**Impact:** 29 files changed, 932 insertions, 585 deletions

#### What Changed

This commit transformed Keycloak realm setup from a one-time creation process to an idempotent configuration management system. Previously, Keycloak realm configuration was only applied on first startup or when a RESET flag was set. After this change, every startup updates the realm configuration to match the desired state.

**Key files added:**
- `airbyte-keycloak-setup/src/main/java/io/airbyte/keycloak/setup/IdentityProvidersConfigurator.java` (125 lines)
- `airbyte-keycloak-setup/src/main/java/io/airbyte/keycloak/setup/UserConfigurator.java` (renamed/refactored from UserCreator.java)
- `airbyte-keycloak-setup/src/main/java/io/airbyte/keycloak/setup/ClientScopeConfigurator.java` (renamed from ClientScopeCreator.java)
- `airbyte-keycloak-setup/src/main/java/io/airbyte/keycloak/setup/WebClientConfigurator.java` (renamed from WebClientCreator.java)
- `airbyte-commons-auth/src/main/java/io/airbyte/commons/auth/config/OidcConfigFactory.java` (61 lines)

**Key files removed:**
- `airbyte-keycloak-setup/src/main/java/io/airbyte/keycloak/setup/IdentityProvidersCreator.java` (83 lines)
- `airbyte-keycloak-setup/src/main/java/io/airbyte/keycloak/setup/UserCreator.java` (112 lines)
- `airbyte-keycloak-setup/src/main/java/io/airbyte/keycloak/setup/AccountClientUpdater.java` (43 lines)

#### Implementation Details

The core change was in the `IdentityProvidersConfigurator`, which intelligently handles existing IDPs:

```java
/**
 * This class is responsible for configuring an identity provider. It creates and manages various
 * identity providers for authentication purposes.
 */
@Singleton
@Slf4j
public class IdentityProvidersConfigurator {

  static final String AIRBYTE_MANAGED_IDP_KEY = "airbyte-managed-idp";
  static final String AIRBYTE_MANAGED_IDP_VALUE = "true";
  private static final String KEYCLOAK_PROVIDER_ID = "oidc";

  public void configureIdp(final RealmResource keycloakRealm) {
    if (oidcConfig.isEmpty()) {
      log.info("No identity provider configuration found. Skipping IDP setup.");
      return;
    }

    final IdentityProviderRepresentation idp = buildIdpFromConfig(keycloakRealm, oidcConfig.get());

    final List<IdentityProviderRepresentation> existingIdps = keycloakRealm.identityProviders().findAll();

    // if no IDPs exist, create one and mark it as airbyte-managed
    if (existingIdps.isEmpty()) {
      log.info("No existing identity providers found. Creating new IDP.");
      createNewIdp(keycloakRealm, idp);
      return;
    }

    // Look for an IDP with the AIRBYTE_MANAGED_IDP_KEY/VALUE in its config. This allows keycloak-setup
    // to programmatically configure a specific IDP, even if the realm contains multiple.
    final List<IdentityProviderRepresentation> existingManagedIdps = existingIdps.stream()
        .filter(existingIdp -> existingIdp.getConfig().getOrDefault(AIRBYTE_MANAGED_IDP_KEY, "false").equals(AIRBYTE_MANAGED_IDP_VALUE))
        .toList();

    if (existingManagedIdps.size() > 1) {
      log.warn(
          "Found multiple IDPs with Config entry {}={}. This isn't supported, as keycloak-setup only supports one managed IDP. Skipping IDP update.",
          AIRBYTE_MANAGED_IDP_KEY, AIRBYTE_MANAGED_IDP_VALUE);
      return;
    }

    if (existingManagedIdps.size() == 1) {
      log.info("Found existing managed IDP. Updating it.");
      updateExistingIdp(keycloakRealm, existingManagedIdps.getFirst(), idp);
      return;
    }

    // if no managed IDPs exist, but there is exactly one IDP, update it and mark it as airbyte-managed
    if (existingIdps.size() == 1) {
      log.info("Found exactly one existing IDP. Updating it and marking it as airbyte-managed.");
      updateExistingIdp(keycloakRealm, existingIdps.getFirst(), idp);
      return;
    }

    // if there are multiple IDPs and none are managed, log a warning and do nothing.
    log.warn("Multiple identity providers exist and none are marked as airbyte-managed. Skipping IDP update.");
  }

  private void updateExistingIdp(final RealmResource keycloakRealm,
                                 final IdentityProviderRepresentation existingIdp,
                                 final IdentityProviderRepresentation updatedIdp) {
    // In order to apply the updated IDP configuration to the existing IDP within Keycloak, we need to
    // set the internal ID of the existing IDP.
    updatedIdp.setInternalId(existingIdp.getInternalId());
    keycloakRealm.identityProviders().get(existingIdp.getAlias()).update(updatedIdp);
  }

  private IdentityProviderRepresentation buildIdpFromConfig(final RealmResource keycloakRealm, final OidcConfig oidcConfig) {
    final IdentityProviderRepresentation idp = new IdentityProviderRepresentation();
    idp.setAlias(oidcConfig.appName());
    idp.setProviderId(KEYCLOAK_PROVIDER_ID);
    idp.setEnabled(true);

    final Map<String, String> configMap = configurationMapService.importProviderFrom(keycloakRealm, oidcConfig, idp.getProviderId());
    final Map<String, String> config = configurationMapService.setupProviderConfig(oidcConfig, configMap);

    // mark the IDP as airbyte-managed so that it can be programmatically updated in the future.
    config.put(AIRBYTE_MANAGED_IDP_KEY, AIRBYTE_MANAGED_IDP_VALUE);
    idp.setConfig(config);

    return idp;
  }
}
```

The key innovation was the `AIRBYTE_MANAGED_IDP_KEY` marker that tags IDPs as being managed by Airbyte, allowing the system to distinguish between:
1. IDPs created and managed by Airbyte (can be updated)
2. IDPs manually created by administrators (should not be touched)

Similarly, the `UserConfigurator` (renamed from `UserCreator`) now updates existing users:

```java
public class UserConfigurator {
  public void configureUser(final RealmResource keycloakRealm, final InitialUserConfig initialUserConfig) {
    final List<UserRepresentation> existingUsers =
        keycloakRealm.users().search(initialUserConfig.email(), true);

    if (existingUsers.isEmpty()) {
      createNewUser(keycloakRealm, initialUserConfig);
    } else {
      updateExistingUser(keycloakRealm, existingUsers.get(0), initialUserConfig);
    }
  }
}
```

The removal of the RESET environment variable simplified deployment:

```bash
# Before: Required explicit reset flag
KEYCLOAK_RESET_REALM=true

# After: Always updates configuration
# No flag needed - configuration is idempotent
```

#### Business Value

This change delivered critical operational improvements:

1. **Configuration Drift Prevention**: Realm configuration now matches code on every deployment, preventing drift
2. **Simplified Operations**: No need to manually reset realms when configuration changes
3. **Safer Updates**: The `airbyte-managed-idp` marker prevents accidentally overwriting manual configurations
4. **Gitops-Friendly**: Configuration-as-code approach where code is source of truth
5. **Reduced Downtime**: Updates happen automatically without manual intervention
6. **Better Testing**: Test environments can be reset by simply restarting Keycloak setup

The extensive test coverage (205 new test lines in `IdentityProvidersConfiguratorTest.java`) ensured all scenarios were handled correctly:
- No IDPs exist
- One unmanaged IDP exists
- One managed IDP exists
- Multiple IDPs with one managed
- Multiple unmanaged IDPs

#### Related Commits

- 9c81dbecd3 (Mar 22, 2024): Clear User/Permission records when resetting Keycloak Realm
- 07c05cfc1f (Apr 25, 2024): Remove OidcConfiguration log line from Keycloak Setup
- 3c7e1b5251 (Feb 22, 2024): Remove validateSignature key from idp config

---

### 5. InstanceConfiguration API with /setup Endpoint

**Commit:** dacfafff41 - August 24, 2023
**Impact:** 70 files changed, 948 insertions, 448 deletions

#### What Changed

This commit introduced a unified `/api/v1/instance_configuration/setup` endpoint that allows the Airbyte webapp to complete initial setup by configuring the default organization, user, and workspace in a single API call. It consolidated separate OSS and Pro handlers into one unified implementation.

**Key files added:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/InstanceConfigurationHandler.java` (170 lines)

**Key files removed:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/DefaultInstanceConfigurationHandler.java`
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/ProInstanceConfigurationHandler.java`

#### Implementation Details

The unified handler provides both GET and POST operations for instance configuration:

```java
@Singleton
public class InstanceConfigurationHandler {

  private final String webappUrl;
  private final AirbyteEdition airbyteEdition;
  private final Optional<AirbyteKeycloakConfiguration> airbyteKeycloakConfiguration;
  private final Optional<ActiveAirbyteLicense> activeAirbyteLicense;
  private final ConfigRepository configRepository;
  private final WorkspacesHandler workspacesHandler;
  private final UserPersistence userPersistence;
  private final OrganizationPersistence organizationPersistence;

  public InstanceConfigurationResponse getInstanceConfiguration()
      throws IOException, ConfigNotFoundException {
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

  public InstanceConfigurationResponse setupInstanceConfiguration(
      final InstanceConfigurationSetupRequestBody requestBody)
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

    // Return the updated instance configuration
    return getInstanceConfiguration();
  }

  private void updateDefaultUser(final InstanceConfigurationSetupRequestBody requestBody)
      throws IOException {
    final User defaultUser = userPersistence.getDefaultUser()
        .orElseThrow(() -> new IllegalStateException("Default user does not exist."));

    // email is a required request property, so always set it.
    defaultUser.setEmail(requestBody.getEmail());

    // name is currently optional, so only set it if it is provided.
    if (requestBody.getUserName() != null) {
      defaultUser.setName(requestBody.getUserName());
    }

    userPersistence.writeUser(defaultUser);
  }

  private void updateDefaultOrganization(final InstanceConfigurationSetupRequestBody requestBody)
      throws IOException {
    final Organization defaultOrganization =
        organizationPersistence.getDefaultOrganization()
            .orElseThrow(() -> new IllegalStateException("Default organization does not exist."));

    // email is a required request property, so always set it.
    defaultOrganization.setEmail(requestBody.getEmail());

    // name is currently optional, so only set it if it is provided.
    if (requestBody.getOrganizationName() != null) {
      defaultOrganization.setName(requestBody.getOrganizationName());
    }

    organizationPersistence.updateOrganization(defaultOrganization);
  }

  private LicenseTypeEnum getLicenseType() {
    if (airbyteEdition.equals(AirbyteEdition.PRO) && activeAirbyteLicense.isPresent()) {
      return Enums.convertTo(activeAirbyteLicense.get().getLicenseType(), LicenseTypeEnum.class);
    } else {
      return null;
    }
  }

  private AuthConfiguration getAuthConfiguration() {
    if (airbyteEdition.equals(AirbyteEdition.PRO) && airbyteKeycloakConfiguration.isPresent()) {
      return new AuthConfiguration()
          .clientId(airbyteKeycloakConfiguration.get().getWebClientId())
          .defaultRealm(airbyteKeycloakConfiguration.get().getAirbyteRealm());
    } else {
      return null;
    }
  }

  // Currently, the default workspace is simply the first workspace created by the bootloader.
  // TODO introduce a proper means of persisting instance-level preferences instead of using
  // the first workspace as a proxy.
  private StandardWorkspace getDefaultWorkspace() throws IOException {
    return configRepository.listStandardWorkspaces(true).stream().findFirst()
        .orElseThrow(() -> new IllegalStateException("Default workspace does not exist."));
  }
}
```

The API specification defined the request and response models:

```yaml
# config.yaml
paths:
  /instance_configuration/setup:
    post:
      operationId: setupInstanceConfiguration
      requestBody:
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/InstanceConfigurationSetupRequestBody"
      responses:
        "200":
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/InstanceConfigurationResponse"

components:
  schemas:
    InstanceConfigurationSetupRequestBody:
      type: object
      required:
        - workspaceId
        - email
        - initialSetupComplete
      properties:
        workspaceId:
          type: string
          format: uuid
        email:
          type: string
        userName:
          type: string
        organizationName:
          type: string
        displaySetupWizard:
          type: boolean
        anonymousDataCollection:
          type: boolean
        initialSetupComplete:
          type: boolean

    InstanceConfigurationResponse:
      type: object
      properties:
        webappUrl:
          type: string
        edition:
          type: string
          enum: [community, pro]
        licenseType:
          type: string
          enum: [pro, enterprise]
        auth:
          $ref: "#/components/schemas/AuthConfiguration"
        initialSetupComplete:
          type: boolean
        defaultUserId:
          type: string
          format: uuid
        defaultOrganizationId:
          type: string
          format: uuid
        defaultWorkspaceId:
          type: string
          format: uuid
```

#### Business Value

This API enabled a streamlined onboarding experience:

1. **Single Transaction**: All setup data collected in one request, reducing race conditions
2. **Atomic Updates**: Organization, user, and workspace updated together or not at all
3. **Edition Agnostic**: Same API works for OSS, Pro, and Cloud deployments
4. **Frontend Simplification**: Webapp doesn't need to know about default IDs or edition-specific logic
5. **Better UX**: User completes setup wizard, clicks "Finish", and everything is configured
6. **Migration Foundation**: Laid groundwork for migrating users from Firebase to Airbyte-managed auth

The consolidation of handlers also reduced code duplication by ~200 lines while improving testability.

#### Related Commits

- 6b4546f400 (Aug 31, 2023): InstanceConfiguration API fixes - default workspace selection
- e7490ddf1c (May 17, 2023): Add User and Permission tables to OSS ConfigsDb
- 9ffa4e9f44 (Nov 9, 2023): Improved initial user handling + SSO config

---

### 6. SSO Configuration with Draft and Active Status

**Commits:**
- 37c94eb19e (Oct 1, 2025) - Add status field to SSO Config
- 2eacc0d2e5 (Sep 29, 2025) - Database migration for status column
- fe1917ce1a (Oct 6, 2025) - Implement activate endpoint and draft configs
- 866d7bae4d (Oct 8, 2025) - Improve draft SSO config with realm cleanup

**Combined Impact:** 33 files changed, ~1,500 insertions, ~350 deletions

#### What Changed

This series of commits introduced a two-phase SSO configuration workflow. Instead of requiring organizations to get their SSO config perfect on the first try, they can now create "draft" configurations for testing, then "activate" them when ready to enforce SSO login.

**Key changes:**
- Added `status` column to `sso_config` table (enum: 'draft', 'active')
- Implemented `/sso_config/activate` endpoint
- Improved draft config handling with automatic Keycloak realm cleanup on failures
- User preservation when updating draft SSO configs

#### Implementation Details

The database migration added the status field:

```java
// V0_64_4_004__AddStatusToSsoConfig.java
public void migrate(final Context context) throws Exception {
  final DSLContext ctx = DSL.using(context.getConnection());

  // Create the enum type
  ctx.createType(SsoConfigStatus.NAME)
      .asEnum("draft", "active")
      .execute();

  // Add the column with default 'active' for existing records
  ctx.alterTable(SSO_CONFIG_TABLE)
      .addColumn(DSL.field("status", SQLDataType.VARCHAR
          .asEnumDataType(SsoConfigStatus.class)
          .nullable(false)
          .defaultValue(SsoConfigStatus.active)))
      .execute();
}
```

The domain model was updated:

```kotlin
data class SsoConfig(
  val id: UUID,
  val organizationId: UUID,
  val companyIdentifier: String,
  val clientId: String,
  val clientSecret: String,
  val discoveryUrl: String,
  val keycloakRealm: String,
  val emailDomain: List<String>,
  val status: SsoConfigStatus, // NEW
)

enum class SsoConfigStatus {
  DRAFT,
  ACTIVE,
}
```

The activate endpoint was implemented in the domain service:

```kotlin
class SsoConfigDomainService {
  /**
   * Activates a draft SSO configuration by:
   * 1. Validating the configuration is in DRAFT status
   * 2. Checking for domain conflicts with other organizations
   * 3. Updating the status to ACTIVE
   */
  fun activateSsoConfig(organizationId: UUID): SsoConfig {
    val ssoConfig = ssoConfigService.getSsoConfig(organizationId)
        ?: throw ConfigNotFoundException("SSO Config", organizationId.toString())

    if (ssoConfig.status == SsoConfigStatus.ACTIVE) {
      throw IllegalStateException("SSO Config is already active")
    }

    // Validate that no other organization is using the same email domain with an active config
    ssoConfig.emailDomain.forEach { domain ->
      val existingActiveConfig = ssoConfigService.getByEmailDomain(domain)
      if (existingActiveConfig != null &&
          existingActiveConfig.organizationId != organizationId &&
          existingActiveConfig.status == SsoConfigStatus.ACTIVE) {
        throw IllegalStateException(
          "Email domain $domain is already in use by another organization's active SSO config"
        )
      }
    }

    // Update status to active
    return ssoConfigService.updateSsoConfig(
      ssoConfig.copy(status = SsoConfigStatus.ACTIVE)
    )
  }
}
```

The critical improvement was in draft config handling with proper cleanup:

```kotlin
class AirbyteKeycloakClient {
  /**
   * Creates a complete OIDC SSO configuration including realm, identity provider, and client.
   * If any step fails after the realm is created, the realm is deleted before throwing the exception.
   */
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

      val airbyteWebappClient = ClientRepresentation().apply {
        clientId = AIRBYTE_WEBAPP_CLIENT_ID
        name = AIRBYTE_WEBAPP_CLIENT_NAME
        protocol = "openid-connect"
        redirectUris = listOf("${airbyteConfig.airbyteUrl}/*")
        webOrigins = listOf(airbyteConfig.airbyteUrl)
        baseUrl = airbyteConfig.airbyteUrl
        isEnabled = true
        isPublicClient = true
      }
      createClientForRealm(request.companyIdentifier, airbyteWebappClient)
    } catch (e: Exception) {
      // If anything fails, clean up the realm
      try {
        deleteRealm(request.companyIdentifier)
      } catch (cleanupEx: Exception) {
        logger.error(cleanupEx) {
          "Failed to cleanup Keycloak realm ${request.companyIdentifier} after configuration failure"
        }
      }
      throw e
    }
  }
}
```

The domain service gained sophisticated draft handling:

```kotlin
/**
 * Creates or updates a draft SSO configuration. This allows organizations to test their
 * SSO setup before enforcing it.
 */
private fun createDraftSsoConfig(config: SsoConfig) {
  validateDiscoveryUrl(config)

  val existingConfig = ssoConfigService.getSsoConfig(config.organizationId)

  when {
    existingConfig == null -> {
      // No existing config, create new one
      createNewDraftSsoConfig(config)
    }

    existingConfig.keycloakRealm != config.companyIdentifier -> {
      // Realm name changed, delete old config and create new one
      deleteSsoConfig(config.organizationId, existingConfig.keycloakRealm)
      createNewDraftSsoConfig(config)
    }

    airbyteKeycloakClient.realmExists(config.companyIdentifier) -> {
      // Realm exists, just update the IDP configuration
      updateExistingKeycloakRealmConfig(config)
    }

    else -> {
      // Database record exists but Keycloak realm doesn't, recreate realm
      logger.info { "Realm ${config.companyIdentifier} does not exist but DB record does, recreating realm" }
      createKeycloakRealmWithErrorHandling(config)
    }
  }
}

/**
 * Updates the IDP configuration for an existing realm, preserving user accounts.
 */
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
    "clientAuthMethod" to CLIENT_AUTH_METHOD,
    "defaultScope" to DEFAULT_SCOPE,
  )

  if (existingIdp != null) {
    // Update existing IDP to preserve user links
    existingIdp.config = idpConfig
    realm.identityProviders().get(DEFAULT_IDP_ALIAS).update(existingIdp)
  } else {
    // Create new IDP
    val idp = IdentityProviderRepresentation().apply {
      alias = DEFAULT_IDP_ALIAS
      providerId = "oidc"
      config = idpConfig
    }
    createIdpForRealm(ssoConfig.companyIdentifier, idp)
  }
}
```

#### Business Value

This two-phase approach dramatically improved the SSO setup experience:

1. **Risk Reduction**: Organizations can test SSO without locking out existing users
2. **Iterative Configuration**: Admins can update client IDs, secrets, and discovery URLs while testing
3. **User Preservation**: Updating draft configs no longer deletes user accounts
4. **Data Integrity**: Automatic Keycloak realm cleanup prevents orphaned resources
5. **Domain Protection**: Active status prevents domain conflicts between organizations
6. **Better UX**: Clear separation between "testing" and "enforcing" SSO
7. **Rollback Capability**: Organizations can deactivate SSO if issues arise

The transaction boundary documentation explained critical design decisions:

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

- 1afd3bf944 (Oct 7, 2025): Implement validate_token endpoint
- 4e687527e1 (Oct 7, 2025): Add SSO validation UI with two-step flow
- 8680bf33f3 (Oct 9, 2025): Add confirmation modal to SSO activation
- 252c085e7d (Oct 16, 2025): Show redirect URI info during SSO setup
- 4edea0b534 (Oct 15, 2025): Move SSO validation code exchange to backend
- 258ff83dd5 (Oct 16, 2025): Revert backend code exchange, set 3-minute lifespan

---

### 7. Default Dataplane Group Configuration

**Commit:** 089aa511f7 - September 18, 2025
**Impact:** 28 files changed, 193 insertions, 149 deletions

#### What Changed

This commit made the default dataplane group configurable via environment variables and application.yml, removing hardcoded assumptions about dataplane group names and enabling flexible multi-dataplane deployments.

**Key files modified:**
- `airbyte-micronaut-runtime/src/main/kotlin/io/airbyte/micronaut/runtime/AirbyteConfig.kt` (7 additions)
- `airbyte-bootloader/src/main/kotlin/io/airbyte/bootloader/DataplaneInitializer.kt` (55 changes)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/DataplaneGroupService.kt` (13 changes)

#### Implementation Details

The configuration was added to `AirbyteConfig`:

```kotlin
@ConfigurationProperties("airbyte")
data class AirbyteConfig(
  val version: String,
  val role: String,
  val edition: String,
  val deploymentMode: String,
  val airbyteUrl: String,
  val webappUrl: String,

  // NEW: Default dataplane group configuration
  val dataplaneGroups: DataplaneGroupsConfig = DataplaneGroupsConfig(),
)

data class DataplaneGroupsConfig(
  val defaultName: String = "default",
  val defaultConfigPath: String? = null,
)
```

The application.yml exposed these as environment variables:

```yaml
# application.yml
airbyte:
  dataplane-groups:
    default-name: ${DATAPLANE_GROUP_DEFAULT_NAME:default}
    default-config-path: ${DATAPLANE_GROUP_DEFAULT_CONFIG_PATH:}
```

The bootloader's `DataplaneInitializer` was refactored to use the configuration:

```kotlin
@Singleton
class DataplaneInitializer(
  private val dataplaneGroupService: DataplaneGroupService,
  private val airbyteConfig: AirbyteConfig,
) {
  fun initializeDefaultDataplaneGroup() {
    val defaultGroupName = airbyteConfig.dataplaneGroups.defaultName
    val existingGroup = dataplaneGroupService.getByName(defaultGroupName)

    if (existingGroup == null) {
      logger.info { "Creating default dataplane group: $defaultGroupName" }
      val config = loadDefaultConfig()
      dataplaneGroupService.create(
        DataplaneGroup(
          name = defaultGroupName,
          config = config,
          isActive = true,
        )
      )
    } else {
      logger.info { "Default dataplane group already exists: $defaultGroupName" }
    }
  }

  private fun loadDefaultConfig(): JsonNode {
    val configPath = airbyteConfig.dataplaneGroups.defaultConfigPath
    if (configPath != null) {
      logger.info { "Loading default dataplane group config from: $configPath" }
      return Jsons.deserialize(File(configPath).readText())
    }
    return Jsons.emptyObject()
  }
}
```

The `DataplaneGroupService` was updated to support retrieval by name:

```kotlin
interface DataplaneGroupService {
  fun getByName(name: String): DataplaneGroup?
  fun create(dataplaneGroup: DataplaneGroup): DataplaneGroup
  fun getDefault(): DataplaneGroup
}

@Singleton
class DataplaneGroupServiceDataImpl(
  private val dataplaneGroupRepository: DataplaneGroupRepository,
  private val airbyteConfig: AirbyteConfig,
) : DataplaneGroupService {

  override fun getDefault(): DataplaneGroup {
    val defaultName = airbyteConfig.dataplaneGroups.defaultName
    return getByName(defaultName)
        ?: throw IllegalStateException("Default dataplane group '$defaultName' does not exist")
  }
}
```

Helm chart templates were updated to inject the configuration:

```yaml
# charts/v2/airbyte/templates/airbyte-bootloader/pod.yaml
env:
  - name: DATAPLANE_GROUP_DEFAULT_NAME
    value: {{ .Values.dataplaneGroups.defaultName | quote }}
  - name: DATAPLANE_GROUP_DEFAULT_CONFIG_PATH
    value: {{ .Values.dataplaneGroups.defaultConfigPath | quote }}

# charts/v2/airbyte/values.yaml
dataplaneGroups:
  defaultName: "default"
  defaultConfigPath: ""
```

#### Business Value

This configuration flexibility enabled advanced deployment scenarios:

1. **Multi-Region Deployments**: Different regions can have different default dataplane groups
2. **Environment Segregation**: Dev/staging/prod can use different dataplanes
3. **Resource Isolation**: Large customers can get dedicated dataplane groups
4. **Testing**: Easy to test dataplane changes by pointing to different groups
5. **Migration Support**: Gradual migration from old to new dataplane infrastructure
6. **Kubernetes-Native**: Standard ConfigMap-based configuration

The change removed hardcoded "default" strings scattered across the codebase, centralizing dataplane group naming in configuration.

#### Related Commits

- b742a451a0 (Feb 15, 2022): Configure kube pod process per job type
- d1c48feaed (Jun 16, 2023): Add configurable schedule jitter

---

### 8. Organization Payment Configuration

**Commits:**
- e4f94d20c1 (Aug 23, 2024) - Create OrganizationPaymentConfig table
- e9be1e7095 (Aug 23, 2024) - Add Micronaut Data layer
- 8d2a7a3be8 (Dec 2, 2024) - Add subscription_status column
- 9b9b93c643 (Dec 13, 2024) - Fix update API with subscription_status

**Combined Impact:** 25 files changed, ~800 insertions, ~150 deletions

#### What Changed

This series of commits introduced configuration management for organization payment settings, including payment provider integration, payment status tracking, usage category overrides, and subscription status.

#### Implementation Details

The database migration created a comprehensive payment config table:

```java
public class V0_57_4_017__CreateOrganizationPaymentConfigTable extends BaseJavaMigration {

  static void createOrganizationPaymentConfigTableAndIndexes(final DSLContext ctx) {
    final Field<UUID> organizationId = DSL.field("organization_id", SQLDataType.UUID.nullable(false));
    final Field<String> paymentProviderId = DSL.field("payment_provider_id", SQLDataType.VARCHAR(256).nullable(true));
    final Field<PaymentStatus> paymentStatus = DSL.field("payment_status",
        SQLDataType.VARCHAR.asEnumDataType(PaymentStatus.class)
            .nullable(false)
            .defaultValue(PaymentStatus.UNINITIALIZED));
    final Field<UsageCategoryOverride> usageCategoryOverride = DSL.field("usage_category",
        SQLDataType.VARCHAR.asEnumDataType(UsageCategoryOverride.class)
            .nullable(true));
    final Field<OffsetDateTime> gracePeriodEndAt = DSL.field("grace_period_end_at",
        SQLDataType.TIMESTAMPWITHTIMEZONE.nullable(true));
    final Field<Integer> usageLimit = DSL.field("usage_limit", SQLDataType.INTEGER.nullable(true));
    final Field<OffsetDateTime> createdAt = DSL.field("created_at",
        SQLDataType.TIMESTAMPWITHTIMEZONE.nullable(false).defaultValue(currentOffsetDateTime()));
    final Field<OffsetDateTime> updatedAt = DSL.field("updated_at",
        SQLDataType.TIMESTAMPWITHTIMEZONE.nullable(false).defaultValue(currentOffsetDateTime()));

    ctx.createTableIfNotExists(ORGANIZATION_PAYMENT_CONFIG_TABLE)
        .columns(organizationId, paymentProviderId, paymentStatus, usageCategoryOverride,
                 gracePeriodEndAt, usageLimit, createdAt, updatedAt)
        .constraints(
            primaryKey(organizationId),
            foreignKey(organizationId).references(ORGANIZATION_TABLE, ORGANIZATION_ID_COL)
        )
        .execute();
  }

  enum PaymentStatus {
    UNINITIALIZED,
    OK,
    GRACE_PERIOD,
    DISABLED,
    MANUAL,
    LOCKED;
  }

  enum UsageCategoryOverride {
    FREE,
    INTERNAL,
    PRE_SALES;
  }
}
```

The Micronaut Data service layer provided type-safe access:

```kotlin
@MappedEntity("organization_payment_config")
data class OrganizationPaymentConfig(
  @field:Id
  val organizationId: UUID,
  val paymentProviderId: String?,
  val paymentStatus: PaymentStatus,
  val usageCategory: UsageCategoryOverride?,
  val gracePeriodEndAt: OffsetDateTime?,
  val usageLimit: Int?,
  val subscriptionStatus: SubscriptionStatus?, // Added in later migration
  @DateCreated
  val createdAt: OffsetDateTime?,
  @DateUpdated
  val updatedAt: OffsetDateTime?,
)

enum class PaymentStatus {
  UNINITIALIZED,
  OK,
  GRACE_PERIOD,
  DISABLED,
  MANUAL,
  LOCKED,
}

enum class SubscriptionStatus {
  ACTIVE,
  INACTIVE,
  CANCELLED,
  PAST_DUE,
}

@JdbcRepository(dialect = Dialect.POSTGRES)
interface OrganizationPaymentConfigRepository :
    CrudRepository<OrganizationPaymentConfig, UUID> {

  fun findByOrganizationId(organizationId: UUID): Optional<OrganizationPaymentConfig>

  @Query("""
    SELECT opc.* FROM organization_payment_config opc
    WHERE opc.payment_status = :paymentStatus
    AND opc.grace_period_end_at < :now
  """)
  fun findExpiredGracePeriods(
    paymentStatus: PaymentStatus,
    now: OffsetDateTime,
  ): List<OrganizationPaymentConfig>
}

interface OrganizationPaymentConfigService {
  fun findByOrganizationId(organizationId: UUID): OrganizationPaymentConfig?
  fun update(config: OrganizationPaymentConfig): OrganizationPaymentConfig
  fun startGracePeriod(organizationId: UUID, endDate: OffsetDateTime): OrganizationPaymentConfig
}
```

The update API was fixed to properly handle subscription_status:

```kotlin
// Before: subscription_status was ignored in updates
fun updateOrganizationPaymentConfig(
  organizationId: UUID,
  paymentStatus: PaymentStatus?,
  usageCategory: UsageCategoryOverride?,
): OrganizationPaymentConfig {
  val existing = findByOrganizationId(organizationId)
      ?: throw ConfigNotFoundException("OrganizationPaymentConfig", organizationId.toString())

  return repository.update(existing.copy(
    paymentStatus = paymentStatus ?: existing.paymentStatus,
    usageCategory = usageCategory ?: existing.usageCategory,
    // subscriptionStatus was lost here!
  ))
}

// After: subscription_status properly preserved
fun updateOrganizationPaymentConfig(
  organizationId: UUID,
  paymentStatus: PaymentStatus?,
  usageCategory: UsageCategoryOverride?,
  subscriptionStatus: SubscriptionStatus?,
): OrganizationPaymentConfig {
  val existing = findByOrganizationId(organizationId)
      ?: throw ConfigNotFoundException("OrganizationPaymentConfig", organizationId.toString())

  return repository.update(existing.copy(
    paymentStatus = paymentStatus ?: existing.paymentStatus,
    usageCategory = usageCategory ?: existing.usageCategory,
    subscriptionStatus = subscriptionStatus ?: existing.subscriptionStatus,
  ))
}
```

The grace period functionality was added:

```kotlin
fun startGracePeriod(
  organizationId: UUID,
  durationDays: Int = 7,
): OrganizationPaymentConfig {
  val existing = findByOrganizationId(organizationId)
      ?: throw ConfigNotFoundException("OrganizationPaymentConfig", organizationId.toString())

  if (existing.paymentStatus != PaymentStatus.MANUAL) {
    throw IllegalStateException(
      "Can only start grace period for MANUAL payment status organizations"
    )
  }

  val gracePeriodEnd = OffsetDateTime.now().plusDays(durationDays.toLong())

  return repository.update(existing.copy(
    paymentStatus = PaymentStatus.GRACE_PERIOD,
    gracePeriodEndAt = gracePeriodEnd,
  ))
}
```

#### Business Value

This configuration infrastructure enabled monetization and billing:

1. **Payment Integration**: Track which payment provider (Stripe, etc.) manages each organization
2. **Grace Periods**: Give customers time to update payment methods without service disruption
3. **Usage Limits**: Enforce tier-based connection limits and data volume caps
4. **Internal vs. Customer**: Mark internal testing orgs vs. paying customers
5. **Subscription Management**: Track active, cancelled, and past-due subscriptions
6. **Automated Enforcement**: Scheduled jobs can disable organizations with expired grace periods
7. **Audit Trail**: Full history of payment status changes via created_at/updated_at

The enum-based status tracking provided type safety and prevented invalid state transitions.

#### Related Commits

- e3cea253fb (Feb 20, 2025): Allow OrgPaymentConfig API to start new grace period

---

## Technical Evolution

The commits tell a story of systematic configuration infrastructure maturation across multiple dimensions:

### Phase 1: Foundation (2022-2023)

The earliest work established configuration basics:

- **February 2022**: Configurable Kubernetes pod process per job type (b742a451a0)
- **June 2023**: Configurable schedule jitter for job distribution (d1c48feaed)
- **August 2023**: InstanceConfiguration API with /setup endpoint (dacfafff41)

This phase focused on making hardcoded values configurable and establishing API patterns.

### Phase 2: Authentication Configuration (2023-2024)

Mid-2023 through mid-2024 saw extensive authentication configuration work:

- **September 2023**: Keycloak realm and SSO configuration setup (9ffa4e9f44)
- **April 2024**: Keycloak idempotent realm updates (2ab27f1189)
- **May 2024**: Deprecate airbyte.yml for application.yml (f2d22f8931)
- **May 2024**: AuthConfigs and @RequiresAuthMode (359badef5f)

This phase unified authentication configuration and aligned with cloud-native patterns.

### Phase 3: Secrets Management (2024-2025)

Late 2024 into 2025 focused on sophisticated secret handling:

- **August 2024**: Organization Payment Config infrastructure (e4f94d20c1, e9be1e7095)
- **March 2025**: airbyte_managed flag for secrets (2bca8c432b)
- **April 2025**: Dual-write secret references alongside coordinates (2e601f1aff)
- **April 2025**: Complete secrets refactoring with SecretConfig (123718be02)

This phase enabled enterprise-grade secrets management with external secret store integration.

### Phase 4: SSO Maturity (2025)

The most recent work hardened SSO configuration for production:

- **September 2025**: SSO Config status column and domain (37c94eb19e, 2eacc0d2e5)
- **September 2025**: Default dataplane group configuration (089aa511f7)
- **October 2025**: Draft SSO configs with validation (fe1917ce1a, 1afd3bf944)
- **October 2025**: Improved draft config handling with cleanup (866d7bae4d)

This phase addressed production edge cases and improved the SSO setup UX.

### Technology Patterns

The evolution shows clear technology trends:

- **Java → Kotlin**: Newer configuration code increasingly in Kotlin for null-safety and conciseness
- **File-based → Environment-based**: Moved from airbyte.yml to application.yml and env vars
- **Hardcoded → Configurable**: Systematic removal of magic strings and hardcoded values
- **Imperative → Declarative**: From manual bean creation to annotation-based configuration
- **Monolithic → Modular**: Configuration split into domain-specific modules (auth, payment, secrets)

---

## Impact Summary

Parker's contributions to Configuration & Settings represent a complete modernization of Airbyte's configuration management, transforming it from a legacy file-based system to a cloud-native, enterprise-ready configuration architecture.

### Quantitative Impact

- **45 commits** over 44 months
- **~15,000 lines** of code changes
- **Major features delivered:**
  - Environment variable-based configuration
  - Secrets management with dual-tracking
  - SSO configuration with draft/active workflow
  - Organization payment configuration
  - Idempotent Keycloak realm management
  - Default dataplane group configuration

### Qualitative Impact

**For Operations:**
- 12-factor app compliance with environment-based config
- Kubernetes-native configuration via ConfigMaps
- Idempotent deployments with automatic configuration updates
- No manual realm resets needed

**For Security:**
- External secret manager integration (AWS/GCP Secrets Manager)
- Airbyte-managed vs. customer-managed secret distinction
- Audit trail for all secret references
- SSO configuration testing without security risk

**For Developers:**
- Type-safe configuration with compile-time validation
- Annotation-based conditional bean loading
- Clear separation of concerns across configuration domains
- Excellent test coverage of configuration scenarios

**For Organizations:**
- Draft SSO configurations for safe testing
- Configurable payment and billing settings
- Grace period management for payment issues
- Usage tracking and limit enforcement

### Key Architectural Patterns

The work established several important patterns:

1. **Configuration Priority**: Environment variables → application.yml → airbyte.yml (backwards compat)
2. **Conditional Bean Loading**: @RequiresAuthMode and @Requires annotations for context-aware beans
3. **Dual-Write Migration**: Write both old and new formats during transition periods
4. **Idempotent Configuration**: Always update to match desired state, no manual reset flags
5. **External Resource Cleanup**: Manual compensation when external systems can't participate in DB transactions
6. **Status-Based Workflows**: Draft→Active patterns for risky configuration changes
7. **Enum-Based State Machines**: Type-safe status transitions with database-backed enums

This foundation enables Airbyte to operate as an enterprise SaaS platform with proper multi-tenancy, monetization, security, and operational maturity.
