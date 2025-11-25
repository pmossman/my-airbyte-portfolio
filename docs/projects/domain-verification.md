# Domain Verification System

## Overview
- **Time Period:** October - November 2025 (~2 months)
- **Lines of Code:** ~1,500 additions
- **Files Changed:** 16 files
- **Key Technologies:** Kotlin, DNS/JNDI, Cron scheduling, Micronaut

One-paragraph summary: Implemented a complete DNS-based domain verification system enabling organizations to prove ownership of their email domains before activating SSO. The system includes automated DNS TXT record checking with intelligent exponential backoff, RFC 1464 compliance for record parsing, and comprehensive UI integration.

## Problem Statement
Enterprise customers deploying SSO needed a way to prove they own the email domains they want to configure for single sign-on. Without domain verification, malicious actors could potentially configure SSO for domains they don't own, creating security vulnerabilities and potential account takeover scenarios.

## Solution Architecture
Designed a three-component system:
1. **DNS Verification Service** - Uses Java's JNDI for DNS lookups without external dependencies
2. **Domain Verification Cron Job** - Automated checking with tiered exponential backoff
3. **API & UI Integration** - Full workflow for creating, checking, and managing verification requests

The architecture prioritizes:
- **Zero external dependencies** - Uses Java's built-in JNDI DNS resolver
- **User responsiveness** - Fast checks in first hour, then backoff
- **System efficiency** - Exponential backoff reduces load for persistent failures

## Implementation Details

### DNS Verification Service

Core service for DNS TXT record lookup and verification:

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

      val found = txtRecords.any { record ->
        val recordParsed = parseRfc1464Record(record)
        recordParsed != null && recordsMatch(expectedParsed, recordParsed)
      }

      when {
        found -> DnsVerificationResult.Verified
        txtRecords.isEmpty() -> DnsVerificationResult.NotFound
        else -> DnsVerificationResult.Misconfigured(parsedRecords)
      }
    } catch (e: Exception) {
      DnsVerificationResult.NotFound
    }
  }
}
```

### Exponential Backoff Cron Job

Intelligent scheduling with tiered checking frequency:

```kotlin
@Singleton
open class DomainVerificationJob(
  private val airbyteApiClient: AirbyteApiClient,
) {
  companion object {
    const val FREQUENT_CHECK_THRESHOLD = 60 // First hour: every minute
    const val MAX_BACKOFF_MINUTES = 60L     // Cap at 1 hour
  }

  @Scheduled(fixedRate = "1m")
  open fun checkPendingDomainVerifications() {
    val verifications = listPendingDomainVerifications()
    val verificationsToCheck = verifications.filter { shouldCheckFrom(it, now) }

    verificationsToCheck.forEach { verification ->
      checkDomainVerification(verification.id)
    }
  }

  private fun shouldCheckFrom(verification, from): Boolean {
    if (verification.attempts < FREQUENT_CHECK_THRESHOLD) return true

    // Exponential backoff: 1, 2, 4, 8, 16, 32, 60 (capped)
    val attemptsOverThreshold = attempts - FREQUENT_CHECK_THRESHOLD
    val backoffMinutes = min(2.0.pow(attemptsOverThreshold), MAX_BACKOFF_MINUTES)
    return minutesSinceLastCheck >= backoffMinutes
  }
}
```

### RFC 1464 Compliance

Proper parsing of DNS TXT records following the standard:

```kotlin
internal fun parseRfc1464Record(record: String): Pair<String, String>? {
  val cleanRecord = record.trim().removeSurrounding("\"")

  // Find first unquoted equals sign (` is escape character per RFC 1464)
  var equalsIndex = -1
  var i = 0
  while (i < cleanRecord.length) {
    when (cleanRecord[i]) {
      '`' -> i++ // Skip escaped character
      '=' -> { equalsIndex = i; break }
    }
    i++
  }

  if (equalsIndex <= 0) return null

  return Pair(
    cleanRecord.take(equalsIndex),
    cleanRecord.substring(equalsIndex + 1)
  )
}
```

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|
| [af83de265f](https://github.com/airbytehq/airbyte-platform/commit/af83de265f) | Nov 5, 2025 | DNS verification service and cron job | 16 files, 1,436 insertions |
| [a229cedc02](https://github.com/airbytehq/airbyte-platform/commit/a229cedc02) | Nov 14, 2025 | Delete and reset buttons for Domain Verification UI | UI enhancements |
| [cc298d242e](https://github.com/airbytehq/airbyte-platform/commit/cc298d242e) | Nov 13, 2025 | "View DNS Info" button for existing verifications | Improved UX |
| [c7596a6c84](https://github.com/airbytehq/airbyte-platform/commit/c7596a6c84) | Nov 13, 2025 | SSO activation button changes for domain verification | Workflow integration |

## Business Value

### User Impact
- **Security**: Prevents unauthorized SSO activation by requiring proof of domain ownership
- **User Experience**: Immediate feedback in first hour (60 checks), no waiting
- **Self-Service**: Organizations can verify domains without contacting support

### Business Impact
- **Enterprise Enablement**: Required feature for enterprise SSO deployments
- **Risk Mitigation**: Prevents account takeover scenarios via SSO misconfiguration
- **Compliance**: Demonstrates due diligence for SOC 2 and similar frameworks

### Technical Impact
- **Zero Dependencies**: Uses Java's built-in JNDI, no external libraries
- **Efficient Design**: Exponential backoff reduces DNS query load by ~90% after first hour
- **RFC Compliant**: Proper RFC 1464 parsing ensures compatibility with all DNS providers

## Lessons Learned / Patterns Used

### Tiered Exponential Backoff
The two-phase approach (aggressive then conservative) balances user experience with system load:
- Phase 1: Check every minute for first hour (immediate feedback)
- Phase 2: Exponential backoff capped at 60 minutes (resource efficiency)

### JNDI DNS Lookups
Using Java's built-in JNDI eliminates external dependencies while providing reliable DNS resolution:
```kotlin
val env = Properties().apply {
  setProperty(Context.INITIAL_CONTEXT_FACTORY, "com.sun.jndi.dns.DnsContextFactory")
  setProperty(Context.PROVIDER_URL, "dns:")
  setProperty("com.sun.jndi.dns.timeout.initial", "5000")
}
val context = InitialDirContext(env)
val attributes = context.getAttributes(hostname, arrayOf("TXT"))
```

### Sealed Result Types
Using Kotlin sealed classes for verification results enables exhaustive pattern matching:
```kotlin
sealed class DnsVerificationResult {
  object Verified : DnsVerificationResult()
  object NotFound : DnsVerificationResult()
  data class Misconfigured(val found: List<String>) : DnsVerificationResult()
}
```
