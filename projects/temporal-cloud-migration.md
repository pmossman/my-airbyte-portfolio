# Temporal Cloud Migration

## Overview
- **Time Period:** June 2022 (~2 weeks)
- **Lines of Code:** ~350 additions
- **Files Changed:** 10 files
- **Key Technologies:** Temporal, Java, SSL/TLS, Certificate Authentication

One-paragraph summary: Migrated Airbyte's workflow orchestration from self-hosted Temporal to Temporal Cloud, introducing dual-mode configuration that supports both cloud and self-hosted deployments. Includes SSL/TLS certificate authentication for secure cloud connections and graceful workflow state recovery.

## Problem Statement
Self-hosted Temporal required significant operational overhead:
- Infrastructure management and monitoring
- Scaling for workflow execution
- High availability configuration
- Certificate rotation and security

Temporal Cloud offered managed service benefits but required architectural changes to support both deployment modes.

## Solution Architecture
Designed a dual-mode Temporal client configuration:

1. **Cloud Mode** - SSL/TLS certificate authentication to Temporal Cloud
2. **Self-Hosted Mode** - Direct connection to Temporal server
3. **Namespace Management** - Cloud vs default namespace handling
4. **Workflow Recovery** - Handle unreachable workflow states

Key design decisions:
- **Configuration-driven** - Mode selected by environment variables
- **SSL/TLS certificates** - PKCS8 format for cloud authentication
- **Namespace-aware** - Different namespace handling per mode
- **Graceful degradation** - Recovery from workflow state mismatches

## Implementation Details

### Dual-Mode Client Configuration

```java
public static WorkflowServiceStubs createTemporalService(
    final boolean isCloud) {
  final WorkflowServiceStubsOptions options = isCloud
      ? getCloudTemporalOptions()
      : getAirbyteTemporalOptions(configs.getTemporalHost());

  final String namespace = isCloud
      ? configs.getTemporalCloudNamespace()
      : DEFAULT_NAMESPACE;

  return createTemporalService(options, namespace);
}

private static WorkflowServiceStubsOptions getCloudTemporalOptions() {
  final InputStream clientCert = new ByteArrayInputStream(
      configs.getTemporalCloudClientCert().getBytes(StandardCharsets.UTF_8));
  final InputStream clientKey = new ByteArrayInputStream(
      configs.getTemporalCloudClientKey().getBytes(StandardCharsets.UTF_8));

  try {
    return WorkflowServiceStubsOptions.newBuilder()
        .setSslContext(SimpleSslContextBuilder
            .forPKCS8(clientCert, clientKey)
            .build())
        .setTarget(configs.getTemporalCloudHost())
        .build();
  } catch (final SSLException e) {
    log.error("SSL Exception attempting to establish Temporal Cloud options.");
    throw new RuntimeException(e);
  }
}

@VisibleForTesting
public static WorkflowServiceStubsOptions getAirbyteTemporalOptions(
    final String temporalHost) {
  return WorkflowServiceStubsOptions.newBuilder()
      .setTarget(temporalHost)
      .build();
}
```

### Namespace-Aware Connection

```java
protected static NamespaceInfo getNamespaceInfo(
    final WorkflowServiceStubs temporalService,
    final String namespace) {
  return temporalService.blockingStub()
      .describeNamespace(DescribeNamespaceRequest.newBuilder()
          .setNamespace(namespace)
          .build())
      .getNamespaceInfo();
}

public static void waitForTemporalServerAndLog(
    final WorkflowServiceStubs temporalService,
    final String namespace) {
  log.info("Waiting for Temporal server with namespace {}...", namespace);

  boolean serverIsReady = false;
  while (!serverIsReady) {
    try {
      final NamespaceInfo namespaceInfo = getNamespaceInfo(temporalService, namespace);
      log.info("Temporal server ready. Namespace: {}", namespaceInfo.getName());
      serverIsReady = true;
    } catch (final StatusRuntimeException e) {
      log.warn("Temporal server not ready yet: {}", e.getMessage());
      sleep(1000);
    }
  }
}
```

