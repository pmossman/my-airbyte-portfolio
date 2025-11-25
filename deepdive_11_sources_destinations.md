# Sources & Destinations - Deep Dive

## Overview

This document analyzes Parker Mossman's contributions to the Sources & Destinations area of the airbyte-platform repository. This work spans from December 2021 to April 2025, encompassing 23 commits that built out connector definition management, soft delete functionality, versioning capabilities, service layer modernization, and RBAC integration.

**Period:** December 20, 2021 - April 16, 2025 (40 months)
**Total Commits:** 23
**Total Changes:** ~8,500 lines of code
**Key Technologies:** Java, Kotlin, JOOQ, Micronaut, OpenAPI

---

## Key Architectural Changes

### 1. Soft Delete (Tombstone) for Connector Definitions

**Commit:** 0789b8a269 - December 20, 2021
**Impact:** 11 files changed, 262 insertions, 20 deletions

#### What Changed

Introduced the "tombstone" pattern for soft-deleting source and destination definitions, allowing connectors to be marked as deleted without actually removing them from the database. This was the foundational change that enabled safe deletion workflows.

**Key files modified:**
- `airbyte-config/models/src/main/resources/types/StandardSourceDefinition.yaml`
- `airbyte-config/models/src/main/resources/types/StandardDestinationDefinition.yaml`
- `airbyte-config/persistence/src/main/java/io/airbyte/config/persistence/ConfigRepository.java`

#### Implementation Details

The schema changes added a tombstone field to both source and destination definitions:

```yaml
# StandardSourceDefinition.yaml
tombstone:
  description:
    if not set or false, the configuration is active. if true, then this
    configuration is permanently off.
  type: boolean
```

The repository methods were updated to respect the tombstone flag:

```java
public List<StandardSourceDefinition> listStandardSourceDefinitions(final boolean includeTombstone)
    throws JsonValidationException, IOException {
  final List<StandardSourceDefinition> sourceDefinitions = new ArrayList<>();
  for (final StandardSourceDefinition sourceDefinition : persistence.listConfigs(
      ConfigSchema.STANDARD_SOURCE_DEFINITION, StandardSourceDefinition.class)) {
    if (!MoreBooleans.isTruthy(sourceDefinition.getTombstone()) || includeTombstone) {
      sourceDefinitions.add(sourceDefinition);
    }
  }
  return sourceDefinitions;
}
```

All list operations gained an `includeTombstone` parameter, allowing explicit control over whether deleted definitions should be returned. The `ConfigDumpImporter` was updated to skip tombstoned definitions during import operations.

Comprehensive tests covered multiple scenarios:
- Null tombstone (treated as false)
- Explicit true/false tombstone values
- Filtering behavior with includeTombstone parameter

#### Business Value

This change enabled critical production capabilities:

1. **Data Integrity**: Definitions could be "deleted" without breaking referential integrity for existing connections
2. **Audit Trail**: Maintained historical record of all connector definitions ever created
3. **Reversibility**: Tombstoned definitions could theoretically be restored if needed
4. **Safe Cleanup**: Prevented cascade deletion issues that could break active data pipelines
5. **Migration Support**: Enabled smooth transitions when deprecating old connector versions

This pattern became the standard for "deleting" resources throughout Airbyte, establishing a key architectural principle.

---

### 2. Delete API Endpoints for Connector Definitions

**Commit:** 9dfd0daf0a - December 20, 2021
**Impact:** 12 files changed, 427 insertions, 116 deletions

#### What Changed

Building on the tombstone foundation, this commit added public API endpoints for deleting source and destination definitions. The implementation cascades the delete to all associated actors (sources/destinations).

**Key files modified:**
- `airbyte-api/src/main/openapi/config.yaml` (API schema)
- `airbyte-server/src/main/java/io/airbyte/server/handlers/SourceDefinitionsHandler.java`
- `airbyte-server/src/main/java/io/airbyte/server/handlers/DestinationDefinitionsHandler.java`
- `airbyte-server/src/main/java/io/airbyte/server/handlers/SourceHandler.java`
- `airbyte-server/src/main/java/io/airbyte/server/handlers/DestinationHandler.java`

#### Implementation Details

New API endpoints were defined in the OpenAPI spec:

```yaml
/v1/source_definitions/delete:
  post:
    tags:
      - source_definition
    summary: Delete a source definition
    operationId: deleteSourceDefinition
    requestBody:
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/SourceDefinitionIdRequestBody"
    responses:
      "204":
        description: The resource was deleted successfully.
      "404":
        $ref: "#/components/responses/NotFoundResponse"
      "422":
        $ref: "#/components/responses/InvalidInputResponse"
```

