# Parker Mossman - Airbyte Contributions Portfolio Website Plan

## Overview

A professional portfolio website showcasing ~4 years of engineering contributions to the Airbyte platform. The site will present 379 commits across 19 technical domains in both chronological and domain-organized views.

**Tech Stack:** Plain HTML/CSS/JavaScript (no framework)
**Hosting:** GitHub Pages
**Style:** Dark developer aesthetic with syntax highlighting vibes
**Search:** Tag/keyword filtering system

---

## Site Architecture

```
/
├── index.html              # Landing page with hero + high-level overview
├── timeline.html           # Chronological view of all contributions
├── domains.html            # Domain/topic grid view
├── domain/
│   ├── organizations.html  # Deep-dive: Organizations & User Management
│   ├── cicd.html          # Deep-dive: CI/CD & Build Infrastructure
│   ├── api.html           # Deep-dive: API Development
│   ├── sso.html           # Deep-dive: SSO & Domain Verification
│   ├── config.html        # Deep-dive: Configuration & Settings
│   ├── temporal.html      # Deep-dive: Temporal Workflows
│   ├── permissions.html   # Deep-dive: Permissions & Access Control
│   ├── workspace.html     # Deep-dive: Workspace Management
│   ├── billing.html       # Deep-dive: Billing & Payments
│   ├── database.html      # Deep-dive: Database Schema & Migrations
│   ├── connectors.html    # Deep-dive: Sources & Destinations
│   ├── testing.html       # Deep-dive: Testing & Quality
│   ├── connections.html   # Deep-dive: Connections & Auto-disable
│   ├── refactoring.html   # Deep-dive: Code Refactoring
│   ├── dataplane.html     # Deep-dive: Dataplane Management
│   ├── jobs.html          # Deep-dive: Job & Attempt Tracking
│   ├── secrets.html       # Deep-dive: Secrets Management
│   ├── kubernetes.html    # Deep-dive: Kubernetes & Infrastructure
│   └── analytics.html     # Deep-dive: Analytics & Segment
├── css/
│   ├── main.css           # Core styles, variables, layout
│   ├── components.css     # Cards, badges, buttons, nav
│   └── code.css           # Syntax highlighting for code snippets
├── js/
│   ├── main.js            # Navigation, smooth scrolling, interactions
│   ├── filter.js          # Tag filtering logic
│   ├── timeline.js        # Timeline view interactions
│   └── data.js            # Structured data (commits, tags, domains)
└── assets/
    └── icons/             # Technology icons (optional)
```

---

## Page Designs

### 1. Landing Page (index.html)

**Purpose:** Make a strong first impression, communicate expertise quickly

#### Hero Section
- Name: Parker Mossman
- Title: "Senior Backend Engineer"
- Tagline: "3.9 years building enterprise data infrastructure at Airbyte"
- Key stats displayed prominently:
  - 379 commits
  - 19 technical domains
  - Dec 2021 - Nov 2025

#### Quick Impact Cards (grid of 6)
Highlight the most impressive/recruiter-friendly domains:
1. **SSO & Enterprise Auth** (49 commits) - "Built complete SSO system with SAML, Keycloak, and domain verification flow"
2. **Multi-tenant RBAC** (97 commits) - "Designed organization/workspace permission hierarchy for enterprise customers"
3. **Billing & Payments** (31 commits) - "Integrated Orb & Stripe for subscription management and grace period handling"
4. **Secrets Architecture** (13 commits) - "Three-table external secrets system supporting AWS, GCP, Azure, and Vault"
5. **Temporal Workflows** (40 commits) - "Distributed job orchestration for data pipeline reliability and scheduling"
6. **API Platform** (52 commits) - "Internal and public REST APIs with OpenAPI specs and monitoring endpoints"

#### Technology Cloud
Visual display of technologies: Java, Kotlin, PostgreSQL, Kubernetes, Temporal, Docker, GitHub Actions, Keycloak, Stripe, AWS, GCP, etc.

#### Call-to-Action Buttons
- "View Timeline" → timeline.html
- "Browse by Domain" → domains.html
- GitHub: https://github.com/pmossman
- LinkedIn: https://www.linkedin.com/in/parker-mossman-23043a7a/

---

### 2. Timeline View (timeline.html)

**Purpose:** Show progression and depth of work chronologically

#### Design
- Vertical timeline with year markers (2021, 2022, 2023, 2024, 2025)
- Each entry shows:
  - Date
  - Commit message (truncated)
  - Domain tag (colored badge)
  - Impact indicator (files changed)
  - Click to expand for details + link to GitHub commit

#### Features
- **Filter by year** (buttons: All | 2021 | 2022 | 2023 | 2024 | 2025)
- **Filter by domain tags** (multi-select checkboxes)
- **Filter by technology tags**
- Smooth scroll animation between entries
- "Jump to year" quick nav

