# SSO & Domain Verification - Deep Dive

## Overview

This document analyzes Parker Mossman's contributions to the SSO & Domain Verification area of the airbyte-platform repository. This work spans from July 2023 to November 2025, encompassing 49 commits that built out Airbyte's enterprise authentication capabilities, including Keycloak integration, SSO configuration workflows, domain verification system, and comprehensive OAuth/SAML support.

**Period:** July 21, 2023 - November 14, 2025 (28 months)
**Total Commits:** 49
**Total Changes:** ~9,500 lines of code
**Key Technologies:** Keycloak, Kotlin, Java, DNS/JNDI, OIDC, SAML, React

---

## Key Architectural Changes

### 1. Domain Verification System with DNS Checking

**Commit:** af83de265f - November 5, 2025
**Impact:** 16 files changed, 1,436 insertions, 39 deletions

#### What Changed

This commit introduced a complete domain verification system using DNS TXT records, enabling organizations to prove domain ownership before activating SSO. The implementation includes a DNS verification service, automated cron job with exponential backoff, and comprehensive metrics tracking.

**Key files added:**
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/DnsVerificationService.kt` (270 lines)
- `airbyte-cron/src/main/kotlin/io/airbyte/cron/jobs/DomainVerificationJob.kt` (156 lines)
- `airbyte-data/src/test/kotlin/io/airbyte/data/services/DnsVerificationServiceTest.kt` (192 lines)
- `airbyte-cron/src/test/kotlin/io/airbyte/cron/jobs/DomainVerificationJobTest.kt` (320 lines)

#### Implementation Details

The DNS verification service uses Java's built-in JNDI (Java Naming and Directory Interface) for DNS lookups without external dependencies:

```kotlin
@Singleton
class DnsVerificationService {
  companion object {
    private const val DNS_PROVIDER_URL = "dns:"
    private const val TXT_RECORD_TYPE = "TXT"
    private const val DNS_TIMEOUT_MS = "5000"
    private const val DNS_RETRIES = "1"
  }

  fun checkDomainVerification(
    dnsRecordName: String,
    expectedValue: String,
  ): DnsVerificationResult {
    return try {
      val txtRecords = lookupTxtRecords(dnsRecordName)
      val expectedParsed = parseRfc1464Record(expectedValue)

      if (expectedParsed == null) {
        logger.error { "Expected value is not in valid RFC 1464 attribute=value format: $expectedValue" }
        return DnsVerificationResult.NotFound
      }

      val found =
        txtRecords.any { record ->
          val recordParsed = parseRfc1464Record(record)
          recordParsed != null && recordsMatch(expectedParsed, recordParsed)
        }

      when {
        found -> {
          logger.info { "DNS verification successful for $dnsRecordName" }
          DnsVerificationResult.Verified
        }
        txtRecords.isEmpty() -> {
          logger.debug { "No DNS TXT records found for $dnsRecordName" }
          DnsVerificationResult.NotFound
        }
        else -> {
          val parsedRecords = txtRecords.mapNotNull { /* ... */ }
          logger.warn {
            "DNS TXT record misconfigured for $dnsRecordName. " +
              "Expected: '${normalizeAttributeName(expectedParsed.first)}=${normalizeValue(expectedParsed.second)}', " +
              "Found: ${parsedRecords.map { "'$it'" }}"
          }
          DnsVerificationResult.Misconfigured(parsedRecords)
        }
      }
    } catch (e: Exception) {
      logger.error(e) { "DNS lookup failed for $dnsRecordName" }
      DnsVerificationResult.NotFound
    }
  }