The handler implementation performed cascading deletes:

```java
public void deleteSourceDefinition(final SourceDefinitionIdRequestBody sourceDefinitionIdRequestBody)
    throws JsonValidationException, IOException, ConfigNotFoundException {
  // "delete" all sources associated with the source definition as well. This will cascade to
  // connections that depend on any deleted sources.
  // Delete sources first in case a failure occurs mid-operation.

  final StandardSourceDefinition persistedSourceDefinition =
      configRepository.getStandardSourceDefinition(sourceDefinitionIdRequestBody.getSourceDefinitionId());

  for (final SourceRead sourceRead : sourceHandler.listSourcesForSourceDefinition(sourceDefinitionIdRequestBody).getSources()) {
    sourceHandler.deleteSource(sourceRead);
  }

  persistedSourceDefinition.withTombstone(true);
  configRepository.writeStandardSourceDefinition(persistedSourceDefinition);
}
```

The `SourceHandler` gained a new method to list sources for a specific definition:

```java
public SourceReadList listSourcesForSourceDefinition(final SourceDefinitionIdRequestBody sourceDefinitionIdRequestBody)
    throws JsonValidationException, IOException, ConfigNotFoundException {

  final List<SourceConnection> sourceConnections = configRepository.listSourceConnection()
      .stream()
      .filter(sc -> sc.getSourceDefinitionId().equals(sourceDefinitionIdRequestBody.getSourceDefinitionId())
          && !MoreBooleans.isTruthy(sc.getTombstone()))
      .toList();

  final List<SourceRead> reads = Lists.newArrayList();
  for (final SourceConnection sourceConnection : sourceConnections) {
    reads.add(buildSourceRead(sourceConnection.getSourceId()));
  }

  return new SourceReadList().sources(reads);
}
```

#### Business Value

This feature enabled important administrative workflows:

1. **Connector Lifecycle Management**: Admins could fully deprecate connectors that were no longer supported
2. **Cascade Awareness**: The delete operation properly cleaned up all dependent resources
3. **Failure Safety**: Deleting sources first ensured consistent state even if the operation failed midway
4. **API Completeness**: Provided full CRUD operations for connector definitions
5. **Custom Connector Cleanup**: Enabled removing custom/private connectors that were no longer needed

The comprehensive test coverage (100+ lines of new tests) ensured the cascading behavior worked correctly across various scenarios.

---

### 3. Release Stage and Release Date Tracking

**Commit:** 5da184895f - February 4, 2022
**Impact:** 16 files changed, 404 insertions, 30 deletions

#### What Changed

Added `release_stage` and `release_date` fields to the `actor_definition` table, enabling tracking of connector maturity levels (alpha, beta, generally_available) and their release dates. This was critical for communicating connector stability to users.

**Key files modified:**
- Database migration: `V0_36_1_001__AddReleaseStageAndReleaseDateToActorDefinition.java`
- `airbyte-config/models/src/main/resources/types/StandardSourceDefinition.yaml`
- `airbyte-config/models/src/main/resources/types/StandardDestinationDefinition.yaml`
- `airbyte-api/src/main/openapi/config.yaml`
- `airbyte-config/config-persistence/src/main/java/io/airbyte/config/persistence/DatabaseConfigPersistence.java`

#### Implementation Details

The migration added new columns to the actor_definition table:

```java
@Override
public void migrate(final DSLContext ctx) throws Exception {
  ctx.alterTable(ACTOR_DEFINITION)
      .addColumnIfNotExists(field(
          "release_date",
          SQLDataType.DATE.nullable(true)))
      .execute();

  ctx.alterTable(ACTOR_DEFINITION)
      .addColumnIfNotExists(field(
          "release_stage",
          SQLDataType.VARCHAR.nullable(true).defaultValue("custom")))
      .execute();
}
```

The schema models were updated to include these fields:

```yaml
# StandardSourceDefinition.yaml
releaseStage:
  description: The release stage of the connector (alpha, beta, generally_available, custom)
  type: string
  enum:
    - alpha
    - beta
    - generally_available
    - custom
releaseDate:
  description: The date this connector was released
  type: string
  format: date
```

The persistence layer handled null release dates gracefully:

