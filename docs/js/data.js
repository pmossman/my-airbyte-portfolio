/**
 * Structured Data - Domains, Commits, and Projects
 * Extracted from Parker Mossman's Airbyte contribution analysis
 */

const REPO_BASE = 'https://github.com/airbytehq/airbyte-platform';

const DOMAINS = [
  {
    id: 'organizations',
    name: 'Organizations & User Management',
    shortName: 'Organizations',
    color: '#da3633',
    commitCount: 63,
    period: { start: '2022-05', end: '2025-10' },
    technologies: ['java', 'kotlin', 'postgresql', 'jooq'],
    description: 'Organization CRUD operations, user management, org-level operations, and major refactoring of OrganizationPersistence to OrganizationService.',
    highlights: [
      'Migrated OrganizationPersistence to OrganizationService architecture',
      'Implemented user management across organization boundaries',
      'Enhanced organization-level operations and APIs',
      'Improved handling of users across multiple organizations'
    ],
    keyCommits: [
      { hash: '6d977582ff', message: 'refactor: migrate OrganizationPersistence to OrganizationService (2nd attempt)', date: '2025-10' },
      { hash: '02d96c8167', message: 'feat: block sso activation if domain is in use by users in another org', date: '2025-10' },
      { hash: '72aaef63bf', message: 'chore: include organizations for user that come from non-organization permission records', date: '2025-08' }
    ]
  },
  {
    id: 'cicd',
    name: 'CI/CD & Build Infrastructure',
    shortName: 'CI/CD',
    color: '#a371f7',
    commitCount: 59,
    period: { start: '2022-01', end: '2025-08' },
    technologies: ['github-actions', 'docker', 'helm', 'gradle'],
    description: 'GitHub Actions workflows, Docker builds, Helm chart management, deployment automation, and build system improvements.',
    highlights: [
      'Maintained Helm chart versioning (40+ version bump commits)',
      'Improved build efficiency and Docker image management',
      'Enhanced deployment automation for Cloud environments',
      'Set up EC2 runners for release workflows'
    ],
    keyCommits: [
      { hash: '5dbeec9cea', message: 'chore: fix local Cloud deploys', date: '2025-08' },
      { hash: '9cff110510', message: 'Run the \'Release Airbyte\' workflow on EC2 runners', date: '2022-01' },
      { hash: '189efe7b42', message: 'Build OSS branch for deploying to Cloud env', date: '2022-04' }
    ]
  },
  {
    id: 'api',
    name: 'API Development',
    shortName: 'APIs',
    color: '#58a6ff',
    commitCount: 52,
    period: { start: '2021-12', end: '2025-11' },
    technologies: ['java', 'kotlin', 'openapi', 'micronaut', 'rest'],
    description: 'REST API endpoint implementation, handler logic, controller development, and public API enhancements.',
    highlights: [
      'Migrated Cloud Server to Micronaut framework',
      'Optimized API performance with efficient queries',
      'Created lightweight job endpoints for faster responses',
      'Developed internal APIs for dataplane health monitoring'
    ],
    keyCommits: [
      { hash: 'a6ffc51ec6', message: 'Migrate Cloud-Server to Micronaut (All changes together)', date: '2023-05' },
      { hash: '39a14b7306', message: 'Efficient queries for connection list', date: '2022-10' },
      { hash: '1d29672122', message: 'Add jobInfoLight API endpoint that excludes attempt information', date: '2022-09' },
      { hash: 'c231086441', message: 'feat: add internal API for dataplane health monitoring', date: '2025-11' },
      { hash: '83bfb7b0ef', message: 'refactor: consolidate SSO API problems and improve error handling', date: '2025-10' }
    ]
  },
  {
    id: 'sso',
    name: 'SSO & Domain Verification',
    shortName: 'SSO',
    color: '#f0883e',
    commitCount: 49,
    period: { start: '2023-07', end: '2025-11' },
    technologies: ['keycloak', 'kotlin', 'java', 'saml', 'oauth', 'dns'],
    description: 'Single Sign-On implementation, domain verification system, Keycloak integration, and SAML/OAuth support.',
    highlights: [
      'Established Keycloak SSO foundation for enterprise',
      'Built complete domain verification system with DNS checking',
      'Implemented SSO user provisioning and first-user admin flow',
      'Created two-step test and activate flow for SSO configs'
    ],
    keyCommits: [
      { hash: 'd8d0540629', message: 'Include Keycloak in Cloud Deploys, fix cloud auth for keycloak tokens', date: '2023-09' },
      { hash: '6103a25502', message: 'SSO: First user signed up in Org gets OrganizationAdmin', date: '2023-10' },
      { hash: '8c643c4e62', message: '[Cloud SSO] Default Workspace Creation for new users', date: '2023-10' },
      { hash: 'af83de265f', message: 'feat: add domain verification cronjob and DNS verification service', date: '2025-11' },
      { hash: '4e687527e1', message: 'feat: add SSO configuration validation UI with two-step test and activate flow', date: '2025-10' }
    ]
  },
  {
    id: 'config',
    name: 'Configuration & Settings',
    shortName: 'Config',
    color: '#8b949e',
    commitCount: 45,
    period: { start: '2022-02', end: '2025-10' },
    technologies: ['java', 'kotlin', 'yaml', 'micronaut'],
    description: 'Application configuration management, environment variables, settings infrastructure, and SSO config handling.',
    highlights: [
      'Implemented flexible configuration for draft SSO configs',
      'Added redirect URI information and copy functionality',
      'Managed code exchange between frontend and backend',
      'Enhanced environment variable management'
    ],
    keyCommits: [
      { hash: '252c085e7d', message: 'feat: show redirect URI info and copy buttons during SSO config setup', date: '2025-10' },
      { hash: '4edea0b534', message: 'chore: move SSO config validation code exchange to backend', date: '2025-10' },
      { hash: '37c94eb19e', message: 'feat: add support for status in SSO Config APIs and domain', date: '2025-10' }
    ]
  },
  {
    id: 'temporal',
    name: 'Temporal Workflows',
    shortName: 'Temporal',
    color: '#3fb950',
    commitCount: 40,
    period: { start: '2021-12', end: '2025-11' },
    technologies: ['temporal', 'java', 'kotlin'],
    description: 'Temporal Cloud setup, workflow management, scheduled activities, and cron job implementation.',
    highlights: [
      'Migrated to Temporal Cloud with SSL/TLS authentication',
      'Implemented schedule jitter for load distribution',
      'Created dataplane heartbeat cleanup workflows',
      'Built billing grace period workflows'
    ],
    keyCommits: [
      { hash: 'cd15c25ab6', message: 'Configure SSL/TLS connection to Temporal Cloud', date: '2022-06' },
      { hash: 'd1c48feaed', message: 'Add configurable schedule jitter based on bucketed wait time', date: '2023-06' },
      { hash: 'af83de265f', message: 'feat: add domain verification cronjob and DNS verification service', date: '2025-11' },
      { hash: '1bd22a13f0', message: 'feat: add dataplane heartbeat cleanup cron job', date: '2025-11' },
      { hash: '0242eb6c1a', message: 'feat: billing GracePeriod Temporal workflow implementation', date: '2024-10' }
    ]
  },
  {
    id: 'permissions',
    name: 'Permissions & Access Control',
    shortName: 'Permissions',
    color: '#da3633',
    commitCount: 34,
    period: { start: '2023-03', end: '2025-10' },
    technologies: ['java', 'kotlin', 'postgresql'],
    description: 'RBAC implementation, permission handling, access control, authorization, and entitlement management.',
    highlights: [
      'Built enterprise RBAC with granular permission-based roles',
      'Implemented permission hierarchy with org-to-workspace inheritance',
      'Added @Secured annotations to all endpoints',
      'Improved instance admin authorization checks'
    ],
    keyCommits: [
      { hash: '630ae7e7c9', message: 'RBAC: Org-level permissions grant workspace-level access', date: '2023-10' },
      { hash: 'cc3010471c', message: 'RBAC: Incrementally add @Secured annotations to OSS API endpoints', date: '2023-11' },
      { hash: '938e4bdc38', message: 'Enterprise RBAC: Replace instance_admin with permission-based roles', date: '2023-12' },
      { hash: '10a57bfc10', message: 'feat: allow org admins to call dataplane and dataplane group endpoints', date: '2025-09' },
      { hash: 'd2991e202e', message: 'chore: allow workspace-level users to call organizations/get_organization_info', date: '2025-08' }
    ]
  },
  {
    id: 'workspace',
    name: 'Workspace Management',
    shortName: 'Workspace',
    color: '#58a6ff',
    commitCount: 33,
    period: { start: '2022-10', end: '2025-09' },
    technologies: ['java', 'kotlin', 'postgresql', 'jooq'],
    description: 'Workspace CRUD operations, workspace-level operations, and dataplane group assignment.',
    highlights: [
      'Implemented dataplane group assignment validation',
      'Enhanced workspace listing with permission filtering',
      'Improved workspace creation/update flows',
      'Set Cloud-specific default geography handling'
    ],
    keyCommits: [
      { hash: '205afe57c0', message: 'feat: validate dataplane group assignment during Workspace create and update', date: '2025-09' },
      { hash: '1fa14d6294', message: 'chore: filter workspaces based on user permission', date: '2025-08' },
      { hash: '8b94df3d9d', message: 'fix: set Cloud-specific default geography everywhere a workspace is persisted', date: '2025-03' }
    ]
  },
  {
    id: 'billing',
    name: 'Billing & Payments',
    shortName: 'Billing',
    color: '#d29922',
    commitCount: 31,
    period: { start: '2023-02', end: '2025-04' },
    technologies: ['java', 'kotlin', 'stripe', 'orb', 'temporal'],
    description: 'Billing system implementation, Orb integration, Stripe webhooks, subscription management, and payment infrastructure.',
    highlights: [
      'Integrated Orb billing platform',
      'Implemented grace period workflows and management',
      'Built subscription status handling',
      'Created Stripe webhook processing'
    ],
    keyCommits: [
      { hash: '0242eb6c1a', message: 'feat: billing GracePeriod Temporal workflow implementation', date: '2024-10' },
      { hash: '6ecbdcab81', message: 'feat: disable connections when an invoice is marked uncollectible or a grace period ends', date: '2024-11' },
      { hash: '9966400f1d', message: 'feat: add /api/v1/billing/complete_checkout_session', date: '2024-09' }
    ]
  },
  {
    id: 'database',
    name: 'Database Schema & Migrations',
    shortName: 'Database',
    color: '#3fb950',
    commitCount: 29,
    period: { start: '2022-01', end: '2025-10' },
    technologies: ['postgresql', 'flyway', 'jooq', 'sql'],
    description: 'Database migrations, schema changes, table modifications, foreign key management, and index optimization.',
    highlights: [
      'Added dataplane heartbeat logging tables',
      'Created SsoConfig status column',
      'Implemented SecretReferences tables',
      'Dropped legacy foreign key columns'
    ],
    keyCommits: [
      { hash: '19029247c8', message: 'feat: add database foundation for dataplane heartbeat logging', date: '2025-10' },
      { hash: '2eacc0d2e5', message: 'feat: (contains migration) add status column to SsoConfig table/model/entity', date: '2025-09' },
      { hash: 'c4dad82dbe', message: 'feat: contains migration - create SecretReferences tables/entities/repositories', date: '2025-03' }
    ]
  },
  {
    id: 'connectors',
    name: 'Sources & Destinations',
    shortName: 'Connectors',
    color: '#39c5cf',
    commitCount: 23,
    period: { start: '2021-12', end: '2025-04' },
    technologies: ['java', 'kotlin', 'postgresql'],
    description: 'Source/destination management, connector definitions, actor operations, and spec job handling.',
    highlights: [
      'Converted services to Kotlin',
      'Implemented source/destination secret writing',
      'Removed legacy clone endpoints',
      'Added soft delete functionality for actor definitions'
    ],
    keyCommits: [
      { hash: '98137c70d8', message: 'chore: move source/destination secret writing from jooq layer to handler layer', date: '2025-03' },
      { hash: '4e57eee384', message: 'chore: convert Source/DestinationServiceJooqImpl to kotlin', date: '2025-03' },
      { hash: '9dfd0daf0a', message: 'Add API endpoint and handlers to delete SourceDefinitions and DestinationDefinitions', date: '2021-12' }
    ]
  },
  {
    id: 'connections',
    name: 'Connections & Auto-disable',
    shortName: 'Connections',
    color: '#db61a2',
    commitCount: 19,
    period: { start: '2022-03', end: '2024-12' },
    technologies: ['java', 'kotlin', 'postgresql', 'temporal'],
    description: 'Connection lifecycle management, auto-disable feature implementation, and failure handling.',
    highlights: [
      'Implemented connection auto-disable based on consecutive failures',
      'Integrated billing status into connection validity',
      'Enhanced connection deletion handling',
      'Built notification system for auto-disabled connections'
    ],
    keyCommits: [
      { hash: '6ecbdcab81', message: 'feat: disable connections when an invoice is marked uncollectible or a grace period ends', date: '2024-11' },
      { hash: 'e83b4be951', message: 'fix: only auto-disable connections if both consecutive failure count and day thresholds are met', date: '2024-11' },
      { hash: '86430ee8e5', message: 'fix: prevent deleted connections from returning as inactive', date: '2024-12' }
    ]
  },
  {
    id: 'refactoring',
    name: 'Code Refactoring',
    shortName: 'Refactoring',
    color: '#8b949e',
    commitCount: 17,
    period: { start: '2023-05', end: '2025-11' },
    technologies: ['java', 'kotlin'],
    description: 'Code refactoring, cleanup, consolidation, and language migrations (Java to Kotlin).',
    highlights: [
      'Migrated key services to Kotlin',
      'Consolidated duplicate code patterns',
      'Improved code organization in new airbyte-domain module',
      'Enhanced maintainability across the codebase'
    ],
    keyCommits: [
      { hash: '6d977582ff', message: 'refactor: migrate OrganizationPersistence to OrganizationService', date: '2025-10' },
      { hash: '4e57eee384', message: 'chore: convert Source/DestinationServiceJooqImpl to kotlin', date: '2025-03' },
      { hash: '52218b10dc', message: 'chore: cleanup pass over new airbyte-domain module', date: '2025-03' }
    ]
  },
  {
    id: 'dataplane',
    name: 'Dataplane Management',
    shortName: 'Dataplane',
    color: '#39c5cf',
    commitCount: 14,
    period: { start: '2025-03', end: '2025-11' },
    technologies: ['kotlin', 'java', 'postgresql', 'temporal'],
    description: 'Dataplane health monitoring, heartbeat logging, region management, and dataplane group operations.',
    highlights: [
      'Built dataplane health monitoring API',
      'Implemented heartbeat logging and cleanup',
      'Created region and dataplane CRUD operations',
      'Added dataplane group assignment and validation'
    ],
    keyCommits: [
      { hash: 'c231086441', message: 'feat: add internal API for dataplane health monitoring', date: '2025-11' },
      { hash: '1591a4e44a', message: 'feat: add service layer for dataplane heartbeat logging', date: '2025-11' },
      { hash: '1bd22a13f0', message: 'feat: add dataplane heartbeat cleanup cron job', date: '2025-11' }
    ]
  },
  {
    id: 'jobs',
    name: 'Job & Attempt Tracking',
    shortName: 'Jobs',
    color: '#f0883e',
    commitCount: 14,
    period: { start: '2022-01', end: '2025-11' },
    technologies: ['java', 'kotlin', 'postgresql'],
    description: 'Job execution tracking, attempt tracking, failure reporting, and per-stream statistics.',
    highlights: [
      'Implemented AttemptFailureSummary and FailureReason tracking',
      'Added per-stream record counts and stats',
      'Built configurable schedule jitter system',
      'Enhanced job cancellation handling'
    ],
    keyCommits: [
      { hash: 'd1c48feaed', message: 'Add configurable schedule jitter based on bucketed wait time', date: '2023-06' },
      { hash: '3c3b8ee53e', message: 'Bring back negative jitter for non-cron schedules', date: '2023-07' },
      { hash: 'bf9e9cae38', message: 'Track per-stream record counts and records committed, and other sync summary metadata', date: '2022-01' },
      { hash: '01f4675a59', message: 'Add AttemptFailureSummary to API response', date: '2022-02' },
      { hash: '191f93cb8d', message: 'Set Attempt to failed status when Job is cancelled', date: '2022-02' }
    ]
  },
  {
    id: 'secrets',
    name: 'Secrets Management',
    shortName: 'Secrets',
    color: '#da3633',
    commitCount: 13,
    period: { start: '2024-10', end: '2025-09' },
    technologies: ['kotlin', 'java', 'postgresql', 'aws', 'gcp', 'vault'],
    description: 'Secret storage, external secrets, secret coordination and reference management, dual-write implementation.',
    highlights: [
      'Created SecretStorage and SecretReferences infrastructure',
      'Implemented dual-write for secret references',
      'Added external vs Airbyte-managed secret distinction',
      'Built bootloader secret creation'
    ],
    keyCommits: [
      { hash: 'e29ae7da90', message: 'feat: create default secret storage in Bootloader', date: '2025-04' },
      { hash: '2e601f1aff', message: 'feat: dual-write secret reference IDs alongside coordinates in configs', date: '2025-04' },
      { hash: 'c4dad82dbe', message: 'feat: contains migration - create SecretReferences tables/entities/repositories', date: '2025-03' }
    ]
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes & Infrastructure',
    shortName: 'Kubernetes',
    color: '#58a6ff',
    commitCount: 13,
    period: { start: '2022-02', end: '2024-07' },
    technologies: ['kubernetes', 'helm', 'docker', 'yaml'],
    description: 'Kubernetes configuration, pod management, container setup, and volume management.',
    highlights: [
      'Deployed Keycloak to Kubernetes with clustering',
      'Set up connector pod initialization with timeouts',
      'Enhanced pod process configuration per job type',
      'Fixed service-account helm template issues'
    ],
    keyCommits: [
      { hash: 'd8d0540629', message: 'Include Keycloak in Cloud Deploys, fix cloud auth for keycloak tokens', date: '2023-09' },
      { hash: '18bf4b6030', message: 'Add more keycloak replicas with RollingUpdate', date: '2023-10' },
      { hash: 'b0640f43f8', message: 'Set kubernetes cache-stack mode for keycloak server', date: '2023-11' },
      { hash: 'cc663f154b', message: 'fix: service-account helm template no longer loses pod permission during upgrade', date: '2024-07' },
      { hash: '34be57c4c1', message: 'Add timeout to connector pod init container command', date: '2022-02' },
      { hash: 'b742a451a0', message: 'Configure kube pod process per job type', date: '2022-02' }
    ]
  },
  {
    id: 'analytics',
    name: 'Analytics & Segment',
    shortName: 'Analytics',
    color: '#d29922',
    commitCount: 9,
    period: { start: '2024-04', end: '2025-04' },
    technologies: ['java', 'kotlin', 'segment'],
    description: 'Segment integration, analytics events, usage tracking, and event instrumentation.',
    highlights: [
      'Implemented organization-level Segment events',
      'Added billing-related event tracking',
      'Created subscription lifecycle events'
    ],
    keyCommits: [
      { hash: '6a703b0298', message: 'chore: support organization-level Segment analytics events', date: '2024-11' },
      { hash: '7def7099f9', message: 'feat: add Segment events for cancel/uncancel subscription and plan phase change', date: '2025-01' },
      { hash: '73025db96c', message: 'feat: send segment events for Billing grace period changes and checkout sessions', date: '2025-01' }
    ]
  }
];

