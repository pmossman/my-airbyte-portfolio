# Secrets Management - Deep Dive

## Overview

This document analyzes Parker Mossman's contributions to the Secrets Management area of the airbyte-platform repository. This work represents a fundamental architectural evolution from a simple coordinate-based secret storage system to a sophisticated three-table architecture supporting both Airbyte-managed and external secrets, with proper reference tracking, dual-write capabilities, and multi-backend support.

**Period:** October 2024 - September 2025 (12 months)
**Total Commits:** 13
**Total Changes:** ~5,700 lines of code
**Key Technologies:** Kotlin, Micronaut Data, JOOQ, Flyway, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, Vault

---

## Key Architectural Changes

### 1. Three-Table Secret Reference Architecture

**Commit:** c4dad82dbe - March 3, 2025
**Impact:** 25 files changed, 1,248 insertions, 2 deletions

#### What Changed

This foundational commit introduced a comprehensive three-table architecture for managing secrets, replacing the previous inline coordinate-only approach. The new system separates secret storage configuration, secret definitions, and references to those secrets.

**Key files added:**
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/entities/SecretStorage.kt` (37 lines)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/entities/SecretConfig.kt` (29 lines)
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/entities/SecretReference.kt` (31 lines)
- Database migration: `V1_1_1_011__AddSecretConfigStorageAndReferenceTables.java` (303 lines)

#### Implementation Details

The migration created three interconnected tables with proper foreign key relationships:

**1. SecretStorage Table** - Defines where secrets are stored:

```java
private static void createSecretStorageTable(final DSLContext ctx) {
    final Field<UUID> id = DSL.field("id", SQLDataType.UUID.nullable(false));
    final Field<SecretStorageScopeType> scopeType =
        DSL.field("scope_type", SQLDataType.VARCHAR.asEnumDataType(SecretStorageScopeType.class).nullable(false));
    final Field<UUID> scopeId = DSL.field("scope_id", SQLDataType.UUID.nullable(false));
    final Field<String> descriptor = DSL.field("descriptor", SQLDataType.VARCHAR(256).nullable(false));
    final Field<SecretStorageType> storageType =
        DSL.field("storage_type", SQLDataType.VARCHAR.asEnumDataType(SecretStorageType.class).nullable(false));
    final Field<Boolean> configuredFromEnvironment =
        DSL.field("configured_from_environment", SQLDataType.BOOLEAN.defaultValue(false).nullable(false));
    final Field<Boolean> tombstone = DSL.field("tombstone", SQLDataType.BOOLEAN.defaultValue(false).nullable(false));

    ctx.createTableIfNotExists(SECRET_STORAGE_TABLE_NAME)
        .constraints(
            primaryKey(id),
            unique(scopeId, scopeType, storageType, descriptor))
        .execute();
}
```

Supported storage types: AWS Secrets Manager, Google Secret Manager, Azure Key Vault, Vault, Local Testing.

**2. SecretConfig Table** - Represents individual secrets:

```java
private static void createSecretConfigTable(final DSLContext ctx) {
    final Field<UUID> id = DSL.field("id", SQLDataType.UUID.nullable(false));
    final Field<UUID> secretStorageId = DSL.field("secret_storage_id", SQLDataType.UUID.nullable(false));
    final Field<String> descriptor = DSL.field("descriptor", SQLDataType.VARCHAR(256).nullable(false));
    final Field<String> externalCoordinate = DSL.field("external_coordinate", SQLDataType.VARCHAR(256).nullable(false));
    final Field<Boolean> tombstone = DSL.field("tombstone", SQLDataType.BOOLEAN.defaultValue(false).nullable(false));

    ctx.createTableIfNotExists(SECRET_CONFIG_TABLE_NAME)
        .constraints(
            primaryKey(id),
            foreignKey(secretStorageId).references(SECRET_STORAGE_TABLE_NAME, "id"),
            unique(secretStorageId, descriptor),
            unique(secretStorageId, externalCoordinate))
        .execute();
}
```

**3. SecretReference Table** - Links secrets to actors (sources/destinations):

```java
private static void createSecretReferenceTable(final DSLContext ctx) {
    final Field<UUID> id = DSL.field("id", SQLDataType.UUID.nullable(false));
    final Field<UUID> secretConfigId = DSL.field("secret_config_id", SQLDataType.UUID.nullable(false));
    final Field<SecretReferenceScopeType> scopeType =
        DSL.field("scope_type", SQLDataType.VARCHAR.asEnumDataType(SecretReferenceScopeType.class).nullable(false));
    final Field<UUID> scopeId = DSL.field("scope_id", SQLDataType.UUID.nullable(false));
    final Field<String> hydrationPath = DSL.field("hydration_path", SQLDataType.CLOB.nullable(true));

    ctx.createTableIfNotExists(SECRET_REFERENCE_TABLE_NAME)
        .constraints(
            primaryKey(id),
            foreignKey(secretConfigId).references(SECRET_CONFIG_TABLE_NAME, "id"))
        .execute();

    // Unique index ensuring one reference per scope and path
    ctx.createUniqueIndexIfNotExists("secret_reference_scope_type_scope_id_hydration_path_idx")
        .on(DSL.table(SECRET_REFERENCE_TABLE_NAME),
            DSL.field("scope_type"),
            DSL.field("scope_id"),
            DSL.field("coalesce(hydration_path, '')"))
        .execute();
}
```

The Micronaut Data entities provide clean ORM mapping:

```kotlin
@MappedEntity("secret_storage")
data class SecretStorage(
  @field:Id
  @AutoPopulated
  var id: UUID? = null,
  @field:TypeDef(type = DataType.OBJECT)
  var scopeType: SecretStorageScopeType,
  var scopeId: UUID,
  var descriptor: String,
  @field:TypeDef(type = DataType.OBJECT)
  var storageType: SecretStorageType,
  var configuredFromEnvironment: Boolean,
  var tombstone: Boolean = false,
  var createdBy: UUID,
  var updatedBy: UUID,
  @DateCreated
  var createdAt: java.time.OffsetDateTime? = null,
  @DateUpdated
  var updatedAt: java.time.OffsetDateTime? = null,
)

@MappedEntity("secret_config")
data class SecretConfig(
  @field:Id
  @AutoPopulated
  var id: UUID? = null,
  var secretStorageId: UUID,
  var descriptor: String,
  var externalCoordinate: String,
  var tombstone: Boolean = false,
  var createdBy: UUID,
  var updatedBy: UUID,
  @DateCreated
  var createdAt: java.time.OffsetDateTime? = null,
  @DateUpdated
  var updatedAt: java.time.OffsetDateTime? = null,
)