  internal fun lookupTxtRecords(hostname: String): List<String> {
    val records = mutableListOf<String>()

    try {
      val env = Properties().apply {
        setProperty(Context.INITIAL_CONTEXT_FACTORY, "com.sun.jndi.dns.DnsContextFactory")
        setProperty(Context.PROVIDER_URL, DNS_PROVIDER_URL)
        setProperty("com.sun.jndi.dns.timeout.initial", DNS_TIMEOUT_MS)
        setProperty("com.sun.jndi.dns.timeout.retries", DNS_RETRIES)
      }

      var context: InitialDirContext? = null
      try {
        context = InitialDirContext(env)
        val attributes = context.getAttributes(hostname, arrayOf(TXT_RECORD_TYPE))
        val txtAttribute = attributes.get(TXT_RECORD_TYPE)

        if (txtAttribute != null) {
          records.addAll(extractRecordValues(txtAttribute))
        }
      } finally {
        context?.close()
      }

      logger.debug { "Found ${records.size} TXT records for $hostname" }
    } catch (e: NamingException) {
      logger.debug { "No TXT records found for $hostname: ${e.message}" }
    } catch (e: Exception) {
      logger.error(e) { "Unexpected error during DNS lookup for $hostname" }
    }

    return records
  }
}
```

The cron job implements intelligent exponential backoff:

```kotlin
@Singleton
open class DomainVerificationJob(
  private val airbyteApiClient: AirbyteApiClient,
) {
  companion object {
    const val FREQUENT_CHECK_THRESHOLD = 60 // Check every minute for first 60 attempts (1 hour)
    const val INITIAL_BACKOFF_MINUTES = 1L
    const val MAX_BACKOFF_MINUTES = 60L // Cap at 1 hour between checks
  }

  @Scheduled(fixedRate = "1m")
  open fun checkPendingDomainVerifications() {
    logger.info { "Starting domain verification check" }

    val pendingVerifications = airbyteApiClient.domainVerificationsApi.listPendingDomainVerifications()
    val verifications = pendingVerifications.domainVerifications ?: emptyList()

    val now = OffsetDateTime.now()
    val verificationsToCheck = verifications.filter { shouldCheckFrom(it, now) }
    val skippedCount = verifications.size - verificationsToCheck.size

    verificationsToCheck.forEach { verification ->
      try {
        val requestBody = DomainVerificationIdRequestBody(verification.id)
        val result = airbyteApiClient.domainVerificationsApi.checkDomainVerification(requestBody)
        logger.debug { "Domain verification ${verification.id} check completed with status ${result.status}" }
        successCount++
      } catch (e: Exception) {
        logger.error(e) { "Failed to check domain verification ${verification.id}" }
        failureCount++
      }
    }
  }

  private fun shouldCheckFrom(
    verification: DomainVerificationResponse,
    from: OffsetDateTime,
  ): Boolean {
    if (verification.lastCheckedAt == null) {
      return true
    }

    val attempts = verification.attempts ?: 0

    // First hour: check every time (every minute)
    if (attempts < FREQUENT_CHECK_THRESHOLD) {
      return true
    }

    // After first hour: apply exponential backoff
    val lastChecked = verification.lastCheckedAt?.let { OffsetDateTime.ofInstant(Instant.ofEpochSecond(it), ZoneOffset.UTC) }
    val minutesSinceLastCheck = Duration.between(lastChecked, from).toMinutes()

    val attemptsOverThreshold = attempts - FREQUENT_CHECK_THRESHOLD
    val exponentialDelay = INITIAL_BACKOFF_MINUTES * (2.0.pow(attemptsOverThreshold.toDouble()))
    val backoffMinutes = min(exponentialDelay, MAX_BACKOFF_MINUTES.toDouble()).toLong()

    return minutesSinceLastCheck >= backoffMinutes
  }
}
```

The backoff schedule after first hour:
- Attempt 60: 1 minute
- Attempt 61: 2 minutes
- Attempt 62: 4 minutes
- Attempt 63: 8 minutes
- Attempt 64: 16 minutes
- Attempt 65: 32 minutes
- Attempt 66+: 60 minutes (capped)

#### Business Value

This feature addresses a critical enterprise requirement:

1. **Security**: Prevents unauthorized SSO activation by requiring proof of domain ownership
2. **Automation**: Automated DNS checking eliminates manual verification steps
3. **User Experience**: Exponential backoff provides quick feedback (1 minute checks for first hour) while reducing DNS load for persistent failures
4. **Reliability**: Zero external dependencies using Java's built-in JNDI DNS resolver
5. **Diagnostics**: Detailed logging distinguishes between "not found" and "misconfigured" states
6. **RFC Compliance**: Properly parses RFC 1464 attribute=value format in TXT records

The tiered approach (frequent checks initially, backoff later) balances responsiveness with system load, making it production-ready for high-scale deployments.

#### Related Commits

- a229cedc02 (Nov 14, 2025): Added delete and reset buttons to Domain Verification UI
- cc298d242e (Nov 13, 2025): Added "View DNS Info" button to existing domain verification requests
- c7596a6c84 (Nov 13, 2025): Changed SSO activation button and modal if domain verification is active

---

### 2. SSO Configuration Validation Flow

**Commit:** 4e687527e1 - October 7, 2025
**Impact:** 11 files changed, 658 insertions, 16 deletions

#### What Changed

Implemented a comprehensive two-step "test and activate" flow for SSO configuration, allowing organizations to validate their SSO setup before activating it. This includes a complete React-based validation UI with callback handling and test user management.

**Key files added:**
- `airbyte-webapp/src/pages/SettingsPage/components/SSOSettingsValidation.tsx` (325 lines)
- `airbyte-webapp/src/pages/SettingsPage/components/useSSOTestCallback.ts` (90 lines)
- `airbyte-webapp/src/pages/SettingsPage/components/useSSOTestManager.ts` (42 lines)
- `airbyte-webapp/src/pages/SettingsPage/components/ssoTestUtils.ts` (21 lines)

#### Implementation Details

The validation UI implements a multi-step wizard:

```typescript
export const SSOSettingsValidation: React.FC<Props> = ({
  organizationId,
  onActivate,
  onCancel,
}) => {
  const [step, setStep] = useState<ValidationStep>("configure");
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const { formatMessage } = useIntl();

  const { startTest, cancelTest } = useSSOTestManager({
    organizationId,
    onSuccess: () => {
      setTestStatus("success");
      setStep("activate");
    },
    onError: (error) => {
      setTestStatus("error");
      setErrorMessage(error.message);
    },
  });

  const handleTestClick = async () => {
    setTestStatus("testing");
    await startTest();
  };

  const handleActivate = async () => {
    try {
      await onActivate();
      setStep("complete");
    } catch (error) {
      setTestStatus("error");
      setErrorMessage(error.message);
    }
  };

  return (
    <div className={styles.validationContainer}>
      {step === "configure" && (
        <ConfigurationStep onTest={handleTestClick} testStatus={testStatus} />
      )}
      {step === "activate" && (
        <ActivationStep onActivate={handleActivate} onBack={() => setStep("configure")} />
      )}
      {step === "complete" && (
        <CompletionStep />
      )}
    </div>
  );
};
```

The test callback hook manages the OAuth flow:

```typescript
export const useSSOTestCallback = () => {
  const { formatMessage } = useIntl();
  const { openOAuthPopup } = useCloudAuthService();

  useEffect(() => {
    // Check if we're returning from an SSO test
    const urlParams = new URLSearchParams(window.location.search);
    const ssoTest = urlParams.get("sso_test");
    const code = urlParams.get("code");
    const state = urlParams.get("state");

    if (ssoTest === "true" && code) {
      // Validate the OAuth code
      validateToken(code, state)
        .then(() => {
          window.opener?.postMessage({ type: "sso-test-success" }, window.location.origin);
        })
        .catch((error) => {
          window.opener?.postMessage({ type: "sso-test-error", error: error.message }, window.location.origin);
        })
        .finally(() => {
          window.close();
        });
    }
  }, []);
};
```

The test manager coordinates the validation process:

```typescript
export const useSSOTestManager = ({ organizationId, onSuccess, onError }) => {
  const startTest = async () => {
    const popup = window.open(
      `/sso/test?organization_id=${organizationId}`,
      "sso-test",
      "width=500,height=600"
    );

    const messageHandler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      if (event.data.type === "sso-test-success") {
        window.removeEventListener("message", messageHandler);
        onSuccess();
      } else if (event.data.type === "sso-test-error") {
        window.removeEventListener("message", messageHandler);
        onError(new Error(event.data.error));
      }
    };

    window.addEventListener("message", messageHandler);

    // Set timeout to detect popup closed
    const checkClosed = setInterval(() => {
      if (popup?.closed) {
        clearInterval(checkClosed);
        window.removeEventListener("message", messageHandler);
        onError(new Error("Test cancelled"));
      }
    }, 500);
  };

  return { startTest };
};
```

#### Business Value

This workflow dramatically improved the SSO setup experience:

1. **Risk Mitigation**: Organizations can test SSO before activating, preventing lockout scenarios
2. **User Experience**: Clear multi-step wizard guides users through configuration
3. **Debugging**: Immediate feedback on misconfiguration helps administrators fix issues
4. **Safety**: Test flow uses isolated test users, not production accounts
5. **Validation**: Ensures OAuth/OIDC configuration is correct before committing

The two-step approach (test, then activate) became a critical safety feature, especially when combined with the forced logout on activation.

#### Related Commits

- 1afd3bf944 (Oct 7, 2025): Implemented `sso_config/validate_token` endpoint
- 8680bf33f3 (Oct 9, 2025): Added confirmation modal to SSO config activation and forced logout
- 6d4c95646b (Oct 14, 2025): More isolation for SSO Test UserManager

---

### 3. Draft SSO Config with Realm Cleanup

**Commit:** 866d7bae4d - October 8, 2025
**Impact:** 3 files changed, 582 insertions, 136 deletions

#### What Changed

Significantly improved SSO configuration workflow by properly handling draft configs, Keycloak realm cleanup on failures, and user preservation when updating SSO settings. This was a critical bug fix that prevented data loss and orphaned resources.

**Key files modified:**
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/impls/keycloak/AirbyteKeycloakClient.kt`
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/sso/SsoConfigDomainService.kt`

#### Implementation Details

The Keycloak client was enhanced with failure recovery and cleanup:

```kotlin
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
    createClientForRealm(request.companyIdentifier, airbyteWebappClient)
  } catch (e: Exception) {
    try {
      deleteRealm(request.companyIdentifier)
    } catch (cleanupEx: Exception) {
      logger.error(cleanupEx) { "Failed to cleanup Keycloak realm ${request.companyIdentifier} after configuration failure" }
    }
    throw e
  }
}
```

The domain service gained sophisticated draft handling with state machine logic:

```kotlin
/**
 * Creates a draft SSO config. If a draft already exists with the same company identifier,
 * updates the IDP configuration while preserving the realm and users.
 *
 * When updating a draft config with the same company identifier, preserves the Keycloak realm and
 * users by only updating the IDP configuration. If the realm doesn't exist but the DB record does,
 * recreates the realm.
 */
