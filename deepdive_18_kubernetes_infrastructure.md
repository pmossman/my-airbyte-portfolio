# Kubernetes & Infrastructure - Deep Dive

## Overview

This document analyzes Parker Mossman's contributions to the Kubernetes & Infrastructure area of the airbyte-platform repository. This work spans from February 2022 to July 2024, encompassing 13 commits that improved pod configuration, resource management, Helm template reliability, and Keycloak deployment stability for Kubernetes-based Airbyte installations.

**Period:** February 15, 2022 - July 30, 2024 (28 months)
**Total Commits:** 13
**Total Changes:** ~1,200 lines of code
**Key Technologies:** Kubernetes, Helm, Java, Keycloak, Infinispan

---

## Key Architectural Changes

### 1. Configure Kubernetes Pod Process Per Job Type

**Commit:** b742a451a0 - February 15, 2022
**Impact:** 11 files changed, 449 insertions, 87 deletions

#### What Changed

This foundational commit introduced job-type-specific Kubernetes pod configurations, enabling different resource requirements, node selectors, and status check intervals for different types of Airbyte jobs (Spec, Check, Discover, Sync/Replication).

**Key files:**
- `airbyte-config/models/src/main/java/io/airbyte/config/Configs.java` (new methods)
- `airbyte-config/models/src/main/java/io/airbyte/config/EnvConfigs.java` (new env vars)
- `airbyte-workers/src/main/java/io/airbyte/workers/WorkerConfigs.java` (complete refactor)
- `airbyte-workers/src/main/java/io/airbyte/workers/WorkerApp.java` (multiple process factories)

#### Implementation Details

The core change was splitting the single `WorkerConfigs` into job-type-specific configurations:

**Before:**
```java
// Single configuration for all job types
final WorkerConfigs workerConfigs = new WorkerConfigs(configs);
final ProcessFactory jobProcessFactory = getJobProcessFactory(configs);
```

**After:**
```java
// Separate configurations per job type
final WorkerConfigs defaultWorkerConfigs = new WorkerConfigs(configs);
final WorkerConfigs specWorkerConfigs = WorkerConfigs.buildSpecWorkerConfigs(configs);
final WorkerConfigs checkWorkerConfigs = WorkerConfigs.buildCheckWorkerConfigs(configs);
final WorkerConfigs discoverWorkerConfigs = WorkerConfigs.buildDiscoverWorkerConfigs(configs);
final WorkerConfigs replicationWorkerConfigs = WorkerConfigs.buildReplicationWorkerConfigs(configs);

final ProcessFactory defaultProcessFactory = getJobProcessFactory(configs, defaultWorkerConfigs);
final ProcessFactory specProcessFactory = getJobProcessFactory(configs, specWorkerConfigs);
final ProcessFactory checkProcessFactory = getJobProcessFactory(configs, checkWorkerConfigs);
final ProcessFactory discoverProcessFactory = getJobProcessFactory(configs, discoverWorkerConfigs);
final ProcessFactory replicationProcessFactory = getJobProcessFactory(configs, replicationWorkerConfigs);
```

**Environment Variables Introduced:**

```java
// Job-type-specific node selectors
public static final String SPEC_JOB_KUBE_NODE_SELECTORS = "SPEC_JOB_KUBE_NODE_SELECTORS";
public static final String CHECK_JOB_KUBE_NODE_SELECTORS = "CHECK_JOB_KUBE_NODE_SELECTORS";
public static final String DISCOVER_JOB_KUBE_NODE_SELECTORS = "DISCOVER_JOB_KUBE_NODE_SELECTORS";

// Replication orchestrator resource limits
private static final String REPLICATION_ORCHESTRATOR_CPU_REQUEST = "REPLICATION_ORCHESTRATOR_CPU_REQUEST";
private static final String REPLICATION_ORCHESTRATOR_CPU_LIMIT = "REPLICATION_ORCHESTRATOR_CPU_LIMIT";
private static final String REPLICATION_ORCHESTRATOR_MEMORY_REQUEST = "REPLICATION_ORCHESTRATOR_MEMORY_REQUEST";
private static final String REPLICATION_ORCHESTRATOR_MEMORY_LIMIT = "REPLICATION_ORCHESTRATOR_MEMORY_LIMIT";
```