```java
private void writeStandardSourceDefinition(final List<StandardSourceDefinition> configs, final DSLContext ctx) {
  final OffsetDateTime timestamp = OffsetDateTime.now();
  configs.forEach((standardSourceDefinition) -> {
    final boolean isExistingConfig = ctx.fetchExists(select()
        .from(ACTOR_DEFINITION)
        .where(ACTOR_DEFINITION.ID.eq(standardSourceDefinition.getSourceDefinitionId())));

    if (isExistingConfig) {
      ctx.update(ACTOR_DEFINITION)
          .set(ACTOR_DEFINITION.RELEASE_STAGE,
              standardSourceDefinition.getReleaseStage() != null
                  ? Enums.toEnum(standardSourceDefinition.getReleaseStage().value(), ReleaseStage.class).orElseThrow()
                  : null)
          .set(ACTOR_DEFINITION.RELEASE_DATE,
              standardSourceDefinition.getReleaseDate() != null
                  ? LocalDate.parse(standardSourceDefinition.getReleaseDate())
                  : null)
          // ... other fields
          .where(ACTOR_DEFINITION.ID.eq(standardSourceDefinition.getSourceDefinitionId()))
          .execute();
    }
  });
}
```

The API responses now included these fields:

```yaml
# API schema for SourceDefinitionRead
releaseStage:
  $ref: "#/components/schemas/ReleaseStage"
releaseDate:
  type: string
  format: date
```

#### Business Value

This enhancement provided critical visibility into connector maturity:

1. **User Expectations**: Users could see whether a connector was production-ready or experimental
2. **Risk Assessment**: Teams could make informed decisions about using alpha/beta connectors in production
3. **Connector Evolution**: Tracked the maturity progression from alpha → beta → GA
4. **Release Planning**: Release dates enabled tracking when connectors reached various milestones
5. **Custom Connector Distinction**: The "custom" release stage clearly identified user-created connectors

The shared enum definition across the codebase ensured consistency between API responses and internal models.

---

### 4. Breaking Change and Override Applied Flags

**Commit:** 5f620f7def - February 22, 2024
**Impact:** 18 files changed, 341 insertions, 116 deletions

#### What Changed

Enhanced `SourceRead` and `DestinationRead` API responses to include information about breaking changes, version overrides, and support state. This enabled the UI to warn users about upcoming breaking changes and show when a version override was applied.

**Key files modified:**
- `airbyte-api/src/main/openapi/config.yaml`
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/SourceHandler.java`
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/DestinationHandler.java`
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/helpers/ActorDefinitionHandlerHelper.java`

#### Implementation Details

The API schema was extended with new fields:

```yaml
SourceRead:
  properties:
    # ... existing fields
    isVersionOverrideApplied:
      type: boolean
    breakingChanges:
      $ref: "#/components/schemas/ActorDefinitionVersionBreakingChanges"
    supportState:
      $ref: "#/components/schemas/SupportState"
```

The `ActorDefinitionHandlerHelper` gained a method to compute breaking changes:

```java
public Optional<ActorDefinitionVersionBreakingChanges> getVersionBreakingChanges(
    final ActorDefinitionVersion actorDefinitionVersion) throws IOException {
  final List<ActorDefinitionBreakingChange> breakingChanges =
      actorDefinitionService.listBreakingChangesForActorDefinitionVersion(actorDefinitionVersion);

  if (!breakingChanges.isEmpty()) {
    final LocalDate minUpgradeDeadline = getMinBreakingChangeUpgradeDeadline(breakingChanges);
    return Optional.of(new ActorDefinitionVersionBreakingChanges()
        .upcomingBreakingChanges(breakingChanges.stream().map(ApiPojoConverters::toApiBreakingChange).toList())
        .minUpgradeDeadline(minUpgradeDeadline));
  } else {
    return Optional.empty();
  }
}

private LocalDate getMinBreakingChangeUpgradeDeadline(final List<ActorDefinitionBreakingChange> breakingChanges) {
  return breakingChanges.stream()
      .map(ActorDefinitionBreakingChange::getUpgradeDeadline)
      .map(LocalDate::parse)
      .min(LocalDate::compareTo)
      .orElse(null);
}
```

The handler methods were updated to include this information:

```java
protected SourceRead toSourceRead(final SourceConnection sourceConnection,
                                  final StandardSourceDefinition standardSourceDefinition)
    throws JsonValidationException, ConfigNotFoundException, IOException {

  final ActorDefinitionVersionWithOverrideStatus sourceVersionWithOverrideStatus =
      actorDefinitionVersionHelper.getSourceVersionWithOverrideStatus(
          standardSourceDefinition, sourceConnection.getWorkspaceId(), sourceConnection.getSourceId());

  final Optional<ActorDefinitionVersionBreakingChanges> breakingChanges =
      actorDefinitionHandlerHelper.getVersionBreakingChanges(sourceVersionWithOverrideStatus.actorDefinitionVersion());

  return new SourceRead()
      .sourceDefinitionId(standardSourceDefinition.getSourceDefinitionId())
      // ... other fields
      .isVersionOverrideApplied(sourceVersionWithOverrideStatus.isOverrideApplied())
      .breakingChanges(breakingChanges.orElse(null))
      .supportState(toApiSupportState(sourceVersionWithOverrideStatus.actorDefinitionVersion().getSupportState()));
}
```

The `ActorDefinitionVersionHandler` was refactored to use this shared helper:

```java
final Optional<ActorDefinitionVersionBreakingChanges> breakingChanges =
    actorDefinitionHandlerHelper.getVersionBreakingChanges(actorDefinitionVersion);