@MappedEntity("secret_reference")
data class SecretReference(
  @field:Id
  @AutoPopulated
  var id: UUID? = null,
  var secretConfigId: UUID,
  @field:TypeDef(type = DataType.OBJECT)
  var scopeType: SecretReferenceScopeType,
  var scopeId: UUID,
  var hydrationPath: String? = null,
  @DateCreated
  var createdAt: java.time.OffsetDateTime? = null,
  @DateUpdated
  var updatedAt: java.time.OffsetDateTime? = null,
)
```

#### Business Value

This architectural change enabled several critical capabilities:

1. **Multi-Tenant Secret Storage**: Organizations and workspaces can now configure their own secret backends
2. **Reference Tracking**: The system knows exactly which actors use which secrets, enabling proper cleanup
3. **External Secret Support**: Users can reference secrets in their own secret managers (AWS, GCP, Azure, Vault)
4. **Audit Trail**: Complete tracking of who created/updated secrets and when
5. **Safe Deletion**: With reference tracking, the system can prevent accidental deletion of in-use secrets
6. **Scoped Storage**: Secret storage can be configured at organization or workspace level

The `hydration_path` field is particularly clever - it stores the JSON path where the secret should be injected during configuration hydration, enabling precise secret placement in complex nested configurations.

---

### 2. Airbyte-Managed vs External Secret Coordinate Hierarchy

**Commit:** 4808dc229d - March 26, 2025
**Impact:** 38 files changed, 635 insertions, 372 deletions

#### What Changed

This commit refactored the `SecretCoordinate` class from a simple data class into a sealed class hierarchy, distinguishing between Airbyte-managed secrets (stored in configured backend) and external secrets (user-provided references to their own secret stores).

**Key files modified:**
- `airbyte-config/config-secrets/src/main/kotlin/secrets/SecretCoordinate.kt` (complete rewrite)
- `airbyte-config/config-secrets/src/main/kotlin/secrets/SecretsHelpers.kt` (updated to use sealed hierarchy)
- All secret persistence implementations updated

#### Implementation Details

The refactored `SecretCoordinate` became a sealed class with two variants:

```kotlin
sealed class SecretCoordinate {
  abstract val fullCoordinate: String

  companion object {
    /**
     * Used to turn a full string coordinate into a [SecretCoordinate]. First attempts to parse the
     * coordinate as an [AirbyteManagedSecretCoordinate]. If that fails, it falls back to an
     * [ExternalSecretCoordinate].
     */
    fun fromFullCoordinate(fullCoordinate: String): SecretCoordinate =
      AirbyteManagedSecretCoordinate.fromFullCoordinate(fullCoordinate)
        ?: ExternalSecretCoordinate(fullCoordinate)
  }

  data class ExternalSecretCoordinate(
    override val fullCoordinate: String,
  ) : SecretCoordinate()

  data class AirbyteManagedSecretCoordinate(
    private val rawCoordinateBase: String = generateCoordinateBase(
      DEFAULT_SECRET_BASE_PREFIX,
      DEFAULT_SECRET_BASE_ID
    ),
    val version: Long = DEFAULT_VERSION,
  ) : SecretCoordinate() {
    val coordinateBase: String = ensureAirbytePrefix(rawCoordinateBase)

    /**
     * Constructor that generates a new [AirbyteManagedSecretCoordinate] with a coordinate base
     * generated based on provided inputs
     */
    constructor(
      secretBasePrefix: String,
      secretBaseId: UUID,
      version: Long,
      uuidSupplier: Supplier<UUID> = Supplier { UUID.randomUUID() },
    ) : this(
      generateCoordinateBase(secretBasePrefix, secretBaseId, uuidSupplier),
      version,
    )

    override val fullCoordinate: String
      get() = "${coordinateBase}${VERSION_DELIMITER}$version"

    companion object {
      const val DEFAULT_SECRET_BASE_PREFIX = "workspace_"
      val DEFAULT_SECRET_BASE_ID: UUID = UUID.fromString("00000000-0000-0000-0000-000000000000")
      const val DEFAULT_VERSION = 1L

      private const val VERSION_DELIMITER = "_v"
      private const val AIRBYTE_PREFIX = "airbyte_"

      private fun ensureAirbytePrefix(coordinateBase: String): String =
        if (coordinateBase.startsWith(AIRBYTE_PREFIX)) {
          coordinateBase
        } else {
          AIRBYTE_PREFIX + coordinateBase
        }

      private fun generateCoordinateBase(
        secretBasePrefix: String,
        secretBaseId: UUID,
        uuidSupplier: Supplier<UUID> = Supplier { UUID.randomUUID() },
      ): String = "${AIRBYTE_PREFIX}${secretBasePrefix}${secretBaseId}_secret_${uuidSupplier.get()}"

      /**
       * Used to turn a full string coordinate into an [AirbyteManagedSecretCoordinate] if it
       * follows the particular expected format. Otherwise, returns null.
       */
      fun fromFullCoordinate(fullCoordinate: String): AirbyteManagedSecretCoordinate? {
        if (!fullCoordinate.startsWith(AIRBYTE_PREFIX)) return null

        val splitIndex = fullCoordinate.lastIndexOf(VERSION_DELIMITER)
        if (splitIndex == -1) return null

        val coordinateBase = fullCoordinate.substring(0, splitIndex)
        val version =
          fullCoordinate.substring(splitIndex + VERSION_DELIMITER.length).toLongOrNull()
            ?: return null

        return AirbyteManagedSecretCoordinate(coordinateBase, version)
      }
    }
  }
}
```

The key innovation is the parsing strategy: when encountering a coordinate string, it first tries to parse it as an Airbyte-managed coordinate (checking for the `airbyte_` prefix and `_v` version delimiter). If that fails, it treats it as an external coordinate, allowing users to specify arbitrary references like `arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret`.

The `SecretsHelpers` was updated to only write Airbyte-managed coordinates to the secret backend:

```kotlin
private fun getAirbyteCoordinatesToWriteAndReplace(
    uuidSupplier: Supplier<UUID>,
    secretBaseId: UUID,
    secretReader: ReadOnlySecretPersistence,
    persistedPartialConfig: ConfigWithSecretReferences?,
    newFullConfig: ConfigWithProcessedSecrets,
    secretBasePrefix: String,
  ): Map<String, AirbyteManagedCoordinateAndRawValue> =
    buildMap {
      newFullConfig.processedSecrets.forEach { (path, processedSecretNode) ->
        processedSecretNode.rawValue?.let { rawValue ->
          // If there is an existing secret reference, attempt to extract its AirbyteManagedSecretCoordinate.
          val persistedNode = persistedPartialConfig?.referencedSecrets?.get(path)
          val existingCoordinate = persistedNode?.secretCoordinate as? AirbyteManagedSecretCoordinate

          // Create a new coordinate.
          val coordinate =
            createNewAirbyteManagedSecretCoordinate(
              secretBasePrefix = secretBasePrefix,
              secretReader = secretReader,
              secretBaseId = secretBaseId,
              uuidSupplier = uuidSupplier,
              oldCoordinate = existingCoordinate,
            )
          put(path, AirbyteManagedCoordinateAndRawValue(coordinate, rawValue))
        }
      }
    }