**Status Check Intervals Per Job Type:**

```java
private static final Duration DEFAULT_WORKER_STATUS_CHECK_INTERVAL = Duration.ofSeconds(30);
private static final Duration SPEC_WORKER_STATUS_CHECK_INTERVAL = Duration.ofSeconds(1);
private static final Duration CHECK_WORKER_STATUS_CHECK_INTERVAL = Duration.ofSeconds(1);
private static final Duration DISCOVER_WORKER_STATUS_CHECK_INTERVAL = Duration.ofSeconds(1);
private static final Duration REPLICATION_WORKER_STATUS_CHECK_INTERVAL = Duration.ofSeconds(30);
```

The fast-running jobs (Spec, Check, Discover) get 1-second status check intervals for quick feedback, while long-running sync jobs use 30-second intervals to reduce API load.

**Builder Methods:**

```java
public static WorkerConfigs buildCheckWorkerConfigs(final Configs configs) {
  // Use job-type-specific node selectors if provided, fall back to default
  final Optional<Map<String, String>> nodeSelectors = configs.getCheckJobKubeNodeSelectors().isPresent()
      ? configs.getCheckJobKubeNodeSelectors()
      : configs.getJobKubeNodeSelectors();

  return new WorkerConfigs(
      configs.getWorkerEnvironment(),
      new ResourceRequirements()
          .withCpuRequest(configs.getJobMainContainerCpuRequest())
          .withCpuLimit(configs.getJobMainContainerCpuLimit())
          .withMemoryRequest(configs.getJobMainContainerMemoryRequest())
          .withMemoryLimit(configs.getJobMainContainerMemoryLimit()),
      configs.getJobKubeTolerations(),
      nodeSelectors,
      configs.getJobKubeMainContainerImagePullSecret(),
      configs.getJobKubeMainContainerImagePullPolicy(),
      configs.getJobKubeSocatImage(),
      configs.getJobKubeBusyboxImage(),
      configs.getJobKubeCurlImage(),
      configs.getJobDefaultEnvMap(),
      CHECK_WORKER_STATUS_CHECK_INTERVAL);
}
```

#### Business Value

This change enabled sophisticated resource management in Kubernetes:

1. **Cost Optimization**: Light jobs (spec, check, discover) can be scheduled on smaller nodes, while sync jobs get dedicated high-memory nodes
2. **Performance**: Fast status checks for quick jobs provide immediate user feedback; slower checks for syncs reduce k8s API load
3. **Flexibility**: Operators can configure node affinity per job type based on their infrastructure topology
4. **Resource Isolation**: Replication orchestrators get custom resource limits separate from connector pods
5. **Scalability**: Different node pools can serve different workload characteristics