### Workflow State Recovery

Handle workflows that become unreachable:

```java
public void update(final UUID connectionId) {
  final boolean workflowReachable = isWorkflowReachable(
      getConnectionManagerName(connectionId));

  if (!workflowReachable) {
    // Workflow unreachable - create a new one
    submitConnectionUpdaterAsync(connectionId);
  } else {
    final ConnectionManagerWorkflow connectionManagerWorkflow =
        getConnectionUpdateWorkflow(connectionId);
    connectionManagerWorkflow.connectionUpdated();
  }
}

private boolean isWorkflowReachable(final String workflowName) {
  try {
    final WorkflowExecution execution = WorkflowExecution.newBuilder()
        .setWorkflowId(workflowName)
        .build();

    service.blockingStub().describeWorkflowExecution(
        DescribeWorkflowExecutionRequest.newBuilder()
            .setNamespace(namespace)
            .setExecution(execution)
            .build()
    );
    return true;
  } catch (final StatusRuntimeException e) {
    if (e.getStatus().getCode() == Status.Code.NOT_FOUND) {
      return false;
    }
    throw e;
  }
}
```

### Configuration Environment Variables

```java
// Cloud configuration
TEMPORAL_CLOUD_ENABLED = "true"
TEMPORAL_CLOUD_HOST = "your-namespace.tmprl.cloud:7233"
TEMPORAL_CLOUD_NAMESPACE = "your-namespace.your-account-id"
TEMPORAL_CLOUD_CLIENT_CERT = "-----BEGIN CERTIFICATE-----..."
TEMPORAL_CLOUD_CLIENT_KEY = "-----BEGIN PRIVATE KEY-----..."

// Self-hosted configuration
TEMPORAL_HOST = "temporal:7233"
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| 9403c28b50 | Jun 21, 2022 | Temporal Cloud migration with SSL/TLS | 10 files, 223 insertions |
| 84436b01a0 | Apr 8, 2022 | Workflow state recovery | 3 files, 126 insertions |
| 884a94ed29 | Apr 8, 2022 | OSS branch build for Cloud | Build infrastructure |

## Business Value

### User Impact
- **Reliability**: Managed service provides better uptime guarantees
- **Scalability**: Temporal Cloud scales automatically
- **No Maintenance**: Users don't need to manage Temporal infrastructure

### Business Impact
- **Reduced Ops Cost**: Eliminated self-hosted Temporal management
- **Enterprise SLAs**: Temporal Cloud provides enterprise-grade guarantees
- **Focus on Core**: Engineering can focus on product, not infrastructure

### Technical Impact
- **Dual-Mode Support**: Same codebase works with cloud or self-hosted
- **Certificate Auth**: Secure mTLS authentication to Temporal Cloud
- **Self-Healing**: Automatic workflow recovery from state mismatches

## Lessons Learned / Patterns Used

### Configuration-Driven Mode Selection
Single boolean switches between modes:
```java
final boolean isCloud = configs.isTemporalCloudEnabled();
final WorkflowServiceStubsOptions options = isCloud
    ? getCloudTemporalOptions()
    : getAirbyteTemporalOptions(temporalHost);
```

### Graceful Workflow Recovery
Check reachability before signaling:
```java
if (!isWorkflowReachable(workflowId)) {
  // Create new workflow instead of failing
  submitConnectionUpdaterAsync(connectionId);
}
```
This pattern handles cases where:
- Workflow completed but database still references it
- Workflow terminated by Temporal cleanup
- Network partition lost workflow state

### mTLS for Cloud Authentication
PKCS8 format for certificate/key pair:
```java
SimpleSslContextBuilder.forPKCS8(clientCert, clientKey).build()
```
This provides mutual TLS authentication - both Airbyte and Temporal Cloud verify each other's identity.