```

#### Business Value

This sealed class hierarchy provided several advantages:

1. **Type Safety**: Compiler-enforced distinction between Airbyte-managed and external secrets
2. **User Control**: Customers can reference secrets in their own secret managers using the `secret_coordinate::` prefix
3. **Backward Compatibility**: Existing Airbyte-managed coordinates continue to work exactly as before
4. **Write Safety**: Only Airbyte-managed secrets are written to the backend, preventing accidental overwrites
5. **Flexible Backends**: External coordinates can point to any secret management system

The pattern matching on sealed classes enables exhaustive when expressions, ensuring all secret types are handled properly throughout the codebase.

---

### 3. Write SecretConfig and SecretReferences from Actor Config

**Commit:** 123718be02 - April 11, 2025
**Impact:** 72 files changed, 2,371 insertions, 955 deletions

#### What Changed

This massive commit implemented the core secret writing logic that creates `SecretConfig` and `SecretReference` database records when processing actor (source/destination) configurations. It introduced sophisticated processing of secret values, including support for raw values, existing coordinates, and prefixed external references.

**Key files modified:**
- `airbyte-config/config-secrets/src/main/kotlin/secrets/SecretsRepositoryWriter.kt` (major refactoring)
- `airbyte-config/config-secrets/src/main/kotlin/secrets/SecretsHelpers.kt` (387 line expansion)
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/SourceHandler.java` (updated)
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/DestinationHandler.java` (updated)

#### Implementation Details

The `SecretsRepositoryWriter` was refactored to work with `ConfigWithProcessedSecrets` instead of raw JSON:

```kotlin
/**
 * Detects secrets in the configuration. Writes them to the secrets store. It returns the config
 * stripped of secrets (replaced with pointers to the secrets).
 *
 * @param workspaceId the workspace id for the config
 * @param fullConfig full config
 * @param secretPersistence to store the secrets
 * @return partial config
 */
fun createFromConfig(
  workspaceId: UUID,
  fullConfig: ConfigWithProcessedSecrets,
  secretPersistence: SecretPersistence,
): JsonNode = createFromConfig(
  workspaceId,
  fullConfig,
  secretPersistence,
  AirbyteManagedSecretCoordinate.DEFAULT_SECRET_BASE_PREFIX
)
```

The new `processConfigSecrets` method in `SecretsHelpers.SecretReferenceHelpers` categorizes each secret:

```kotlin
private fun determineSecretNodeType(secretNode: JsonNode): SecretNodeType =
  when {
    secretNode.has(SECRET_REF_ID_FIELD) -> SecretNodeType.SECRET_REFERENCE_ID
    secretNode.has(COORDINATE_FIELD) -> {
      val secretCoord = SecretCoordinate.fromFullCoordinate(secretNode.get(COORDINATE_FIELD).asText())
      when (secretCoord) {
        is AirbyteManagedSecretCoordinate -> SecretNodeType.AIRBYTE_MANAGED_SECRET_COORDINATE
        else -> SecretNodeType.EXTERNAL_SECRET_COORDINATE
      }
    }
    secretNode.asText().startsWith(SECRET_REF_PREFIX) -> SecretNodeType.PREFIXED_SECRET_REFERENCE
    else -> SecretNodeType.RAW_SECRET_VALUE
  }

private fun processSecretNode(
  secretNode: JsonNode,
  secretStorageId: SecretStorageId?,
): ProcessedSecretNode {
  if (secretNode.isArray || secretNode.isMissingNode || secretNode.isNull) {
    throw IllegalStateException("Cannot process node that is an array, missing, or null")
  }
  return when (determineSecretNodeType(secretNode)) {
    SecretNodeType.PREFIXED_SECRET_REFERENCE ->
      ProcessedSecretNode(
        secretCoordinate = ExternalSecretCoordinate(secretNode.asText().removePrefix(SECRET_REF_PREFIX)),
        secretStorageId = secretStorageId,
      )
    SecretNodeType.AIRBYTE_MANAGED_SECRET_COORDINATE ->
      ProcessedSecretNode(
        secretCoordinate = AirbyteManagedSecretCoordinate.fromFullCoordinate(
          secretNode.get(COORDINATE_FIELD).asText()
        ),
        secretStorageId = secretStorageId?.takeIf { secretNode.has(SECRET_STORAGE_ID_FIELD) },
        secretReferenceId = secretNode.get(SECRET_REF_ID_FIELD)?.asText()?.let { SecretReferenceId(UUID.fromString(it)) },
      )
    SecretNodeType.EXTERNAL_SECRET_COORDINATE ->
      ProcessedSecretNode(
        secretCoordinate = ExternalSecretCoordinate(secretNode.get(COORDINATE_FIELD).asText()),
        secretStorageId = secretStorageId?.takeIf { secretNode.has(SECRET_STORAGE_ID_FIELD) },
        secretReferenceId = secretNode.get(SECRET_REF_ID_FIELD)?.asText()?.let { SecretReferenceId(UUID.fromString(it)) },
      )
    SecretNodeType.RAW_SECRET_VALUE ->
      ProcessedSecretNode(rawValue = secretNode.asText())
    SecretNodeType.SECRET_REFERENCE_ID ->
      ProcessedSecretNode(
        secretReferenceId = SecretReferenceId(UUID.fromString(secretNode.get(SECRET_REF_ID_FIELD).asText()))
      )
  }
}
```

The update logic properly handles ephemeral secrets and old coordinate cleanup:

```kotlin
fun updateFromConfig(
  secretBaseId: UUID,
  oldPartialConfig: ConfigWithSecretReferences,
  fullConfig: ConfigWithProcessedSecrets,
  spec: JsonNode,
  secretPersistence: SecretPersistence,
  secretBasePrefix: String = AirbyteManagedSecretCoordinate.DEFAULT_SECRET_BASE_PREFIX,
): JsonNode {
  val configWithSecretPlaceholders =
    SecretsHelpers.SecretReferenceHelpers.configWithTextualSecretPlaceholders(
      fullConfig.originalConfig,
      spec,
    )
  validator.ensure(spec, configWithSecretPlaceholders)

  val updatedSplitConfig: SplitSecretConfig =
    SecretsHelpers.splitAndUpdateConfig(
      secretBaseId,
      oldPartialConfig,
      fullConfig,
      secretPersistence,
      secretBasePrefix
    )

  updatedSplitConfig
    .getCoordinateToPayload()
    .forEach { (coordinate: AirbyteManagedSecretCoordinate, payload: String) ->
      secretPersistence.write(coordinate, payload)
      metricClient.count(metric = OssMetricsRegistry.UPDATE_SECRET_DEFAULT_STORE)
    }

  deleteLegacyAirbyteManagedCoordinates(oldPartialConfig, fullConfig, secretPersistence)

  return updatedSplitConfig.partialConfig
}