private fun createDraftSsoConfig(config: SsoConfig) {
  validateDiscoveryUrl(config)

  if (config.emailDomain != null) {
    throw BadRequestProblem(
      ProblemMessageData()
        .message("Email domain should not be provided when creating a draft SSO config"),
    )
  }

  val existingConfig = ssoConfigService.getSsoConfig(config.organizationId)
  if (existingConfig != null && existingConfig.status.toDomain() == SsoConfigStatus.ACTIVE) {
    throw SSOSetupProblem(
      ProblemSSOSetupData()
        .companyIdentifier(config.companyIdentifier)
        .errorMessage("An active SSO Config already exists for organization ${config.organizationId}"),
    )
  }

  when {
    existingConfig == null -> createNewDraftSsoConfig(config)

    existingConfig.keycloakRealm != config.companyIdentifier -> {
      deleteSsoConfig(config.organizationId, existingConfig.keycloakRealm)
      createNewDraftSsoConfig(config)
    }

    airbyteKeycloakClient.realmExists(config.companyIdentifier) -> {
      updateExistingKeycloakRealmConfig(config)
    }

    else -> {
      logger.info {
        "Realm ${config.companyIdentifier} does not exist but DB record does for organization ${config.organizationId}, recreating realm"
      }
      createKeycloakRealmWithErrorHandling(config)
    }
  }
}

private fun createNewDraftSsoConfig(config: SsoConfig) {
  createKeycloakRealmWithErrorHandling(config)
  try {
    ssoConfigService.createSsoConfig(config)
  } catch (ex: Exception) {
    try {
      airbyteKeycloakClient.deleteRealm(config.companyIdentifier)
    } catch (cleanupEx: Exception) {
      logger.error(cleanupEx) { "Failed to cleanup Keycloak realm after database failure" }
    }
    throw ex
  }
}
```

A critical method preserves users when updating IDP settings:

```kotlin
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
    val newIdp = IdentityProviderRepresentation().apply {
      alias = DEFAULT_IDP_ALIAS
      providerId = "oidc"
      config = idpConfig
    }
    createIdpForRealm(ssoConfig.companyIdentifier, newIdp)
  }
}
```

#### Business Value

This fix addressed critical production issues:

1. **Data Integrity**: Proper cleanup prevented orphaned Keycloak realms when configuration failed
2. **User Preservation**: Updating draft configs no longer deleted user accounts, preventing data loss
3. **Robustness**: Graceful degradation when database and Keycloak get out of sync
4. **Better Error Handling**: Transaction boundary documentation explained why Keycloak operations aren't wrapped in DB transactions
5. **Iteration Support**: Organizations could iterate on draft SSO configs without losing progress
6. **State Recovery**: Handles the case where DB record exists but Keycloak realm was deleted

The comment explaining transaction boundaries was particularly valuable:

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

- fe1917ce1a (Oct 6, 2025): Add sso_config/activate and allow draft SSO configs without requiring email domain
- 2eacc0d2e5 (Sep 29, 2025): Add status column to SsoConfig table/model/entity
- 37c94eb19e (Oct 1, 2025): Add support for `status` in SSO Config APIs and domain

---

### 4. Keycloak Setup Automation

**Commit:** 2ab27f1189 - April 22, 2024
**Impact:** 29 files changed, 932 insertions, 585 deletions

#### What Changed

Completely rewrote Keycloak setup to automatically update realm configuration without needing manual reset flags. This changed the deployment model from "create once" to "configure continuously," enabling infrastructure-as-code patterns for Keycloak.

**Key architectural changes:**
- Renamed `*Creator` classes to `*Configurator` classes (semantic shift from create-only to update-or-create)
- Introduced `IdentityProvidersConfigurator` with smart IDP management
- Added `OidcConfigFactory` for importing IDP discovery documents
- Removed `RESET_KEYCLOAK_REALM` flag requirement

**Key files added/refactored:**
- `airbyte-keycloak-setup/src/main/java/io/airbyte/keycloak/setup/IdentityProvidersConfigurator.java` (125 lines)
- `airbyte-commons-auth/src/main/java/io/airbyte/commons/auth/config/OidcConfigFactory.java` (61 lines)
- `airbyte-keycloak-setup/src/main/java/io/airbyte/keycloak/setup/UserConfigurator.java` (refactored from UserCreator)
- `airbyte-keycloak-setup/src/main/java/io/airbyte/keycloak/setup/WebClientConfigurator.java` (refactored from WebClientCreator)

#### Implementation Details

The `IdentityProvidersConfigurator` implements intelligent IDP management:

```java
@Singleton
@Slf4j
public class IdentityProvidersConfigurator {

