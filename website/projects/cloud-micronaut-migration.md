# Cloud Micronaut Migration

## Overview
- **Time Period:** May 2023 (~3 weeks)
- **Lines of Code:** ~2,000 additions
- **Files Changed:** 40+ files
- **Key Technologies:** Java, Micronaut, Gradle

One-paragraph summary: Migrated the Cloud Server application from a legacy framework to Micronaut, enabling modern dependency injection, improved startup time, and alignment with the OSS server architecture. This migration required careful coordination due to the critical nature of the cloud infrastructure.

## Problem Statement
The Cloud Server was running on older infrastructure that:
- Had slower startup times
- Used different patterns than the OSS server
- Made code sharing between Cloud and OSS difficult
- Lacked modern dependency injection capabilities

## Solution Architecture
Careful migration approach:

1. **Framework Migration** - Move to Micronaut framework
2. **Dependency Injection** - Adopt Micronaut DI patterns
3. **Configuration** - Align with Micronaut configuration system
4. **Rollback Safety** - Multiple reverts to ensure stability

## Implementation Details

### Micronaut Application Setup

```java
@MicronautApplication
public class CloudServerApplication {
  public static void main(String[] args) {
    Micronaut.build(args)
        .mainClass(CloudServerApplication.class)
        .banner(false)
        .start();
  }
}
```

### Controller Migration

```java
// Before: Custom framework annotations
@CloudController("/api/v1/connections")
public class ConnectionController {
  private final ConnectionService connectionService;

  public ConnectionController(ConnectionService connectionService) {
    this.connectionService = connectionService;
  }

  @CloudGet
  public List<ConnectionRead> list() {
    return connectionService.listConnections();
  }
}

// After: Micronaut annotations
@Controller("/api/v1/connections")
public class ConnectionController {
  private final ConnectionService connectionService;

  @Inject
  public ConnectionController(ConnectionService connectionService) {
    this.connectionService = connectionService;
  }

  @Get
  public List<ConnectionRead> list() {
    return connectionService.listConnections();
  }
}
```

### Service Layer Migration

```java
// Micronaut singleton services
@Singleton
public class CloudConnectionService implements ConnectionService {
  private final ConnectionRepository connectionRepository;
  private final WorkspaceService workspaceService;

  @Inject
  public CloudConnectionService(
      ConnectionRepository connectionRepository,
      WorkspaceService workspaceService) {
    this.connectionRepository = connectionRepository;
    this.workspaceService = workspaceService;
  }

  @Override
  public List<ConnectionRead> listConnections() {
    // Implementation
  }
}
```

### Configuration Migration

```yaml
# application.yml - Micronaut configuration
micronaut:
  application:
    name: cloud-server
  server:
    port: 8001

airbyte:
  cloud:
    billing-enabled: true
    auth-provider: firebase

datasources:
  default:
    url: ${DATABASE_URL}
    driver-class-name: org.postgresql.Driver
```

### Gradle Build Configuration

```groovy
plugins {
    id "io.micronaut.application" version "3.7.0"
}

dependencies {
    implementation "io.micronaut:micronaut-inject"
    implementation "io.micronaut:micronaut-runtime"
    implementation "io.micronaut:micronaut-http-server-netty"

    // Shared modules
    implementation project(":airbyte-api")
    implementation project(":airbyte-config:config-persistence")
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [a6ffc51ec6](https://github.com/airbytehq/airbyte-platform/commit/a6ffc51ec6) | May 10, 2023 | Migrate Cloud-Server to Micronaut (All changes together) | Full migration |
| [20330b8d47](https://github.com/airbytehq/airbyte-platform/commit/20330b8d47) | May 10, 2023 | Revert "Migrate Cloud-Server to Micronaut" | Rollback #1 |
| [cb46216af1](https://github.com/airbytehq/airbyte-platform/commit/cb46216af1) | May 11, 2023 | Parker/un revert cloud micronaut | Re-apply |
| [ae03b53894](https://github.com/airbytehq/airbyte-platform/commit/ae03b53894) | May 12, 2023 | Revert "Parker/un revert cloud micronaut" | Rollback #2 |
| [b64423913e](https://github.com/airbytehq/airbyte-platform/commit/b64423913e) | May 12, 2023 | Parker/again unrevert cloud server micronaut | Final re-apply |

## Business Value

### Technical Impact
- **Faster Startup**: Micronaut's AOT compilation reduces startup time
- **Code Sharing**: Aligned patterns enable sharing between Cloud and OSS
- **Modern DI**: Constructor injection and singleton management

### Operational Impact
- **Deployment Speed**: Faster rollouts due to quicker startup
- **Resource Efficiency**: Lower memory footprint
- **Maintainability**: Consistent patterns across codebase

### Developer Impact
- **Familiar Patterns**: Standard DI patterns developers know
- **Better Testing**: Easier to mock dependencies
- **IDE Support**: Full Micronaut tooling support

## Lessons Learned

### Careful Rollout Strategy
Critical infrastructure requires careful migration:
```
1. Merge migration
2. Monitor for issues
3. Revert if problems found
4. Fix issues
5. Re-apply with fixes
6. Repeat until stable
```

### Feature Parity Verification
Ensure all endpoints work identically:
```java
@Test
void migratedEndpointBehavesIdentically() {
  // Test each endpoint returns same response
  var legacyResponse = legacyClient.getConnections();
  var micronautResponse = micronautClient.getConnections();
  assertThat(micronautResponse).isEqualTo(legacyResponse);
}
```

### Dependency Injection Patterns
Prefer constructor injection:
```java
// Good: Constructor injection (testable)
@Singleton
public class MyService {
  private final Dependency dep;

  @Inject
  public MyService(Dependency dep) {
    this.dep = dep;
  }
}

// Avoid: Field injection (harder to test)
@Singleton
public class MyService {
  @Inject
  private Dependency dep;
}
```