/**
 * For legacy configs not yet using secret references, delete old airbyte-managed secrets that
 * are no longer relevant after the update. Legacy configs are those that do not have an
 * associated secretStorageId.
 */
private fun deleteLegacyAirbyteManagedCoordinates(
  oldPartialConfig: ConfigWithSecretReferences,
  fullConfig: ConfigWithProcessedSecrets,
  secretPersistence: SecretPersistence,
) {
  oldPartialConfig.referencedSecrets.forEach { (path, oldSecretRef) ->
    (oldSecretRef.secretCoordinate as? AirbyteManagedSecretCoordinate)
      ?.takeIf { fullConfig.processedSecrets[path]?.rawValue != null }
      ?.takeIf { oldSecretRef.secretStorageId == null }
      ?.let { deleteAirbyteManagedSecretCoordinate(it, secretPersistence) }
  }
}
```

#### Business Value

This commit delivered the core secret management functionality:

1. **Automatic Secret Detection**: Secrets are identified from connector specs and automatically extracted
2. **Multiple Input Formats**: Supports raw values, existing coordinates, and external references
3. **Safe Updates**: Old secrets are only deleted when replaced, preventing data loss
4. **Version Tracking**: Increments version when secret values change
5. **Legacy Support**: Maintains compatibility with pre-reference-tracking configurations

The sophisticated categorization of secret types enables smooth migration from the old system while supporting new features like external secret references.

---

### 4. Bootloader Secret Storage Initialization

**Commit:** e29ae7da90 - April 24, 2025
**Impact:** 30 files changed, 923 insertions, 205 deletions

#### What Changed

This commit added automatic creation of a default `SecretStorage` record during bootloader initialization, ensuring every Airbyte instance has a configured secret backend available immediately.

**Key files added:**
- `airbyte-bootloader/src/main/kotlin/io/airbyte/bootloader/SecretStorageInitializer.kt` (94 lines)

**Key files modified:**
- `airbyte-bootloader/src/main/kotlin/io/airbyte/bootloader/Bootloader.kt` (integrated initializer)
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/secrets/SecretStorageService.kt` (enhanced)

#### Implementation Details

The `SecretStorageInitializer` creates or updates the default secret storage based on environment configuration:

```kotlin
@Singleton
class SecretStorageInitializer(
  private val secretStorageService: SecretStorageService,
  @Property(name = "airbyte.secret.persistence") private val configuredSecretPersistenceType: String,
) {
  companion object {
    private const val DEFAULT_SECRET_STORAGE_DESCRIPTOR = "Default Secret Storage"
  }

  /**
   * Creates or updates the default secret storage for the instance. The default secret storage is
   * always set with configuredFromEnvironment = true, and is associated with the default
   * organization and user.
   *
   * If the default secret storage already exists, it will be updated to match the configured
   * secret storage type if it differs from the existing one.
   */
  fun createOrUpdateDefaultSecretStorage() {
    val configuredSecretStorageType = mapConfiguredSecretPersistenceType(configuredSecretPersistenceType)

    when (val existingStorage = secretStorageService.findById(SecretStorage.DEFAULT_SECRET_STORAGE_ID)) {
      null -> {
        logger.info { "Creating default secret storage." }
        secretStorageService.create(
          SecretStorageCreate(
            id = SecretStorage.DEFAULT_SECRET_STORAGE_ID,
            scopeType = SecretStorageScopeType.ORGANIZATION,
            scopeId = OrganizationPersistence.DEFAULT_ORGANIZATION_ID,
            descriptor = DEFAULT_SECRET_STORAGE_DESCRIPTOR,
            storageType = configuredSecretStorageType,
            configuredFromEnvironment = true,
            createdBy = UserId(UserPersistence.DEFAULT_USER_ID),
          ),
        )
      }
      else -> {
        logger.info { "Default secret storage already exists." }
        if (existingStorage.storageType != configuredSecretStorageType) {
          logger.info {
            "Existing secret storage type ${existingStorage.storageType} does not match configured secret storage type $configuredSecretPersistenceType. Updating..."
          }
          secretStorageService.patch(
            id = existingStorage.id,
            updatedBy = UserId(UserPersistence.DEFAULT_USER_ID),
            storageType = configuredSecretStorageType.toPatch(),
          )
        }
      }
    }
  }

  /**
   * Maps the configured secret persistence type to the corresponding enum value if one exists.
   *
   * Note that this mapping is not crucial for existing functionality, since the default secret
   * storage is going to be configured entirely from its environment anyway. In the future, this
   * mapping may become more important especially if we want to support multiple
   * environment-configured secret storage types within the same Airbyte instance.
   */
  private fun mapConfiguredSecretPersistenceType(configuredType: String): SecretStorageType =
    when (configuredType.lowercase()) {
      ImplementationTypes.AWS_SECRET_MANAGER -> SecretStorageType.AWS_SECRETS_MANAGER
      ImplementationTypes.GOOGLE_SECRET_MANAGER -> SecretStorageType.GOOGLE_SECRET_MANAGER
      ImplementationTypes.VAULT -> SecretStorageType.VAULT
      ImplementationTypes.AZURE_KEY_VAULT -> SecretStorageType.AZURE_KEY_VAULT
      ImplementationTypes.TESTING_CONFIG_DB_TABLE -> SecretStorageType.LOCAL_TESTING
      else -> {
        logger.warn { "Unknown secret storage type: $configuredType. Defaulting to local testing." }
        SecretStorageType.LOCAL_TESTING
      }
    }
}
```

The bootloader integration ensures this runs on every startup:

```kotlin
@Inject
private lateinit var secretStorageInitializer: SecretStorageInitializer

fun initializeSecretStorage() {
  secretStorageInitializer.createOrUpdateDefaultSecretStorage()
}
```

The `SecretStorage` entity includes a well-known ID constant:

```kotlin
companion object {
  val DEFAULT_SECRET_STORAGE_ID: UUID = UUID.fromString("00000000-0000-0000-0000-000000000000")
}
```

#### Business Value

This initialization logic provided critical operational benefits:

1. **Zero-Configuration**: Fresh Airbyte instances automatically have a working secret storage
2. **Configuration Drift Detection**: Detects and updates mismatched storage types
3. **Backwards Compatibility**: Existing instances continue working with their configured backend
4. **Multi-Backend Support**: Maps environment variables to AWS, GCP, Azure, Vault, or local storage
5. **Idempotent**: Safe to run multiple times without side effects