  static final String AIRBYTE_MANAGED_IDP_KEY = "airbyte-managed-idp";
  static final String AIRBYTE_MANAGED_IDP_VALUE = "true";
  private static final String KEYCLOAK_PROVIDER_ID = "oidc";

  private final ConfigurationMapService configurationMapService;
  private final Optional<OidcConfig> oidcConfig;

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
    log.warn("Multiple identity providers exist and none are marked as airbyte-managed. Skipping IDP update. If you want your OIDC configuration to "
        + "apply to a specific IDP, please add a Config entry with key {} and value {} to that IDP and try again.",
        AIRBYTE_MANAGED_IDP_KEY, AIRBYTE_MANAGED_IDP_VALUE);
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

The `OidcConfigFactory` imports discovery documents:

```java
@Singleton
public class OidcConfigFactory {

  public Optional<OidcConfig> create(final IdentityProviderConfiguration identityProviderConfiguration) {
    if (identityProviderConfiguration.getType() == IdentityProviderConfiguration.IdentityProviderType.OIDC) {
      final AuthOidcConfiguration oidc = identityProviderConfiguration.getOidc();

      return Optional.of(new OidcConfig(
        oidc.getDomain(),
        oidc.getAppName(),
        oidc.getClientId(),
        oidc.getClientSecret()
      ));
    }

    return Optional.empty();
  }
}
```

#### Business Value

This transformation had significant operational impact:

1. **Infrastructure as Code**: Keycloak configuration now defined in source control, not manual setup
2. **Simplified Deployments**: No more manual realm reset flags or special deployment procedures
3. **Continuous Updates**: Configuration changes automatically applied on pod restart
4. **Reduced Toil**: Eliminated manual Keycloak administration for common configuration changes
5. **Consistency**: Same configuration logic across OSS and Cloud deployments
6. **Safety**: Smart IDP detection prevents accidental overwrites in multi-IDP scenarios

The "managed IDP" pattern (using the `airbyte-managed-idp` config key) elegantly solved the problem of identifying which IDP to update when multiple exist.

#### Related Commits

- de311f40cc (Apr 9, 2024): Keycloak in Cloud Stability Improvements
- 9c81dbecd3 (Mar 22, 2024): Keycloak Setup: Clear User/Permission records when resetting Keycloak Realm
- d64570a321 (Feb 13, 2024): Update RESET_KEYCLOAK_REALM to delete and re-create entire realm

---

### 5. SSO Token Validation Endpoint

**Commit:** 1afd3bf944 - October 7, 2025
**Impact:** 10 files changed, 536 insertions, 157 deletions

#### What Changed

Implemented a dedicated `sso_config/validate_token` endpoint for validating SSO access tokens during the configuration test phase. This refactored the `KeycloakTokenValidator` to support realm-specific validation and added comprehensive error handling.

**Key files modified:**
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/impls/keycloak/AirbyteKeycloakClient.kt` (141 lines added)
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/sso/SsoConfigDomainService.kt` (60 lines added)
- `airbyte-commons-server/src/main/kotlin/io/airbyte/server/authorization/KeycloakTokenValidator.kt` (refactored)

#### Implementation Details

The domain service validates tokens with comprehensive error handling:

```kotlin
fun validateToken(
  organizationId: UUID,
  accessToken: String,
) {
  // First, retrieve the organization's SSO configuration
  val ssoConfig =
    ssoConfigService.getSsoConfig(organizationId) ?: throw SSOTokenValidationProblem(
      ProblemSSOTokenValidationData()
        .organizationId(organizationId)
        .errorMessage("SSO configuration does not exist for organization $organizationId"),
    )

  // Extract the realm from the token
  val tokenRealm = airbyteKeycloakClient.extractRealmFromToken(accessToken)

  // Verify the token's realm matches the organization's configured realm
  if (tokenRealm == null || tokenRealm != ssoConfig.keycloakRealm) {
    throw SSOTokenValidationProblem(
      ProblemSSOTokenValidationData()
        .organizationId(organizationId)
        .errorMessage("Token does not belong to organization realm ${ssoConfig.keycloakRealm}"),
    )
  }

  // Now validate the token against the organization's specific realm
  try {
    airbyteKeycloakClient.validateTokenWithRealm(accessToken, ssoConfig.keycloakRealm)
  } catch (e: TokenExpiredException) {
    throw SSOTokenValidationProblem(
      ProblemSSOTokenValidationData()
        .organizationId(organizationId)
        .errorMessage("Token is expired or invalid"),
    )
  } catch (e: InvalidTokenException) {
    throw SSOTokenValidationProblem(
      ProblemSSOTokenValidationData()
        .organizationId(organizationId)
        .errorMessage("Token is invalid: ${e.message}"),
    )
  } catch (e: MalformedTokenResponseException) {
    throw SSOTokenValidationProblem(
      ProblemSSOTokenValidationData()
        .organizationId(organizationId)
        .errorMessage("Token validation failed: ${e.message}"),
    )
  } catch (e: KeycloakServiceException) {
    throw SSOTokenValidationProblem(
      ProblemSSOTokenValidationData()
        .organizationId(organizationId)
        .errorMessage("Unable to validate token: Keycloak service unavailable"),
    )
  }
}
```

The Keycloak client gained realm extraction and realm-specific validation:

```kotlin
fun extractRealmFromToken(token: String): String? {
  return try {
    val jwt = JWT.decode(token)
    val issuer = jwt.issuer
    // Issuer format: http://keycloak:8180/realms/{realm}
    issuer?.substringAfterLast("/realms/")
  } catch (e: Exception) {
    logger.warn(e) { "Failed to extract realm from token" }
    null
  }
}

fun validateTokenWithRealm(token: String, realm: String) {
  val tokenRealm = extractRealmFromToken(token)
  if (tokenRealm != realm) {
    throw InvalidTokenException("Token is for realm '$tokenRealm', expected '$realm'")
  }

  // Validate token with Keycloak
  val url = "$keycloakBaseUrl/realms/$realm/protocol/openid-connect/userinfo"
  val request = Request.Builder()
    .url(url)
    .header("Authorization", "Bearer $token")
    .build()

  httpClient.newCall(request).execute().use { response ->
    if (!response.isSuccessful) {
      throw InvalidTokenException("Token validation failed: ${response.code}")
    }
  }
}
```

#### Business Value

This endpoint was critical for the SSO test flow:

1. **Security**: Validates tokens belong to the correct organization's realm
2. **Error Clarity**: Distinguishes between expired, invalid, and mismatched tokens
3. **Testing**: Enables SSO configuration testing without activating SSO
4. **Debugging**: Provides clear error messages for misconfigured SSO
5. **Multi-Realm Support**: Properly handles organizations with different Keycloak realms

The realm extraction from token issuer was particularly elegant, avoiding the need to maintain realm mappings.

#### Related Commits

- 4e687527e1 (Oct 7, 2025): Add SSO configuration validation UI with two-step test and activate flow
- 83bfb7b0ef (Oct 9, 2025): Consolidate SSO API problems and improve error handling

---

### 6. Block SSO Activation for Domains in Use

**Commit:** 02d96c8167 - October 23, 2025
**Impact:** 8 files changed, 305 insertions, 23 deletions

#### What Changed

Added validation to prevent SSO activation when the email domain is already in use by users in other organizations. This prevents account takeover scenarios and cross-organization security issues.

**Key files modified:**
- `airbyte-config/config-persistence/src/main/kotlin/io/airbyte/config/persistence/UserPersistence.kt` (new query method)
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/sso/SsoConfigDomainService.kt` (validation logic)

#### Implementation Details

New query method to find conflicting users:

```kotlin
fun findUsersWithEmailDomainOutsideOrganization(
  emailDomain: String,
  organizationId: UUID,
): List<User> {
  return ctx
    .select(USER.asterisk())
    .from(USER)
    .where(
      USER.EMAIL.likeIgnoreCase("%@$emailDomain")
        .and(
          USER.ID.notIn(
            ctx.select(PERMISSION.USER_ID)
              .from(PERMISSION)
              .where(PERMISSION.ORGANIZATION_ID.eq(organizationId))
          )
        )
    )
    .fetch()
    .map { /* map to User */ }
}
```

Validation logic with clear error messages:

```kotlin
private fun validateNoExistingUsersOutsideOrganization(
  emailDomain: String,
  organizationId: UUID,
  companyIdentifier: String,
) {
  val usersOutsideOrg = userPersistence.findUsersWithEmailDomainOutsideOrganization(emailDomain, organizationId)
  if (usersOutsideOrg.isNotEmpty()) {
    throw SSOActivationProblem(
      ProblemSSOActivationData()
        .organizationId(organizationId)
        .companyIdentifier(companyIdentifier)
        .errorMessage(
          "Cannot activate SSO for domain '$emailDomain' because ${usersOutsideOrg.size} user(s) from other organizations are already using this " +
            "domain. Please contact support to resolve this conflict.",
        ),
    )
  }
}

private fun validateEmailDomainForActivation(
  organizationId: UUID,
  emailDomain: String,
  companyIdentifier: String,
) {
  validateEmailDomainMatchesOrganization(organizationId, emailDomain, companyIdentifier)
  validateEmailDomainNotExists(emailDomain, organizationId, companyIdentifier)
  validateNoExistingUsersOutsideOrganization(emailDomain, organizationId, companyIdentifier)
}
```

#### Business Value

This validation prevented critical security issues:

1. **Security**: Prevents account takeover by ensuring domains are exclusive to one organization
2. **Data Protection**: Users in other organizations can't be suddenly forced into SSO
3. **Clear Errors**: Actionable error message directs users to contact support
4. **Audit Trail**: Comprehensive test coverage documents expected behavior

The validation runs at activation time, not draft creation time, allowing organizations to configure SSO before resolving conflicts.

#### Related Commits

- fe1917ce1a (Oct 6, 2025): Add sso_config/activate and allow draft SSO configs without requiring email domain
- 866d7bae4d (Oct 8, 2025): Improve draft SSO config handling with realm cleanup and user preservation

---

### 7. Multi-Realm Token Validation

**Commit:** d3eb6f902f - August 13, 2024
**Impact:** 10 files changed, 195 insertions, 33 deletions

#### What Changed

Refactored `KeycloakTokenValidator` to support multiple realms, enabling Airbyte to validate tokens from different Keycloak realms (organization-specific and Connector Builder Server). Introduced the `TokenRoleResolver` abstraction for realm-specific role extraction.

**Key files added:**
- `airbyte-commons-server/src/main/kotlin/io/airbyte/server/authorization/TokenRoleResolver.kt` (38 lines)
- `airbyte-connector-builder-server/src/main/kotlin/io/airbyte/connector_builder/authorization/ConnectorBuilderTokenRoleResolver.kt` (34 lines)

**Key files modified:**
- `airbyte-commons-server/src/main/kotlin/io/airbyte/server/authorization/KeycloakTokenValidator.kt` (refactored)

#### Implementation Details

The `TokenRoleResolver` abstraction:

```kotlin
interface TokenRoleResolver {
  /**
   * Extracts roles from a validated JWT token.
   *
   * @param jwt The validated JWT token
   * @return Set of role strings for the user
   */
  fun resolveRoles(jwt: DecodedJWT): Set<String>
}
```

RBAC implementation for main API:

```kotlin
@Singleton
class RbacTokenRoleResolver : TokenRoleResolver {
  override fun resolveRoles(jwt: DecodedJWT): Set<String> {
    val realmAccess = jwt.getClaim("realm_access").asMap()
    val roles = realmAccess?.get("roles") as? List<*>
    return roles?.filterIsInstance<String>()?.toSet() ?: emptySet()
  }
}
```

Connector Builder implementation:

```kotlin
@Singleton
class ConnectorBuilderTokenRoleResolver : TokenRoleResolver {
  override fun resolveRoles(jwt: DecodedJWT): Set<String> {
    // Connector Builder uses resource-level roles
    val resourceAccess = jwt.getClaim("resource_access").asMap()
    val connectorBuilderRoles = resourceAccess?.get("connector-builder") as? Map<*, *>
    val roles = connectorBuilderRoles?.get("roles") as? List<*>
    return roles?.filterIsInstance<String>()?.toSet() ?: emptySet()
  }
}
```

Refactored validator:

```kotlin
@Singleton
class KeycloakTokenValidator(
  private val httpClientFactory: HttpClientFactory,
  private val keycloakBaseUrl: String,
  private val tokenRoleResolver: TokenRoleResolver,
) {

  fun validateToken(token: String, realm: String): Set<String> {
    val url = "$keycloakBaseUrl/realms/$realm/protocol/openid-connect/userinfo"
    val request = Request.Builder()
      .url(url)
      .header("Authorization", "Bearer $token")
      .build()

    httpClient.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw InvalidTokenException("Token validation failed")
      }
    }