For example, an operator might configure:
- Spec/Check/Discover jobs on spot instances for cost savings (they're quick and retryable)
- Sync jobs on dedicated reserved instances for reliability
- Replication orchestrators with minimal resources since they just coordinate

---

### 2. Add /tmp EmptyDir Volume to Connector Pods

**Commit:** dfd25f0e85 - April 11, 2022
**Impact:** 40 files changed, 218 insertions, 187 deletions

#### What Changed

This commit added an emptyDir volume mounted at `/tmp` in connector pods, addressing connector and normalization failures caused by read-only filesystems. The change was initially implemented, reverted (commit eea515614c), then re-implemented with fixes.

**Key files:**
- `airbyte-workers/src/main/java/io/airbyte/workers/process/KubePodProcess.java`
- `airbyte-integrations/bases/base-normalization/dbt-project-template-*/dbt_project.yml` (multiple DBT configs)
- `airbyte-integrations/bases/base-normalization/Dockerfile`

#### Implementation Details

**Kubernetes Volume Configuration:**

```java
public static final String TMP_DIR = "/tmp";

// Create emptyDir volume
final Volume tmpVolume = new VolumeBuilder()
    .withName("tmp")
    .withNewEmptyDir()
    .endEmptyDir()
    .build();

// Mount in main container
final VolumeMount tmpVolumeMount = new VolumeMountBuilder()
    .withName("tmp")
    .withMountPath(TMP_DIR)
    .build();

// Add to container spec
final Container main = getMain(
    image,
    imagePullPolicy,
    usesStdin,
    entrypointOverride,
    List.of(pipeVolumeMount, configVolumeMount, terminationVolumeMount, tmpVolumeMount),
    resourceRequirements,
    internalToExternalPorts,
    envMap,
    labels);

// Add volume to pod spec
.withVolumes(pipeVolume, configVolume, terminationVolume, tmpVolume)
```

**DBT Configuration Changes:**

The change also required updating DBT's packages directory from `/tmp/dbt_modules` to `/dbt`:

```yaml
# Before:
packages-install-path: "/tmp/dbt_modules"

# After:
packages-install-path: "/dbt"
```

This was necessary because the emptyDir volume only covers `/tmp` itself, not subdirectories. DBT packages could exceed the size limits of emptyDir, so they were moved to a separate location.

#### Business Value

1. **Connector Compatibility**: Many connectors expect `/tmp` to be writable for temporary files, cache, etc.
2. **Normalization Stability**: DBT transformations often write temporary files during compilation
3. **Security**: emptyDir is pod-scoped and automatically cleaned up, preventing data leaks between jobs
4. **Resource Management**: emptyDir can have size limits to prevent pods from consuming excessive disk
5. **Kubernetes Best Practices**: Properly handling writable storage in containerized environments

#### Why It Was Reverted and Re-Implemented

The initial implementation broke DBT normalization because DBT packages were stored in `/tmp/dbt_modules`. When the emptyDir volume was added, it shadowed any files that were copied to `/tmp` during the image build. The fix moved DBT packages to `/dbt`, which is outside the volume mount.

This demonstrates the complexity of volume management in Kubernetes and the need for thorough testing across all components.

---

### 3. Add Timeout to Connector Pod Init Container Command

**Commit:** 34be57c4c1 - February 23, 2022
**Impact:** 2 files changed, 47 insertions, 8 deletions

#### What Changed

Added a timeout mechanism to init containers with disk usage monitoring, preventing pods from hanging indefinitely when file copies fail.

**Key files:**
- `airbyte-workers/src/main/java/io/airbyte/workers/process/KubePodProcess.java`
- `airbyte-workers/src/main/resources/entrypoints/sync/init.sh` (new file)

#### Implementation Details

**Before:**

Init containers used a simple busybox command that would wait forever:

```java
var initEntrypointStr = String.format("mkfifo %s && mkfifo %s", STDOUT_PIPE_FILE, STDERR_PIPE_FILE);
if (usesStdin) {
  initEntrypointStr = String.format("mkfifo %s && ", STDIN_PIPE_FILE) + initEntrypointStr;
}
initEntrypointStr = initEntrypointStr + String.format(" && until [ -f %s ]; do sleep 0.1; done;", SUCCESS_FILE_NAME);

return new ContainerBuilder()
    .withCommand("sh", "-c", initEntrypointStr)
    // ...
```

**After:**

A sophisticated shell script with timeout and disk monitoring:

```java
private static final double INIT_SLEEP_PERIOD_SECONDS = 0.1;
private static final Duration INIT_RETRY_TIMEOUT_MINUTES = Duration.ofMinutes(1);
private static final int INIT_RETRY_MAX_ITERATIONS = (int) (INIT_RETRY_TIMEOUT_MINUTES.toSeconds() / INIT_SLEEP_PERIOD_SECONDS);

final var initCommand = MoreResources.readResource("entrypoints/sync/init.sh")
    .replaceAll("USES_STDIN_VALUE", String.valueOf(usesStdin))
    .replaceAll("STDOUT_PIPE_FILE_VALUE", STDOUT_PIPE_FILE)
    .replaceAll("STDERR_PIPE_FILE_VALUE", STDERR_PIPE_FILE)
    .replaceAll("STDIN_PIPE_FILE_VALUE", STDIN_PIPE_FILE)
    .replaceAll("MAX_ITERATION_VALUE", String.valueOf(INIT_RETRY_MAX_ITERATIONS))
    .replaceAll("SUCCESS_FILE_NAME_VALUE", SUCCESS_FILE_NAME)
    .replaceAll("SLEEP_PERIOD_VALUE", String.valueOf(INIT_SLEEP_PERIOD_SECONDS));

return new ContainerBuilder()
    .withCommand("sh", "-c", initCommand)
    // ...
```

**Init Script (`entrypoints/sync/init.sh`):**

```bash
USES_STDIN=USES_STDIN_VALUE

mkfifo STDOUT_PIPE_FILE_VALUE
mkfifo STDERR_PIPE_FILE_VALUE

if [ "$USES_STDIN" = true ]; then
  mkfifo STDIN_PIPE_FILE_VALUE
fi

ITERATION=0
MAX_ITERATION=MAX_ITERATION_VALUE
DISK_USAGE=$(du -s /config | awk '{print $1;}')

# Wait for success file OR timeout, but reset timeout if disk usage is increasing
# (indicating active file copy)
until [ -f SUCCESS_FILE_NAME_VALUE -o $ITERATION -ge $MAX_ITERATION ]; do
  ITERATION=$((ITERATION+1))
  LAST_DISK_USAGE=$DISK_USAGE
  DISK_USAGE=$(du -s /config | awk '{print $1;}')

  # If disk usage increased, reset iteration counter (file copy is progressing)
  if [ $DISK_USAGE -gt $LAST_DISK_USAGE ]; then
    ITERATION=0
  fi

  sleep SLEEP_PERIOD_VALUE
done

if [ -f SUCCESS_FILE_NAME_VALUE ]; then
  echo "All files copied successfully, exiting with code 0..."
  exit 0
else
  echo "Timeout while attempting to copy to init container, exiting with code 1..."
  exit 1
fi
```

#### Business Value

1. **Failure Detection**: Pods no longer hang indefinitely when file copies fail, enabling faster retry/recovery
2. **Intelligent Timeout**: Monitoring disk usage prevents premature timeout on large file copies
3. **Resource Efficiency**: Hanging pods consume cluster resources; timeouts free them up
4. **Debugging**: Clear error messages distinguish between "timeout" vs "success" scenarios
5. **Reliability**: Automatic failure detection enables Temporal/Kubernetes to retry failed jobs

The disk usage monitoring is particularly clever - it distinguishes between "file copy stuck" (no disk change) vs "large file copying slowly" (disk increasing). This prevents false positives on slow networks or large connector images.

#### Related Changes

- **Commit ecb50ec5f5** (February 17, 2023): Increased timeout from 1 minute to 5 minutes after discovering that pods on newly-provisioned nodes needed more time for image pulls and initialization.

---

### 4. Kubernetes Cache-Stack Mode for Keycloak Server

**Commit:** b0640f43f8 - November 1, 2023
**Impact:** 5 files changed, 50 insertions, 9 deletions

#### What Changed

Configured Keycloak to use Infinispan distributed caching with Kubernetes discovery, enabling session sharing across multiple Keycloak replicas for high availability.

**Key files:**
- `airbyte-keycloak/scripts/entrypoint.sh`
- `charts/airbyte-keycloak/templates/deployment.yaml`
- `charts/airbyte-keycloak/templates/service.yaml` (new headless service)
- `charts/airbyte-keycloak/values.yaml`
- `charts/airbyte/templates/env-configmap.yaml`

#### Implementation Details

**Keycloak Build Configuration:**

```bash
# Before:
bin/kc.sh build --health-enabled=true --http-relative-path /auth

# After:
bin/kc.sh build --cache=ispn --cache-stack=kubernetes --health-enabled=true --http-relative-path /auth
```

**Infinispan/JGroups Configuration:**

```yaml
# Helm template - deployment.yaml
- name: JAVA_OPTS_APPEND
  valueFrom:
    configMapKeyRef:
      name: {{ .Release.Name }}-airbyte-env
      key: KEYCLOAK_JAVA_OPTS_APPEND

# env-configmap.yaml
KEYCLOAK_JAVA_OPTS_APPEND: -Djgroups.dns.query={{ .Release.Name }}-airbyte-keycloak-headless-svc
```

**Headless Service for Pod Discovery:**

```yaml
# New headless service for cluster member discovery
apiVersion: v1
kind: Service
metadata:
  name: {{.Release.Name }}-airbyte-keycloak-headless-svc
spec:
  type: ClusterIP
  clusterIP: None  # Headless service returns individual pod IPs
  ports:
    - name: jgroups
      port: 7800  # JGroups/Infinispan clustering port
      targetPort: 7800
    - port: {{ .Values.service.port }}
      targetPort: http
      protocol: TCP
      name: http
  selector:
    {{- include "airbyte.selectorLabels" . | nindent 4 }}
```

**Deployment Container Ports:**

```yaml
ports:
  - name: http
    containerPort: {{ .Values.service.port }}
    protocol: TCP
  - containerPort: 7800  # JGroups clustering port
```

**Updated Probe Timings:**

```yaml
livenessProbe:
  enabled: true
  initialDelaySeconds: 60  # Increased from 30 to allow for cluster joining
  periodSeconds: 5
  timeoutSeconds: 5
  failureThreshold: 3
  successThreshold: 1

readinessProbe:
  enabled: true
  initialDelaySeconds: 30
  periodSeconds: 5
  timeoutSeconds: 5
  failureThreshold: 10  # Increased from 3 to tolerate cache sync delays
  successThreshold: 1
```

#### Business Value

1. **High Availability**: Multiple Keycloak replicas can serve traffic, eliminating single point of failure
2. **Session Sharing**: User sessions persist across pod restarts/failures via distributed cache
3. **Horizontal Scaling**: Can scale Keycloak pods up/down without losing session state
4. **Kubernetes-Native**: Uses DNS-based pod discovery instead of static IPs or external coordination
5. **Production-Ready**: Infinispan is Keycloak's recommended caching solution for production

**How It Works:**

1. Headless service returns A records for all Keycloak pod IPs when queried
2. JGroups uses DNS query to discover cluster members: `jgroups.dns.query=airbyte-keycloak-headless-svc`
3. Pods join Infinispan cluster via port 7800
4. Session data replicates across cluster using Infinispan distributed cache
5. When a pod dies, sessions remain available on other replicas

This is critical for Airbyte Cloud deployments where Keycloak handles authentication for thousands of users across multiple availability zones.

---

### 5. Keycloak Volume Mount Ownership Fix

**Commit:** f3f77fc84e - April 9, 2024
**Impact:** 1 file changed, 11 insertions

#### What Changed

Added an init container to fix volume mount ownership for Keycloak's Infinispan data directory, resolving permission errors when Keycloak runs as non-root user.

**Key file:**
- `charts/airbyte-keycloak/templates/statefulset.yaml`

#### Implementation Details

```yaml
{{- if and .Values.containerSecurityContext.runAsUser .Values.containerSecurityContext.runAsGroup }}
- name: fix-volume-permissions
  image: busybox
  command: ["sh", "-c", "chown -R {{ .Values.containerSecurityContext.runAsUser }}:{{ .Values.containerSecurityContext.runAsGroup }} /opt/keycloak/data/infinispan"]
  securityContext:
    runAsUser: 0        # Run as root to change ownership
    privileged: true    # Required for chown
  volumeMounts:
    - name: keycloak-storage
      mountPath: /opt/keycloak/data/infinispan
{{- end }}
```

#### Business Value

1. **Security**: Allows Keycloak to run as non-root user (best practice)
2. **Pod Security Standards**: Compatible with restricted pod security policies
3. **Reliability**: Prevents Infinispan cache write failures due to permission denied
4. **Kubernetes Best Practices**: Uses init container pattern for one-time setup tasks

**The Problem:**

When using PersistentVolumeClaims, volumes are often mounted with root ownership. If Keycloak runs as non-root (e.g., UID 1000), it can't write to `/opt/keycloak/data/infinispan`, causing cache persistence to fail.

**The Solution:**

Init container runs as root once at pod startup to fix ownership, then Keycloak main container runs securely as non-root with writable cache directory.

#### Related Commits

This was part of a series addressing Keycloak volume ownership:

- **Commit 160baec0a3** (April 9, 2024): Attempted to use `fsGroup` instead of init container
- **Commit c3bc561ad5** (April 9, 2024): Reverted fsGroup approach due to issues

The `fsGroup` approach would have been cleaner (Kubernetes automatically sets ownership), but it doesn't work reliably across all storage provisioners. The init container approach is more universally compatible.

---

### 6. Service Account Helm Template Fix

**Commit:** cc663f154b - July 30, 2024
**Impact:** 1 file changed, 6 insertions, 7 deletions

#### What Changed

Fixed a Helm template bug where the Kubernetes service account would lose pod permissions during chart upgrades, causing job pods to fail.

**Key file:**
- `charts/airbyte/templates/serviceaccount.yaml`

#### Implementation Details

**Before:**

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-weight: "-10"
rules:
  - apiGroups: ["*"]
    resources: ["jobs", "pods", "pods/log", "pods/exec", "pods/attach"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
{{- if eq .Values.global.edition "community" }}
  - apiGroups: ["*"]
    resources: ["secrets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
{{- end }}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-weight: "-10"
```

**After:**

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-weight: "-5"
rules:
  - apiGroups: ["*"]
{{- if eq .Values.global.edition "community" }}
    resources: ["jobs", "pods", "pods/log", "pods/exec", "pods/attach", "secrets"]
{{- else }}
    resources: ["jobs", "pods", "pods/log", "pods/exec", "pods/attach"]
{{- end }}
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-weight: "-3"
```

#### Business Value

1. **Upgrade Reliability**: Helm upgrades no longer break existing Airbyte installations
2. **Production Stability**: Jobs don't fail with "forbidden: pods" errors after upgrade
3. **Template Correctness**: Conditional resources now properly structured as single rule
4. **Hook Ordering**: Adjusted weights ensure proper Role → RoleBinding creation order

**The Bug:**

The original template had `resources` split across multiple rule entries with conditional logic. During Helm upgrade, this could result in incomplete rules being applied, losing pod permissions. Consolidating into a single rule with conditional resources fixed the race condition.

**Hook Weights:**

Changed from `-10` for both to `-5` (Role) and `-3` (RoleBinding) to ensure Role is created before RoleBinding attempts to reference it.

---

### 7. Log Pod State on Init Container Timeout

**Commit:** 2157b47b60 - February 24, 2022
**Impact:** 2 files changed, 14 insertions, 3 deletions

#### What Changed

Added diagnostic logging when init container wait conditions time out, helping debug intermittent pod startup failures.

**Key files:**
- `airbyte-workers/src/main/java/io/airbyte/workers/process/KubePodProcess.java`
- `airbyte-workers/src/test-integration/java/io/airbyte/workers/process/KubePodProcessIntegrationTest.java`

#### Implementation Details

```java
private static void waitForInitPodToRun(final KubernetesClient client, final Pod podDefinition) throws InterruptedException {
  LOGGER.info("Waiting for init container to be ready before copying files...");
  final PodResource<Pod> pod =
      client.pods().inNamespace(podDefinition.getMetadata().getNamespace()).withName(podDefinition.getMetadata().getName());
  try {
    pod.waitUntilCondition(p -> p.getStatus().getInitContainerStatuses().size() != 0, 5, TimeUnit.MINUTES);
  } catch (InterruptedException e) {
    LOGGER.error("Init pod not found after 5 minutes");
    LOGGER.error("Pod search executed in namespace {} for pod name {} resulted in: {}",
        podDefinition.getMetadata().getNamespace(),
        podDefinition.getMetadata().getName(),
        pod.get().toString());
    throw e;
  }
  LOGGER.info("Init container present..");
  // ... continue waiting for init container to enter Running state
}
```

#### Business Value

1. **Debugging**: Full pod state helps diagnose why init container didn't appear
2. **Observability**: Logs show pod conditions, events, and scheduling issues
3. **Faster Root Cause Analysis**: Engineers can identify node pressure, image pull failures, etc.
4. **Transient Issues**: Distinguishes temporary Kubernetes issues from code bugs

This was specifically added to debug a transient test failure, demonstrating the value of defensive logging in distributed systems.

---

### 8. Connection-Based Pod Killing

**Commit:** 0b1a75def0 - June 22, 2023
**Impact:** 1 file changed, 2 insertions, 4 deletions

#### What Changed

Changed pod cleanup logic to find pods by Connection ID instead of worker process ID, ensuring all pods for a connection are killed even if process ID changes.

**Key file:**
- `airbyte-commons-worker/src/main/java/io/airbyte/workers/sync/LauncherWorker.java`

#### Implementation Details

**Before:**

```java
private Map<String, String> buildPodLabels() {
  final Map<String, String> metadataLabels = new HashMap<>();
  metadataLabels.put(PROCESS_ID_LABEL_KEY, processId.toString());
  metadataLabels.put(SYNC_STEP_KEY, ORCHESTRATOR_STEP);
  if (connectionId != null) {
    metadataLabels.put(CONNECTION_ID_LABEL_KEY, connectionId.toString());
  }
  return metadataLabels;
}

private List<Pod> getNonTerminalPodsWithLabels() {
  return containerOrchestratorConfig.kubernetesClient().pods()
      .inNamespace(containerOrchestratorConfig.namespace())
      .withLabels(Map.of(PROCESS_ID_LABEL_KEY, processId.toString()))
      .list()
      // ...
}
```

**After:**

```java
private Map<String, String> buildPodLabels() {
  final Map<String, String> metadataLabels = new HashMap<>();
  metadataLabels.put(PROCESS_ID_LABEL_KEY, processId.toString());
  metadataLabels.put(SYNC_STEP_KEY, ORCHESTRATOR_STEP);
  metadataLabels.put(CONNECTION_ID_LABEL_KEY, connectionId.toString());  // Now always set
  return metadataLabels;
}

private List<Pod> getNonTerminalPodsWithLabels() {
  return containerOrchestratorConfig.kubernetesClient().pods()
      .inNamespace(containerOrchestratorConfig.namespace())
      .withLabels(Map.of(CONNECTION_ID_LABEL_KEY, connectionId.toString()))  // Search by connection
      .list()
      // ...
}
```

#### Business Value

1. **Reliable Cleanup**: All pods for a connection are found and killed, even across retries
2. **Resource Management**: Prevents orphaned pods consuming cluster resources
3. **Correctness**: Process ID can change on retry, but connection ID is stable
4. **Cost Savings**: Fewer orphaned pods = lower infrastructure costs

**The Problem:**

When a sync job is retried, Temporal assigns a new process ID. The old implementation would fail to find pods from previous attempts (different process ID), leaving them running. These orphaned pods could consume resources indefinitely.

**The Solution:**

Connection ID is stable across retries, so searching by connection ID finds all pods regardless of which attempt created them.

---

## Technical Evolution

The commits tell a story of progressive Kubernetes infrastructure maturation:

### Phase 1: Resource Management (Early 2022)

The work began with fundamental pod configuration:

- **February 2022**: Job-type-specific pod configurations (b742a451a0)
- **February 2022**: Init container timeout mechanism (34be57c4c1)
- **February 2022**: Pod state diagnostic logging (2157b47b60)

This phase focused on making Airbyte's Kubernetes pods production-ready with proper resource limits, failure detection, and debugging capabilities.

### Phase 2: Storage and Permissions (Mid 2022)

As usage grew, storage-related issues emerged:

- **March 2022**: Initial /tmp emptyDir volume (reverted)
- **April 2022**: Re-implemented /tmp emptyDir with DBT fixes (dfd25f0e85)

This phase addressed the reality that many connectors expect writable `/tmp`, requiring careful volume management.

### Phase 3: High Availability (Late 2022 - 2023)

Focus shifted to multi-replica deployments:

- **June 2023**: Connection-based pod cleanup (0b1a75def0)
- **November 2023**: Keycloak Infinispan clustering (b0640f43f8)

This phase enabled horizontal scaling of both worker pods and authentication services.

### Phase 4: Security and Reliability (2024)

The most recent work hardened production deployments:

- **April 2024**: Keycloak volume permissions (f3f77fc84e)
- **July 2024**: Service account Helm template fix (cc663f154b)

This phase addressed security best practices (non-root containers) and Helm upgrade reliability.

### Technology Patterns

The evolution shows consistent engineering patterns:

- **Defensive Programming**: Timeouts, logging, error handling added throughout
- **Kubernetes Best Practices**: EmptyDir volumes, init containers, headless services
- **Incremental Improvement**: Initial solutions refined based on production experience (fsGroup → initContainer)
- **Configuration Flexibility**: Environment variables and Helm values for operator customization
- **Production-Hardening**: Each commit addresses real issues discovered in deployment

---

## Impact Summary

Parker's contributions to Kubernetes & Infrastructure enabled Airbyte to run reliably at scale in production Kubernetes environments. The work addressed fundamental challenges in containerized data pipeline orchestration.

### Quantitative Impact

- **13 commits** over 28 months
- **~1,200 lines** of code changes
- **Major features delivered:**
  - Job-type-specific pod configuration
  - Persistent volume management with emptyDir
  - Init container timeout and monitoring
  - Keycloak high-availability clustering
  - Non-root container security
  - Helm template reliability

### Qualitative Impact

**For Platform Operators:**
- Fine-grained control over pod placement and resources per job type
- High-availability Keycloak authentication across replicas
- Secure non-root container deployments
- Reliable Helm upgrades without permission loss
- Better debugging with diagnostic logging

**For Platform Reliability:**
- Automatic failure detection via init container timeouts
- Proper cleanup of orphaned pods
- Writable `/tmp` for connector compatibility
- Session sharing across Keycloak pods
- Production-hardened permission models

**For Cost Optimization:**
- Resource-appropriate pods reduce over-provisioning
- Orphaned pod cleanup prevents resource waste
- Node selector flexibility enables spot instance usage
- Efficient status check intervals reduce API load

### Key Architectural Patterns

The work established important patterns:

1. **Job-Type Specialization**: Different job types get different configurations, enabling optimization
2. **Init Container Pattern**: One-time setup tasks (permissions, timeouts) in init containers
3. **Volume Management**: Careful emptyDir usage for writable storage without persistent volume overhead
4. **Kubernetes-Native Discovery**: DNS-based service discovery for Infinispan clustering
5. **Defensive Timeout Logic**: Smart timeouts that distinguish "slow" from "stuck"
6. **Helm Hook Ordering**: Proper hook weights ensure correct resource creation order

### Production-Readiness

These changes collectively transformed Airbyte from a basic Kubernetes deployment to a production-grade platform:

- **Reliability**: Timeouts, retries, and cleanup ensure jobs don't hang
- **Scalability**: Per-job-type configs enable efficient resource utilization
- **Security**: Non-root containers, RBAC, pod security standards
- **High Availability**: Multi-replica Keycloak with session sharing
- **Observability**: Diagnostic logging for troubleshooting
- **Operator Experience**: Helm templates that work correctly across upgrades

The work demonstrates deep understanding of Kubernetes internals, from storage provisioners and security contexts to service discovery and RBAC. Each commit addresses a real production challenge with a well-reasoned solution that follows cloud-native best practices.