#### Grouping Options
- By month (default)
- By quarter
- Condensed (just dots on timeline, hover for details)

---

### 3. Domains Overview (domains.html)

**Purpose:** Browse contributions organized by technical area

#### Design
- Grid of domain cards (responsive: 3 cols desktop, 2 tablet, 1 mobile)
- Each card shows:
  - Domain name
  - Commit count badge
  - Time period
  - 3-4 key technologies used (small badges)
  - Brief 1-2 sentence description
  - Hover effect: slight lift + glow

#### Sorting Options
- By commit count (default - most to least)
- Alphabetical
- By start date (earliest first)
- By recency (most recent activity first)

#### Cards link to individual domain pages

---

### 4. Domain Deep-Dive Pages (domain/*.html)

**Purpose:** Detailed view of work in each technical area

#### Header Section
- Domain name
- Stats: commit count, time period, total lines changed
- Technology badges
- Brief overview paragraph

#### Key Projects Section
For each major feature/project within the domain:
- **Project title**
- **Problem statement** (what was needed)
- **Solution summary** (what was built)
- **Key commits** with expandable details:
  - Commit hash (linked to GitHub)
  - Date
  - Full commit message
  - Files changed count
  - Code snippets (syntax highlighted)
- **Business value** statement

#### Sidebar Navigation
- Quick jump to each project within the page
- Related domains (cross-links)
- Back to domains overview

---

## Visual Design System

### Color Palette (Dark Developer Theme)

```css
:root {
  /* Backgrounds */
  --bg-primary: #0d1117;      /* GitHub dark bg */
  --bg-secondary: #161b22;    /* Slightly lighter */
  --bg-tertiary: #21262d;     /* Cards, elevated surfaces */
  --bg-code: #1a1f26;         /* Code blocks */

  /* Text */
  --text-primary: #e6edf3;    /* Main text */
  --text-secondary: #8b949e;  /* Muted text */
  --text-link: #58a6ff;       /* Links */

  /* Accents */
  --accent-blue: #58a6ff;     /* Primary accent */
  --accent-green: #3fb950;    /* Success, additions */
  --accent-purple: #a371f7;   /* Highlights */
  --accent-orange: #d29922;   /* Warnings, attention */
  --accent-red: #f85149;      /* Deletions */

  /* Domain tag colors (for visual distinction) */
  --tag-auth: #da3633;
  --tag-api: #58a6ff;
  --tag-database: #3fb950;
  --tag-infra: #a371f7;
  --tag-billing: #d29922;
  /* ... more as needed */

  /* Borders */
  --border-default: #30363d;
  --border-muted: #21262d;
}
```

### Typography

```css
/* Fonts */
--font-body: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
--font-mono: 'JetBrains Mono', 'Fira Code', monospace;

/* Sizes */
--text-xs: 0.75rem;
--text-sm: 0.875rem;
--text-base: 1rem;
--text-lg: 1.125rem;
--text-xl: 1.25rem;
--text-2xl: 1.5rem;
--text-3xl: 2rem;
--text-4xl: 2.5rem;
```

### Components

#### Cards
- Rounded corners (8px)
- Subtle border (1px solid --border-default)
- Hover: border color lightens, subtle box-shadow glow
- Transition: 150ms ease

#### Badges/Tags
- Small rounded pills
- Color-coded by domain/technology
- Text in white or dark for contrast

#### Code Blocks
- Syntax highlighting (Prism.js or highlight.js)
- Languages: Java, Kotlin, SQL, YAML, JSON
- Copy button on hover
- Line numbers for longer snippets

#### Timeline
- Vertical line (2px, gradient from accent to muted)
- Circular markers at each entry
- Alternating left/right layout on desktop
- All entries on right on mobile

#### Navigation
- Fixed header with logo/name
- Nav links: Home | Timeline | Domains
- Mobile: hamburger menu

---

## Tag/Filter System

### Tag Categories

#### Domain Tags (19)
Each commit belongs to one primary domain:
- `organizations` | `cicd` | `api` | `sso` | `config` | `temporal` | `permissions` | `workspace` | `billing` | `database` | `connectors` | `testing` | `connections` | `refactoring` | `dataplane` | `jobs` | `secrets` | `kubernetes` | `analytics`

#### Technology Tags
Extracted from the documents:
- **Languages:** `java` | `kotlin` | `sql` | `yaml` | `groovy` | `python`
- **Frameworks:** `micronaut` | `jooq` | `temporal` | `flyway`
- **Infrastructure:** `kubernetes` | `docker` | `helm` | `github-actions`
- **Databases:** `postgresql`
- **Services:** `keycloak` | `stripe` | `orb` | `segment` | `aws` | `gcp` | `azure` | `vault`

