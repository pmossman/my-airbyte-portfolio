# API Performance Optimization

## Overview
- **Time Period:** September 2022 (~3 weeks)
- **Lines of Code:** ~500 additions
- **Files Changed:** 12 files
- **Key Technologies:** Java, PostgreSQL, REST API

One-paragraph summary: Optimized critical API endpoints that were causing performance issues at scale. Introduced efficient database queries, lightweight API endpoints, and removed unnecessary data fetching to dramatically improve response times for connection listing and job retrieval.

## Problem Statement
As customer usage grew, several API endpoints became bottlenecks:
- Connection list endpoints fetched excessive data
- Job endpoints loaded all attempt data even when not needed
- Web backend made redundant database calls
- Catalog data was fetched even when not displayed

## Solution Architecture
Targeted optimizations:

1. **Efficient Queries** - Optimized SQL for connection listing
2. **Lightweight Endpoints** - New endpoints returning minimal data
3. **Selective Fetching** - Only load data that's actually needed
4. **Query Consolidation** - Reduce round-trips to database

## Implementation Details

### Efficient Connection List Query

```java
// Before: N+1 query problem
public List<ConnectionRead> listConnections(UUID workspaceId) {
  List<Connection> connections = connectionRepo.findByWorkspace(workspaceId);
  return connections.stream()
      .map(c -> {
        // Each connection triggers additional queries
        Source source = sourceRepo.findById(c.getSourceId());
        Destination dest = destRepo.findById(c.getDestinationId());
        return buildConnectionRead(c, source, dest);
      })
      .toList();
}

// After: Single efficient query with joins
public List<ConnectionRead> listConnections(UUID workspaceId) {
  return connectionRepo.findByWorkspaceWithSourceAndDestination(workspaceId)
      .stream()
      .map(this::toConnectionRead)
      .toList();
}

// Efficient JOOQ query
public List<ConnectionWithSourceDest> findByWorkspaceWithSourceAndDestination(
    UUID workspaceId) {
  return ctx.select(
          CONNECTION.asterisk(),
          SOURCE.NAME.as("source_name"),
          DESTINATION.NAME.as("destination_name"))
      .from(CONNECTION)
      .join(SOURCE).on(CONNECTION.SOURCE_ID.eq(SOURCE.ID))
      .join(DESTINATION).on(CONNECTION.DESTINATION_ID.eq(DESTINATION.ID))
      .where(CONNECTION.WORKSPACE_ID.eq(workspaceId))
      .fetchInto(ConnectionWithSourceDest.class);
}
```

### Lightweight Job Endpoint

```java
// New lightweight endpoint that excludes attempt details
@GET
@Path("/jobs/get_light")
public JobInfoLight getJobLight(@QueryParam("id") long jobId) {
  Job job = jobPersistence.getJob(jobId);

  // Return job info without loading all attempts
  return new JobInfoLight()
      .job(new JobRead()
          .id(job.getId())
          .status(job.getStatus())
          .createdAt(job.getCreatedAt())
          .updatedAt(job.getUpdatedAt()))
      // Deliberately excludes: attempts, logs, full config
      ;
}

// vs full endpoint that loads everything
@GET
@Path("/jobs/get")
public JobInfoRead getJob(@QueryParam("id") long jobId) {
  Job job = jobPersistence.getJob(jobId);
  List<Attempt> attempts = attemptRepo.findByJobId(jobId);  // Expensive

  return new JobInfoRead()
      .job(toJobRead(job))
      .attempts(attempts.stream().map(this::toAttemptRead).toList());
}
```

### Remove Catalog from Connection List

```java
// Before: Catalog fetched but not displayed in list view
public WebBackendConnectionReadList listConnectionsForWorkspace(
    UUID workspaceId) {
  return connections.stream()
      .map(c -> {
        // Catalog is large and not needed for list view
        Catalog catalog = catalogRepo.findByConnection(c.getId());
        return buildFullRead(c, catalog);
      })
      .toList();
}

// After: Skip catalog for list endpoint
public WebBackendConnectionReadList listConnectionsForWorkspace(
    UUID workspaceId) {
  return connections.stream()
      .map(this::buildListRead)  // No catalog
      .toList();
}

// Detail endpoint still includes catalog
public WebBackendConnectionRead getConnection(UUID connectionId) {
  Connection c = connectionRepo.findById(connectionId);
  Catalog catalog = catalogRepo.findByConnection(connectionId);
  return buildFullRead(c, catalog);
}
```

### Optimized WebBackend Read

```java
// Rewrite to avoid fetching all jobs
public WebBackendConnectionRead buildWebBackendConnectionRead(
    UUID connectionId) {

  Connection connection = connectionRepo.findById(connectionId);

  // Only fetch latest job, not all historical jobs
  Optional<Job> latestJob = jobRepo.findLatestByConnection(connectionId);

  // Only fetch latest sync job for sync status
  Optional<Job> latestSyncJob = jobRepo.findLatestSyncByConnection(connectionId);

  return new WebBackendConnectionRead()
      .connectionId(connectionId)
      .status(connection.getStatus())
      .latestSyncJobStatus(latestSyncJob.map(Job::getStatus).orElse(null))
      .latestSyncJobCreatedAt(latestSyncJob.map(Job::getCreatedAt).orElse(null))
      // ... other fields
      ;
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [39a14b7306](https://github.com/airbytehq/airbyte-platform/commit/39a14b7306) | Oct 10, 2022 | Efficient queries for connection list | Query optimization |
| [07c5f13d5a](https://github.com/airbytehq/airbyte-platform/commit/07c5f13d5a) | Sep 16, 2022 | Rewrite buildWebBackendConnectionRead to avoid fetching all jobs | Reduce fetching |
| [1d29672122](https://github.com/airbytehq/airbyte-platform/commit/1d29672122) | Sep 13, 2022 | Add jobInfoLight API endpoint that excludes attempt information | Lightweight endpoint |
| [a8c72121f8](https://github.com/airbytehq/airbyte-platform/commit/a8c72121f8) | Sep 28, 2022 | Remove catalog from web_backend/connections/list | Remove unused data |

## Business Value

### Performance Impact
- **Faster List Views**: Connection list loads in milliseconds instead of seconds
- **Reduced Database Load**: Fewer queries, less data transferred
- **Better Scalability**: Endpoints scale with customer growth

### User Experience
- **Snappier UI**: List pages load quickly
- **Less Waiting**: Job status checks are instant
- **Smoother Navigation**: Moving between pages feels responsive

### Technical Impact
- **Query Efficiency**: Eliminated N+1 problems
- **Endpoint Design**: Pattern for light vs full endpoints
- **Selective Loading**: Only fetch what's needed

## Lessons Learned

### Light vs Full Endpoints
Having both versions enables UI optimization:
```java
// List view uses light endpoint
GET /jobs/list_light  // Fast, minimal data

// Detail view uses full endpoint
GET /jobs/get         // Complete data when needed
```

### Eager vs Lazy Loading
Don't load nested data unless requested:
```java
// Bad: Always load everything
connection.getCatalog();  // Expensive, often unused

// Good: Load on demand
if (includeDetails) {
  connection.loadCatalog();
}
```
