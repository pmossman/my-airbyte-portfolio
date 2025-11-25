/**
 * Filter & Sort functionality for domains page
 */

document.addEventListener('DOMContentLoaded', () => {
  const { DOMAINS, TECHNOLOGIES, ALL_TECHNOLOGIES, sortDomainsByCommits, sortDomainsByRecency, sortDomainsAlphabetically, formatPeriod } = window.PORTFOLIO_DATA;

  const domainGrid = document.getElementById('domainGrid');
  const techFilters = document.getElementById('techFilters');
  const sortSelect = document.getElementById('sortSelect');
  const domainCount = document.getElementById('domainCount');
  const clearFiltersBtn = document.getElementById('clearFilters');
  const searchInput = document.getElementById('searchInput');

  let selectedTechs = new Set();
  let currentSort = 'commits';
  let searchQuery = '';

  // Domain icons (simple SVG representations)
  const domainIcons = {
    organizations: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    cicd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    api: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>',
    sso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    config: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    temporal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    permissions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    workspace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    billing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
    database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
    connectors: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg>',
    testing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    connections: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    refactoring: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    dataplane: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>',
    jobs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    secrets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>',
    kubernetes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    analytics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>'
  };

  // Initialize tech filter buttons
  function initTechFilters() {
    // Get most common technologies (appearing in 3+ domains)
    const techCounts = {};
    DOMAINS.forEach(domain => {
      domain.technologies.forEach(tech => {
        techCounts[tech] = (techCounts[tech] || 0) + 1;
      });
    });

    const commonTechs = Object.entries(techCounts)
      .filter(([_, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([tech]) => tech);

    techFilters.innerHTML = commonTechs.map(tech => {
      const techData = TECHNOLOGIES[tech] || { name: tech, color: '#8b949e' };
      return `<button class="filter-tag" data-tech="${tech}">${techData.name}</button>`;
    }).join('');

    // Add click handlers
    techFilters.querySelectorAll('.filter-tag').forEach(btn => {
      btn.addEventListener('click', () => {
        const tech = btn.dataset.tech;
        if (selectedTechs.has(tech)) {
          selectedTechs.delete(tech);
          btn.classList.remove('active');
        } else {
          selectedTechs.add(tech);
          btn.classList.add('active');
        }
        updateDisplay();
      });
    });
  }

  // Create a domain card
  function createDomainCard(domain) {
    const card = document.createElement('a');
    card.href = `domain/${domain.id}.html`;
    card.className = 'card domain-card';
    card.dataset.domain = domain.id;
    card.dataset.technologies = domain.technologies.join(',');

    const icon = domainIcons[domain.id] || domainIcons.api;
    const period = formatPeriod(domain.period);

    card.innerHTML = `
      <div class="domain-card-header">
        <div class="domain-icon" style="background-color: ${domain.color}20; color: ${domain.color};">
          ${icon}
        </div>
        <div style="flex-grow: 1;">
          <h3 class="card-title">${domain.name}</h3>
          <div class="domain-meta">
            <span class="commit-badge" style="color: ${domain.color};">${domain.commitCount} commits</span>
            <span>${period}</span>
          </div>
        </div>
      </div>
      <p class="card-body">${domain.description}</p>
      <ul class="highlight-list">
        ${domain.highlights.slice(0, 2).map(h => `<li>${h}</li>`).join('')}
      </ul>
      <div class="card-footer">
        ${domain.technologies.slice(0, 4).map(tech => {
          const techData = TECHNOLOGIES[tech] || { name: tech };
          return `<span class="badge badge-tech">${techData.name}</span>`;
        }).join('')}
      </div>
    `;

    return card;
  }

  // Get sorted and filtered domains
  function getFilteredDomains() {
    let domains;

    switch (currentSort) {
      case 'recent':
        domains = sortDomainsByRecency();
        break;
      case 'alpha':
        domains = sortDomainsAlphabetically();
        break;
      case 'commits':
      default:
        domains = sortDomainsByCommits();
    }

    if (selectedTechs.size > 0) {
      domains = domains.filter(domain =>
        [...selectedTechs].every(tech => domain.technologies.includes(tech))
      );
    }

    // Apply text search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      domains = domains.filter(domain => {
        // Search in name
        if (domain.name.toLowerCase().includes(query)) return true;
        if (domain.shortName && domain.shortName.toLowerCase().includes(query)) return true;
        // Search in description
        if (domain.description.toLowerCase().includes(query)) return true;
        // Search in technologies
        if (domain.technologies.some(tech => {
          const techData = TECHNOLOGIES[tech] || { name: tech };
          return tech.toLowerCase().includes(query) || techData.name.toLowerCase().includes(query);
        })) return true;
        // Search in highlights
        if (domain.highlights.some(h => h.toLowerCase().includes(query))) return true;
        return false;
      });
    }

    return domains;
  }

  // Update the display
  function updateDisplay() {
    const filteredDomains = getFilteredDomains();

    // Update grid
    domainGrid.innerHTML = '';
    filteredDomains.forEach(domain => {
      domainGrid.appendChild(createDomainCard(domain));
    });

    // Update count
    domainCount.textContent = filteredDomains.length;

    // Show/hide clear button
    const hasFilters = selectedTechs.size > 0 || searchQuery.trim();
    clearFiltersBtn.style.display = hasFilters ? 'block' : 'none';

    // Update URL state
    updateUrlState();
  }

  // Update URL with current filter state
  function updateUrlState() {
    const params = new URLSearchParams();

    if (selectedTechs.size > 0) {
      params.set('tech', [...selectedTechs].join(','));
    }

    if (currentSort !== 'commits') {
      params.set('sort', currentSort);
    }

    if (searchQuery.trim()) {
      params.set('q', searchQuery.trim());
    }

    const newUrl = params.toString()
      ? `${window.location.pathname}?${params.toString()}`
      : window.location.pathname;

    history.replaceState(null, '', newUrl);
  }

  // Read URL state on load
  function readUrlState() {
    const params = new URLSearchParams(window.location.search);

    const techParam = params.get('tech');
    if (techParam) {
      techParam.split(',').forEach(tech => {
        selectedTechs.add(tech);
        const btn = techFilters.querySelector(`[data-tech="${tech}"]`);
        if (btn) btn.classList.add('active');
      });
    }

    const sortParam = params.get('sort');
    if (sortParam && ['commits', 'recent', 'alpha'].includes(sortParam)) {
      currentSort = sortParam;
      sortSelect.value = currentSort;
    }

    const searchParam = params.get('q');
    if (searchParam && searchInput) {
      searchQuery = searchParam;
      searchInput.value = searchParam;
    }
  }

  // Event listeners
  sortSelect.addEventListener('change', (e) => {
    currentSort = e.target.value;
    updateDisplay();
  });

  clearFiltersBtn.addEventListener('click', () => {
    selectedTechs.clear();
    searchQuery = '';
    if (searchInput) searchInput.value = '';
    techFilters.querySelectorAll('.filter-tag').forEach(btn => {
      btn.classList.remove('active');
    });
    updateDisplay();
  });

  // Search input event listener with debounce
  if (searchInput) {
    let debounceTimeout;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        searchQuery = e.target.value;
        updateDisplay();
      }, 150);
    });
  }

  // Initialize
  initTechFilters();
  readUrlState();
  updateDisplay();
});
