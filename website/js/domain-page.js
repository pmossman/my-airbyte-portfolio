/**
 * Dynamic Domain Page Content Generator
 * Populates domain page content based on URL and data.js
 */

document.addEventListener('DOMContentLoaded', () => {
  const { DOMAINS, TECHNOLOGIES, formatPeriod, getCommitUrl, getProjectsForDomain } = window.PORTFOLIO_DATA;

  // Get domain ID from URL (e.g., domain/api.html -> api)
  const path = window.location.pathname;
  const domainId = path.split('/').pop().replace('.html', '');

  // Find domain data
  const domain = DOMAINS.find(d => d.id === domainId);

  if (!domain) {
    console.error('Domain not found:', domainId);
    return;
  }

  // Populate page content
  document.title = `${domain.name} | Parker Mossman`;

  // Update meta description
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) {
    metaDesc.content = `${domain.name} - ${domain.description}`;
  }

  // Update header
  const pageTitle = document.getElementById('pageTitle');
  const pageDesc = document.getElementById('pageDesc');
  const domainStats = document.getElementById('domainStats');
  const domainIcon = document.getElementById('domainIcon');
  const techBadges = document.getElementById('techBadges');

  if (pageTitle) pageTitle.textContent = domain.name;
  if (pageDesc) pageDesc.textContent = domain.description;

  if (domainStats) {
    const period = formatPeriod(domain.period);
    domainStats.innerHTML = `
      <span class="domain-stat"><strong>${domain.commitCount}</strong> commits</span>
      <span class="domain-stat"><strong>${period}</strong></span>
    `;
  }

  if (domainIcon) {
    domainIcon.style.backgroundColor = `${domain.color}20`;
    domainIcon.style.color = domain.color;
  }

  if (techBadges) {
    techBadges.innerHTML = domain.technologies.map(tech => {
      const techData = TECHNOLOGIES[tech] || { name: tech };
      return `<span class="badge badge-tech">${techData.name}</span>`;
    }).join('');
  }

  // Populate highlights
  const highlightsGrid = document.getElementById('highlightsGrid');
  if (highlightsGrid && domain.highlights) {
    highlightsGrid.innerHTML = domain.highlights.map(highlight => `
      <div class="card">
        <p class="card-body">${highlight}</p>
      </div>
    `).join('');
  }

  // Populate commits
  const commitsContainer = document.getElementById('commitsContainer');
  if (commitsContainer && domain.keyCommits) {
    commitsContainer.innerHTML = domain.keyCommits.map(commit => `
      <div class="commit">
        <a href="${getCommitUrl(commit.hash)}" target="_blank" rel="noopener" class="commit-hash">${commit.hash.substring(0, 7)}</a>
        <span class="commit-message">${commit.message}</span>
        <span class="commit-stats">${commit.date}</span>
      </div>
    `).join('');
  }

  // Populate related projects
  const projectsContainer = document.getElementById('relatedProjects');
  const projectsSection = document.getElementById('relatedProjectsSection');
  if (projectsContainer && projectsSection) {
    const relatedProjects = getProjectsForDomain(domainId);
    if (relatedProjects.length > 0) {
      projectsSection.style.display = 'block';
      projectsContainer.innerHTML = relatedProjects.map(p => `
        <a href="../project/${p.id}.html" class="card">
          <h3 class="card-title">${p.name}</h3>
          <p class="card-body text-sm text-muted">Deep-dive project documentation</p>
        </a>
      `).join('');
    }
  }

  // Populate related domains
  const relatedContainer = document.getElementById('relatedDomains');
  if (relatedContainer) {
    // Find related domains based on shared technologies
    const related = DOMAINS
      .filter(d => d.id !== domainId)
      .map(d => ({
        ...d,
        sharedTechs: d.technologies.filter(t => domain.technologies.includes(t)).length
      }))
      .sort((a, b) => b.sharedTechs - a.sharedTechs)
      .slice(0, 3);

    relatedContainer.innerHTML = related.map(d => `
      <a href="${d.id}.html" class="card">
        <h3 class="card-title">${d.shortName}</h3>
        <p class="card-body text-sm">${d.description.substring(0, 80)}...</p>
      </a>
    `).join('');
  }
});