#### Work Type Tags
- `feature` | `bugfix` | `refactor` | `migration` | `test` | `config` | `docs`

### Filter UI

```
┌─────────────────────────────────────────────────────────┐
│ Filter by Domain:                                        │
│ [Organizations] [CI/CD] [API] [SSO] [Config] ...        │
│                                                          │
│ Filter by Technology:                                    │
│ [Java] [Kotlin] [PostgreSQL] [Kubernetes] [Temporal]... │
│                                                          │
│ [Clear All Filters]                          Showing: 379│
└─────────────────────────────────────────────────────────┘
```

- Clicking a tag toggles it (active = highlighted)
- Multiple tags = AND logic (shows items matching ALL selected)
- URL updates with filter state (shareable links)
- Count updates dynamically

---

## Data Structure (js/data.js)

```javascript
const DOMAINS = [
  {
    id: 'organizations',
    name: 'Organizations & User Management',
    shortName: 'Organizations',
    color: '#da3633',
    commitCount: 63,
    period: { start: '2023-08', end: '2025-10' },
    technologies: ['java', 'kotlin', 'postgresql', 'jooq'],
    description: 'Multi-tenant RBAC system with organization/workspace hierarchy',
    highlights: [
      'Permission inheritance system',
      'OrganizationService architecture',
      'User isolation patterns'
    ]
  },
  // ... 18 more domains
];

const COMMITS = [
  {
    hash: 'c231086441',
    date: '2025-11-05',
    message: 'Add external secrets support to configuration',
    domain: 'secrets',
    technologies: ['java', 'postgresql', 'aws'],
    filesChanged: 10,
    insertions: 708,
    deletions: 10,
    githubUrl: 'https://github.com/airbytehq/airbyte-platform/commit/c231086441',
    highlights: ['Three-table architecture', 'Dual-write pattern']
  },
  // ... all commits
];

const PROJECTS = [
  {
    id: 'sso-implementation',
    domain: 'sso',
    title: 'Enterprise SSO System',
    problem: 'Enterprise customers needed SAML-based single sign-on',
    solution: 'Built complete SSO flow with Keycloak, domain verification, and SAML support',
    commits: ['abc123', 'def456', ...],
    businessValue: 'Enabled enterprise sales by meeting security requirements'
  },
  // ... key projects
];
```

---

## Implementation Phases

### Phase 1: Foundation
1. Set up project structure and GitHub Pages
2. Create CSS design system (variables, base styles)
3. Build reusable components (cards, badges, nav)
4. Create landing page with static content

### Phase 2: Data & Content
5. Parse markdown documents → structured JSON data
6. Create data.js with all commits, domains, projects
7. Build domain overview page with cards
8. Build individual domain pages

### Phase 3: Timeline & Interactivity
9. Build timeline page with year markers
10. Implement tag filtering system
11. Add smooth transitions and hover effects
12. URL state management for filters

### Phase 4: Polish
13. Add syntax highlighting for code blocks
14. Responsive design testing and fixes
15. Performance optimization (lazy loading)
16. Cross-browser testing

### Phase 5: Launch
17. Final content review
18. Deploy to GitHub Pages
19. Custom domain setup (optional)

---

## Performance Considerations

- **No framework overhead** - vanilla JS loads fast
- **Static HTML** - instant first paint
- **CSS in `<head>`** - no flash of unstyled content
- **JS at end of `<body>`** - non-blocking
- **Lazy load** code snippets (load on expand)
- **Preload** fonts for smoother rendering
- **Minimal dependencies** - only Prism.js for syntax highlighting

---

## GitHub Commit Links

All commit hashes will link to:
```
https://github.com/airbytehq/airbyte-platform/commit/{hash}
```

Example:
```html
<a href="https://github.com/airbytehq/airbyte-platform/commit/c231086441"
   target="_blank"
   rel="noopener">
  c231086
</a>
```

---

## Responsive Breakpoints

```css
/* Mobile first */
@media (min-width: 640px) { /* sm */ }
@media (min-width: 768px) { /* md */ }
@media (min-width: 1024px) { /* lg */ }
@media (min-width: 1280px) { /* xl */ }
```

---

## Open Questions / Future Enhancements

1. **Search**: Full-text search could be added later using a client-side library like Fuse.js
2. **Analytics**: Add simple analytics (Plausible/Umami) to track which domains get most views?
3. **PDF Export**: Generate a condensed PDF resume version?
4. **Dark/Light Toggle**: Start with dark, add light mode option later?

---

## Next Steps

1. Review this plan and provide feedback
2. Create the project folder structure
3. Start with Phase 1: Foundation

Ready to proceed?