    val jwt = JWT.decode(token)
    return tokenRoleResolver.resolveRoles(jwt)
  }
}
```

#### Business Value

This refactoring enabled key capabilities:

1. **Multi-Service Support**: Same Keycloak instance can serve multiple services (API, Connector Builder)
2. **Extensibility**: New services can implement their own `TokenRoleResolver`
3. **Separation of Concerns**: Validation logic separate from role extraction
4. **Testing**: Easier to mock and test role resolution independently
5. **Flexibility**: Different services can use different claim structures

The abstraction also prepared for future multi-tenancy where each organization has its own realm.

#### Related Commits

- 21d6309e04 (Aug 14, 2024): Add KeycloakAccessTokenInterceptor for AirbyteApi client-credentials flow
- 3950b43ebb (Jul 10, 2024): Put Application clients in a single dedicated realm

---

### 8. SSO Draft and Activation Flow

**Commit:** fe1917ce1a - October 6, 2025
**Impact:** 10 files changed, 557 insertions, 55 deletions

#### What Changed

Introduced the draft/active status model for SSO configs, allowing organizations to configure and test SSO before activation. Added the `/sso_config/activate` endpoint and removed the requirement for email domain during draft creation.

**Key files modified:**
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/sso/SsoConfigDomainService.kt` (major refactor)
- `airbyte-data/src/main/kotlin/io/airbyte/data/services/SsoConfigService.kt` (new methods)