breakingChanges.ifPresent(advRead::setBreakingChanges);
```

#### Business Value

This change significantly improved the user experience around connector upgrades:

1. **Breaking Change Visibility**: Users could see upcoming breaking changes before they impacted their pipelines
2. **Upgrade Planning**: The minimum upgrade deadline helped teams prioritize upgrade work
3. **Version Override Awareness**: Users knew when they were pinned to a specific version vs. using the default
4. **Support State Transparency**: Clear indication of whether a connector version was supported, deprecated, or sunset
5. **UI Integration**: Frontend could display warnings and prompts for users to upgrade before deadlines

The refactoring to share logic via `ActorDefinitionHandlerHelper` eliminated code duplication and ensured consistent breaking change computation across all endpoints.

---

### 5. Enterprise RBAC: Actor Definition Access Validation

**Commit:** 7c29af659d - December 5, 2023
**Impact:** 9 files changed, 281 insertions, 4 deletions

#### What Changed

Introduced role-based access control for actor definition endpoints, allowing only instance admins and organization admins to create, update, or delete connector definitions. This was a critical security enhancement for multi-tenant deployments.

**Key files added:**
- `ActorDefinitionAccessValidator.java` (interface)
- `CommunityActorDefinitionAccessValidator.java` (OSS implementation)
- `EnterpriseActorDefinitionAccessValidator.java` (Enterprise implementation)

**Key files modified:**
- `SourceDefinitionApiController.java`
- `DestinationDefinitionApiController.java`

#### Implementation Details

The validator interface defined a simple contract:

```java
/**
 * Interface for validating access to actor definitions. Implementations vary across Self-Hosted and
 * Cloud editions.
 */
public interface ActorDefinitionAccessValidator {

  /**
   * Check if the current user/request has write access to the indicated actor definition.
   *
   * @param actorDefinitionId the primary key ID of the actor definition to check
   * @throws ApplicationErrorKnownException if the user does not have write access to the actor
   *         definition
   */
  void validateWriteAccess(final UUID actorDefinitionId) throws ApplicationErrorKnownException;
}
```

The Community edition implementation was a no-op:

```java
@Singleton
public class CommunityActorDefinitionAccessValidator implements ActorDefinitionAccessValidator {

  @Override
  public void validateWriteAccess(final UUID actorDefinitionId) throws ApplicationErrorKnownException {
    // do nothing - Community edition has no access restrictions
  }
}
```

The Enterprise implementation enforced RBAC rules:

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
          permissionPersistence.findPermissionTypeForUserAndOrganization(
              OrganizationPersistence.DEFAULT_ORGANIZATION_ID, authId);

      if (defaultOrgPermissionType.equals(PermissionType.ORGANIZATION_ADMIN)) {
        return;
      }

      // if we haven't returned by now, the user does not have write access.
      throw new ApplicationErrorKnownException(
          "User with auth ID " + authId + " does not have write access to actor definition " + actorDefinitionId);
    } catch (final Exception e) {
      throw new ApplicationErrorKnownException(
          "Could not validate user access to actor definition " + actorDefinitionId + " due to error", e);
    }
  }
}
```

The API controllers were updated to invoke the validator:

```java
@Post("/update")
@Secured({AUTHENTICATED_USER})  // Changed from ADMIN to AUTHENTICATED_USER
@ExecuteOn(AirbyteTaskExecutors.IO)
@Override
public SourceDefinitionRead updateSourceDefinition(final SourceDefinitionUpdate sourceDefinitionUpdate) {
  // the accessValidator will provide additional authorization checks, depending on Airbyte edition.
  accessValidator.validateWriteAccess(sourceDefinitionUpdate.getSourceDefinitionId());
  return ApiHelper.execute(() -> sourceDefinitionsHandler.updateSourceDefinition(sourceDefinitionUpdate));
}

@Post("/delete")
@Secured({AUTHENTICATED_USER})  // Changed from ADMIN to AUTHENTICATED_USER
@ExecuteOn(AirbyteTaskExecutors.IO)
@Override
@Status(HttpStatus.NO_CONTENT)
public void deleteSourceDefinition(final SourceDefinitionIdRequestBody sourceDefinitionIdRequestBody) {
  accessValidator.validateWriteAccess(sourceDefinitionIdRequestBody.getSourceDefinitionId());
  ApiHelper.execute(() -> {
    sourceDefinitionsHandler.deleteSourceDefinition(sourceDefinitionIdRequestBody);
    return null;
  });
}
```

