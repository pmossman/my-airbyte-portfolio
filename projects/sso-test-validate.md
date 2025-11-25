# SSO Test/Validate Workflow

## Overview
- **Time Period:** September - October 2025 (~6 weeks)
- **Lines of Code:** ~2,200 additions
- **Files Changed:** 35+ files
- **Key Technologies:** Kotlin, React, Keycloak, OAuth/OIDC, TypeScript

One-paragraph summary: Implemented a comprehensive two-step "test and activate" workflow for SSO configuration, allowing organizations to validate their SSO setup before activating it. Includes draft SSO configs, a React-based validation UI with OAuth popup handling, token validation endpoints, and comprehensive error handling with typed API problems.

## Problem Statement
Previously, activating SSO was a one-shot operation with no safety net. If the configuration was wrong, users could get locked out of their organization. Administrators needed a way to test their SSO configuration before committing to activation.

## Solution Architecture
Designed a multi-phase SSO workflow:
1. **Draft Config** - Create SSO config without activating
2. **Test Flow** - OAuth popup validates configuration
3. **Token Validation** - API verifies token belongs to correct realm
4. **Activation** - Commit SSO config with email domain

Key innovations:
- **Draft/Active state machine** - Separate configuration from commitment
- **Test user isolation** - Test flow doesn't affect production users
- **Realm validation** - Ensures tokens match organization's Keycloak realm

## Implementation Details

### Draft/Active State Model

Database migration added status column:

```kotlin
@Transactional("config")
open fun createSsoConfig(ssoConfig: SsoConfig): SsoConfig {
  return when (ssoConfig.status) {
    SsoConfigStatus.DRAFT -> createDraftSsoConfig(ssoConfig)
    SsoConfigStatus.ACTIVE -> createActiveSsoConfig(ssoConfig)
  }
}

private fun createDraftSsoConfig(config: SsoConfig) {
  validateDiscoveryUrl(config)

  // Email domain NOT required for draft
  if (config.emailDomain != null) {
    throw BadRequestProblem("Email domain should not be provided for draft")
  }

  val existingConfig = ssoConfigService.getSsoConfig(config.organizationId)
  when {
    existingConfig == null -> createNewDraftSsoConfig(config)
    existingConfig.keycloakRealm != config.companyIdentifier -> {
      deleteSsoConfig(existingConfig)
      createNewDraftSsoConfig(config)
    }
    airbyteKeycloakClient.realmExists(config.companyIdentifier) -> {
      updateExistingKeycloakRealmConfig(config)
    }
    else -> {
      // Realm missing but DB record exists - recreate
      createKeycloakRealmWithErrorHandling(config)
    }
  }
}
```

### React Validation UI

Multi-step wizard with OAuth popup:

```typescript
export const SSOSettingsValidation: React.FC<Props> = ({
  organizationId,
  onActivate,
  onCancel,
}) => {
  const [step, setStep] = useState<ValidationStep>("configure");
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");

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

  return (
    <div className={styles.validationContainer}>
      {step === "configure" && (
        <ConfigurationStep
          onTest={handleTestClick}
          testStatus={testStatus}
        />
      )}
      {step === "activate" && (
        <ActivationStep
          onActivate={handleActivate}
          onBack={() => setStep("configure")}
        />
      )}
      {step === "complete" && <CompletionStep />}
    </div>
  );
};
```

### Token Validation Endpoint

Validates tokens belong to correct organization realm:

```kotlin
fun validateToken(organizationId: UUID, accessToken: String) {
  val ssoConfig = ssoConfigService.getSsoConfig(organizationId)
    ?: throw SSOTokenValidationProblem("SSO config not found")

  // Extract realm from token issuer
  val tokenRealm = airbyteKeycloakClient.extractRealmFromToken(accessToken)

  // Verify realm matches organization's config
  if (tokenRealm != ssoConfig.keycloakRealm) {
    throw SSOTokenValidationProblem(
      "Token does not belong to realm ${ssoConfig.keycloakRealm}"
    )
  }

  // Validate token with Keycloak
  try {
    airbyteKeycloakClient.validateTokenWithRealm(
      accessToken,
      ssoConfig.keycloakRealm
    )
  } catch (e: TokenExpiredException) {
    throw SSOTokenValidationProblem("Token is expired")
  } catch (e: InvalidTokenException) {
    throw SSOTokenValidationProblem("Token is invalid: ${e.message}")
  }
}
```

### Keycloak Realm Cleanup on Failure

Proper cleanup when configuration fails:

```kotlin
fun createOidcSsoConfig(request: SsoConfig) {
  keycloakAdminClient.realms().create(realmRepresentation)

  try {
    val idpConfig = importIdpConfig(request.discoveryUrl)
    createIdpForRealm(request.companyIdentifier, idpConfig)
    createClientForRealm(request.companyIdentifier, airbyteWebappClient)
  } catch (e: Exception) {
    // Cleanup on failure - prevent orphaned realms
    try {
      deleteRealm(request.companyIdentifier)
    } catch (cleanupEx: Exception) {
      logger.error { "Failed to cleanup realm after config failure" }
    }
    throw e
  }
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| 2eacc0d2e5 | Sep 29, 2025 | Add status column to SsoConfig | Schema foundation |
| fe1917ce1a | Oct 6, 2025 | Draft/activate workflow and endpoints | Core workflow |
| 4e687527e1 | Oct 7, 2025 | SSO validation UI with test flow | Frontend |
| 1afd3bf944 | Oct 7, 2025 | Token validation endpoint | API |
| 866d7bae4d | Oct 8, 2025 | Realm cleanup and user preservation | Error handling |
| 83bfb7b0ef | Oct 9, 2025 | Consolidated SSO API problems | Error types |

## Business Value

### User Impact
- **Risk Mitigation**: Test SSO before activating - no lockout scenarios
- **Clear Workflow**: Multi-step wizard guides configuration
- **Immediate Feedback**: OAuth popup provides instant validation results
- **Iteration Support**: Draft configs can be updated repeatedly

### Business Impact
- **Enterprise Enablement**: Safe SSO setup builds customer confidence
- **Reduced Support**: Self-service testing reduces configuration support tickets
- **Compliance**: Documented test flow supports audit requirements

### Technical Impact
- **Clean State Machine**: Explicit draft/active states prevent invalid configurations
- **Proper Cleanup**: Keycloak realms cleaned up on failure
- **User Preservation**: Updating drafts doesn't delete test users
- **Type-Safe Errors**: OpenAPI problem types enable proper error handling

## Lessons Learned / Patterns Used

### State Machine for Configuration
Separating draft and active states enables:
- Safe iteration on configuration
- Clear validation gates before activation
- Rollback capability if issues arise

### OAuth Popup Pattern
Using window.open() for SSO test enables:
- Isolated authentication context
- Parent window notification via postMessage
- Clean cancellation handling

```typescript
const popup = window.open(
  `/sso/test?organization_id=${organizationId}`,
  "sso-test",
  "width=500,height=600"
);

window.addEventListener("message", (event) => {
  if (event.data.type === "sso-test-success") {
    onSuccess();
  }
});
```

### Compensating Transactions
When database and external systems (Keycloak) can't be in same transaction:
1. Create external resource first
2. Then create database record
3. If database fails, cleanup external resource

```kotlin
/**
 * NOT @Transactional because Keycloak operations can't be rolled back
 * via database transactions. Manual cleanup on failure instead.
 */
```
