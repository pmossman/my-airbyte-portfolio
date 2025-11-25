# Secret Management Architecture

## Overview
- **Time Period:** March - April 2025 (~6 weeks)
- **Lines of Code:** ~5,700 additions
- **Files Changed:** 72+ files
- **Key Technologies:** Kotlin, Micronaut Data, JOOQ, Flyway, AWS/GCP/Azure/Vault integration

One-paragraph summary: Designed and implemented a comprehensive three-table secret reference architecture supporting both Airbyte-managed secrets and external secret references (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, Vault). Includes proper reference tracking, dual-write migration strategy, sealed class coordinate hierarchy, and multi-backend support.

## Problem Statement
The existing secret management system stored raw coordinates directly in configuration JSON, making it impossible to:
- Track which actors (sources/destinations) use which secrets
- Support external secret managers (customer-managed secrets)
- Safely clean up secrets when actors are deleted
- Implement proper multi-tenant secret isolation

Enterprise customers with SOC 2 and similar compliance requirements needed secrets to stay in their own infrastructure.

## Solution Architecture
Designed a three-table architecture separating concerns:

1. **SecretStorage** - Defines where secrets are stored (AWS, GCP, Azure, Vault, local)
2. **SecretConfig** - Represents individual secrets with their external coordinates
3. **SecretReference** - Links secrets to actors with JSON path for hydration

Key design decisions:
- **Sealed class hierarchy** distinguishes Airbyte-managed from external secrets at compile time
- **Dual-write migration** enables gradual rollout without breaking existing configs
- **Feature flag gating** allows per-organization rollout
- **Value classes for IDs** provide compile-time type safety

## Implementation Details

### Three-Table Schema

```sql
-- Where secrets are stored (organizational configuration)
CREATE TABLE secret_storage (
  id UUID PRIMARY KEY,
  scope_type secret_storage_scope_type NOT NULL,
  scope_id UUID NOT NULL,
  descriptor VARCHAR(256) NOT NULL,
  storage_type secret_storage_type NOT NULL,
  configured_from_environment BOOLEAN DEFAULT FALSE,
  tombstone BOOLEAN DEFAULT FALSE,
  UNIQUE (scope_id, scope_type, storage_type, descriptor)
);

-- Individual secret configurations
CREATE TABLE secret_config (
  id UUID PRIMARY KEY,
  secret_storage_id UUID REFERENCES secret_storage(id),
  descriptor VARCHAR(256) NOT NULL,
  external_coordinate VARCHAR(256) NOT NULL,
  airbyte_managed BOOLEAN DEFAULT TRUE,
  tombstone BOOLEAN DEFAULT FALSE,
  UNIQUE (secret_storage_id, descriptor),
  UNIQUE (secret_storage_id, external_coordinate)
);

-- Links secrets to actors (sources/destinations)
CREATE TABLE secret_reference (
  id UUID PRIMARY KEY,
  secret_config_id UUID REFERENCES secret_config(id),
  scope_type secret_reference_scope_type NOT NULL,
  scope_id UUID NOT NULL,
  hydration_path TEXT,
  UNIQUE (scope_type, scope_id, COALESCE(hydration_path, ''))
);
```

### Sealed Class Coordinate Hierarchy

Type-safe distinction between Airbyte-managed and external secrets:

```kotlin
sealed class SecretCoordinate {
  abstract val fullCoordinate: String

  companion object {
    fun fromFullCoordinate(fullCoordinate: String): SecretCoordinate =
      AirbyteManagedSecretCoordinate.fromFullCoordinate(fullCoordinate)
        ?: ExternalSecretCoordinate(fullCoordinate)
  }

  // User-provided references to external secret managers
  data class ExternalSecretCoordinate(
    override val fullCoordinate: String,
  ) : SecretCoordinate()

  // Airbyte-created secrets with versioning
  data class AirbyteManagedSecretCoordinate(
    private val rawCoordinateBase: String,
    val version: Long = 1L,
  ) : SecretCoordinate() {
    val coordinateBase: String = ensureAirbytePrefix(rawCoordinateBase)
    override val fullCoordinate: String
      get() = "${coordinateBase}_v$version"

    companion object {
      private const val AIRBYTE_PREFIX = "airbyte_"
      private const val VERSION_DELIMITER = "_v"

      fun fromFullCoordinate(fullCoordinate: String): AirbyteManagedSecretCoordinate? {
        if (!fullCoordinate.startsWith(AIRBYTE_PREFIX)) return null
        // Parse coordinate base and version...
      }
    }
  }
}
```

### Secret Reference Service with Feature Flags