#### Implementation Details

Separation of draft and active creation logic:

```kotlin
open fun createSsoConfig(ssoConfig: SsoConfig): SsoConfig {
  return when (ssoConfig.status) {
    SsoConfigStatus.DRAFT -> createDraftSsoConfig(ssoConfig)
    SsoConfigStatus.ACTIVE -> createActiveSsoConfig(ssoConfig)
  }
}

private fun createDraftSsoConfig(config: SsoConfig) {
  validateDiscoveryUrl(config)

  if (config.emailDomain != null) {
    throw BadRequestProblem(
      ProblemMessageData()
        .message("Email domain should not be provided when creating a draft SSO config"),
    )
  }

  val existingConfig = ssoConfigService.getSsoConfig(config.organizationId)
  // ... draft creation logic
}

private fun createActiveSsoConfig(config: SsoConfig) {
  validateDiscoveryUrl(config)

  val configEmailDomain = config.emailDomain ?: throw BadRequestProblem(
    ProblemMessageData()
      .message("An email domain is required when creating an active SSO configuration."),
  )

  validateEmailDomainForActivation(config.organizationId, configEmailDomain, config.companyIdentifier)

  // ... active creation logic
}
```

Activation endpoint:

```kotlin
@Transactional("config")
open fun activateSsoConfig(
  organizationId: UUID,
  emailDomain: String,
): SsoConfig {
  val currentSsoConfig = ssoConfigService.getSsoConfig(organizationId)
    ?: throw SSOActivationProblem(
      ProblemSSOActivationData()
        .organizationId(organizationId)
        .errorMessage("No SSO configuration exists for this organization."),
    )

  if (currentSsoConfig.status.toDomain() == SsoConfigStatus.ACTIVE) {
    throw SSOActivationProblem(
      ProblemSSOActivationData()
        .organizationId(organizationId)
        .errorMessage("This SSO configuration is already active."),
    )
  }

  validateEmailDomainForActivation(organizationId, emailDomain, currentSsoConfig.keycloakRealm)

  try {
    ssoConfigService.updateSsoConfigStatus(organizationId, SsoConfigStatus.ACTIVE)
    organizationEmailDomainService.createOrganizationEmailDomain(
      OrganizationEmailDomain(
        organizationId = organizationId,
        emailDomain = emailDomain,
      )
    )
  } catch (e: Exception) {
    logger.error(e) { "Failed to activate SSO config for organization $organizationId" }
    throw e
  }

  return ssoConfigService.getSsoConfig(organizationId)!!
}
```

#### Business Value

This two-phase approach dramatically improved SSO safety:

1. **Risk Reduction**: Organizations can fully test SSO before activating
2. **Iteration**: Draft configs can be updated repeatedly without affecting users
3. **Validation**: Email domain only required at activation, not configuration
4. **Separation**: Clear distinction between "configuring" and "committing" SSO
5. **Rollback**: Can return to pre-activation state if issues arise

The status column migration (2eacc0d2e5) added the database foundation for this workflow.

#### Related Commits

- 2eacc0d2e5 (Sep 29, 2025): Add status column to SsoConfig table/model/entity
- 37c94eb19e (Oct 1, 2025): Add support for `status` in SSO Config APIs and domain
- 1afd3bf944 (Oct 7, 2025): Implement `sso_config/validate_token` endpoint

---

### 9. First SSO User Role Assignment

**Commit:** 6103a25502 - October 19, 2023
**Impact:** 9 files changed, 428 insertions, 108 deletions

#### What Changed