The `configuredFromEnvironment` flag distinguishes between environment-configured (default) and user-configured secret storage, enabling future features where organizations can configure their own secret backends alongside the default.

---

### 5. Move Secret Writing from JOOQ Layer to Handler Layer

**Commit:** 98137c70d8 - March 25, 2025
**Impact:** 10 files changed, 173 insertions, 152 deletions

#### What Changed

This architectural refactoring moved secret writing logic from the JOOQ service layer (where it was mixed with database operations) to the handler layer (where business logic belongs), improving separation of concerns and enabling runtime secret persistence.

**Key files modified:**
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/SourceHandler.java`
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/DestinationHandler.java`
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/impls/jooq/SourceServiceJooqImpl.kt` (simplified)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/impls/jooq/DestinationServiceJooqImpl.kt` (simplified)

#### Implementation Details

Before this change, the JOOQ service layer handled both database writes AND secret writing:

```kotlin
// OLD approach - mixed concerns in JOOQ layer
fun writeSourceConnectionWithSecrets(
  sourceConnection: SourceConnection,
  connectorSpecification: ConnectorSpecification
) {
  val partialConfig = secretsRepositoryWriter.createFromConfig(
    workspaceId,
    sourceConnection.configuration,
    connectorSpecification.connectionSpecification,
  )
  sourceConnection.configuration = partialConfig
  writeSourceConnectionNoSecrets(sourceConnection)
}
```

After the change, handlers explicitly manage secrets before calling the service:

```kotlin
// NEW approach - handlers manage secrets, services manage persistence
private fun persistSourceConnection(
  // ... parameters ...
) {
  val sourceConnection = StandardSourceDefinition()
    .withWorkspaceId(workspaceId)
    .withSourceId(sourceId)
    .withConfiguration(oAuthMaskedConfigurationJson)
    // ... other fields ...

  val previousSourceConfig =
    sourceService.getSourceConnectionIfExists(sourceId).map(SourceConnection::getConfiguration)

  var secretPersistence: RuntimeSecretPersistence? = null
  if (featureFlagClient.boolVariation(UseRuntimeSecretPersistence.INSTANCE, Organization(organizationId))) {
    val secretPersistenceConfig = secretPersistenceConfigService.get(ScopeType.ORGANIZATION, organizationId)
    secretPersistence = RuntimeSecretPersistence(secretPersistenceConfig, metricClient)
  }

  val partialConfig: JsonNode = if (previousSourceConfig.isPresent) {
    secretsRepositoryWriter.updateFromConfig(
        workspaceId,
        previousSourceConfig.get(),
        sourceConnection.configuration,
        spec.connectionSpecification,
        secretPersistence)
  } else {
    secretsRepositoryWriter.createFromConfig(
        workspaceId,
        sourceConnection.configuration,
        spec.connectionSpecification,
        secretPersistence)
  }
  sourceConnection.configuration = partialConfig

  sourceService.writeSourceConnectionNoSecrets(sourceConnection)
}
```

The JOOQ service layer was simplified to only handle database operations:

```kotlin
// Simplified JOOQ service - only database operations
override fun writeSourceConnectionNoSecrets(
  partialSource: SourceConnection,
) {
  database.transaction { ctx ->
    writeSource(ctx, listOf(partialSource))
  }
}
```

#### Business Value

This refactoring delivered several architectural benefits:

1. **Separation of Concerns**: Secret logic separated from database logic
2. **Runtime Secret Persistence**: Enabled feature-flag-gated runtime secret backend selection
3. **Testability**: Handlers can now be tested with mock secret persistence without database setup
4. **Feature Flags**: Allows gradual rollout of new secret features per organization
5. **Code Clarity**: Each layer has a single, well-defined responsibility

The runtime secret persistence capability is particularly important - it allows organizations to use their own secret backends without redeploying Airbyte.

---

### 6. Dual-Write Secret Reference IDs in Configs

**Commit:** 2e601f1aff - April 23, 2025
**Impact:** 17 files changed, 272 insertions, 134 deletions

#### What Changed

This commit implemented a dual-write strategy where secret reference IDs are written directly into actor configurations alongside secret coordinates, enabling a gradual migration path from coordinate-based to reference-ID-based secret lookup.