```kotlin
@Singleton
class SecretReferenceService(
  private val secretReferenceRepository: SecretReferenceRepository,
  private val featureFlagClient: FeatureFlagClient,
) {
  fun createAndInsertSecretReferences(
    actorConfig: ConfigWithProcessedSecrets,
    actorId: ActorId,
    workspaceId: WorkspaceId,
    secretStorageId: SecretStorageId,
  ): ConfigWithSecretReferenceIdsInjected {
    // Feature flag check for gradual rollout
    if (!featureFlagClient.boolVariation(PersistSecretConfigsAndReferences, ...)) {
      return ConfigWithSecretReferenceIdsInjected(actorConfig.originalConfig)
    }

    val createdSecretRefIdByPath = mutableMapOf<String, SecretReferenceId>()
    actorConfig.processedSecrets.forEach { path, secretNode ->
      if (secretNode.secretCoordinate != null) {
        val secretConfig = getOrCreateSecretConfig(secretNode, secretStorageId)
        val secretRef = createSecretReference(secretConfig, actorId, path)
        createdSecretRefIdByPath[path] = secretRef.id
      }
    }

    cleanupDanglingSecretReferences(actorId, actorConfig)
    return injectSecretReferenceIds(actorConfig.originalConfig, createdSecretRefIdByPath)
  }
}
```

### Bootloader Initialization

```kotlin
@Singleton
class SecretStorageInitializer(
  private val secretStorageService: SecretStorageService,
  @Property(name = "airbyte.secret.persistence")
  private val configuredType: String,
) {
  fun createOrUpdateDefaultSecretStorage() {
    val storageType = mapConfiguredType(configuredType)

    when (val existing = secretStorageService.findById(DEFAULT_ID)) {
      null -> {
        secretStorageService.create(
          SecretStorageCreate(
            id = DEFAULT_SECRET_STORAGE_ID,
            scopeType = SecretStorageScopeType.ORGANIZATION,
            storageType = storageType,
            configuredFromEnvironment = true,
          )
        )
      }
      else -> if (existing.storageType != storageType) {
        secretStorageService.patch(id = existing.id, storageType = storageType)
      }
    }
  }
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [c4dad82dbe](https://github.com/airbytehq/airbyte-platform/commit/c4dad82dbe) | Mar 3, 2025 | Three-table architecture schema | 25 files, 1,248 insertions |
| [4808dc229d](https://github.com/airbytehq/airbyte-platform/commit/4808dc229d) | Mar 26, 2025 | Sealed class coordinate hierarchy | 38 files, 635 insertions |
| [123718be02](https://github.com/airbytehq/airbyte-platform/commit/123718be02) | Apr 11, 2025 | Write SecretConfig and SecretReferences | 72 files, 2,371 insertions |
| [e29ae7da90](https://github.com/airbytehq/airbyte-platform/commit/e29ae7da90) | Apr 24, 2025 | Bootloader initialization | 30 files, 923 insertions |
| [2e601f1aff](https://github.com/airbytehq/airbyte-platform/commit/2e601f1aff) | Apr 23, 2025 | Dual-write secret reference IDs | 17 files, 272 insertions |

## Business Value

### User Impact
- **External Secret Support**: Reference secrets in AWS/GCP/Azure/Vault
- **No Vendor Lock-in**: Secrets stay in customer infrastructure
- **Automatic Detection**: Secrets extracted from connector configs automatically
- **Safe Cleanup**: Secrets properly cleaned when actors deleted

### Business Impact
- **SOC 2 Compliance**: Proper secret management required for certification
- **Enterprise Sales**: Large customers require external secret manager support
- **Multi-Tenancy**: Organizations can configure their own secret backends
- **Reduced Risk**: Secrets never transmitted or stored in plaintext

### Technical Impact
- **Type Safety**: Sealed classes prevent bugs at compile time
- **Reference Tracking**: System knows which actors use which secrets
- **Gradual Rollout**: Feature flags enable safe migration
- **Versioned Secrets**: Immutable values with version tracking

## Lessons Learned / Patterns Used

### Three-Table Separation Pattern
Separating storage, config, and references enables:
- Multi-tenant secret isolation
- Different storage backends per organization
- Proper lifecycle management
- Reference counting for safe deletion

### Expand-Contract Migration
Dual-write strategy enables safe migration:
1. **Expand**: Add secret_reference_id alongside coordinate
2. **Migrate**: Gradually switch reads to use reference IDs
3. **Contract**: Remove coordinate when migration complete

### Value Classes for Type Safety
Zero-overhead type safety:
```kotlin
@JvmInline value class SecretStorageId(val value: UUID)
@JvmInline value class SecretConfigId(val value: UUID)
@JvmInline value class SecretReferenceId(val value: UUID)

// Compile error: can't mix up ID types
fun getSecret(id: SecretConfigId) // vs getSecret(id: SecretStorageId)
```