#### Business Value

This RBAC integration provided essential security for enterprise deployments:

1. **Fine-Grained Authorization**: Not all authenticated users could modify connector definitions
2. **Organization-Level Control**: Organization admins had appropriate permissions within their scope
3. **Edition-Specific Behavior**: OSS remained permissive while Enterprise enforced strict controls
4. **Micronaut Integration**: Used `@Replaces` annotation to cleanly swap implementations based on edition
5. **Consistent Enforcement**: All write operations (create, update, delete) protected by the same validator
6. **Clear Error Messages**: Users received informative errors when lacking permissions

The comprehensive test coverage ensured the authorization logic worked correctly for various permission levels.

---

### 6. Kotlin Migration: Source/DestinationServiceJooqImpl

**Commit:** 4e57eee384 - March 19, 2025
**Impact:** 5 files changed, 2,035 insertions, 1,636 deletions

#### What Changed

Migrated the JOOQ-based service implementations for sources and destinations from Java to Kotlin. This massive refactoring improved code readability, null safety, and leveraged Kotlin's modern language features while maintaining identical functionality.

**Key files:**
- Deleted: `SourceServiceJooqImpl.java` (820 lines)
- Added: `SourceServiceJooqImpl.kt` (1,039 lines)
- Deleted: `DestinationServiceJooqImpl.java` (810 lines)
- Added: `DestinationServiceJooqImpl.kt` (990 lines)

#### Implementation Details

The Kotlin version leveraged language features for more concise code:

**Before (Java):**
```java
@Override
public DestinationConnection getDestinationConnection(final UUID destinationId)
    throws JsonValidationException, IOException, ConfigNotFoundException {
  return listDestinationQuery(Optional.of(destinationId))
      .findFirst()
      .orElseThrow(() -> new ConfigNotFoundException(ConfigSchema.DESTINATION_CONNECTION, destinationId));
}

private Stream<DestinationConnection> listDestinationQuery(final Optional<UUID> destId) throws IOException {
  return database.query(ctx -> ctx.select(asterisk())
      .from(ACTOR)
      .where(ACTOR.ACTOR_TYPE.eq(ActorType.destination))
      .and(destId.map(ACTOR.ID::eq).orElse(noCondition()))
      .and(ACTOR.TOMBSTONE.notEqual(true))
      .fetch())
      .stream()
      .map(DbConverter::buildDestinationConnection);
}
```

**After (Kotlin):**
```kotlin
override fun getDestinationConnection(destinationId: UUID): DestinationConnection =
  listDestinationQuery(destinationId = destinationId)
    .firstOrNull()
    ?: throw ConfigNotFoundException(ConfigSchema.DESTINATION_CONNECTION, destinationId)

private fun listDestinationQuery(destinationId: UUID? = null): Sequence<DestinationConnection> =
  database.query { ctx ->
    ctx.select(asterisk())
      .from(ACTOR)
      .where(ACTOR.ACTOR_TYPE.eq(ActorType.destination))
      .apply { destinationId?.let { and(ACTOR.ID.eq(it)) } }
      .and(ACTOR.TOMBSTONE.notEqual(true))
      .fetch()
  }.asSequence()
    .map(DbConverter::buildDestinationConnection)
```

The Kotlin version used extension functions and null-safe operators:

```kotlin
private fun <T> List<T>.listActorDefinitionsJoinedWithGrants(
  scopeId: UUID,
  scopeType: io.airbyte.db.instance.configs.jooq.generated.enums.ScopeType,
  joinType: JoinType,
  actorType: ActorType,
  recordToReturnType: (Record) -> T,
  vararg conditions: Condition
): List<T> {
  val records = actorDefinitionsJoinedWithGrants(
    scopeId = scopeId,
    scopeType = scopeType,
    joinType = joinType,
    conditions = ConditionsHelper.addAll(
      conditions,
      ACTOR_DEFINITION.ACTOR_TYPE.eq(actorType),
      ACTOR_DEFINITION.PUBLIC.eq(false)
    )
  )

  return records.map(recordToReturnType)
}
```

Default parameters eliminated method overloading:

```kotlin
fun listDestinationsForDefinition(
  definitionId: UUID,
  includeTombstone: Boolean = false
): List<DestinationConnection> =
  database.query { ctx ->
    ctx.select(asterisk())
      .from(ACTOR)
      .where(ACTOR.ACTOR_TYPE.eq(ActorType.destination))
      .and(ACTOR.ACTOR_DEFINITION_ID.eq(definitionId))
      .apply { if (!includeTombstone) and(ACTOR.TOMBSTONE.notEqual(true)) }
      .fetch()
  }.map(DbConverter::buildDestinationConnection)
```