Implemented the critical business logic that the first SSO user in an organization becomes OrganizationAdmin, while subsequent users become OrganizationMember. This prevents organizations from getting locked out when SSO is first activated.

**Key files modified:**
- `airbyte-config/config-persistence/src/main/java/io/airbyte/config/persistence/PermissionPersistence.java` (enhanced with first-user detection)
- `airbyte-commons-server/src/main/java/io/airbyte/commons/server/handlers/PermissionHandler.java` (permission creation logic)

#### Implementation Details

Permission persistence checks if user is first in organization:

```java
public boolean isFirstUserInOrganization(UUID organizationId) {
  return ctx.fetchCount(
    DSL.selectFrom(PERMISSION)
      .where(PERMISSION.ORGANIZATION_ID.eq(organizationId))
  ) == 0;
}

public void createPermissionForUser(
  UUID userId,
  UUID organizationId,
  PermissionType permissionType
) throws IOException {
  try {
    ctx.insertInto(PERMISSION)
      .set(PERMISSION.ID, UUID.randomUUID())
      .set(PERMISSION.USER_ID, userId)
      .set(PERMISSION.ORGANIZATION_ID, organizationId)
      .set(PERMISSION.PERMISSION_TYPE, permissionType)
      .execute();
  } catch (DataAccessException e) {
    throw new IOException("Failed to create permission", e);
  }
}
```

Handler determines appropriate role:

```java
public void createPermissionForNewSSOUser(
  UUID userId,
  UUID organizationId
) throws IOException {
  boolean isFirstUser = permissionPersistence.isFirstUserInOrganization(organizationId);

  PermissionType permissionType = isFirstUser
    ? PermissionType.ORGANIZATION_ADMIN
    : PermissionType.ORGANIZATION_MEMBER;

  log.info("Creating {} permission for new SSO user {} in organization {} (first user: {})",
    permissionType, userId, organizationId, isFirstUser);

  permissionPersistence.createPermissionForUser(userId, organizationId, permissionType);
}
```

#### Business Value

This seemingly simple logic solved a critical UX problem:

1. **Prevents Lockout**: First user gets admin, can invite others and manage organization
2. **Security**: Subsequent users get limited permissions by default
3. **Intuitive**: Matches user expectations (person who sets up SSO should be admin)
4. **Zero-Config**: No manual permission assignment needed after SSO activation
5. **Audit Trail**: Clear logging of why users get specific roles

Without this, organizations would activate SSO and then have no way to administer the organization.

#### Related Commits

- 3021f7bf1b (Oct 26, 2023): Block new SSO users if an Organization cannot be found for their realm
- 8c643c4e62 (Oct 23, 2023): Default Workspace Creation for new users
- a497898732 (Oct 19, 2023): Include optional SsoRealm in OrganizationRead

---

### 10. Consolidate SSO API Problems

**Commit:** 83bfb7b0ef - October 9, 2025
**Impact:** 12 files changed, 409 insertions, 195 deletions

#### What Changed

Consolidated SSO error handling by defining standardized API problems for setup, activation, and validation failures. This replaced scattered exception handling with typed, well-documented error responses.

**Key files modified:**
- `airbyte-api/server-api/src/main/openapi/api-problems.yaml` (35 lines added)
- `airbyte-domain/services/src/main/kotlin/io/airbyte/domain/services/sso/SsoConfigDomainService.kt` (refactored error handling)

#### Implementation Details

New problem types defined in OpenAPI:

```yaml
SSOSetupProblem:
  type: object
  required:
    - problemType
    - data
  properties:
    problemType:
      type: string
      enum: [sso-setup]
    data:
      $ref: '#/components/schemas/ProblemSSOSetupData'

ProblemSSOSetupData:
  type: object
  required:
    - companyIdentifier
    - errorMessage
  properties:
    companyIdentifier:
      type: string
    errorMessage:
      type: string
    discoveryUrl:
      type: string

SSOActivationProblem:
  type: object
  required:
    - problemType
    - data
  properties:
    problemType:
      type: string
      enum: [sso-activation]
    data:
      $ref: '#/components/schemas/ProblemSSOActivationData'

ProblemSSOActivationData:
  type: object
  required:
    - organizationId
    - errorMessage
  properties:
    organizationId:
      type: string
      format: uuid
    companyIdentifier:
      type: string
    errorMessage:
      type: string
```

Usage in domain service:

```kotlin
private fun validateDiscoveryUrl(config: SsoConfig) {
  try {
    URL(config.discoveryUrl)
  } catch (e: MalformedURLException) {
    throw SSOSetupProblem(
      ProblemSSOSetupData()
        .companyIdentifier(config.companyIdentifier)
        .errorMessage("Invalid discovery URL: ${config.discoveryUrl}")
        .discoveryUrl(config.discoveryUrl),
    )
  }
}

private fun validateEmailDomainNotExists(
  emailDomain: String,
  organizationId: UUID,
  companyIdentifier: String,
) {
  val existingDomain = organizationEmailDomainService.getOrganizationEmailDomainByEmailDomain(emailDomain)
  if (existingDomain != null && existingDomain.organizationId != organizationId) {
    throw SSOActivationProblem(
      ProblemSSOActivationData()
        .organizationId(organizationId)
        .companyIdentifier(companyIdentifier)
        .errorMessage("Email domain '$emailDomain' is already in use by another organization."),
    )
  }
}
```

Frontend error messages in locales:

```json
{
  "settings.sso.error.setup": "SSO setup failed: {errorMessage}",
  "settings.sso.error.activation": "SSO activation failed: {errorMessage}",
  "settings.sso.error.validation": "SSO token validation failed: {errorMessage}",
  "settings.sso.error.discoveryUrl": "Invalid OIDC discovery URL. Please check the URL and try again."
}
```

#### Business Value

This consolidation improved both developer and user experience:

1. **Type Safety**: Compile-time checking of error data structures
2. **Consistency**: All SSO errors follow same pattern
3. **Documentation**: OpenAPI spec documents all possible errors
4. **Frontend Integration**: Generated TypeScript types for error handling
5. **Debugging**: Structured error data easier to log and analyze
6. **Localization**: Error messages easily translatable

The migration from generic exceptions to typed problems made SSO errors first-class API responses.

#### Related Commits