**Key files modified:**
- `airbyte-config/config-secrets/src/main/kotlin/secrets/SecretsHelpers.kt`
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/secrets/SecretReferenceService.kt`

#### Implementation Details

The `SecretReferenceService` was enhanced to conditionally persist secret references based on feature flags:

```kotlin
@Singleton
class SecretReferenceService(
  private val secretReferenceRepository: SecretReferenceRepository,
  private val secretConfigRepository: SecretConfigRepository,
  private val featureFlagClient: FeatureFlagClient,
  private val workspaceHelper: WorkspaceHelper,
) {
  fun createAndInsertSecretReferencesWithStorageId(
    actorConfig: ConfigWithProcessedSecrets,
    actorId: ActorId,
    workspaceId: WorkspaceId,
    secretStorageId: SecretStorageId,
    currentUserId: UserId,
  ): ConfigWithSecretReferenceIdsInjected {
    // If the feature flag to persist secret configs and references is not enabled,
    // return the original config without any changes.
    val orgId = workspaceHelper.getOrganizationForWorkspace(workspaceId.value)
    if (!featureFlagClient.boolVariation(
        PersistSecretConfigsAndReferences,
        Multi(listOf(Workspace(workspaceId.value), Organization(orgId))),
      )
    ) {
      return ConfigWithSecretReferenceIdsInjected(actorConfig.originalConfig)
    }

    val createdSecretRefIdByPath = mutableMapOf<String, SecretReferenceId>()
    actorConfig.processedSecrets.forEach { path, secretNode ->
      if (secretNode.secretReferenceId != null) {
        createdSecretRefIdByPath[path] = secretNode.secretReferenceId
      } else if (secretNode.secretCoordinate != null) {
        // Create or get existing SecretConfig
        val secretConfig = getOrCreateSecretConfig(
          secretNode.secretCoordinate,
          secretNode.secretStorageId ?: secretStorageId,
          currentUserId,
        )

        // Create SecretReference
        val secretRef = SecretReferenceCreate(
          secretConfigId = SecretConfigId(secretConfig.id!!),
          scopeType = SecretReferenceScopeType.ACTOR,
          scopeId = actorId.value,
          hydrationPath = path,
        )
        val createdRef = secretReferenceRepository.save(secretRef.toEntity()).toDomainModel()
        createdSecretRefIdByPath[path] = SecretReferenceId(createdRef.id!!)
      }
    }

    cleanupDanglingSecretReferences(actorId, actorConfig)

    return SecretReferenceHelpers.updateSecretNodesWithSecretReferenceIds(
      actorConfig.originalConfig,
      createdSecretRefIdByPath,
    )
  }
}
```

The dual-write happens in `SecretsHelpers`:

```kotlin
object SecretReferenceHelpers {
  fun updateSecretNodesWithSecretReferenceIds(
    config: JsonNode,
    secretRefIdByPath: Map<String, SecretReferenceId>,
  ): ConfigWithSecretReferenceIdsInjected {
    var updatedConfig = config.deepCopy<JsonNode>()

    secretRefIdByPath.forEach { (path, secretRefId) ->
      updatedConfig = JsonPaths.replaceAt(updatedConfig, path) { existingNode, _ ->
        if (existingNode.isObject && existingNode.has(COORDINATE_FIELD)) {
          // Add secret_reference_id to existing coordinate node
          (existingNode as ObjectNode).put(SECRET_REF_ID_FIELD, secretRefId.value.toString())
          existingNode
        } else {
          // Create new node with both coordinate and reference ID
          Jsons.jsonNode(
            buildMap {
              put(COORDINATE_FIELD, "placeholder")
              put(SECRET_REF_ID_FIELD, secretRefId.value.toString())
            }
          )
        }
      }
    }

    return ConfigWithSecretReferenceIdsInjected(updatedConfig)
  }
}
```

The reading side also respects feature flags:

```kotlin
fun getConfigWithSecretReferences(
  actorId: ActorId,
  config: JsonNode,
  workspaceId: WorkspaceId,
): ConfigWithSecretReferences {
  // If the feature flag to read secret reference IDs in configs is enabled, look up the
  // secret references for the actorId and "hydrate" them into the config.
  val orgId = workspaceHelper.getOrganizationForWorkspace(workspaceId.value)
  val refsForScope =
    if (featureFlagClient.boolVariation(
        ReadSecretReferenceIdsInConfigs,
        Multi(listOf(Workspace(workspaceId.value), Organization(orgId))),
      )
    ) {
      val result = secretReferenceRepository.listWithConfigByScopeTypeAndScopeId(
        SecretReferenceScopeType.ACTOR,
        actorId.value
      )
      assertConfigReferenceIdsExist(config, result.map { it.secretReference.id }.toSet())
      result
    } else {
      emptyList()
    }

  val nonPersistedSecretRefsInConfig =
    SecretReferenceHelpers.getReferenceMapFromConfig(InlinedConfigWithSecretRefs(config)).filter {
      it.value.secretReferenceId == null
    }

  val persistedSecretRefs =
    refsForScope
      .filter { it.secretReference.hydrationPath != null }
      .associateBy(
        { it.secretReference.hydrationPath!! },
        {
          SecretReferenceConfig(
            secretCoordinate = SecretCoordinate.fromFullCoordinate(it.secretConfig.externalCoordinate),
            secretStorageId = it.secretConfig.secretStorageId,
            secretReferenceId = it.secretReference.id.value,
          )
        },
      )

  // Apply the non-persisted secret references over the persisted ones
  val secretRefs = persistedSecretRefs + nonPersistedSecretRefsInConfig
  return ConfigWithSecretReferences(config, secretRefs)
}
```

#### Business Value

The dual-write strategy enabled safe, gradual migration:

1. **No Breaking Changes**: Old code reading coordinates continues to work
2. **Feature Flag Control**: Reference IDs can be rolled out incrementally per organization
3. **Data Consistency**: Both coordinates and reference IDs are kept in sync
4. **Rollback Safety**: If issues arise, feature flags can be disabled without data loss
5. **Migration Path**: Provides a clear path from coordinate-based to reference-based lookups

This is a textbook example of the "expand-contract" pattern for database migrations - first expand by adding new fields (reference IDs), then gradually migrate reads to use new fields, finally contract by removing old fields (coordinates).

---

### 7. Ephemeral Secret References Fix

**Commit:** 62a3701b95 - April 17, 2025
**Impact:** 2 files changed, 57 insertions, 4 deletions

#### What Changed

This small but critical fix ensured that ephemeral (newly created) secret references properly replace persisted ones during configuration updates, preventing stale secret references from being used.

**Key files modified:**
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/secrets/SecretReferenceService.kt`

#### Implementation Details

The fix changed the merge order of persisted vs. incoming secret references:

```kotlin
fun getConfigWithSecretReferences(
  scopeType: SecretReferenceScopeType,
  scopeId: UUID,
  config: JsonNode,
): ConfigWithSecretReferences {
  val refsForScope = secretReferenceRepository.listWithConfigByScopeTypeAndScopeId(scopeType, scopeId)
  assertConfigReferenceIdsExist(config, refsForScope.map { it.secretReference.id }.toSet())

  val secretRefsInConfig = SecretReferenceHelpers.getReferenceMapFromConfig(InlinedConfigWithSecretRefs(config))

  val persistedSecretRefs =
    refsForScope.filter { it.secretReference.hydrationPath != null }.associateBy(
      { it.secretReference.hydrationPath!! },
      {
        SecretReferenceConfig(
          secretCoordinate = SecretCoordinate.fromFullCoordinate(it.secretConfig.externalCoordinate),
          secretStorageId = it.secretConfig.secretStorageId,
          secretReferenceId = it.secretReference.id.value,
        )
      },
    )

  // BEFORE (bug): val secretRefs = legacyCoordRefMap + persistedRefMap
  // Persisted refs would override ephemeral ones, using stale secrets

  // AFTER (fix): for any secret reference in the config, replace the corresponding persisted secret
  // (if it exists) because it may have been updated in the incoming config
  val secretRefs = persistedSecretRefs + secretRefsInConfig
  return ConfigWithSecretReferences(config, secretRefs)
}
```

The comment explains the critical insight: when updating a configuration with new secret values, the incoming (ephemeral) references should take precedence over persisted references, because they represent the user's intended updates.

#### Business Value

This fix prevented a subtle but serious bug:

1. **Correct Updates**: User secret updates are properly applied instead of being ignored
2. **Security**: Prevents using old secret values when user explicitly updates them
3. **Data Integrity**: Ensures the configuration always reflects the most recent secret values
4. **User Experience**: Updates work as expected without requiring multiple save attempts

Without this fix, users updating their database passwords or API keys would see their updates appear to succeed but then fail at runtime because the old secrets were being used.

---

### 8. API Endpoints for SecretStorage Management

**Commit:** 1332a12ed6 - March 18, 2025
**Impact:** 32 files changed, 386 insertions, 62 deletions

#### What Changed

This commit introduced public API endpoints for managing secret storage, allowing organizations to configure and retrieve their secret backend settings through the REST API.