// Technology metadata for display
const TECHNOLOGIES = {
  'java': { name: 'Java', color: '#b07219' },
  'kotlin': { name: 'Kotlin', color: '#A97BFF' },
  'postgresql': { name: 'PostgreSQL', color: '#336791' },
  'kubernetes': { name: 'Kubernetes', color: '#326ce5' },
  'temporal': { name: 'Temporal', color: '#00b4ab' },
  'docker': { name: 'Docker', color: '#2496ed' },
  'github-actions': { name: 'GitHub Actions', color: '#2088FF' },
  'helm': { name: 'Helm', color: '#0F1689' },
  'keycloak': { name: 'Keycloak', color: '#4D4D4D' },
  'stripe': { name: 'Stripe', color: '#635BFF' },
  'orb': { name: 'Orb', color: '#6366F1' },
  'aws': { name: 'AWS', color: '#FF9900' },
  'gcp': { name: 'GCP', color: '#4285F4' },
  'vault': { name: 'Vault', color: '#000000' },
  'micronaut': { name: 'Micronaut', color: '#1A1A1A' },
  'jooq': { name: 'JOOQ', color: '#4A90D9' },
  'flyway': { name: 'Flyway', color: '#CC0200' },
  'openapi': { name: 'OpenAPI', color: '#6BA539' },
  'segment': { name: 'Segment', color: '#52BD95' },
  'rest': { name: 'REST', color: '#009688' },
  'saml': { name: 'SAML', color: '#E34F26' },
  'oauth': { name: 'OAuth', color: '#EB5424' },
  'dns': { name: 'DNS', color: '#4A90D9' },
  'gradle': { name: 'Gradle', color: '#02303A' },
  'junit': { name: 'JUnit', color: '#25A162' },
  'mockk': { name: 'MockK', color: '#A97BFF' },
  'sql': { name: 'SQL', color: '#336791' },
  'yaml': { name: 'YAML', color: '#CB171E' }
};