- 1afd3bf944 (Oct 7, 2025): Implement `sso_config/validate_token` endpoint
- 4e687527e1 (Oct 7, 2025): Add SSO configuration validation UI with two-step test and activate flow

---

## Technical Evolution

The commits tell a story of systematic SSO platform maturation across four major phases:

### 1. Foundation: Keycloak Integration (2023)

The work began in mid-2023 with establishing Keycloak as the SSO provider:

- **July 2023**: Initial Keycloak deployment and docker-compose integration (bdac4015b9, bc4d45e96b)
- **September 2023**: Cloud deployment and token validation (d8d0540629, 118dd2aab2)
- **October 2023**: Organization-realm mapping and first-user admin logic (a497898732, 6103a25502)
- **November 2023**: Realm naming and default workspace creation (0dbae32ea5, 8c643c4e62)

This phase focused on making Keycloak work in Airbyte's architecture and establishing basic SSO flows.

### 2. Stability & Operations (2024 Q1-Q2)

With the foundation in place, 2024 focused on production hardening:

- **February 2024**: Realm reset and IDP configuration improvements (d64570a321, 3c7e1b5251)
- **March 2024**: Keycloak version upgrade and stability improvements (7480a9a1c1, c0d1da6c4f, 9c81dbecd3)
- **April 2024**: Keycloak setup automation and configuration-as-code (2ab27f1189, de311f40cc, f3f77fc84e)

This phase addressed operational pain points: upgrades, volume mounts, configuration drift, and realm management.

### 3. Multi-Tenancy & Security (2024 Q3)

Mid-2024 brought multi-realm support and security improvements:

- **July 2024**: Dedicated Application clients realm (3950b43ebb)
- **August 2024**: Multi-realm token validation and Connector Builder support (d3eb6f902f, 21d6309e04)

This phase enabled proper isolation between organizations and services.

### 4. Enterprise Features: Draft/Activate Workflow (2025)

The most recent work built enterprise-grade SSO configuration:

- **September 2025**: Status column and draft/active model (2eacc0d2e5, 37c94eb19e)
- **October 2025**: Complete draft workflow, validation UI, and activation flow (fe1917ce1a, 4e687527e1, 1afd3bf944, 866d7bae4d, 83bfb7b0ef, 8680bf33f3, 02d96c8167)
- **November 2025**: Domain verification system (af83de265f, a229cedc02, cc298d242e, c7596a6c84)

This phase transformed SSO from "activate and hope" to a safe, testable, enterprise-ready workflow.

### Technology Choices

The evolution shows deliberate technology decisions:

- **Keycloak**: Industry-standard, self-hosted identity provider
- **JNDI DNS**: Built-in Java DNS resolution, no external dependencies
- **State Machine**: Explicit draft/active states for safe configuration
- **OpenAPI Problems**: Typed error responses following RFC 7807
- **React Hooks**: Modern frontend patterns for SSO test flow
- **Exponential Backoff**: Smart retry logic balancing speed and load

---

## Impact Summary

Parker's contributions to SSO & Domain Verification represent a complete implementation of enterprise authentication for Airbyte. The work enabled Airbyte to support Fortune 500 companies with complex identity requirements while maintaining the simplicity needed for smaller teams.

### Quantitative Impact

- **49 commits** over 28 months
- **~9,500 lines** of code changes
- **Major features delivered:**
  - Complete Keycloak integration and deployment automation
  - Draft/Active SSO configuration workflow
  - DNS-based domain verification system
  - Multi-realm token validation
  - SSO test and validation UI
  - First-user admin assignment
  - Domain conflict prevention

### Qualitative Impact

**For Organizations:**
- Safe SSO setup with test-before-activate workflow
- Automatic domain verification preventing unauthorized SSO
- First user automatically becomes admin (no lockout)
- Clear error messages guide configuration
- Draft configs enable iteration without risk

**For Developers:**
- Configuration-as-code for Keycloak (no manual setup)
- Comprehensive error handling with typed problems
- Multi-realm architecture supports multiple services
- Well-tested DNS verification (192 test lines)
- Clean separation of draft and active logic

**For Platform Operations:**
- Automated Keycloak updates on deployment
- Exponential backoff reduces DNS query load
- Metrics and monitoring for domain verification
- Graceful degradation when Keycloak/DB out of sync
- Production-hardened error recovery

### Key Architectural Patterns

The work established several important patterns:

1. **Draft/Active State Machine**: Separate configuration from activation for safety
2. **Managed Resources**: `airbyte-managed-idp` key enables infrastructure-as-code
3. **Exponential Backoff**: Tiered checking (frequent → exponential) balances UX and load
4. **Token Realm Extraction**: Validates tokens without maintaining realm mappings
5. **Compensating Transactions**: Manual cleanup when external services can't participate in DB transactions
6. **Problem Types**: Structured errors following RFC 7807 for API consistency
7. **Multi-Realm Abstraction**: `TokenRoleResolver` enables service-specific role logic

### Security Highlights

Several commits specifically addressed security concerns:

1. **Domain Verification**: Prevents unauthorized SSO activation (af83de265f)
2. **Cross-Organization Protection**: Blocks SSO activation when domain in use elsewhere (02d96c8167)
3. **Realm Validation**: Ensures tokens belong to correct organization (1afd3bf944)
4. **First User Admin**: Prevents lockout scenarios (6103a25502)
5. **Draft Isolation**: Test SSO without affecting production users (fe1917ce1a)

### Infrastructure as Code

The Keycloak setup automation (2ab27f1189) was transformational:

- Eliminated manual realm configuration
- Enabled GitOps workflows for identity provider changes
- Reduced deployment complexity
- Improved consistency across environments
- Made Keycloak configuration auditable and version-controlled

This single commit reduced operational toil by hours per deployment and eliminated an entire class of configuration drift bugs.

### User Experience

The SSO validation flow (4e687527e1, 1afd3bf944) represented a major UX improvement:

- Organizations can test SSO in a popup without committing
- Clear multi-step wizard guides configuration
- Immediate feedback on misconfiguration
- No risk of locking out users during testing

This transformed SSO setup from a high-risk, one-shot operation to an iterative, low-risk process.

This foundation enables Airbyte to support enterprise customers with the most stringent authentication and compliance requirements while maintaining a simple, safe setup experience.