**Key files added:**
- `airbyte-server/src/main/kotlin/io/airbyte/server/apis/controllers/SecretStorageApiController.kt` (40 lines)
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/secrets/SecretStorageService.kt` (108 lines)
- `airbyte-domain/models/src/main/kotlin/io/airbyte/domain/models/IdTypes.kt` (46 lines for type-safe IDs)

#### Implementation Details

The API controller provides endpoints for secret storage operations:

```kotlin
@Controller("/api/v1/secret_storage")
@ExecuteOn(AirbyteTaskExecutors.IO)
class SecretStorageApiController(
  private val secretStorageService: SecretStorageService,
) : SecretStorageApi {

  @RequiresIntent(Intent.ManageSecretStorages)
  override fun getSecretStorage(
    @Body secretStorageIdRequestBody: SecretStorageIdRequestBody,
  ): SecretStorageRead {
    val secretStorage = secretStorageService.getById(
      SecretStorageId(secretStorageIdRequestBody.secretStorageId)
    )
    return secretStorageService.hydrateStorageConfig(secretStorage).toApiModel()
  }
}

private fun SecretStorageWithConfig.toApiModel(): SecretStorageRead {
  val secretStorageRead = SecretStorageRead()
  secretStorageRead.id(this.secretStorage.id?.value)
  secretStorageRead.isConfiguredFromEnvironment(this.secretStorage.configuredFromEnvironment)
  secretStorageRead.config(this.config)
  return secretStorageRead
}
```

The domain service provides the business logic:

```kotlin
@Singleton
class SecretStorageService(
  private val secretStorageRepository: SecretStorageRepository,
  private val secretStorageServiceData: SecretStorageServiceData,
) {

  fun getById(id: SecretStorageId): SecretStorage {
    return secretStorageServiceData.getById(id)
  }

  fun hydrateStorageConfig(secretStorage: SecretStorage): SecretStorageWithConfig {
    val config = when (secretStorage.storageType) {
      SecretStorageType.AWS_SECRETS_MANAGER -> buildAwsConfig(secretStorage)
      SecretStorageType.GOOGLE_SECRET_MANAGER -> buildGcpConfig(secretStorage)
      SecretStorageType.AZURE_KEY_VAULT -> buildAzureConfig(secretStorage)
      SecretStorageType.VAULT -> buildVaultConfig(secretStorage)
      SecretStorageType.LOCAL_TESTING -> Jsons.emptyObject()
    }
    return SecretStorageWithConfig(secretStorage, config)
  }

  fun findByWorkspaceId(workspaceId: WorkspaceId): List<SecretStorage> {
    val organization = organizationService.getByWorkspaceId(workspaceId)
    return secretStorageServiceData.findByScopeTypeAndScopeId(
      SecretStorageScopeType.ORGANIZATION,
      organization.id
    )
  }
}
```

Type-safe ID wrappers prevent mixing up different UUID types:

```kotlin
@JvmInline
value class SecretStorageId(val value: UUID)

@JvmInline
value class SecretConfigId(val value: UUID)

@JvmInline
value class SecretReferenceId(val value: UUID)

@JvmInline
value class WorkspaceId(val value: UUID)

