# Kubernetes Pod Management

## Overview
- **Time Period:** February - March 2022 (~5 weeks)
- **Lines of Code:** ~600 additions
- **Files Changed:** 15 files
- **Key Technologies:** Kubernetes, Java, Docker, Helm

One-paragraph summary: Enhanced Kubernetes pod management for connector execution including init container timeouts, per-job-type pod configuration, and improved pod lifecycle handling. These changes improved reliability and debuggability of connector pods running in Kubernetes environments.

## Problem Statement
Running connectors in Kubernetes pods presented challenges:
- Init containers could hang indefinitely without timeouts
- All job types used the same pod configuration regardless of requirements
- Pod state debugging was difficult when issues occurred
- Cleanup of orphaned pods was unreliable

## Solution Architecture
Implemented targeted improvements:

1. **Init Container Timeouts** - Prevent indefinite hangs during pod initialization
2. **Per-Job-Type Configuration** - Different pod specs for different job types
3. **Enhanced Logging** - Better visibility into pod state during failures
4. **Pod Cleanup** - Connection-based pod identification for cleanup

## Implementation Details

### Init Container Timeout

```java
// Add timeout to init container command to prevent hangs
public class KubePodProcess {
  private static final Duration INIT_CONTAINER_TIMEOUT = Duration.ofMinutes(5);

  private Container createInitContainer() {
    return new ContainerBuilder()
        .withName("init")
        .withImage(initImage)
        .withCommand("/bin/sh", "-c",
            String.format("timeout %d cp /config/* /shared/",
                INIT_CONTAINER_TIMEOUT.toSeconds()))
        .build();
  }
}
```

### Per-Job-Type Pod Configuration

```java
public class KubePodProcessFactory {
  public KubePodProcess create(
      JobType jobType,
      ResourceRequirements resourceRequirements) {

    // Different configurations based on job type
    PodSpec spec = switch (jobType) {
      case SYNC -> createSyncPodSpec(resourceRequirements);
      case CHECK -> createCheckPodSpec();  // Lightweight
      case DISCOVER -> createDiscoverPodSpec();
      case SPEC -> createSpecPodSpec();  // Minimal resources
    };

    return new KubePodProcess(spec);
  }

  private PodSpec createSyncPodSpec(ResourceRequirements reqs) {
    return new PodSpecBuilder()
        .withContainers(createConnectorContainer(reqs))
        .withVolumes(createSharedVolumes())
        .withRestartPolicy("Never")
        .build();
  }
}
```

### Pod State Logging for Debugging

```java
// Log pod state when init container times out
private void logPodStateOnTimeout(Pod pod) {
  log.warn("Init pod wait condition timed out for pod: {}", pod.getMetadata().getName());

  PodStatus status = pod.getStatus();
  log.warn("Pod phase: {}", status.getPhase());
  log.warn("Pod conditions: {}", status.getConditions());

  for (ContainerStatus cs : status.getInitContainerStatuses()) {
    log.warn("Init container {} state: {}", cs.getName(), cs.getState());
    if (cs.getState().getWaiting() != null) {
      log.warn("  Waiting reason: {}", cs.getState().getWaiting().getReason());
    }
  }
}
```

### Connection-Based Pod Cleanup

```java
// Find pods to kill based on Connection ID instead of worker processId
public List<Pod> findPodsToCleanup(UUID connectionId) {
  return kubernetesClient.pods()
      .inNamespace(namespace)
      .withLabel("connection_id", connectionId.toString())
      .withLabel("status", "running")
      .list()
      .getItems()
      .stream()
      .filter(this::isNonTerminal)
      .collect(Collectors.toList());
}

private boolean isNonTerminal(Pod pod) {
  String phase = pod.getStatus().getPhase();
  return !phase.equals("Succeeded") && !phase.equals("Failed");
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [34be57c4c1](https://github.com/airbytehq/airbyte-platform/commit/34be57c4c1) | Feb 23, 2022 | Add timeout to connector pod init container command | Prevent hangs |
| [b742a451a0](https://github.com/airbytehq/airbyte-platform/commit/b742a451a0) | Feb 15, 2022 | Configure kube pod process per job type | Per-job config |
| [2157b47b60](https://github.com/airbytehq/airbyte-platform/commit/2157b47b60) | Feb 24, 2022 | Log pod state if init pod wait condition times out | Debug logging |
| [0b1a75def0](https://github.com/airbytehq/airbyte-platform/commit/0b1a75def0) | Jun 22, 2023 | Find non-terminal running pods to kill based on Connection ID | Pod cleanup |

## Business Value

### Reliability Impact
- **No More Hung Pods**: Init containers fail fast instead of hanging
- **Predictable Resources**: Job types get appropriate resource allocation
- **Clean Shutdown**: Orphaned pods cleaned up reliably

### Operational Impact
- **Faster Debugging**: Pod state logged on failures
- **Resource Efficiency**: Check/Spec jobs use minimal resources
- **Cluster Health**: No accumulation of zombie pods

### Technical Impact
- **Timeout Patterns**: Established pattern for init container timeouts
- **Configuration Flexibility**: Per-job-type customization possible
- **Label-Based Management**: Connection ID labels enable targeted operations

## Lessons Learned

### Init Container Timeouts
Shell timeout command is more reliable than Kubernetes-level timeouts:
```bash
# Preferred: explicit timeout in command
timeout 300 cp /config/* /shared/

# vs relying on Kubernetes activeDeadlineSeconds
```

### Label Strategy
Using connection_id labels enables efficient queries:
```java
// Good: find by connection
.withLabel("connection_id", connectionId.toString())

// Bad: scan all pods and filter
.list().stream().filter(p -> matchesConnection(p, connectionId))
```