// All unique technologies across domains
const ALL_TECHNOLOGIES = [...new Set(DOMAINS.flatMap(d => d.technologies))].sort();

// Project definitions for deep-dives
const PROJECTS = [
  // 2022
  { id: 'job-failure-tracking', name: 'Job Failure Tracking', domains: ['jobs', 'api', 'database'], period: { start: '2022-01', end: '2022-02' }, category: 'data' },
  { id: 'kubernetes-pod-management', name: 'Kubernetes Pod Management', domains: ['kubernetes', 'jobs', 'config'], period: { start: '2022-02', end: '2022-03' }, category: 'infrastructure' },
  { id: 'temporal-cloud-migration', name: 'Temporal Cloud Migration', domains: ['temporal', 'kubernetes', 'config'], period: { start: '2022-06', end: '2022-06' }, category: 'infrastructure' },
  { id: 'multi-region-geography', name: 'Multi-Region Geography', domains: ['api', 'database', 'connections'], period: { start: '2022-08', end: '2022-11' }, category: 'infrastructure' },
  { id: 'api-performance-optimization', name: 'API Performance Optimization', domains: ['api', 'database', 'connections'], period: { start: '2022-09', end: '2022-09' }, category: 'data' },
  // 2023
  { id: 'cloud-micronaut-migration', name: 'Cloud Micronaut Migration', domains: ['api', 'config'], period: { start: '2023-05', end: '2023-05' }, category: 'infrastructure' },
  { id: 'schedule-jitter', name: 'Schedule Jitter System', domains: ['jobs', 'temporal'], period: { start: '2023-06', end: '2023-07' }, category: 'data' },
  { id: 'keycloak-sso-foundation', name: 'Keycloak SSO Foundation', domains: ['sso', 'kubernetes', 'config'], period: { start: '2023-07', end: '2023-09' }, category: 'sso' },
  { id: 'cron-scheduling-fix', name: 'Cron Scheduling Fix', domains: ['jobs', 'temporal'], period: { start: '2023-10', end: '2023-10' }, category: 'data' },
  { id: 'enterprise-rbac', name: 'Enterprise RBAC Foundation', domains: ['permissions', 'organizations', 'sso'], period: { start: '2023-10', end: '2023-12' }, category: 'permissions' },
  { id: 'permission-hierarchy', name: 'Permission Hierarchy', domains: ['permissions', 'organizations', 'workspace'], period: { start: '2023-10', end: '2024-04' }, category: 'permissions' },
  { id: 'first-user-admin-flow', name: 'First User Admin Flow', domains: ['permissions', 'organizations'], period: { start: '2023-11', end: '2024-01' }, category: 'permissions' },
  // 2024
  { id: 'organization-payment-config', name: 'Organization Payment Config', domains: ['billing', 'organizations', 'database'], period: { start: '2024-08', end: '2024-08' }, category: 'billing' },
  { id: 'stripe-webhook-consolidation', name: 'Stripe Webhook Consolidation', domains: ['billing', 'api'], period: { start: '2024-09', end: '2024-10' }, category: 'billing' },
  { id: 'grace-period-workflow', name: 'Grace Period Workflow', domains: ['billing', 'temporal', 'connections'], period: { start: '2024-10', end: '2024-10' }, category: 'billing' },
  { id: 'connection-auto-disable', name: 'Connection Auto-Disable', domains: ['connections', 'billing', 'temporal'], period: { start: '2024-10', end: '2024-12' }, category: 'billing' },
  { id: 'orb-subscription-integration', name: 'Orb Subscription Integration', domains: ['billing', 'api'], period: { start: '2024-12', end: '2024-12' }, category: 'billing' },
  // 2025
  { id: 'secrets-architecture', name: 'Secrets Architecture', domains: ['secrets', 'database', 'connectors'], period: { start: '2025-03', end: '2025-04' }, category: 'infrastructure' },
  { id: 'workspace-permission-filtering', name: 'Workspace Permission Filtering', domains: ['workspace', 'permissions', 'database'], period: { start: '2025-08', end: '2025-08' }, category: 'permissions' },
  { id: 'sso-test-validate', name: 'SSO Test/Validate Workflow', domains: ['sso', 'config', 'api'], period: { start: '2025-09', end: '2025-10' }, category: 'sso' },
  { id: 'dataplane-health-monitoring', name: 'Dataplane Health Monitoring', domains: ['dataplane', 'api', 'database'], period: { start: '2025-10', end: '2025-11' }, category: 'infrastructure' },
  { id: 'domain-verification', name: 'Domain Verification', domains: ['sso', 'temporal', 'api'], period: { start: '2025-10', end: '2025-11' }, category: 'sso' }
];

