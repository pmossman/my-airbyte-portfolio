# Multi-Region Geography Support

## Overview
- **Time Period:** August - November 2022 (~4 months)
- **Lines of Code:** ~1,500 additions
- **Files Changed:** 30+ files
- **Key Technologies:** Java, PostgreSQL, REST API

One-paragraph summary: Implemented multi-region geography support enabling workspaces and connections to be assigned to specific geographic regions (US, EU, etc.). This was foundational infrastructure for data residency compliance and multi-cloud deployments.

## Problem Statement
Enterprise customers required:
- Data residency compliance (GDPR, etc.)
- Ability to specify where their data syncs execute
- Workspace and connection-level geography settings
- API support for geography management

## Solution Architecture
Built a comprehensive geography system:

1. **Geography Enum** - Defined supported regions
2. **Workspace Geography** - Default geography for new connections
3. **Connection Geography** - Per-connection override capability
4. **Router Service** - Route syncs to appropriate regional infrastructure

## Implementation Details

### Geography Enum Definition

```java
public enum Geography {
  AUTO("auto"),      // Let platform decide
  US("us"),          // United States
  EU("eu");          // European Union

  private final String value;

  Geography(String value) {
    this.value = value;
  }

  public static Geography fromValue(String value) {
    return Arrays.stream(values())
        .filter(g -> g.value.equals(value))
        .findFirst()
        .orElse(AUTO);
  }
}
```

### Workspace Geography Support

```java
// Add geography to workspace
public class Workspace {
  private UUID workspaceId;
  private String name;
  private Geography geography;  // New field

  // Migration
  // ALTER TABLE workspace ADD COLUMN geography VARCHAR(10) DEFAULT 'auto';
}

// API endpoint
@POST
@Path("/workspaces/update_geography")
public WorkspaceRead updateWorkspaceGeography(
    @RequestBody WorkspaceGeographyUpdate update) {

  workspaceService.setGeography(
      update.getWorkspaceId(),
      update.getGeography()
  );

  return workspaceService.getWorkspace(update.getWorkspaceId());
}
```

### Connection Geography Support

```java
// Connection inherits from workspace but can override
public class Connection {
  private UUID connectionId;
  private UUID workspaceId;
  private Geography geography;  // null = inherit from workspace

  public Geography getEffectiveGeography() {
    if (geography != null) {
      return geography;
    }
    return workspaceService.getWorkspace(workspaceId).getGeography();
  }
}

// API for setting connection geography
@POST
@Path("/connections/update")
public ConnectionRead updateConnection(
    @RequestBody ConnectionUpdate update) {

  if (update.getGeography() != null) {
    connectionService.setGeography(
        update.getConnectionId(),
        update.getGeography()
    );
  }
  // ... other updates
}
```

### Router Service Integration

```java
@Singleton
public class RouterService {
  private final Map<Geography, String> regionEndpoints;

  public RouterService(GeographyConfig config) {
    this.regionEndpoints = Map.of(
        Geography.US, config.getUsEndpoint(),
        Geography.EU, config.getEuEndpoint()
    );
  }

  public String getEndpointForConnection(UUID connectionId) {
    Geography geo = connectionService
        .getConnection(connectionId)
        .getEffectiveGeography();

    if (geo == Geography.AUTO) {
      geo = determineOptimalRegion(connectionId);
    }

    return regionEndpoints.get(geo);
  }

  private Geography determineOptimalRegion(UUID connectionId) {
    // Logic to determine best region based on source/destination locations
    return Geography.US;  // Default
  }
}
```

### API Response Enhancement

```java
// Include geography in API responses
public ConnectionRead toConnectionRead(Connection conn) {
  return new ConnectionRead()
      .connectionId(conn.getConnectionId())
      .name(conn.getName())
      .geography(conn.getGeography())
      // ... other fields
      ;
}

public WorkspaceRead toWorkspaceRead(Workspace ws) {
  return new WorkspaceRead()
      .workspaceId(ws.getWorkspaceId())
      .name(ws.getName())
      .geography(ws.getGeography())
      // ... other fields
      ;
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [614ebb615d](https://github.com/airbytehq/airbyte-platform/commit/614ebb615d) | Aug 26, 2022 | Multi-Cloud MVP: Combined branch for testing and merge | Foundation |
| [fb9efb378d](https://github.com/airbytehq/airbyte-platform/commit/fb9efb378d) | Oct 10, 2022 | Add Workspace and Connection Geography Support to API | API support |
| [4e236b5b42](https://github.com/airbytehq/airbyte-platform/commit/4e236b5b42) | Oct 20, 2022 | Add Geography support to RouterService | Routing logic |
| [5d4b564389](https://github.com/airbytehq/airbyte-platform/commit/5d4b564389) | Oct 26, 2022 | Persist geography updates | Persistence |

## Business Value

### Compliance Impact
- **Data Residency**: Customers can ensure data stays in specific regions
- **GDPR Compliance**: EU data can be processed in EU
- **Audit Trail**: Geography settings are tracked and auditable

### Customer Impact
- **Enterprise Enablement**: Unlocks enterprise customers with geo requirements
- **Self-Service**: Customers can configure geography themselves
- **Flexibility**: Override at connection level when needed

### Technical Impact
- **Multi-Cloud Foundation**: Enables regional deployments
- **Routing Infrastructure**: Clean separation of routing logic
- **Extensible**: Easy to add new regions (APAC, etc.)

## Lessons Learned

### Inheritance Pattern
Connection geography inheriting from workspace with override capability:
```java
// Workspace sets default
workspace.setGeography(Geography.EU);

// Connections inherit unless overridden
connection.getEffectiveGeography();  // Returns EU

// Override for specific connection
connection.setGeography(Geography.US);
connection.getEffectiveGeography();  // Returns US
```

### Migration Strategy
Adding geography with sensible defaults:
```sql
-- Default to AUTO for existing data
ALTER TABLE workspace
  ADD COLUMN geography VARCHAR(10) DEFAULT 'auto';

-- Connections default to null (inherit)
ALTER TABLE connection
  ADD COLUMN geography VARCHAR(10) DEFAULT NULL;
```