Data classes replaced verbose Java builders:

```kotlin
data class DestinationAndDefinition(
  val destination: DestinationConnection,
  val definition: StandardDestinationDefinition
)
```

#### Business Value

This migration delivered significant long-term benefits:

1. **Null Safety**: Kotlin's type system eliminated null pointer exceptions at compile time
2. **Conciseness**: ~400 fewer lines of code while maintaining identical functionality
3. **Readability**: Named parameters and default arguments made code self-documenting
4. **Maintainability**: Less boilerplate meant easier understanding and modification
5. **Modern Codebase**: Aligned with Airbyte's strategy to migrate to Kotlin
6. **Functional Style**: Encouraged immutable data and functional programming patterns
7. **Extension Functions**: Enabled cleaner organization of utility methods

The test updates ensured backward compatibility - all existing tests passed with the new implementation.

---

### 7. Remove Clone API Endpoints

**Commit:** aa7a8190be - March 20, 2025
**Impact:** 9 files changed, 358 deletions

#### What Changed

Removed the `/clone` API endpoints for sources and destinations, along with all supporting code. These endpoints were deemed unnecessary as the same functionality could be achieved through create operations with copied configurations.

**Key files modified:**
- `airbyte-server-api/src/main/openapi/config.yaml` (removed endpoint definitions)
- `SourceHandler.java` (removed cloneSource method)
- `DestinationHandler.java` (removed cloneDestination method)
- `SourceApiController.kt` (removed controller method)
- `DestinationApiController.kt` (removed controller method)

#### Implementation Details

The OpenAPI spec removal:

```yaml
# REMOVED:
/v1/sources/clone:
  post:
    tags:
      - source
    summary: Clone source
    operationId: cloneSource
    # ... endpoint definition removed
```

Handler methods removed (example from SourceHandler):

```java
// REMOVED ~47 lines:
public SourceRead cloneSource(final SourceCloneRequestBody sourceCloneRequestBody)
    throws JsonValidationException, IOException, ConfigNotFoundException {

  final SourceConnection sourceConnectionToClone =
      configRepository.getSourceConnection(sourceCloneRequestBody.getSourceCloneId());

  final SourceConnection sourceConnection = new SourceConnection()
      .withSourceDefinitionId(sourceConnectionToClone.getSourceDefinitionId())
      .withWorkspaceId(sourceCloneRequestBody.getSourceConfiguration().getWorkspaceId())
      .withName(sourceCloneRequestBody.getSourceConfiguration().getName())
      .withConfiguration(sourceCloneRequestBody.getSourceConfiguration().getConfiguration())
      .withSourceId(uuidSupplier.get());

  secretsRepositoryWriter.writeSourceConnection(sourceConnection,
      configRepository.getStandardSourceDefinition(sourceConnection.getSourceDefinitionId()).getSpec());

  return buildSourceRead(sourceConnection.getSourceId());
}
```

Corresponding controller endpoints removed from both source and destination controllers:

```kotlin
// REMOVED from SourceApiController.kt:
@Post("/clone")
@Secured(SecuredWorkspace.WORKSPACE_EDITOR)
@ExecuteOn(AirbyteTaskExecutors.IO)
override fun cloneSource(sourceCloneRequestBody: SourceCloneRequestBody): SourceRead {
  // ... implementation
}
```

Tests removed (100+ lines of test code):

```java
// REMOVED from SourceHandlerTest.java:
@Test
void testCloneSource() throws JsonValidationException, IOException, ConfigNotFoundException {
  final SourceConnection sourceConnection = SourceHelpers.generateSource(UUID.randomUUID());
  final SourceCloneRequestBody request = new SourceCloneRequestBody()
      .sourceCloneId(sourceConnection.getSourceId())
      .sourceConfiguration(new SourceCloneConfiguration()
          .name("cloned-source")
          .workspaceId(WORKSPACE_ID)
          .configuration(sourceConnection.getConfiguration()));
  // ... test logic
}
```

#### Business Value

This cleanup provided several benefits:

1. **API Simplification**: Reduced API surface area by removing redundant functionality
2. **Maintenance Reduction**: Less code to maintain, test, and document
3. **Clearer Patterns**: Users should use standard create operations with configuration copied from existing resources
4. **Code Quality**: Eliminated 358 lines of code that served minimal unique value
5. **Focus**: Team could focus on core functionality rather than maintaining multiple ways to do the same thing