// Get projects related to a domain
function getProjectsForDomain(domainId) {
  return PROJECTS.filter(p => p.domains.includes(domainId));
}

// Helper functions
function getDomainById(id) {
  return DOMAINS.find(d => d.id === id);
}

function getDomainsByTechnology(tech) {
  return DOMAINS.filter(d => d.technologies.includes(tech));
}

function getCommitUrl(hash) {
  return `${REPO_BASE}/commit/${hash}`;
}

function formatPeriod(period) {
  const start = new Date(period.start + '-01');
  const end = new Date(period.end + '-01');
  const startStr = start.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const endStr = end.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  return `${startStr} - ${endStr}`;
}

function sortDomainsByCommits() {
  return [...DOMAINS].sort((a, b) => b.commitCount - a.commitCount);
}

function sortDomainsByRecency() {
  return [...DOMAINS].sort((a, b) => {
    const aDate = new Date(a.period.end + '-01');
    const bDate = new Date(b.period.end + '-01');
    return bDate - aDate;
  });
}

function sortDomainsAlphabetically() {
  return [...DOMAINS].sort((a, b) => a.name.localeCompare(b.name));
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.PORTFOLIO_DATA = {
    DOMAINS,
    PROJECTS,
    TECHNOLOGIES,
    ALL_TECHNOLOGIES,
    REPO_BASE,
    getDomainById,
    getDomainsByTechnology,
    getProjectsForDomain,
    getCommitUrl,
    formatPeriod,
    sortDomainsByCommits,
    sortDomainsByRecency,
    sortDomainsAlphabetically
  };
}