@JvmInline
value class OrganizationId(val value: UUID)
```

#### Business Value

This API enabled programmatic secret storage management:

1. **Self-Service**: Organizations can configure their own secret backends without admin help
2. **Type Safety**: Value classes prevent accidentally using wrong ID types
3. **Security**: Intent-based authorization ensures only authorized users can manage secrets
4. **Multi-Tenant**: Organizations can have different secret backends
5. **Programmatic Access**: Enables infrastructure-as-code for Airbyte configuration

The `hydrateStorageConfig` method is particularly clever - it fetches the storage record and then builds the appropriate configuration object based on the storage type, handling the differences between AWS, GCP, Azure, and Vault.

---

### 9. Airbyte-Managed Boolean Flag

**Commit:** 2bca8c432b - March 14, 2025
**Impact:** 9 files changed, 53 insertions, 3 deletions

#### What Changed

This small migration added an `airbyte_managed` boolean column to the `secret_config` table, enabling the system to distinguish between secrets created by Airbyte vs. secrets referenced by users from external sources.

**Key files modified:**
- `airbyte-db/db-lib/src/main/java/io/airbyte/db/instance/configs/migrations/V1_1_1_012__AddAirbyteManagedBooleanToSecretConfigTable.java`
- `airbyte-data/src/main/kotlin/io/airbyte/data/repositories/entities/SecretConfig.kt`

#### Implementation Details

The migration adds a simple boolean column:

```java
public class V1_1_1_012__AddAirbyteManagedBooleanToSecretConfigTable extends BaseJavaMigration {
  @Override
  public void migrate(final Context context) throws Exception {
    final DSLContext ctx = DSL.using(context.getConnection());

    ctx.alterTable("secret_config")
        .addColumn(
          DSL.field("airbyte_managed", SQLDataType.BOOLEAN.nullable(false).defaultValue(true))
        )
        .execute();
  }
}
```

The entity is updated:

```kotlin
@MappedEntity("secret_config")
data class SecretConfig(
  @field:Id
  @AutoPopulated
  var id: UUID? = null,
  var secretStorageId: UUID,
  var descriptor: String,
  var externalCoordinate: String,
  var airbyteManaged: Boolean = true,  // NEW FIELD
  var tombstone: Boolean = false,
  var createdBy: UUID,
  var updatedBy: UUID,
  @DateCreated
  var createdAt: java.time.OffsetDateTime? = null,
  @DateUpdated
  var updatedAt: java.time.OffsetDateTime? = null,
)
```

#### Business Value

This flag enables important distinctions:

1. **Lifecycle Management**: Airbyte-managed secrets can be automatically deleted, external ones cannot
2. **Billing**: Future features could charge differently for managed vs. external secrets
3. **Cleanup**: Safe to delete managed secrets when actors are deleted, but not external ones
4. **Auditing**: Track which secrets Airbyte created vs. which users provided
5. **Migration**: Helps identify legacy secrets during system upgrades

The default value of `true` ensures existing secrets are marked as Airbyte-managed, maintaining backward compatibility.

---

### 10. Secret Backend Support Implementation

The commits collectively implement support for multiple secret backends:

**Supported Backends:**
- **AWS Secrets Manager**: Full support with IAM-based authentication
- **Google Secret Manager**: Full support with service account authentication
- **Azure Key Vault**: Full support with managed identity authentication
- **Vault**: Full support with token-based authentication
- **Local Testing**: Development/testing backend using database storage

Each backend implements the `SecretPersistence` interface:

```kotlin
interface SecretPersistence {
  fun read(coordinate: AirbyteManagedSecretCoordinate): String
  fun write(coordinate: AirbyteManagedSecretCoordinate, payload: String)
  fun delete(coordinate: AirbyteManagedSecretCoordinate)
}
```

The implementations are backend-specific but share common patterns:

```kotlin
class AwsSecretManagerPersistence(
  private val client: SecretsManagerClient,
  private val metricClient: MetricClient,
) : SecretPersistence {
  override fun read(coordinate: AirbyteManagedSecretCoordinate): String {
    try {
      val response = client.getSecretValue(
        GetSecretValueRequest.builder()
          .secretId(coordinate.coordinateBase)
          .versionId(coordinate.version.toString())
          .build()
      )
      return response.secretString()
    } catch (e: ResourceNotFoundException) {
      logger.warn { "Secret not found: ${coordinate.fullCoordinate}" }
      return ""
    }
  }

  override fun write(coordinate: AirbyteManagedSecretCoordinate, payload: String) {
    // Create or update secret
    if (secretExists(coordinate.coordinateBase)) {
      client.putSecretValue(
        PutSecretValueRequest.builder()
          .secretId(coordinate.coordinateBase)
          .secretString(payload)
          .build()
      )
    } else {
      client.createSecret(
        CreateSecretRequest.builder()
          .name(coordinate.coordinateBase)
          .secretString(payload)
          .build()
      )
    }
  }
}
```

---

## Technical Evolution

The secrets management work shows a deliberate, phased approach to building a production-ready system:

### Phase 1: Foundation (March 2025)

The work began with establishing the data model:

- **March 3**: Three-table architecture (c4dad82dbe)
- **March 14**: Airbyte-managed flag (2bca8c432b)
- **March 18**: API endpoints (1332a12ed6)

This phase focused on getting the database schema and basic services right.

### Phase 2: Coordinate Refactoring (March 2025)

With the foundation in place, the team addressed type safety:

- **March 25**: Move secret writing to handlers (98137c70d8)
- **March 26**: Sealed class hierarchy for coordinates (4808dc229d)

This phase improved code quality and enabled external secret support.

### Phase 3: Secret Reference Implementation (April 2025)

The major feature work happened in April:

- **April 7**: Auth secret creation fixes (3c65ef259f)
- **April 11**: Write SecretConfig and SecretReferences (123718be02) - the big one!
- **April 17**: Ephemeral secrets fix (62a3701b95)
- **April 23**: Dual-write secret reference IDs (2e601f1aff)
- **April 24**: Bootloader initialization (e29ae7da90)

This phase delivered the core functionality of the new secrets system.

### Phase 4: Production Hardening (September 2025)

The final phase addressed operational concerns:

- **September 24**: Environment variable support for auth secrets (3be70739a2)

This phase ensured the system works reliably in production environments.

### Technology Choices

The evolution demonstrates thoughtful technology decisions:

- **Kotlin for New Code**: All new services and entities written in Kotlin for null safety and conciseness
- **Micronaut Data**: Modern ORM with compile-time query validation
- **Sealed Classes**: Type-safe coordinate hierarchy prevents bugs
- **Value Classes**: Type-safe ID wrappers with zero runtime overhead
- **Feature Flags**: Gradual rollout capability for risk mitigation
- **Flyway Migrations**: Version-controlled database schema changes

---

## Impact Summary

Parker's contributions to Secrets Management represent a complete architectural evolution of how Airbyte handles sensitive configuration data. The work transformed a simple coordinate-based system into an enterprise-grade secret management platform.

### Quantitative Impact

- **13 commits** over 12 months
- **~5,700 lines** of code changes
- **Major features delivered:**
  - Three-table reference architecture
  - Sealed class coordinate hierarchy
  - Multi-backend secret storage support
  - Dual-write migration strategy
  - API endpoints for secret management
  - Automatic bootloader initialization

### Qualitative Impact

**For Users:**
- Can reference secrets in their own secret managers (AWS, GCP, Azure, Vault)
- No vendor lock-in - secrets stay in their infrastructure
- Automatic secret detection and extraction from connector configs
- Proper cleanup when actors are deleted

**For Operators:**
- Zero-configuration default setup
- Multiple backend support without code changes
- Feature flags enable gradual rollout
- Proper audit trails and lifecycle management

**For Developers:**
- Type-safe coordinate and ID handling
- Clear separation of concerns (handlers, services, repositories)
- Comprehensive test coverage
- Well-documented edge cases

**For the Platform:**
- Multi-tenant secret isolation
- Reference tracking prevents dangling secrets
- Versioned secrets enable rollback
- External secret support enables enterprise adoption

### Key Architectural Patterns

The work established several important patterns:

1. **Three-Table Architecture**: Separation of storage, config, and references enables flexibility
2. **Sealed Class Hierarchy**: Type-safe distinction between managed and external secrets
3. **Dual-Write Migration**: Expand-contract pattern enables zero-downtime migrations
4. **Feature Flag Gating**: Gradual rollout reduces risk
5. **Value Classes for IDs**: Compile-time type safety with zero runtime cost
6. **Hydration Path**: JSON path storage enables precise secret injection
7. **Coordinate Versioning**: Immutable secret values with version tracking

### Security Improvements

The new system significantly improves Airbyte's security posture:

1. **No Secrets in Configs**: Secrets replaced with references before database storage
2. **Proper Lifecycle**: Secrets cleaned up when actors deleted
3. **Reference Tracking**: System knows which actors use which secrets
4. **External Storage**: Secrets can stay in customer's infrastructure
5. **Audit Trail**: Complete tracking of secret creation, updates, and deletions
6. **Multi-Backend**: Support for enterprise secret management systems

### Business Value

This work directly enables Airbyte's enterprise strategy:

1. **SOC 2 Compliance**: Proper secret management is required for compliance certification
2. **Enterprise Sales**: Large customers require external secret manager support
3. **Multi-Tenancy**: Organizations can configure their own secret backends
4. **Reduced Risk**: Secrets never transmitted or stored in plaintext
5. **Competitive Advantage**: Few data integration tools offer this level of secret management

The reference tracking capability is particularly valuable - it enables features like "show me all sources using this secret" and "prevent deletion of in-use secrets," which are table stakes for enterprise adoption.

---

## Conclusion

The Secrets Management work represents one of the most significant architectural investments in the Airbyte platform. By building a proper three-table reference architecture, implementing sealed class hierarchies for type safety, and supporting multiple external secret backends, Parker created a foundation that enables Airbyte to serve enterprise customers with stringent security requirements.

The dual-write migration strategy demonstrates sophisticated thinking about production system evolution - enabling gradual rollout while maintaining backward compatibility. The use of feature flags, value classes for type safety, and proper separation of concerns shows mature software engineering practices.

This foundation not only solves immediate secret management needs but creates a platform for future features like secret rotation, secret versioning, compliance reporting, and multi-region secret replication.