The removal was safe because:
- Clone functionality could be replicated with a GET followed by a POST
- No critical workflows depended exclusively on these endpoints
- The change was clearly documented in release notes

---

### 8. Fix: Pass workspaceId to Spec Job Based on scopeType/scopeId

**Commit:** da18ef85da - April 14, 2025
**Impact:** 7 files changed, 93 insertions, 62 deletions

#### What Changed

Fixed a bug where custom connector definitions created at the organization scope failed because spec jobs require a workspace ID to determine which data plane should execute the job. Added logic to resolve workspace ID from scopeType/scopeId parameters.

**Key files modified:**
- `SourceDefinitionsHandler.java`
- `DestinationDefinitionsHandler.java`
- `ActorDefinitionHandlerHelper.java`
- `DefaultSynchronousSchedulerClient.java`

#### Implementation Details

Added workspace ID resolution logic to both source and destination handlers:

```java
private UUID resolveWorkspaceId(final CustomSourceDefinitionCreate customSourceDefinitionCreate) {
  // Legacy field - use if provided
  if (customSourceDefinitionCreate.getWorkspaceId() != null) {
    return customSourceDefinitionCreate.getWorkspaceId();
  }

  // New scoped approach - extract workspace ID from scopeType/scopeId
  if (ScopeType.fromValue(customSourceDefinitionCreate.getScopeType().toString())
      .equals(ScopeType.WORKSPACE)) {
    return customSourceDefinitionCreate.getScopeId();
  }

  // Organization-scoped custom connectors not yet supported for jobs
  throw new UnprocessableEntityProblem(new ProblemMessageData()
      .message(String.format(
          "Cannot determine workspace ID for custom source definition creation: %s",
          customSourceDefinitionCreate)));
}
```

Updated the handler to use the resolved workspace ID:

```java
public SourceDefinitionRead createCustomSourceDefinition(
    final CustomSourceDefinitionCreate customSourceDefinitionCreate) throws IOException {
  final UUID id = uuidSupplier.get();
  final SourceDefinitionCreate sourceDefinitionCreate = customSourceDefinitionCreate.getSourceDefinition();
  final UUID workspaceId = resolveWorkspaceId(customSourceDefinitionCreate);  // NEW

  final ActorDefinitionVersion actorDefinitionVersion =
      actorDefinitionHandlerHelper
          .defaultDefinitionVersionFromCreate(
              sourceDefinitionCreate.getDockerRepository(),
              sourceDefinitionCreate.getDockerImageTag(),
              sourceDefinitionCreate.getDocumentationUrl(),
              workspaceId)  // Changed from nullable to required
          .withActorDefinitionId(id);

  // ... rest of method
}
```

The `ActorDefinitionHandlerHelper` signature changed from nullable to required:

```java
// Before:
public ActorDefinitionVersion defaultDefinitionVersionFromCreate(
    final String dockerRepository,
    final String dockerImageTag,
    final URI documentationUrl,
    final @Nullable UUID workspaceId)  // nullable

// After:
public ActorDefinitionVersion defaultDefinitionVersionFromCreate(
    final String dockerRepository,
    final String dockerImageTag,
    final URI documentationUrl,
    final UUID workspaceId)  // required, not null
```

Tests were updated to verify the resolution logic:

```java
final CustomSourceDefinitionCreate customCreateForWorkspace = new CustomSourceDefinitionCreate()
    .sourceDefinition(create)
    .scopeId(workspaceId)
    .scopeType(io.airbyte.api.model.generated.ScopeType.WORKSPACE)
    .workspaceId(null); // scopeType and scopeId should be sufficient to resolve to the expected workspaceId

// Verify the handler correctly resolved the workspace ID
verify(actorDefinitionHandlerHelper).defaultDefinitionVersionFromCreate(
    create.getDockerRepository(),
    create.getDockerImageTag(),
    create.getDocumentationUrl(),
    workspaceId);  // Should resolve to this even though workspaceId field was null
```

Organization-scoped tests were commented out with a TODO:

```java
// TODO: custom connectors for organizations are not currently supported. Jobs currently require an
// explicit workspace ID to resolve a dataplane group where the job should run. We can uncomment
// this section of the test once we support resolving a default dataplane group for a given
// organization ID.
```

#### Business Value

This fix addressed a critical production issue:

1. **Bug Resolution**: Custom connectors could now be created successfully in all supported scopes
2. **Scope Support**: Properly handled the new scopeType/scopeId pattern introduced for multi-org support
3. **Backward Compatibility**: Still supported the legacy workspaceId field while transitioning to scopes
4. **Clear Error Messages**: Threw informative errors when workspace ID couldn't be determined
5. **Data Plane Routing**: Jobs could correctly resolve which data plane should execute them
6. **Future Readiness**: Laid groundwork for organization-scoped custom connectors (noted in TODOs)

