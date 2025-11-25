# Website Enhancement Plan: Detailed Domain Pages & Project Deep-Dives

## Overview

This plan covers two enhancements:
1. **Inline expandable detail** on domain pages to show full deep-dive content
2. **Project-level deep-dive documents** for 5 focused deliverables

---

## Part 1: Inline Expandable Detail on Domain Pages

### Goal
Allow viewers to expand sections on domain pages to reveal the full detail from the deep-dive markdown documents (code snippets, implementation details, business value, related commits).

### Implementation Approach

1. **Convert markdown deep-dives to structured JSON**
   - Parse each deep-dive document
   - Extract: overview, key architectural changes, code blocks, business value sections
   - Store as `domain-content/{domain-id}.json`

2. **Update domain page template**
   - Add expandable sections for each major feature/commit
   - Initially show: title + brief description
   - On expand: show full code snippets, implementation details, business value

3. **Component structure**
   ```
   [Domain Header]
   [Key Achievements - cards]

   [Detailed Work] <- NEW SECTION
     [▼ Feature 1: Domain Verification System]
       - What Changed
       - Implementation Details (with code blocks)
       - Business Value
       - Related Commits
     [▼ Feature 2: SSO Test/Validate Workflow]
       ...

   [Related Domains]
   ```

4. **Files to create/modify**
   - `js/domain-content.js` - Content loader and renderer
   - `domain/*.html` - Update template with expandable sections
   - `css/components.css` - Add expandable section styles

---

## Part 2: Project-Level Deep-Dive Documents

### Selected Projects (5)

| Project | Timeframe | Source Domains |
|---------|-----------|----------------|
| Domain Verification System | Sep-Nov 2025 (~3 mo) | SSO, Temporal |
| Secret Management Architecture | Mar-Apr 2025 (~6 wk) | Secrets, Database |
| Dataplane Health Monitoring | Oct-Nov 2025 (~6 wk) | Dataplane, Temporal, API |
| Connection Query Optimization | Sep-Oct 2022 | Connections, API, Database |
| SSO Test/Validate Workflow | Oct 2025 | SSO, Config, API |

### Document Structure (for each project)

```markdown
# [Project Name]

## Overview
- Time period
- Lines of code / files changed
- Key technologies
- One-paragraph summary

## Problem Statement
What problem did this solve? Why was it needed?

## Solution Architecture
High-level design decisions and approach

## Implementation Details
### [Component 1]
- Code snippets
- Technical explanation

### [Component 2]
- Code snippets
- Technical explanation

## Key Commits
| Commit | Date | Description | Impact |
|--------|------|-------------|--------|

## Business Value
- User impact
- Business impact
- Technical impact

## Lessons Learned / Patterns Used
- Architectural patterns applied
- Technical decisions and trade-offs
```

### Output Location
- Documents: `/Users/parker/code/parker-airbyte-analysis/projects/`
- Website pages: `website/project/{project-id}.html`

---

## Implementation Order

1. **Create project deep-dive documents** (markdown, in /projects folder)
2. **Create projects overview page** (website/projects.html)
3. **Create individual project pages** (website/project/*.html)
4. **Update navigation** to include Projects link
5. **Add expandable detail to domain pages**
6. **Test and polish**

---

## File Structure After Enhancement

```
parker-airbyte-analysis/
├── projects/                              <- NEW
│   ├── domain-verification.md
│   ├── secrets-architecture.md
│   ├── dataplane-health.md
│   ├── query-optimization.md
│   └── sso-test-workflow.md
│
├── website/
│   ├── index.html
│   ├── timeline.html
│   ├── domains.html
│   ├── projects.html                      <- NEW
│   ├── domain/
│   │   └── *.html (with expandable sections)
│   ├── project/                           <- NEW
│   │   ├── domain-verification.html
│   │   ├── secrets-architecture.html
│   │   ├── dataplane-health.html
│   │   ├── query-optimization.html
│   │   └── sso-test-workflow.html
│   └── js/
│       └── domain-content.js              <- NEW
```