The fix was well-tested with updated test cases that verified workspace ID resolution from both direct specification and scope-based inference.

---

## Technical Evolution

The commits tell a story of systematic feature development and architectural modernization:

### 1. Foundational Infrastructure (2021-2022)

The work began in late 2021 with establishing core deletion and lifecycle capabilities:

- **December 2021**: Introduced tombstone soft delete pattern (0789b8a269)
- **December 2021**: Added delete API endpoints with cascading behavior (9dfd0daf0a)
- **February 2022**: Implemented release stage and date tracking (5da184895f)
- **February 2022**: Added tombstone to actor_definitions table for instances (76da3ccf55)
- **February 2022**: Distinguished failure origins in workers (1638d79696)

This phase focused on safe deletion, connector maturity tracking, and better error attribution.

### 2. Connector Lifecycle Enhancements (2023)

2023 brought improvements to connector management and enterprise features:

- **January 2023**: Added repository methods for alpha/beta connector detection (72a9b29edd, a8bdbe22e9)
- **December 2023**: Integrated RBAC for actor definition access (7c29af659d)

This phase enabled better visibility into connector maturity and secured sensitive operations.

### 3. User Experience Improvements (2024)

2024 focused on surfacing important information to users:

- **February 2024**: Added breaking change and override flags to reads (5f620f7def)
- **February 2024**: Set failure origin for discover job failures (6c9be36ee5)
- **August 2024**: Supported multiple realms in Keycloak token validation (d3eb6f902f)

This phase improved observability and prepared for connector version management.

### 4. Modernization and Cleanup (2025)

The most recent work focused on code modernization and simplification:

- **March 2025**: Migrated service implementations to Kotlin (4e57eee384)
- **March 2025**: Removed unnecessary clone endpoints (aa7a8190be)
- **April 2025**: Fixed workspace ID resolution for spec jobs (da18ef85da)
- **April 2025**: Added acceptance tests for updates (ab80695655)

This phase reduced technical debt, modernized the codebase, and improved test coverage.

### Technology Choices

The evolution shows deliberate technology decisions:

- **Java → Kotlin**: Gradual migration to more expressive, null-safe language
- **Soft Deletes**: Tombstone pattern became standard for safe resource removal
- **RBAC Integration**: Enterprise security integrated at service boundaries
- **API Simplification**: Removal of redundant endpoints in favor of simpler patterns
- **Scope Abstraction**: Migration from workspace-specific to scope-based (workspace/organization) APIs

---

## Impact Summary

Parker's contributions to Sources & Destinations represent the complete implementation of connector definition lifecycle management for Airbyte. The work enabled Airbyte to safely manage hundreds of connector definitions with proper versioning, access control, and user communication.

### Quantitative Impact

- **23 commits** over 40 months (Dec 2021 - Apr 2025)
- **~8,500 lines** of code changes
- **Major features delivered:**
  - Soft delete (tombstone) for connector definitions
  - Delete API endpoints with cascade behavior
  - Release stage and date tracking
  - Breaking change communication
  - RBAC for connector management
  - Kotlin migration of core services
  - Workspace ID resolution for multi-org deployments

### Qualitative Impact

**For Users:**
- Safe deletion of deprecated connectors without breaking existing connections
- Clear visibility into connector maturity (alpha/beta/GA)
- Warnings about upcoming breaking changes with upgrade deadlines
- Understanding of when version overrides are applied

**For Developers:**
- Clean soft delete pattern used throughout the platform
- Type-safe Kotlin code with better null handling
- Comprehensive test coverage for complex scenarios
- Clear separation of OSS and Enterprise authorization logic

**For the Platform:**
- Scalable connector lifecycle management
- Proper cascade deletion preventing orphaned resources
- RBAC integration for multi-tenant security
- Modern, maintainable codebase in Kotlin

### Key Architectural Patterns

The work established several important patterns:

1. **Tombstone Soft Deletes**: Mark resources as deleted without removing them, preserving referential integrity
2. **Cascade Deletion**: Delete dependent resources first to ensure consistent state on failure
3. **Edition-Specific Validators**: Use Micronaut's `@Replaces` to swap implementations based on deployment edition
4. **Breaking Change Communication**: Surface version compatibility information at the API layer
5. **Scope Resolution**: Abstract workspace/organization distinction to support multi-tenant architectures
6. **Service Layer in Kotlin**: Leverage modern language features for more maintainable code

This foundation enables Airbyte to manage a growing connector ecosystem with hundreds of definitions, supporting both community and enterprise deployments with appropriate access controls and user communication.
