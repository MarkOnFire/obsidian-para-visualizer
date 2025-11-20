const { Plugin, ItemView, WorkspaceLeaf, Notice } = require('obsidian');

const VIEW_TYPE_PARA_VISUALIZER = 'para-visualizer-view';

// PARA color scheme
const PARA_COLORS = {
  inbox: '#8b5cf6',
  projects: '#3b82f6',
  areas: '#10b981',
  resources: '#f59e0b',
  archive: '#6b7280'
};

const DEFAULT_REVIEW_INTERVALS = {
  inbox: 2,
  projects: 7,
  areas: 30,
  resources: 90,
  archive: 180
};

class PARAVisualizerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentView = 'heatmap'; // Default view
    this.dateRange = 90; // days
    this.vaultData = null;
    this.scope = 'vault'; // 'vault' or 'note'
    this.currentNoteData = null;
  }

  getViewType() {
    return VIEW_TYPE_PARA_VISUALIZER;
  }

  getDisplayText() {
    return 'PARA Visualizer';
  }

  getIcon() {
    return 'bar-chart-2';
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('para-visualizer-view');

    await this.collectVaultData();

    // Listen for active file changes
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', async () => {
        if (this.scope === 'note') {
          await this.updateCurrentNoteData();
          this.render();
        }
      })
    );

    // Listen for file modifications
    this.registerEvent(
      this.app.vault.on('modify', async (file) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (this.scope === 'note' && activeFile && file.path === activeFile.path) {
          await this.updateCurrentNoteData();
          this.render();
        }
      })
    );

    // Listen for file renames/moves
    this.registerEvent(
      this.app.vault.on('rename', async (file, oldPath) => {
        // Refresh vault data when any file is renamed (paths change)
        await this.collectVaultData();

        // If we're in note view and the current note was moved, update it
        const activeFile = this.app.workspace.getActiveFile();
        if (this.scope === 'note' && activeFile) {
          await this.updateCurrentNoteData();
          this.render();
        }
      })
    );

    // Listen for file deletions
    this.registerEvent(
      this.app.vault.on('delete', async (file) => {
        // Refresh vault data
        await this.collectVaultData();

        // If we're in note view, check if current note still exists
        const activeFile = this.app.workspace.getActiveFile();
        if (this.scope === 'note') {
          if (!activeFile) {
            this.currentNoteData = null;
          }
          this.render();
        }
      })
    );

    this.render();
  }

  async collectVaultData() {
    const files = this.app.vault.getMarkdownFiles();
    const data = {
      notes: [],
      tags: new Map(),
      paraLocations: {
        inbox: [],
        projects: [],
        areas: [],
        resources: [],
        archive: []
      },
      activity: new Map(), // date -> count
      links: [], // { source, target }
      tasks: {
        all: [],
        byDate: new Map(), // completion date -> tasks
        byPara: {
          inbox: { open: 0, completed: 0 },
          projects: { open: 0, completed: 0 },
          areas: { open: 0, completed: 0 },
          resources: { open: 0, completed: 0 },
          archive: { open: 0, completed: 0 }
        }
      }
    };

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;

      // Extract PARA location from frontmatter
      const paraLocation = cache.frontmatter?.para || 'unknown';

      // Extract tags (both frontmatter and inline)
      const noteTags = new Set();
      if (cache.frontmatter?.tags) {
        const tags = Array.isArray(cache.frontmatter.tags)
          ? cache.frontmatter.tags
          : [cache.frontmatter.tags];
        tags.forEach(tag => noteTags.add(tag));
      }
      if (cache.tags) {
        cache.tags.forEach(tagCache => {
          const tag = tagCache.tag.replace('#', '');
          noteTags.add(tag);
        });
      }

      // Extract PARA history if available
      const paraHistory = cache.frontmatter?.para_history || [];

      const reviewInterval = this.getReviewIntervalFromFrontmatter(cache.frontmatter);

      // Build note object
      const noteData = {
        path: file.path,
        basename: file.basename,
        paraLocation: paraLocation,
        paraHistory: paraHistory, // Array of {from, to, date, timestamp}
        tags: Array.from(noteTags),
        created: file.stat.ctime,
        modified: file.stat.mtime,
        size: file.stat.size,
        links: [],
        reviewInterval: reviewInterval
      };

      // Extract links
      if (cache.links) {
        cache.links.forEach(link => {
          noteData.links.push(link.link);
          data.links.push({
            source: file.path,
            target: link.link
          });
        });
      }

      data.notes.push(noteData);

      // Track PARA location
      if (data.paraLocations[paraLocation]) {
        data.paraLocations[paraLocation].push(noteData);
      }

      // Track tags
      noteTags.forEach(tag => {
        if (!data.tags.has(tag)) {
          data.tags.set(tag, []);
        }
        data.tags.get(tag).push(noteData);
      });

      // Track activity by date
      const modDate = new Date(file.stat.mtime).toISOString().split('T')[0];
      data.activity.set(modDate, (data.activity.get(modDate) || 0) + 1);

      // Parse tasks from file content
      const tasks = await this.parseTasksFromFile(file, paraLocation);
      tasks.forEach(task => {
        data.tasks.all.push(task);

        // Track by PARA location
        if (data.tasks.byPara[paraLocation]) {
          if (task.completed) {
            data.tasks.byPara[paraLocation].completed++;

            // Track by completion date
            if (task.completionDate) {
              if (!data.tasks.byDate.has(task.completionDate)) {
                data.tasks.byDate.set(task.completionDate, []);
              }
              data.tasks.byDate.get(task.completionDate).push(task);
            }
          } else {
            data.tasks.byPara[paraLocation].open++;
          }
        }
      });
    }

    this.vaultData = data;
  }

  async parseTasksFromFile(file, paraLocation) {
    const tasks = [];

    try {
      const content = await this.app.vault.read(file);
      const lines = content.split('\n');

      // Regex for Obsidian Tasks format
      // Matches: - [ ] task or - [x] task
      const taskRegex = /^[\s]*-\s\[([ xX])\]\s(.+)$/;

      // Regex for completion date: ✅ 2025-11-14
      const completionDateRegex = /✅\s*(\d{4}-\d{2}-\d{2})/;

      // Regex for due date: 📅 2025-11-14
      const dueDateRegex = /📅\s*(\d{4}-\d{2}-\d{2})/;

      // Regex for created date: ➕ 2025-11-14
      const createdDateRegex = /➕\s*(\d{4}-\d{2}-\d{2})/;

      lines.forEach((line, lineNum) => {
        const match = line.match(taskRegex);
        if (match) {
          const isCompleted = match[1].toLowerCase() === 'x';
          const taskText = match[2];

          // Extract dates from task text
          const completionMatch = taskText.match(completionDateRegex);
          const dueMatch = taskText.match(dueDateRegex);
          const createdMatch = taskText.match(createdDateRegex);

          const task = {
            file: file.path,
            fileName: file.basename,
            paraLocation: paraLocation,
            line: lineNum + 1,
            text: taskText.replace(/[✅📅➕⏫🔼🔽⏬🔁⏳]/g, '').trim(), // Clean emojis
            completed: isCompleted,
            completionDate: completionMatch ? completionMatch[1] : null,
            dueDate: dueMatch ? dueMatch[1] : null,
            createdDate: createdMatch ? createdMatch[1] : null
          };

          // Calculate task age if completed
          if (task.completed && task.completionDate && task.createdDate) {
            const created = new Date(task.createdDate);
            const completed = new Date(task.completionDate);
            task.ageInDays = Math.floor((completed - created) / (1000 * 60 * 60 * 24));
          }

          tasks.push(task);
        }
      });
    } catch (error) {
      console.error(`Failed to parse tasks from ${file.path}:`, error);
    }

    return tasks;
  }

  getReviewIntervalFromFrontmatter(frontmatter) {
    if (!frontmatter) return null;
    const rawValue =
      frontmatter.review_interval ??
      frontmatter.reviewInterval ??
      frontmatter.review_every ??
      frontmatter.reviewEvery ??
      frontmatter.review;
    return this.parseReviewIntervalValue(rawValue);
  }

  parseReviewIntervalValue(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number' && isFinite(value)) {
      return value > 0 ? value : null;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (!normalized.length) return null;
      if (normalized === 'daily') return 1;
      if (normalized === 'weekly') return 7;
      if (normalized === 'monthly') return 30;
      if (normalized === 'quarterly') return 90;

      const match = normalized.match(/(\d+)\s*(d|day|days|w|wk|week|weeks|m|mo|month|months)/);
      if (match) {
        const amount = parseInt(match[1], 10);
        const unit = match[2];
        if (!isNaN(amount) && amount > 0) {
          if (unit.startsWith('d')) return amount;
          if (unit.startsWith('w')) return amount * 7;
          if (unit.startsWith('m')) return amount * 30;
        }
      }

      const numeric = parseInt(normalized, 10);
      return !isNaN(numeric) && numeric > 0 ? numeric : null;
    }
    return null;
  }

  getReviewIntervalForNote(note) {
    if (note.reviewInterval && note.reviewInterval > 0) {
      return note.reviewInterval;
    }
    return this.getDefaultReviewInterval(note.paraLocation);
  }

  getDefaultReviewInterval(location) {
    return DEFAULT_REVIEW_INTERVALS[location] || 30;
  }

  formatDays(value) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    if (value < 1) return '<1 day';
    const rounded = Math.round(value);
    return rounded === 1 ? '1 day' : `${rounded} days`;
  }

  hexToRgba(hex, alpha) {
    const sanitized = hex.replace('#', '');
    const bigint = parseInt(sanitized, 16);
    if (isNaN(bigint)) {
      return `rgba(59, 130, 246, ${alpha})`;
    }
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  normalizeLocation(value) {
    if (!value || typeof value !== 'string') return 'unknown';
    return value.toLowerCase();
  }

  getLocationAtTime(states, timestamp) {
    if (!states || states.length === 0) return null;
    if (timestamp < states[0].timestamp) return null;
    let location = states[0].location;
    for (const state of states) {
      if (timestamp >= state.timestamp) {
        location = state.location;
      } else {
        break;
      }
    }
    return location;
  }

  render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('para-visualizer-view');

    // Header
    const header = container.createDiv('para-visualizer-header');
    this.renderTabs(header);
    this.renderControls(header);

    // Content
    const content = container.createDiv('para-visualizer-content');

    if (!this.vaultData) {
      content.createDiv('para-loading').setText('Loading vault data...');
      return;
    }

    switch (this.currentView) {
      case 'heatmap':
        this.renderHeatmap(content);
        break;
      case 'graph':
        this.renderGraph(content);
        break;
      case 'sankey':
        this.renderSankey(content);
        break;
      case 'tasks':
        this.renderTaskAnalytics(content);
        break;
      case 'tags':
        this.renderTagCloud(content);
        break;
      case 'stats':
        this.renderStats(content);
        break;
      case 'review':
        this.renderReviewRadar(content);
        break;
      case 'pipeline':
        this.renderPipelineTimeline(content);
        break;
      case 'task-calendar':
        this.renderTaskCalendar(content);
        break;
      case 'note-context':
        this.renderNoteContext(content);
        break;
      case 'note-history':
        this.renderNoteHistory(content);
        break;
      case 'note-tasks':
        this.renderNoteTasks(content);
        break;
    }
  }

  renderTabs(container) {
    // Scope toggle
    const scopeToggle = container.createDiv('para-scope-toggle');
    scopeToggle.style.cssText = 'display: flex; gap: 8px; margin-bottom: 12px; background: var(--background-secondary); padding: 4px; border-radius: 8px; width: fit-content;';

    const vaultBtn = scopeToggle.createEl('button');
    vaultBtn.textContent = '🗂️ Vault';
    vaultBtn.style.cssText = `padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; background: ${this.scope === 'vault' ? 'var(--interactive-accent)' : 'transparent'}; color: ${this.scope === 'vault' ? 'var(--text-on-accent)' : 'var(--text-normal)'}`;
    vaultBtn.addEventListener('click', () => {
      this.scope = 'vault';
      this.currentView = 'heatmap'; // Default vault view
      this.render();
    });

    const noteBtn = scopeToggle.createEl('button');
    noteBtn.textContent = '📝 Current Note';
    noteBtn.style.cssText = `padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; background: ${this.scope === 'note' ? 'var(--interactive-accent)' : 'transparent'}; color: ${this.scope === 'note' ? 'var(--text-on-accent)' : 'var(--text-normal)'}`;
    noteBtn.addEventListener('click', async () => {
      this.scope = 'note';
      this.currentView = 'note-context'; // Default note view
      await this.updateCurrentNoteData();
      this.render();
    });

    // Tabs based on scope
    const tabsContainer = container.createDiv('para-visualizer-tabs');

    let tabs = [];
    if (this.scope === 'vault') {
      tabs = [
        { id: 'heatmap', label: 'Activity Heatmap', icon: '📅' },
        { id: 'graph', label: 'Knowledge Graph', icon: '🕸️' },
        { id: 'sankey', label: 'PARA Flow', icon: '🌊' },
        { id: 'tasks', label: 'Task Analytics', icon: '✅' },
        { id: 'review', label: 'Review Radar', icon: '📍' },
        { id: 'pipeline', label: 'Pipeline Timeline', icon: '📈' },
        { id: 'task-calendar', label: 'Task Load Calendar', icon: '🗓️' },
        { id: 'tags', label: 'Tag Cloud', icon: '🏷️' },
        { id: 'stats', label: 'Statistics', icon: '📊' }
      ];
    } else {
      tabs = [
        { id: 'note-context', label: 'Note Context', icon: '🔍' },
        { id: 'note-history', label: 'PARA History', icon: '🌊' },
        { id: 'note-tasks', label: 'Tasks', icon: '✅' }
      ];
    }

    tabs.forEach(tab => {
      const tabEl = tabsContainer.createDiv('para-visualizer-tab');
      if (tab.id === this.currentView) {
        tabEl.addClass('active');
      }
      tabEl.setText(`${tab.icon} ${tab.label}`);
      tabEl.addEventListener('click', () => {
        this.currentView = tab.id;
        this.render();
      });
    });
  }

  renderControls(container) {
    const controlsContainer = container.createDiv('para-visualizer-controls');

    // Date range selector
    const dateControl = controlsContainer.createDiv('para-visualizer-control');
    dateControl.createEl('label', { text: 'Time range:' });
    const dateSelect = dateControl.createEl('select');
    const ranges = [
      { value: 30, label: 'Last 30 days' },
      { value: 90, label: 'Last 90 days' },
      { value: 180, label: 'Last 6 months' },
      { value: 365, label: 'Last year' },
      { value: 9999, label: 'All time' }
    ];
    ranges.forEach(range => {
      const option = dateSelect.createEl('option', {
        text: range.label,
        value: range.value.toString()
      });
      if (range.value === this.dateRange) {
        option.selected = true;
      }
    });
    dateSelect.addEventListener('change', () => {
      this.dateRange = parseInt(dateSelect.value);
      this.render();
    });

    // Refresh button
    const refreshBtn = controlsContainer.createEl('button', { text: '🔄 Refresh' });
    refreshBtn.addClass('para-visualizer-control');
    refreshBtn.addEventListener('click', async () => {
      await this.collectVaultData();
      this.render();
      new Notice('PARA Visualizer refreshed');
    });
  }

  renderHeatmap(container) {
    const statsPanel = container.createDiv('para-stats-panel');

    // Calculate stats
    const totalNotes = this.vaultData.notes.length;
    const recentNotes = this.vaultData.notes.filter(n =>
      (Date.now() - n.modified) < (this.dateRange * 24 * 60 * 60 * 1000)
    ).length;

    // Render stat cards
    Object.entries(this.vaultData.paraLocations).forEach(([location, notes]) => {
      const card = statsPanel.createDiv('para-stat-card');
      const value = card.createDiv('para-stat-value');
      value.setText(notes.length.toString());
      value.style.color = PARA_COLORS[location];
      const label = card.createDiv('para-stat-label');
      label.setText(location.toUpperCase());
    });

    // Render heatmap for each PARA location
    const heatmapContainer = container.createDiv('para-heatmap');

    Object.entries(this.vaultData.paraLocations).forEach(([location, notes]) => {
      if (notes.length === 0) return;

      const section = heatmapContainer.createDiv('para-heatmap-section');

      const header = section.createEl('h3');
      const badge = header.createSpan('para-location-badge');
      badge.addClass(location);
      badge.setText(location.toUpperCase());
      header.appendText(` (${notes.length} notes)`);

      // Build activity map for this location
      const activityMap = new Map();
      const cutoffDate = Date.now() - (this.dateRange * 24 * 60 * 60 * 1000);

      notes.forEach(note => {
        if (note.modified >= cutoffDate) {
          const date = new Date(note.modified).toISOString().split('T')[0];
          if (!activityMap.has(date)) {
            activityMap.set(date, []);
          }
          activityMap.get(date).push(note);
        }
      });

      // Calculate max activity for scaling
      const maxActivity = Math.max(...Array.from(activityMap.values()).map(arr => arr.length), 1);

      // Generate date range
      const grid = section.createDiv('para-heatmap-grid');
      const today = new Date();
      for (let i = this.dateRange - 1; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];

        const count = activityMap.get(dateStr)?.length || 0;
        const level = Math.min(4, Math.floor((count / maxActivity) * 4));

        const cell = grid.createDiv('para-heatmap-cell');
        cell.addClass(`level-${level}`);
        cell.style.backgroundColor = PARA_COLORS[location];

        // Tooltip on hover
        cell.setAttribute('title', `${dateStr}: ${count} notes`);

        // Click to show notes
        if (count > 0) {
          cell.addEventListener('click', () => {
            const notesList = activityMap.get(dateStr)
              .map(n => n.basename)
              .join('\n');
            new Notice(`Notes on ${dateStr}:\n${notesList}`, 5000);
          });
          cell.style.cursor = 'pointer';
        }
      }
    });
  }

  renderGraph(container) {
    const graphContainer = container.createDiv('para-graph-container');
    const canvas = graphContainer.createEl('canvas', { cls: 'para-graph-canvas' });

    // Legend
    const legend = graphContainer.createDiv('para-graph-legend');
    legend.createEl('strong', { text: 'PARA Locations' });
    Object.entries(PARA_COLORS).forEach(([location, color]) => {
      const item = legend.createDiv('para-graph-legend-item');
      const colorBox = item.createDiv('para-graph-legend-color');
      colorBox.style.backgroundColor = color;
      item.createSpan({ text: location.charAt(0).toUpperCase() + location.slice(1) });
    });

    // Draw graph using Canvas API
    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    const height = canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const displayWidth = canvas.offsetWidth;
    const displayHeight = canvas.offsetHeight;

    // Filter notes by date range
    const cutoffDate = Date.now() - (this.dateRange * 24 * 60 * 60 * 1000);
    const filteredNotes = this.vaultData.notes.filter(n => n.modified >= cutoffDate);

    if (filteredNotes.length === 0) {
      const empty = container.createDiv('para-empty');
      empty.createDiv('para-empty-icon').setText('📭');
      empty.createDiv('para-empty-message').setText('No notes found in selected time range');
      return;
    }

    // Create force-directed layout (simplified)
    const nodes = filteredNotes.map((note, i) => ({
      id: note.path,
      label: note.basename,
      para: note.paraLocation,
      x: Math.random() * displayWidth,
      y: Math.random() * displayHeight,
      vx: 0,
      vy: 0,
      links: note.links
    }));

    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    // Build edges
    const edges = [];
    this.vaultData.links.forEach(link => {
      const source = nodeMap.get(link.source);
      const target = nodeMap.get(link.target);
      if (source && target) {
        edges.push({ source, target });
      }
    });

    // Simple force simulation
    const simulate = () => {
      // Apply forces
      const centerX = displayWidth / 2;
      const centerY = displayHeight / 2;
      const repulsion = 100;
      const linkDistance = 50;

      // Repulsion between nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x;
          const dy = nodes[j].y - nodes[i].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = repulsion / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          nodes[i].vx -= fx;
          nodes[i].vy -= fy;
          nodes[j].vx += fx;
          nodes[j].vy += fy;
        }
      }

      // Attraction along edges
      edges.forEach(edge => {
        const dx = edge.target.x - edge.source.x;
        const dy = edge.target.y - edge.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - linkDistance) * 0.01;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        edge.source.vx += fx;
        edge.source.vy += fy;
        edge.target.vx -= fx;
        edge.target.vy -= fy;
      });

      // Center attraction
      nodes.forEach(node => {
        const dx = centerX - node.x;
        const dy = centerY - node.y;
        node.vx += dx * 0.001;
        node.vy += dy * 0.001;
      });

      // Update positions with damping
      nodes.forEach(node => {
        node.x += node.vx;
        node.y += node.vy;
        node.vx *= 0.9;
        node.vy *= 0.9;

        // Keep in bounds
        node.x = Math.max(20, Math.min(displayWidth - 20, node.x));
        node.y = Math.max(20, Math.min(displayHeight - 20, node.y));
      });
    };

    const draw = () => {
      ctx.clearRect(0, 0, displayWidth, displayHeight);

      // Draw edges
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.2)';
      ctx.lineWidth = 1;
      edges.forEach(edge => {
        ctx.beginPath();
        ctx.moveTo(edge.source.x, edge.source.y);
        ctx.lineTo(edge.target.x, edge.target.y);
        ctx.stroke();
      });

      // Draw nodes
      nodes.forEach(node => {
        const color = PARA_COLORS[node.para] || '#999';
        const size = Math.min(8, Math.max(4, node.links.length + 3));

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, size, 0, Math.PI * 2);
        ctx.fill();

        // Label for larger nodes
        if (node.links.length > 3) {
          ctx.fillStyle = '#fff';
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(node.label.substring(0, 15), node.x, node.y - 12);
        }
      });
    };

    // Animation loop
    let iterations = 0;
    const animate = () => {
      if (iterations < 100) {
        simulate();
        draw();
        iterations++;
        requestAnimationFrame(animate);
      } else {
        draw(); // Final draw
      }
    };

    animate();

    // Click handling
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      for (const node of nodes) {
        const dx = x - node.x;
        const dy = y - node.y;
        if (Math.sqrt(dx * dx + dy * dy) < 10) {
          this.app.workspace.openLinkText(node.id, '', false);
          break;
        }
      }
    });
  }

  renderSankey(container) {
    const sankeyContainer = container.createDiv('para-sankey-container');

    // Calculate PARA flow based on note age and location
    // Assumptions about flow patterns:
    // - Notes created in inbox -> likely moved to projects/areas/resources
    // - Notes in projects for >90 days -> likely moved to archive
    // - Notes can move: inbox->projects->archive or inbox->areas (ongoing)

    const cutoffDate = Date.now() - (this.dateRange * 24 * 60 * 60 * 1000);
    const filteredNotes = this.vaultData.notes.filter(n => n.created >= cutoffDate);

    if (filteredNotes.length === 0) {
      const empty = container.createDiv('para-empty');
      empty.createDiv('para-empty-icon').setText('🌊');
      empty.createDiv('para-empty-message').setText('No notes found in selected time range');
      return;
    }

    // Build flow data
    // Since we don't have historical location tracking, we'll estimate flows based on:
    // 1. Current distribution
    // 2. Note age vs location (older notes in archive suggests flow)
    // 3. Creation vs modification patterns

    const flowData = this.calculatePARAFlows(filteredNotes);

    // Stats panel
    const statsPanel = sankeyContainer.createDiv('para-sankey-stats');
    statsPanel.createEl('h3', { text: 'PARA Flow Analysis' });

    const statsGrid = statsPanel.createDiv('para-stats-panel');

    const totalFlow = Object.values(flowData.flows).reduce((sum, val) => sum + val, 0);

    // Key metrics
    const dataAccuracy = flowData.historyCount > 0
      ? `${Math.round((flowData.historyCount / (flowData.historyCount + flowData.estimateCount)) * 100)}%`
      : '0%';

    const metrics = [
      { label: 'Total Flow Events', value: totalFlow },
      { label: 'Active Projects', value: flowData.activeProjects },
      { label: 'Archived Notes', value: flowData.archivedNotes },
      { label: 'Avg. Project Duration', value: `${flowData.avgProjectDuration} days` },
      { label: 'Data Accuracy', value: dataAccuracy, tooltip: `${flowData.historyCount} with history, ${flowData.estimateCount} estimated` }
    ];

    metrics.forEach(metric => {
      const card = statsGrid.createDiv('para-stat-card');
      if (metric.tooltip) {
        card.setAttribute('title', metric.tooltip);
      }
      card.createDiv('para-stat-value').setText(metric.value.toString());
      card.createDiv('para-stat-label').setText(metric.label);
    });

    // Canvas for Sankey diagram
    const canvas = sankeyContainer.createEl('canvas', { cls: 'para-sankey-canvas' });
    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    const height = canvas.height = 600 * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const displayWidth = canvas.offsetWidth;
    const displayHeight = 600;

    // Sankey layout
    const nodes = [
      // Left column (sources)
      { id: 'inbox-source', label: 'Inbox', para: 'inbox', x: 80, y: displayHeight / 2, width: 60, height: 0 },

      // Middle column (active work)
      { id: 'projects', label: 'Projects', para: 'projects', x: displayWidth / 2 - 80, y: displayHeight * 0.25, width: 60, height: 0 },
      { id: 'areas', label: 'Areas', para: 'areas', x: displayWidth / 2 - 80, y: displayHeight * 0.5, width: 60, height: 0 },
      { id: 'resources', label: 'Resources', para: 'resources', x: displayWidth / 2 - 80, y: displayHeight * 0.75, width: 60, height: 0 },

      // Right column (destination)
      { id: 'archive', label: 'Archive', para: 'archive', x: displayWidth - 140, y: displayHeight / 2, width: 60, height: 0 }
    ];

    // Calculate node heights based on flows
    const nodeFlows = {
      'inbox-source': flowData.flows['inbox->projects'] + flowData.flows['inbox->areas'] + flowData.flows['inbox->resources'],
      'projects': flowData.flows['inbox->projects'] + flowData.flows['projects->archive'],
      'areas': flowData.flows['inbox->areas'],
      'resources': flowData.flows['inbox->resources'],
      'archive': flowData.flows['projects->archive'] + flowData.flows['areas->archive'] + flowData.flows['resources->archive']
    };

    const maxFlow = Math.max(...Object.values(nodeFlows), 1);
    const minHeight = 40;
    const maxHeight = displayHeight * 0.4;

    nodes.forEach(node => {
      const flow = nodeFlows[node.id] || 0;
      node.height = Math.max(minHeight, (flow / maxFlow) * maxHeight);
    });

    // Define flows (edges)
    const flows = [
      { source: 'inbox-source', target: 'projects', value: flowData.flows['inbox->projects'] },
      { source: 'inbox-source', target: 'areas', value: flowData.flows['inbox->areas'] },
      { source: 'inbox-source', target: 'resources', value: flowData.flows['inbox->resources'] },
      { source: 'projects', target: 'archive', value: flowData.flows['projects->archive'] },
      { source: 'areas', target: 'archive', value: flowData.flows['areas->archive'] },
      { source: 'resources', target: 'archive', value: flowData.flows['resources->archive'] }
    ].filter(flow => flow.value > 0);

    // Draw flows (curved paths)
    flows.forEach(flow => {
      const sourceNode = nodes.find(n => n.id === flow.source);
      const targetNode = nodes.find(n => n.id === flow.target);

      const flowHeight = (flow.value / maxFlow) * maxHeight * 0.8;

      // Calculate bezier curve
      const x1 = sourceNode.x + sourceNode.width;
      const y1 = sourceNode.y;
      const x2 = targetNode.x;
      const y2 = targetNode.y;
      const cx1 = x1 + (x2 - x1) * 0.5;
      const cx2 = x2 - (x2 - x1) * 0.5;

      // Draw gradient flow
      const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
      gradient.addColorStop(0, PARA_COLORS[sourceNode.para] + 'aa');
      gradient.addColorStop(1, PARA_COLORS[targetNode.para] + 'aa');

      ctx.fillStyle = gradient;
      ctx.strokeStyle = gradient;
      ctx.lineWidth = flowHeight;
      ctx.lineCap = 'round';

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(cx1, y1, cx2, y2, x2, y2);
      ctx.stroke();

      // Draw flow label
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      if (flow.value > 0) {
        ctx.fillStyle = '#333';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(flow.value.toString(), midX, midY - 5);
      }
    });

    // Draw nodes
    nodes.forEach(node => {
      const color = PARA_COLORS[node.para];

      // Node rectangle
      ctx.fillStyle = color;
      ctx.fillRect(node.x, node.y - node.height / 2, node.width, node.height);

      // Node border
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(node.x, node.y - node.height / 2, node.width, node.height);

      // Node label
      ctx.fillStyle = '#333';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = node.x < displayWidth / 2 ? 'left' : 'right';
      const labelX = node.x < displayWidth / 2 ? node.x - 10 : node.x + node.width + 10;
      ctx.fillText(node.label, labelX, node.y + 5);

      // Flow count
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      const count = nodeFlows[node.id] || 0;
      if (count > 0) {
        ctx.fillText(count.toString(), node.x + node.width / 2, node.y + 5);
      }
    });

    // Insights section
    const insights = sankeyContainer.createDiv('para-sankey-insights');
    insights.createEl('h3', { text: 'Insights & Patterns' });

    const insightsList = insights.createEl('ul');
    insightsList.style.paddingLeft = '20px';
    insightsList.style.lineHeight = '1.8';

    // Generate insights
    const totalNotes = filteredNotes.length;
    const inboxPct = ((nodeFlows['inbox-source'] / totalNotes) * 100).toFixed(0);
    const archivePct = ((nodeFlows['archive'] / totalNotes) * 100).toFixed(0);

    if (flowData.flows['inbox->projects'] > flowData.flows['inbox->areas']) {
      insightsList.createEl('li', { text: `Most inbox items become projects (${flowData.flows['inbox->projects']} notes)` });
    } else {
      insightsList.createEl('li', { text: `Most inbox items become ongoing areas (${flowData.flows['inbox->areas']} notes)` });
    }

    if (flowData.flows['projects->archive'] > totalNotes * 0.1) {
      insightsList.createEl('li', { text: `Good completion rate: ${flowData.flows['projects->archive']} projects archived` });
    } else {
      insightsList.createEl('li', { text: 'Projects tend to stay active longer than average' });
    }

    if (flowData.avgProjectDuration < 30) {
      insightsList.createEl('li', { text: 'Fast project turnaround (< 1 month average)' });
    } else if (flowData.avgProjectDuration > 90) {
      insightsList.createEl('li', { text: 'Long-term projects (> 3 months average)' });
    }

    insightsList.createEl('li', { text: `${archivePct}% of notes eventually get archived` });
  }

  calculatePARAFlows(notes) {
    // Use real history data when available, fall back to heuristics

    const flows = {
      'inbox->projects': 0,
      'inbox->areas': 0,
      'inbox->resources': 0,
      'projects->archive': 0,
      'areas->archive': 0,
      'resources->archive': 0
    };

    let activeProjects = 0;
    let archivedNotes = 0;
    let projectDurations = [];
    let historyCount = 0;
    let estimateCount = 0;

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    notes.forEach(note => {
      const ageInDays = (now - note.created) / dayMs;
      const timeSinceModDays = (now - note.modified) / dayMs;

      // Use real history data if available
      if (note.paraHistory && note.paraHistory.length > 0) {
        historyCount++;
        note.paraHistory.forEach(entry => {
          const flowKey = `${entry.from}->${entry.to}`;
          if (flows.hasOwnProperty(flowKey)) {
            flows[flowKey]++;
          }

          // Track project durations for real data
          if (entry.from === 'projects' && entry.to === 'archive') {
            const projectDuration = (entry.timestamp - note.created) / dayMs;
            if (projectDuration > 0) {
              projectDurations.push(projectDuration);
            }
          }
        });
      } else {
        // Fall back to heuristic estimation
        estimateCount++;
        switch (note.paraLocation) {
          case 'inbox':
            // Assume inbox items will eventually move
            // This is speculative - in reality they're still in inbox
            break;

          case 'projects':
            activeProjects++;
            // Assume notes came from inbox
            flows['inbox->projects']++;
            projectDurations.push(ageInDays);

            // If old and unmodified, likely to be archived
            if (ageInDays > 90 && timeSinceModDays > 30) {
              flows['projects->archive']++;
            }
            break;

          case 'areas':
            // Assume came from inbox
            flows['inbox->areas']++;

            // Areas rarely archive unless very old
            if (ageInDays > 180 && timeSinceModDays > 90) {
              flows['areas->archive']++;
            }
            break;

          case 'resources':
            // Assume came from inbox
            flows['inbox->resources']++;

            // Resources rarely archive
            if (ageInDays > 365 && timeSinceModDays > 180) {
              flows['resources->archive']++;
            }
            break;

          case 'archive':
            archivedNotes++;
            // Count backwards - where did archived notes come from?
            // Estimate: most archives come from projects
            if (ageInDays < 90) {
              flows['projects->archive']++;
            } else if (ageInDays < 180) {
              flows['areas->archive']++;
            } else {
              flows['resources->archive']++;
            }
            break;
        }
      }

      // Count active projects and archived notes from current state
      if (note.paraLocation === 'projects') {
        activeProjects++;
      } else if (note.paraLocation === 'archive') {
        archivedNotes++;
      }
    });

    const avgProjectDuration = projectDurations.length > 0
      ? Math.round(projectDurations.reduce((a, b) => a + b, 0) / projectDurations.length)
      : 0;

    console.log(`Quick PARA Flow: ${historyCount} notes with history, ${estimateCount} estimated`);

    return {
      flows,
      activeProjects,
      archivedNotes,
      avgProjectDuration,
      historyCount,
      estimateCount
    };
  }

  renderTaskAnalytics(container) {
    const taskData = this.vaultData.tasks;

    if (!taskData || taskData.all.length === 0) {
      const empty = container.createDiv('para-empty');
      empty.createDiv('para-empty-icon').setText('✅');
      empty.createDiv('para-empty-message').setText('No tasks found in vault');
      return;
    }

    const analytics = container.createDiv('para-task-analytics');

    // Overall task metrics
    const metricsSection = analytics.createDiv('para-heatmap-section');
    metricsSection.createEl('h3', { text: 'Task Overview' });

    const totalTasks = taskData.all.length;
    const completedTasks = taskData.all.filter(t => t.completed).length;
    const openTasks = totalTasks - completedTasks;
    const completionRate = totalTasks > 0 ? ((completedTasks / totalTasks) * 100).toFixed(1) : 0;

    // Calculate tasks with completion dates (tracked completion)
    const tasksWithCompletionDates = taskData.all.filter(t => t.completed && t.completionDate).length;
    const trackingCoverage = completedTasks > 0 ? ((tasksWithCompletionDates / completedTasks) * 100).toFixed(0) : 0;

    const metricsGrid = metricsSection.createDiv('para-stats-panel');

    const metrics = [
      { label: 'Total Tasks', value: totalTasks },
      { label: 'Completed', value: completedTasks },
      { label: 'Open', value: openTasks },
      { label: 'Completion Rate', value: `${completionRate}%` },
      { label: 'Tracking Coverage', value: `${trackingCoverage}%`, tooltip: `${tasksWithCompletionDates} of ${completedTasks} completed tasks have completion dates` }
    ];

    metrics.forEach(metric => {
      const card = metricsGrid.createDiv('para-stat-card');
      if (metric.tooltip) {
        card.setAttribute('title', metric.tooltip);
      }
      card.createDiv('para-stat-value').setText(metric.value.toString());
      card.createDiv('para-stat-label').setText(metric.label);
    });

    // Task distribution by PARA location
    const paraSection = analytics.createDiv('para-heatmap-section');
    paraSection.createEl('h3', { text: 'Tasks by PARA Location' });

    const paraGrid = paraSection.createDiv('para-task-para-grid');

    Object.entries(taskData.byPara).forEach(([location, counts]) => {
      if (counts.open === 0 && counts.completed === 0) return;

      const card = paraGrid.createDiv('para-task-para-card');

      const header = card.createDiv('para-task-para-header');
      const badge = header.createSpan('para-location-badge');
      badge.addClass(location);
      badge.setText(location.toUpperCase());

      const stats = card.createDiv('para-task-para-stats');

      const openBar = stats.createDiv('para-task-bar');
      openBar.createSpan({ text: `Open: ${counts.open}`, cls: 'para-task-bar-label' });
      const openProgress = openBar.createDiv('para-task-bar-progress');
      const total = counts.open + counts.completed;
      const openPct = total > 0 ? (counts.open / total) * 100 : 0;
      openProgress.style.width = `${openPct}%`;
      openProgress.style.backgroundColor = '#f59e0b'; // Orange for open tasks

      const completedBar = stats.createDiv('para-task-bar');
      completedBar.createSpan({ text: `Completed: ${counts.completed}`, cls: 'para-task-bar-label' });
      const completedProgress = completedBar.createDiv('para-task-bar-progress');
      const completedPct = total > 0 ? (counts.completed / total) * 100 : 0;
      completedProgress.style.width = `${completedPct}%`;
      completedProgress.style.backgroundColor = PARA_COLORS[location];
    });

    // Task completion heatmap
    if (tasksWithCompletionDates > 0) {
      const heatmapSection = analytics.createDiv('para-heatmap-section');
      heatmapSection.createEl('h3', { text: 'Task Completion Heatmap' });

      // Build completion activity map
      const activityMap = new Map();
      let maxCompletions = 0;

      taskData.byDate.forEach((tasks, date) => {
        activityMap.set(date, tasks.length);
        maxCompletions = Math.max(maxCompletions, tasks.length);
      });

      // Generate date range for last N days
      const grid = heatmapSection.createDiv('para-heatmap-grid');
      const today = new Date();
      for (let i = this.dateRange - 1; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];

        const count = activityMap.get(dateStr) || 0;
        const level = maxCompletions > 0 ? Math.min(4, Math.floor((count / maxCompletions) * 4)) : 0;

        const cell = grid.createDiv('para-heatmap-cell');
        cell.addClass(`level-${level}`);
        cell.style.backgroundColor = '#10b981'; // Green for completed tasks

        cell.setAttribute('title', `${dateStr}: ${count} tasks completed`);

        if (count > 0) {
          cell.addEventListener('click', () => {
            const tasks = activityMap.get(dateStr) || [];
            const taskList = taskData.byDate.get(dateStr).map(t => `${t.text} (${t.fileName})`).join('\n');
            new Notice(`${count} tasks completed on ${dateStr}:\n${taskList}`, 5000);
          });
          cell.style.cursor = 'pointer';
        }
      }
    }

    // Task velocity chart (line graph)
    const velocitySection = analytics.createDiv('para-heatmap-section');
    velocitySection.createEl('h3', { text: 'Task Completion Velocity' });

    const velocityCanvas = velocitySection.createEl('canvas', { cls: 'para-velocity-canvas' });
    const ctx = velocityCanvas.getContext('2d');
    const width = velocityCanvas.width = velocityCanvas.offsetWidth * window.devicePixelRatio;
    const height = velocityCanvas.height = 300 * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const displayWidth = velocityCanvas.offsetWidth;
    const displayHeight = 300;

    // Calculate daily completion counts
    const dailyCounts = [];
    const today = new Date();
    for (let i = this.dateRange - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const count = taskData.byDate.get(dateStr)?.length || 0;
      dailyCounts.push({ date: dateStr, count });
    }

    // Draw velocity chart
    const maxVelocity = Math.max(...dailyCounts.map(d => d.count), 1);
    const padding = 40;
    const chartWidth = displayWidth - padding * 2;
    const chartHeight = displayHeight - padding * 2;

    // Draw axes
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, displayHeight - padding);
    ctx.lineTo(displayWidth - padding, displayHeight - padding);
    ctx.stroke();

    // Draw grid lines
    ctx.strokeStyle = '#eee';
    for (let i = 0; i <= 5; i++) {
      const y = padding + (chartHeight / 5) * i;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(displayWidth - padding, y);
      ctx.stroke();

      // Y-axis labels
      ctx.fillStyle = '#666';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      const value = Math.round(maxVelocity * (1 - i / 5));
      ctx.fillText(value.toString(), padding - 5, y + 3);
    }

    // Draw line chart
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.beginPath();

    dailyCounts.forEach((point, index) => {
      const x = padding + (index / (dailyCounts.length - 1)) * chartWidth;
      const y = displayHeight - padding - (point.count / maxVelocity) * chartHeight;

      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();

    // Draw points
    dailyCounts.forEach((point, index) => {
      const x = padding + (index / (dailyCounts.length - 1)) * chartWidth;
      const y = displayHeight - padding - (point.count / maxVelocity) * chartHeight;

      ctx.fillStyle = '#10b981';
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });

    // X-axis label
    ctx.fillStyle = '#666';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Days', displayWidth / 2, displayHeight - 5);

    // Y-axis label
    ctx.save();
    ctx.translate(15, displayHeight / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Tasks Completed', 0, 0);
    ctx.restore();

    // Task age analysis (for completed tasks with dates)
    const tasksWithAge = taskData.all.filter(t => t.ageInDays !== undefined);
    if (tasksWithAge.length > 0) {
      const ageSection = analytics.createDiv('para-heatmap-section');
      ageSection.createEl('h3', { text: 'Task Age Analysis' });

      const ages = tasksWithAge.map(t => t.ageInDays);
      const avgAge = Math.round(ages.reduce((a, b) => a + b, 0) / ages.length);
      const minAge = Math.min(...ages);
      const maxAge = Math.max(...ages);
      const medianAge = ages.sort((a, b) => a - b)[Math.floor(ages.length / 2)];

      const ageGrid = ageSection.createDiv('para-stats-panel');

      const ageMetrics = [
        { label: 'Avg. Time to Complete', value: `${avgAge} days` },
        { label: 'Fastest Completion', value: `${minAge} days` },
        { label: 'Slowest Completion', value: `${maxAge} days` },
        { label: 'Median Time', value: `${medianAge} days` }
      ];

      ageMetrics.forEach(metric => {
        const card = ageGrid.createDiv('para-stat-card');
        card.createDiv('para-stat-value').setText(metric.value);
        card.createDiv('para-stat-label').setText(metric.label);
      });
    }

    // Insights
    const insights = analytics.createDiv('para-sankey-insights');
    insights.createEl('h3', { text: 'Task Insights' });

    const insightsList = insights.createEl('ul');
    insightsList.style.paddingLeft = '20px';
    insightsList.style.lineHeight = '1.8';

    // Generate insights
    if (completionRate >= 70) {
      insightsList.createEl('li', { text: `Great job! ${completionRate}% of your tasks are completed.` });
    } else if (completionRate >= 50) {
      insightsList.createEl('li', { text: `You're making progress with ${completionRate}% completion rate.` });
    } else {
      insightsList.createEl('li', { text: `${openTasks} tasks are still open. Consider prioritizing.` });
    }

    if (trackingCoverage < 50) {
      insightsList.createEl('li', { text: `Tip: Add completion dates (✅ YYYY-MM-DD) to track your velocity over time.` });
    }

    const projectTasks = taskData.byPara.projects.open + taskData.byPara.projects.completed;
    if (projectTasks > totalTasks * 0.5) {
      insightsList.createEl('li', { text: `Most tasks (${projectTasks}) are in Projects - your active work area.` });
    }

    if (tasksWithAge.length > 0) {
      const avgAge = Math.round(tasksWithAge.map(t => t.ageInDays).reduce((a, b) => a + b, 0) / tasksWithAge.length);
      if (avgAge < 7) {
        insightsList.createEl('li', { text: `Fast turnaround! Average task completion in ${avgAge} days.` });
      } else if (avgAge > 30) {
        insightsList.createEl('li', { text: `Tasks take ${avgAge} days on average. Consider breaking them into smaller chunks.` });
      }
    }
  }

  renderTagCloud(container) {
    const tagCloud = container.createDiv('para-tag-cloud');

    // Filter tags (exclude system tags)
    const systemTags = new Set(['all', 'inbox', 'projects', 'areas', 'resources', 'archive']);
    const tagData = Array.from(this.vaultData.tags.entries())
      .filter(([tag]) => !systemTags.has(tag))
      .map(([tag, notes]) => ({
        tag,
        count: notes.length,
        recentCount: notes.filter(n =>
          (Date.now() - n.modified) < (this.dateRange * 24 * 60 * 60 * 1000)
        ).length
      }))
      .filter(item => item.recentCount > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 50); // Top 50 tags

    if (tagData.length === 0) {
      const empty = container.createDiv('para-empty');
      empty.createDiv('para-empty-icon').setText('🏷️');
      empty.createDiv('para-empty-message').setText('No tags found in selected time range');
      return;
    }

    const maxCount = Math.max(...tagData.map(t => t.count));
    const minSize = 12;
    const maxSize = 48;

    tagData.forEach(item => {
      const size = minSize + ((item.count / maxCount) * (maxSize - minSize));
      const opacity = 0.5 + (item.recentCount / item.count) * 0.5;

      const tagEl = tagCloud.createSpan('para-tag-cloud-item');
      tagEl.setText(`#${item.tag}`);
      tagEl.style.fontSize = `${size}px`;
      tagEl.style.opacity = opacity.toString();

      // Random PARA color
      const paraKeys = Object.keys(PARA_COLORS);
      const randomColor = PARA_COLORS[paraKeys[Math.floor(Math.random() * paraKeys.length)]];
      tagEl.style.color = randomColor;

      tagEl.setAttribute('title', `${item.count} notes (${item.recentCount} recent)`);

      tagEl.addEventListener('click', () => {
        // Search for tag
        this.app.internalPlugins.getPluginById('global-search').instance.openGlobalSearch(`tag:#${item.tag}`);
      });
    });
  }

  renderStats(container) {
    const stats = container.createDiv();

    // Overall stats
    const overallSection = stats.createDiv('para-heatmap-section');
    overallSection.createEl('h3', { text: 'Vault Overview' });

    const overallGrid = overallSection.createDiv('para-stats-panel');

    const totalCard = overallGrid.createDiv('para-stat-card');
    totalCard.createDiv('para-stat-value').setText(this.vaultData.notes.length.toString());
    totalCard.createDiv('para-stat-label').setText('Total Notes');

    const tagsCard = overallGrid.createDiv('para-stat-card');
    tagsCard.createDiv('para-stat-value').setText(this.vaultData.tags.size.toString());
    tagsCard.createDiv('para-stat-label').setText('Unique Tags');

    const linksCard = overallGrid.createDiv('para-stat-card');
    linksCard.createDiv('para-stat-value').setText(this.vaultData.links.length.toString());
    linksCard.createDiv('para-stat-label').setText('Total Links');

    // Average links per note
    const avgLinks = (this.vaultData.links.length / this.vaultData.notes.length).toFixed(1);
    const avgCard = overallGrid.createDiv('para-stat-card');
    avgCard.createDiv('para-stat-value').setText(avgLinks);
    avgCard.createDiv('para-stat-label').setText('Avg Links/Note');

    // PARA distribution
    const paraSection = stats.createDiv('para-heatmap-section');
    paraSection.createEl('h3', { text: 'PARA Distribution' });

    const paraGrid = paraSection.createDiv('para-stats-panel');
    Object.entries(this.vaultData.paraLocations).forEach(([location, notes]) => {
      const card = paraGrid.createDiv('para-stat-card');
      const value = card.createDiv('para-stat-value');
      value.setText(notes.length.toString());
      value.style.color = PARA_COLORS[location];

      const percentage = ((notes.length / this.vaultData.notes.length) * 100).toFixed(1);
      card.createDiv('para-stat-label').setText(`${location.toUpperCase()} (${percentage}%)`);
    });

    // Recent activity
    const activitySection = stats.createDiv('para-heatmap-section');
    activitySection.createEl('h3', { text: 'Recent Activity' });

    const periods = [
      { days: 1, label: 'Last 24 hours' },
      { days: 7, label: 'Last 7 days' },
      { days: 30, label: 'Last 30 days' },
      { days: 90, label: 'Last 90 days' }
    ];

    const activityGrid = activitySection.createDiv('para-stats-panel');
    periods.forEach(period => {
      const cutoff = Date.now() - (period.days * 24 * 60 * 60 * 1000);
      const count = this.vaultData.notes.filter(n => n.modified >= cutoff).length;

      const card = activityGrid.createDiv('para-stat-card');
      card.createDiv('para-stat-value').setText(count.toString());
      card.createDiv('para-stat-label').setText(period.label);
    });

    // Top tags
    const tagsSection = stats.createDiv('para-heatmap-section');
    tagsSection.createEl('h3', { text: 'Top 10 Tags' });

    const topTags = Array.from(this.vaultData.tags.entries())
      .map(([tag, notes]) => ({ tag, count: notes.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const tagsList = tagsSection.createEl('ol');
    tagsList.style.paddingLeft = '20px';
    topTags.forEach(item => {
      tagsList.createEl('li', { text: `#${item.tag} (${item.count})` });
    });
  }

  renderReviewRadar(container) {
    const reviewData = this.computeReviewStats();
    const reviewView = container.createDiv('para-review-view');

    if (reviewData.locations.length === 0) {
      const empty = reviewView.createDiv('para-empty');
      empty.createDiv('para-empty-icon').setText('🧭');
      empty.createDiv('para-empty-message').setText('No PARA notes available to calculate review cadence.');
      return;
    }

    const summary = reviewView.createDiv('para-stats-panel');
    const cards = [
      { label: 'Overall Health', value: `${reviewData.overallHealth}%` },
      { label: 'Overdue Reviews', value: reviewData.overdueNotes.length.toString() },
      { label: 'Freshest Area', value: reviewData.freshest ? `${reviewData.freshest.label} (${this.formatDays(reviewData.freshest.avgDays)} ago)` : '—' }
    ];

    cards.forEach(cardData => {
      const card = summary.createDiv('para-stat-card');
      card.createDiv('para-stat-value').setText(cardData.value);
      card.createDiv('para-stat-label').setText(cardData.label);
    });

    const layout = reviewView.createDiv('para-review-layout');
    const chartWrapper = layout.createDiv('para-review-chart');
    const canvas = chartWrapper.createEl('canvas', { cls: 'para-review-canvas' });

    this.drawReviewRadarChart(canvas, reviewData.locations);

    const insights = layout.createDiv('para-review-insights');
    insights.createEl('h3', { text: 'Insights' });
    const list = insights.createEl('ul');

    list.createEl('li', { text: `Review cadence health is at ${reviewData.overallHealth}% across tracked PARA buckets.` });

    if (reviewData.stalest) {
      list.createEl('li', {
        text: `${reviewData.stalest.label} is the stalest area (${Math.round(reviewData.stalest.avgDays)} days since average touch; target ${Math.round(reviewData.stalest.avgTarget)} days).`
      });
    }

    if (reviewData.overdueNotes.length > 0) {
      const worst = reviewData.overdueNotes[0];
      list.createEl('li', {
        text: `${worst.note.basename} is overdue by ${Math.round(worst.overdueBy)} days (target ${worst.target} days).`
      });
    } else {
      list.createEl('li', { text: 'No notes are currently overdue for review. 🎉' });
    }

    const locationGrid = reviewView.createDiv('para-review-location-grid');
    reviewData.locations.forEach(stat => {
      const card = locationGrid.createDiv('para-review-location-card');
      const header = card.createDiv('para-review-location-header');
      const badge = header.createSpan('para-location-badge');
      badge.addClass(stat.location);
      badge.setText(stat.label.toUpperCase());

      header.createSpan({ text: `${Math.round(stat.score * 100)}% healthy`, cls: 'para-review-score' });

      const meta = card.createDiv('para-review-location-meta');

      meta.createEl('p', { text: `Avg touch: ${this.formatDays(stat.avgDays)} (target ${this.formatDays(stat.avgTarget)})` });
      meta.createEl('p', { text: `Tracked notes: ${stat.noteCount}` });
      meta.createEl('p', { text: `Overdue: ${stat.overdueCount}` });
      meta.createEl('p', { text: `Last touched: ${stat.lastTouched ? new Date(stat.lastTouched).toLocaleDateString() : '—'}` });
    });

    const overdueSection = reviewView.createDiv('para-review-overdue');
    overdueSection.createEl('h3', { text: 'Notes Needing Review' });

    if (reviewData.overdueNotes.length === 0) {
      overdueSection.createEl('p', { text: 'Everything is within the desired cadence.' });
    } else {
      const listEl = overdueSection.createEl('ul');
      reviewData.overdueNotes.slice(0, 8).forEach(item => {
        const li = listEl.createEl('li');
        li.addClass('para-review-overdue-item');
        li.innerHTML = `
          <strong>${item.note.basename}</strong>
          <span class="para-review-overdue-meta">
            ${item.note.paraLocation.toUpperCase()} • ${this.formatDays(item.daysSince)} since touch • Overdue by ${Math.round(item.overdueBy)} days
          </span>
        `;
        li.addEventListener('click', () => {
          this.app.workspace.openLinkText(item.note.path, '', false);
        });
      });
      if (reviewData.overdueNotes.length > 8) {
        overdueSection.createEl('p', {
          text: `${reviewData.overdueNotes.length - 8} more notes are overdue.`,
          attr: { style: 'color: var(--text-muted); font-size: 0.9em;' }
        });
      }
    }
  }

  drawReviewRadarChart(canvas, locations) {
    const ratio = window.devicePixelRatio || 1;
    const displayWidth = canvas.offsetWidth || canvas.parentElement?.offsetWidth || 400;
    const displayHeight = 360;
    canvas.width = displayWidth * ratio;
    canvas.height = displayHeight * ratio;

    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);

    const centerX = displayWidth / 2;
    const centerY = displayHeight / 2;
    const radius = Math.min(displayWidth, displayHeight) / 2 - 40;
    const axisCount = locations.length;
    const rings = 4;

    ctx.strokeStyle = 'var(--background-modifier-border)';
    ctx.lineWidth = 1;

    for (let i = 1; i <= rings; i++) {
      const ringRadius = (radius / rings) * i;
      ctx.beginPath();
      for (let axis = 0; axis < axisCount; axis++) {
        const angle = (Math.PI * 2 * axis) / axisCount - Math.PI / 2;
        const x = centerX + Math.cos(angle) * ringRadius;
        const y = centerY + Math.sin(angle) * ringRadius;
        axis === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }

    ctx.strokeStyle = 'var(--background-modifier-border)';
    locations.forEach((stat, index) => {
      const angle = (Math.PI * 2 * index) / axisCount - Math.PI / 2;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(x, y);
      ctx.stroke();

      ctx.fillStyle = 'var(--text-muted)';
      ctx.font = '12px sans-serif';
      const labelX = centerX + Math.cos(angle) * (radius + 20);
      const labelY = centerY + Math.sin(angle) * (radius + 20);
      ctx.textAlign = labelX < centerX ? 'right' : 'left';
      ctx.fillText(`${stat.label} (${Math.round(stat.avgDays)}d / ${Math.round(stat.avgTarget)}d)`, labelX, labelY);
    });

    ctx.beginPath();
    locations.forEach((stat, index) => {
      const angle = (Math.PI * 2 * index) / axisCount - Math.PI / 2;
      const r = radius * Math.max(0, Math.min(1, stat.score));
      const x = centerX + Math.cos(angle) * r;
      const y = centerY + Math.sin(angle) * r;
      index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(59, 130, 246, 0.25)';
    ctx.strokeStyle = '#3b82f6';
    ctx.fill();
    ctx.stroke();

    locations.forEach((stat, index) => {
      const angle = (Math.PI * 2 * index) / axisCount - Math.PI / 2;
      const r = radius * stat.score;
      const x = centerX + Math.cos(angle) * r;
      const y = centerY + Math.sin(angle) * r;
      ctx.beginPath();
      ctx.fillStyle = '#3b82f6';
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  computeReviewStats() {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const locations = [];
    const overdueNotes = [];
    const order = ['inbox', 'projects', 'areas', 'resources'];

    order.forEach(location => {
      const notes = this.vaultData.notes.filter(n => n.paraLocation === location);
      if (notes.length === 0) return;

      let totalDays = 0;
      let totalTarget = 0;
      let targetCount = 0;
      let latestTouch = 0;
      let overdueCount = 0;

      notes.forEach(note => {
        const daysSince = (now - note.modified) / dayMs;
        totalDays += daysSince;
        latestTouch = Math.max(latestTouch, note.modified);
        const target = this.getReviewIntervalForNote(note);
        if (target) {
          totalTarget += target;
          targetCount++;
          if (daysSince > target) {
            overdueCount++;
            overdueNotes.push({
              note,
              daysSince,
              target,
              overdueBy: daysSince - target
            });
          }
        }
      });

      const avgDays = totalDays / notes.length;
      const avgTarget = targetCount > 0 ? totalTarget / targetCount : this.getDefaultReviewInterval(location);
      const score = avgDays <= 0 ? 1 : Math.min(1, avgTarget / avgDays);

      locations.push({
        location,
        label: location.charAt(0).toUpperCase() + location.slice(1),
        avgDays,
        avgTarget,
        score,
        lastTouched: latestTouch,
        noteCount: notes.length,
        overdueCount
      });
    });

    overdueNotes.sort((a, b) => b.overdueBy - a.overdueBy);

    const overallHealth = locations.length
      ? Math.round((locations.reduce((sum, loc) => sum + loc.score, 0) / locations.length) * 100)
      : 0;

    const stalest = locations.reduce((worst, current) => {
      if (!worst) return current;
      return current.avgDays > worst.avgDays ? current : worst;
    }, null);

    const freshest = locations.reduce((best, current) => {
      if (!best) return current;
      return current.avgDays < best.avgDays ? current : best;
    }, null);

    return {
      locations,
      overdueNotes,
      overallHealth,
      stalest,
      freshest
    };
  }

  renderPipelineTimeline(container) {
    const pipelineView = container.createDiv('para-pipeline-view');
    const pipelineData = this.generatePipelineTimelineData();

    if (pipelineData.timeline.length === 0) {
      const empty = pipelineView.createDiv('para-empty');
      empty.createDiv('para-empty-icon').setText('📉');
      empty.createDiv('para-empty-message').setText('Not enough PARA history data to build the pipeline timeline.');
      return;
    }

    const totalActive = this.vaultData.notes.filter(n => n.paraLocation !== 'archive').length;
    const summary = pipelineView.createDiv('para-stats-panel');
    const cards = [
      { label: 'Active Pipeline', value: totalActive.toString() },
      { label: 'Projects Archived (window)', value: (pipelineData.transitionCounts['projects->archive'] || 0).toString() },
      {
        label: 'Longest Stage',
        value: pipelineData.longestStage
          ? `${pipelineData.longestStage.label} (${this.formatDays(pipelineData.longestStage.duration)})`
          : '—'
      }
    ];

    cards.forEach(cardData => {
      const card = summary.createDiv('para-stat-card');
      card.createDiv('para-stat-value').setText(cardData.value);
      card.createDiv('para-stat-label').setText(cardData.label);
    });

    const chartSection = pipelineView.createDiv('para-pipeline-chart');
    chartSection.createEl('h3', { text: 'Pipeline Over Time' });
    const canvas = chartSection.createEl('canvas', { cls: 'para-pipeline-canvas' });
    this.drawPipelineTimelineChart(canvas, pipelineData.timeline);

    const legend = chartSection.createDiv('para-pipeline-legend');
    Object.entries(PARA_COLORS).forEach(([location, color]) => {
      const item = legend.createDiv('para-graph-legend-item');
      const colorBox = item.createDiv('para-graph-legend-color');
      colorBox.style.backgroundColor = color;
      item.createSpan({ text: location.charAt(0).toUpperCase() + location.slice(1) });
    });

    const insights = pipelineView.createDiv('para-pipeline-insights');
    insights.createEl('h3', { text: 'Flow Insights' });
    const list = insights.createEl('ul');
    list.style.paddingLeft = '20px';

    if (pipelineData.busiestDay) {
      const dominant = pipelineData.busiestDay.dominant
        ? pipelineData.busiestDay.dominant.charAt(0).toUpperCase() + pipelineData.busiestDay.dominant.slice(1)
        : 'Mixed';
      list.createEl('li', {
        text: `${pipelineData.busiestDay.date} was the busiest day (${pipelineData.busiestDay.total} notes) dominated by ${dominant}.`
      });
    }

    if (pipelineData.longestStage) {
      list.createEl('li', {
        text: `${pipelineData.longestStage.label} keeps notes the longest (${this.formatDays(pipelineData.longestStage.duration)} on average).`
      });
    }

    if (pipelineData.topTransition) {
      list.createEl('li', {
        text: `${pipelineData.topTransition.key} happened ${pipelineData.topTransition.value} times in this window.`
      });
    }

    const durationSection = pipelineView.createDiv('para-pipeline-durations');
    durationSection.createEl('h3', { text: 'Average Time in Stage' });
    const durationGrid = durationSection.createDiv('para-pipeline-duration-grid');

    ['inbox', 'projects', 'areas', 'resources', 'archive'].forEach(location => {
      const card = durationGrid.createDiv('para-pipeline-duration-card');
      const header = card.createDiv('para-pipeline-duration-header');
      const badge = header.createSpan('para-location-badge');
      badge.addClass(location);
      badge.setText(location.toUpperCase());

      const duration = pipelineData.avgStageDurations[location];
      card.createDiv('para-pipeline-duration-value').setText(
        duration ? this.formatDays(duration) : 'No data'
      );
      card.createDiv('para-pipeline-duration-label').setText('Avg time before moving');
    });

    const transitionSection = pipelineView.createDiv('para-pipeline-transitions');
    transitionSection.createEl('h3', { text: 'Top Transitions' });
    const transitionList = transitionSection.createEl('ol');
    transitionList.style.paddingLeft = '20px';

    const topTransitions = Object.entries(pipelineData.transitionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (topTransitions.length === 0) {
      transitionSection.createEl('p', { text: 'No tracked transitions during this window.' });
    } else {
      topTransitions.forEach(([key, value]) => {
        transitionList.createEl('li', { text: `${key} — ${value} notes` });
      });
    }
  }

  drawPipelineTimelineChart(canvas, timeline) {
    const ratio = window.devicePixelRatio || 1;
    const displayWidth = canvas.offsetWidth || canvas.parentElement?.offsetWidth || 600;
    const displayHeight = 360;
    canvas.width = displayWidth * ratio;
    canvas.height = displayHeight * ratio;

    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);

    const padding = 40;
    const chartWidth = displayWidth - padding * 2;
    const chartHeight = displayHeight - padding * 2;
    const categories = ['inbox', 'projects', 'areas', 'resources', 'archive'];
    const maxTotal = Math.max(...timeline.map(day => day.total), 1);
    const stepCount = timeline.length > 1 ? timeline.length - 1 : 1;

    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, displayHeight - padding);
    ctx.lineTo(displayWidth - padding, displayHeight - padding);
    ctx.stroke();

    ctx.strokeStyle = '#eee';
    for (let i = 1; i <= 4; i++) {
      const y = padding + (chartHeight / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(displayWidth - padding, y);
      ctx.stroke();
    }

    const stackedTotals = new Array(timeline.length).fill(0);

    categories.forEach(location => {
      const topPoints = [];
      const bottomPoints = [];
      timeline.forEach((day, index) => {
        const base = stackedTotals[index];
        const value = day.counts[location] || 0;
        const top = base + value;
        const x = padding + (index / stepCount) * chartWidth;
        const yTop = displayHeight - padding - (top / maxTotal) * chartHeight;
        const yBase = displayHeight - padding - (base / maxTotal) * chartHeight;
        topPoints.push({ x, y: yTop });
        bottomPoints.push({ x, y: yBase });
        stackedTotals[index] = top;
      });

      ctx.beginPath();
      topPoints.forEach((point, idx) => (idx === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
      for (let i = bottomPoints.length - 1; i >= 0; i--) {
        const point = bottomPoints[i];
        ctx.lineTo(point.x, point.y);
      }
      ctx.closePath();
      ctx.fillStyle = this.hexToRgba(PARA_COLORS[location], 0.3);
      ctx.strokeStyle = this.hexToRgba(PARA_COLORS[location], 0.7);
      ctx.fill();
      ctx.stroke();
    });

    ctx.fillStyle = '#666';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    const labelIndexes = [0, Math.floor(timeline.length / 2), timeline.length - 1];
    labelIndexes.forEach(index => {
      const day = timeline[index];
      const x = padding + (index / stepCount) * chartWidth;
      ctx.fillText(day.date, x, displayHeight - padding + 20);
    });

    ctx.save();
    ctx.translate(15, displayHeight / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Notes per PARA stage', 0, 0);
    ctx.restore();
  }

  generatePipelineTimelineData() {
    const dayMs = 24 * 60 * 60 * 1000;
    const timeline = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (this.dateRange - 1));

    for (let i = 0; i < this.dateRange; i++) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + i);
      timeline.push({
        date: date.toISOString().split('T')[0],
        timestamp: date.getTime(),
        counts: {
          inbox: 0,
          projects: 0,
          areas: 0,
          resources: 0,
          archive: 0
        },
        total: 0,
        dominant: null
      });
    }

    const transitionCounts = {};
    const stageDurations = {
      inbox: [],
      projects: [],
      areas: [],
      resources: [],
      archive: []
    };

    this.vaultData.notes.forEach(note => {
      const history = (note.paraHistory || [])
        .map(entry => {
          const rawTimestamp =
            entry.timestamp ??
            entry.time ??
            (entry.date ? new Date(entry.date).getTime() : null);
          if (!rawTimestamp || !isFinite(rawTimestamp)) return null;

          return {
            timestamp: Number(rawTimestamp),
            from: this.normalizeLocation(entry.from ?? entry.from_location ?? entry.fromLocation ?? note.paraLocation),
            to: this.normalizeLocation(entry.to ?? entry.to_location ?? entry.toLocation ?? note.paraLocation)
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.timestamp - b.timestamp);

      const creationTs = note.created || 0;
      const initialLocation = history.length > 0
        ? this.normalizeLocation(history[0].from || note.paraLocation)
        : this.normalizeLocation(note.paraLocation);

      const states = [{ timestamp: creationTs, location: initialLocation }];
      history.forEach(move => {
        states.push({ timestamp: move.timestamp, location: move.to || states[states.length - 1].location });
      });
      states.sort((a, b) => a.timestamp - b.timestamp);

      timeline.forEach(day => {
        const loc = this.getLocationAtTime(states, day.timestamp + dayMs / 2);
        if (loc && day.counts[loc] !== undefined) {
          day.counts[loc]++;
        }
      });

      let prevTimestamp = creationTs;
      let prevLocation = states[0]?.location || initialLocation;
      history.forEach(move => {
        const duration = (move.timestamp - prevTimestamp) / dayMs;
        if (duration >= 0 && stageDurations[prevLocation]) {
          stageDurations[prevLocation].push(duration);
        }
        const key = `${prevLocation}->${move.to}`;
        transitionCounts[key] = (transitionCounts[key] || 0) + 1;
        prevTimestamp = move.timestamp;
        prevLocation = move.to || prevLocation;
      });
    });

    timeline.forEach(day => {
      const entries = Object.entries(day.counts);
      day.total = entries.reduce((sum, [, value]) => sum + value, 0);
      const dominant = entries.reduce(
        (best, [location, value]) => (value > (best?.value || 0) ? { location, value } : best),
        null
      );
      day.dominant = dominant?.location || null;
    });

    const avgStageDurations = {};
    Object.entries(stageDurations).forEach(([location, durations]) => {
      if (durations.length > 0) {
        avgStageDurations[location] = durations.reduce((sum, value) => sum + value, 0) / durations.length;
      }
    });

    const longestStage = Object.entries(avgStageDurations).reduce((best, [location, duration]) => {
      if (!best || duration > best.duration) {
        return {
          location,
          duration,
          label: location.charAt(0).toUpperCase() + location.slice(1)
        };
      }
      return best;
    }, null);

    const busiestDay = timeline.reduce((best, day) => {
      if (!best || day.total > best.total) return day;
      return best;
    }, null);

    const topTransition = Object.entries(transitionCounts).reduce((best, [key, value]) => {
      if (!best || value > best.value) {
        return { key, value };
      }
      return best;
    }, null);

    return {
      timeline,
      transitionCounts,
      avgStageDurations,
      longestStage,
      busiestDay,
      topTransition
    };
  }

  renderTaskCalendar(container) {
    const calendarView = container.createDiv('para-task-calendar-view');
    const tasksWithDueDates = this.vaultData.tasks.all.filter(task => task.dueDate);
    const calendarData = this.buildTaskCalendarData(tasksWithDueDates);

    const summary = calendarView.createDiv('para-stats-panel');
    const busiestLabel = calendarData.busiestCell
      ? `${calendarData.busiestCell.dayLabel} ${calendarData.busiestCell.dateLabel} (${calendarData.busiestCell.tasks.length})`
      : '—';

    const summaryCards = [
      { label: 'Tasks w/ due dates', value: tasksWithDueDates.length.toString() },
      { label: 'Overdue tasks', value: calendarData.overdueTasks.length.toString() },
      { label: 'Due next 7 days', value: calendarData.upcomingWeekCount.toString() },
      { label: 'Busiest day', value: busiestLabel }
    ];

    summaryCards.forEach(cardData => {
      const card = summary.createDiv('para-stat-card');
      card.createDiv('para-stat-value').setText(cardData.value);
      card.createDiv('para-stat-label').setText(cardData.label);
    });

    const grid = calendarView.createDiv('para-task-calendar-grid');
    calendarData.cells.forEach(cell => {
      const cellEl = grid.createDiv('para-task-calendar-cell');
      if (cell.isToday) cellEl.addClass('today');
      if (cell.isPast && !cell.isToday) cellEl.addClass('past');

      const header = cellEl.createDiv('para-task-calendar-cell-header');
      header.createSpan({ text: cell.dayLabel, cls: 'para-task-calendar-day' });
      header.createSpan({ text: cell.dateLabel.toString(), cls: 'para-task-calendar-date' });

      const bar = cellEl.createDiv('para-task-calendar-bar');
      if (cell.tasks.length === 0) {
        bar.addClass('empty');
        bar.setText('No tasks');
      } else {
        const total = cell.tasks.length;
        Object.entries(cell.counts).forEach(([location, count]) => {
          if (count === 0) return;
          const segment = bar.createDiv('para-task-calendar-bar-segment');
          segment.style.backgroundColor = PARA_COLORS[location] || 'var(--interactive-accent)';
          segment.style.width = `${(count / total) * 100}%`;
          segment.setAttribute('title', `${count} ${location}`);
        });
      }

      if (cell.tasks.length > 0) {
        const list = cellEl.createEl('ul', { cls: 'para-task-calendar-list' });
        cell.tasks.slice(0, 3).forEach(task => {
          const item = list.createEl('li', { cls: 'para-task-calendar-item' });
          const taskDue = new Date(task.dueDate);
          taskDue.setHours(0, 0, 0, 0);
          const now = new Date();
          now.setHours(0, 0, 0, 0);
          if (!task.completed && taskDue < now) {
            item.addClass('overdue');
          }

          const paraKey = task.paraLocation || 'unknown';
          const paraLabel = task.paraLocation ? task.paraLocation.substring(0, 3).toUpperCase() : 'N/A';

          item.innerHTML = `
            <span class="para-task-calendar-status">${task.completed ? '✅' : taskDue < now ? '⚠️' : '•'}</span>
            ${task.text}
            <span class="para-task-calendar-para para-location-badge ${paraKey}">
              ${paraLabel}
            </span>
          `;

          item.addEventListener('click', () => {
            this.app.workspace.openLinkText(task.file, '', false);
          });
        });

        if (cell.tasks.length > 3) {
          cellEl.createEl('p', {
            text: `+${cell.tasks.length - 3} more`,
            cls: 'para-task-calendar-more'
          });
        }
      }
    });

    const totalsSection = calendarView.createDiv('para-task-calendar-stats');
    totalsSection.createEl('h3', { text: 'Load by PARA' });
    const totalsGrid = totalsSection.createDiv('para-task-calendar-totals');
    Object.entries(calendarData.windowCounts).forEach(([location, count]) => {
      const card = totalsGrid.createDiv('para-task-calendar-total');
      const badge = card.createSpan('para-location-badge');
      badge.addClass(location);
      badge.setText(location.toUpperCase());
      card.createDiv('para-task-calendar-total-value').setText(count.toString());
      card.createDiv('para-task-calendar-total-label').setText('Tasks in calendar window');
    });

    const overdueSection = calendarView.createDiv('para-task-calendar-overdue');
    overdueSection.createEl('h3', { text: 'Overdue Tasks' });
    if (calendarData.overdueTasks.length === 0) {
      overdueSection.createEl('p', { text: 'No overdue tasks. Nice work!' });
    } else {
      const list = overdueSection.createEl('ul');
      list.addClass('para-task-calendar-overdue-list');
      calendarData.overdueTasks.slice(0, 10).forEach(task => {
        const item = list.createEl('li');
        const paraLabel = task.paraLocation ? task.paraLocation.toUpperCase() : 'UNKNOWN';
        item.innerHTML = `
          <strong>${task.text}</strong>
          <span class="para-task-calendar-overdue-meta">
            ${task.dueDate} • ${task.fileName} • ${paraLabel}
          </span>
        `;
        item.addEventListener('click', () => {
          this.app.workspace.openLinkText(task.file, '', false);
        });
      });
      if (calendarData.overdueTasks.length > 10) {
        overdueSection.createEl('p', {
          text: `${calendarData.overdueTasks.length - 10} additional overdue tasks`,
          attr: { style: 'color: var(--text-muted); font-size: 0.9em;' }
        });
      }
    }
  }

  buildTaskCalendarData(tasks) {
    const dayMs = 24 * 60 * 60 * 1000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    const weekday = today.getDay();
    const mondayOffset = (weekday + 6) % 7;
    start.setDate(start.getDate() - mondayOffset);

    const totalDays = 28;
    const cells = [];
    const cellMap = new Map();

    for (let i = 0; i < totalDays; i++) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      date.setHours(0, 0, 0, 0);
      const dateStr = date.toISOString().split('T')[0];
      const cell = {
        date: dateStr,
        timestamp: date.getTime(),
        dayLabel: date.toLocaleDateString(undefined, { weekday: 'short' }),
        dateLabel: date.getDate(),
        tasks: [],
        counts: { inbox: 0, projects: 0, areas: 0, resources: 0, archive: 0 },
        isToday: date.getTime() === today.getTime(),
        isPast: date.getTime() < today.getTime()
      };
      cells.push(cell);
      cellMap.set(dateStr, cell);
    }

    const overdueTasks = [];
    const windowCounts = { inbox: 0, projects: 0, areas: 0, resources: 0, archive: 0 };

    tasks.forEach(task => {
      const due = new Date(task.dueDate);
      if (isNaN(due.getTime())) return;
      due.setHours(0, 0, 0, 0);
      const dateStr = due.toISOString().split('T')[0];
      if (!task.completed && due < today) {
        overdueTasks.push(task);
      }
      const cell = cellMap.get(dateStr);
      if (cell) {
        cell.tasks.push(task);
        if (cell.counts[task.paraLocation] !== undefined) {
          cell.counts[task.paraLocation]++;
          windowCounts[task.paraLocation]++;
        }
      }
    });

    cells.forEach(cell => {
      cell.tasks.sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        return a.text.localeCompare(b.text);
      });
    });

    const upcomingWeekEnd = today.getTime() + 7 * dayMs;
    const upcomingWeekCount = cells
      .filter(cell => cell.timestamp >= today.getTime() && cell.timestamp < upcomingWeekEnd)
      .reduce((sum, cell) => sum + cell.tasks.filter(t => !t.completed).length, 0);

    let busiestCell = cells.reduce((best, cell) => {
      if (!best || cell.tasks.length > best.tasks.length) return cell;
      return best;
    }, null);
    if (busiestCell && busiestCell.tasks.length === 0) {
      busiestCell = null;
    }

    return {
      cells,
      overdueTasks,
      upcomingWeekCount,
      busiestCell,
      windowCounts
    };
  }

  async updateCurrentNoteData() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      this.currentNoteData = null;
      return;
    }

    // Ensure vault data is loaded
    if (!this.vaultData) {
      console.warn('PARA Visualizer: Vault data not loaded yet, skipping note update');
      this.currentNoteData = null;
      return;
    }

    const cache = this.app.metadataCache.getFileCache(activeFile);
    if (!cache) {
      this.currentNoteData = null;
      return;
    }

    // Get note data from vault data
    let noteData = this.vaultData.notes.find(n => n.path === activeFile.path);
    if (!noteData) {
      console.warn(`PARA Visualizer: Note not found in vault data: ${activeFile.path}`);
      console.warn('This may happen after moving a file. Refreshing vault data...');
      // Refresh vault data and try again
      await this.collectVaultData();
      noteData = this.vaultData.notes.find(n => n.path === activeFile.path);
      if (!noteData) {
        console.error(`PARA Visualizer: Note still not found after refresh: ${activeFile.path}`);
        this.currentNoteData = null;
        return;
      }
      console.log('PARA Visualizer: Note found after vault refresh');
    }

    // Find incoming links (what notes link TO this one)
    const incomingLinks = this.vaultData.notes.filter(n =>
      n.links.some(link => {
        // Handle both full paths and basenames
        return link === activeFile.basename || link === activeFile.path;
      })
    );

    // Find outgoing links (what notes this one links TO)
    const outgoingLinks = noteData.links.map(link => {
      return this.vaultData.notes.find(n =>
        n.basename === link || n.path === link
      );
    }).filter(n => n); // Remove null entries

    // Find sibling notes (same PARA location + same subfolder)
    const siblings = this.vaultData.notes.filter(n => {
      if (n.path === activeFile.path) return false;
      if (n.paraLocation !== noteData.paraLocation) return false;

      // Check if in same subfolder
      const activeFolder = activeFile.parent?.path || '';
      const noteFolder = n.path.split('/').slice(0, -1).join('/');
      return activeFolder === noteFolder;
    });

    // Find notes with shared tags (exclude system tags)
    const systemTags = ['all', 'inbox', 'projects', 'areas', 'resources', 'archive'];
    const contentTags = noteData.tags.filter(tag => !systemTags.includes(tag.toLowerCase()));

    const relatedByTag = [];
    if (contentTags.length > 0) {
      this.vaultData.notes.forEach(n => {
        if (n.path === activeFile.path) return;
        const nContentTags = n.tags.filter(tag => !systemTags.includes(tag.toLowerCase()));
        const sharedTags = nContentTags.filter(tag => contentTags.includes(tag));
        if (sharedTags.length > 0) {
          relatedByTag.push({
            note: n,
            sharedTags: sharedTags,
            tagScore: sharedTags.length
          });
        }
      });
      relatedByTag.sort((a, b) => b.tagScore - a.tagScore);
    }

    // Parse tasks from current file
    const tasks = await this.parseTasksFromFile(activeFile, noteData.paraLocation);

    this.currentNoteData = {
      file: activeFile,
      note: noteData,
      incomingLinks: incomingLinks,
      outgoingLinks: outgoingLinks,
      siblings: siblings,
      relatedByTag: relatedByTag.slice(0, 10), // Top 10
      tasks: tasks
    };
  }

  renderNoteContext(container) {
    if (!this.currentNoteData) {
      const activeFile = this.app.workspace.getActiveFile();
      if (!activeFile) {
        container.createDiv('para-empty-state').innerHTML = `
          <div style="text-align: center; padding: 40px; color: var(--text-muted);">
            <p>📝 No note selected</p>
            <p style="font-size: 0.9em;">Open a note to see its context and connections</p>
          </div>
        `;
      } else {
        container.createDiv('para-empty-state').innerHTML = `
          <div style="text-align: center; padding: 40px; color: var(--text-muted);">
            <p>⏳ Loading note data...</p>
          </div>
        `;
        // Trigger update
        this.updateCurrentNoteData().then(() => this.render());
      }
      return;
    }

    const { note, incomingLinks, outgoingLinks, siblings, relatedByTag } = this.currentNoteData;

    // Header with note info
    const header = container.createDiv('para-note-header');
    header.createEl('h2', { text: note.basename });

    const metadata = header.createDiv('para-note-metadata');
    const paraColor = PARA_COLORS[note.paraLocation] || '#6b7280';
    metadata.innerHTML = `
      <span style="background: ${paraColor}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.85em;">
        ${note.paraLocation.toUpperCase()}
      </span>
      <span style="margin-left: 8px; color: var(--text-muted); font-size: 0.9em;">
        ${note.tags.map(t => '#' + t).join(' ')}
      </span>
    `;

    // Stats row
    const stats = container.createDiv('para-note-stats');
    stats.style.cssText = 'display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 20px 0;';

    const statBoxes = [
      { label: 'Incoming Links', value: incomingLinks.length, icon: '⬅️' },
      { label: 'Outgoing Links', value: outgoingLinks.length, icon: '➡️' },
      { label: 'Siblings', value: siblings.length, icon: '👥' },
      { label: 'Related Notes', value: relatedByTag.length, icon: '🔗' }
    ];

    statBoxes.forEach(stat => {
      const box = stats.createDiv('para-stat-box');
      box.style.cssText = 'background: var(--background-secondary); padding: 12px; border-radius: 8px; text-align: center;';
      box.innerHTML = `
        <div style="font-size: 1.5em; margin-bottom: 4px;">${stat.icon} ${stat.value}</div>
        <div style="font-size: 0.85em; color: var(--text-muted);">${stat.label}</div>
      `;
    });

    // Sections
    const sections = container.createDiv('para-note-sections');

    // Incoming links
    if (incomingLinks.length > 0) {
      const section = sections.createDiv('para-note-section');
      section.createEl('h3', { text: '⬅️ Incoming Links' });
      section.createEl('p', {
        text: `${incomingLinks.length} note${incomingLinks.length > 1 ? 's' : ''} link to this note`,
        attr: { style: 'color: var(--text-muted); font-size: 0.9em; margin-bottom: 8px;' }
      });

      const list = section.createEl('ul');
      incomingLinks.slice(0, 10).forEach(n => {
        const item = list.createEl('li');
        item.style.cssText = 'cursor: pointer; padding: 4px 0;';
        item.innerHTML = `
          <span style="background: ${PARA_COLORS[n.paraLocation]}; color: white; padding: 1px 6px; border-radius: 3px; font-size: 0.75em; margin-right: 6px;">
            ${n.paraLocation.substring(0, 3).toUpperCase()}
          </span>
          ${n.basename}
        `;
        item.addEventListener('click', () => {
          this.app.workspace.openLinkText(n.path, '', false);
        });
      });

      if (incomingLinks.length > 10) {
        section.createEl('p', {
          text: `...and ${incomingLinks.length - 10} more`,
          attr: { style: 'color: var(--text-muted); font-size: 0.85em; font-style: italic;' }
        });
      }
    }

    // Outgoing links
    if (outgoingLinks.length > 0) {
      const section = sections.createDiv('para-note-section');
      section.createEl('h3', { text: '➡️ Outgoing Links' });
      section.createEl('p', {
        text: `This note links to ${outgoingLinks.length} other note${outgoingLinks.length > 1 ? 's' : ''}`,
        attr: { style: 'color: var(--text-muted); font-size: 0.9em; margin-bottom: 8px;' }
      });

      const list = section.createEl('ul');
      outgoingLinks.slice(0, 10).forEach(n => {
        const item = list.createEl('li');
        item.style.cssText = 'cursor: pointer; padding: 4px 0;';
        item.innerHTML = `
          <span style="background: ${PARA_COLORS[n.paraLocation]}; color: white; padding: 1px 6px; border-radius: 3px; font-size: 0.75em; margin-right: 6px;">
            ${n.paraLocation.substring(0, 3).toUpperCase()}
          </span>
          ${n.basename}
        `;
        item.addEventListener('click', () => {
          this.app.workspace.openLinkText(n.path, '', false);
        });
      });

      if (outgoingLinks.length > 10) {
        section.createEl('p', {
          text: `...and ${outgoingLinks.length - 10} more`,
          attr: { style: 'color: var(--text-muted); font-size: 0.85em; font-style: italic;' }
        });
      }
    }

    // Siblings
    if (siblings.length > 0) {
      const section = sections.createDiv('para-note-section');
      section.createEl('h3', { text: '👥 Sibling Notes' });
      section.createEl('p', {
        text: `${siblings.length} other note${siblings.length > 1 ? 's' : ''} in the same folder`,
        attr: { style: 'color: var(--text-muted); font-size: 0.9em; margin-bottom: 8px;' }
      });

      const list = section.createEl('ul');
      siblings.slice(0, 10).forEach(n => {
        const item = list.createEl('li');
        item.style.cssText = 'cursor: pointer; padding: 4px 0;';
        item.textContent = n.basename;
        item.addEventListener('click', () => {
          this.app.workspace.openLinkText(n.path, '', false);
        });
      });

      if (siblings.length > 10) {
        section.createEl('p', {
          text: `...and ${siblings.length - 10} more`,
          attr: { style: 'color: var(--text-muted); font-size: 0.85em; font-style: italic;' }
        });
      }
    }

    // Related by tags
    if (relatedByTag.length > 0) {
      const section = sections.createDiv('para-note-section');
      section.createEl('h3', { text: '🔗 Related by Tags' });
      section.createEl('p', {
        text: `Notes sharing tags with this note`,
        attr: { style: 'color: var(--text-muted); font-size: 0.9em; margin-bottom: 8px;' }
      });

      const list = section.createEl('ul');
      relatedByTag.forEach(rel => {
        const item = list.createEl('li');
        item.style.cssText = 'cursor: pointer; padding: 4px 0;';
        item.innerHTML = `
          <span style="background: ${PARA_COLORS[rel.note.paraLocation]}; color: white; padding: 1px 6px; border-radius: 3px; font-size: 0.75em; margin-right: 6px;">
            ${rel.note.paraLocation.substring(0, 3).toUpperCase()}
          </span>
          ${rel.note.basename}
          <span style="color: var(--text-muted); font-size: 0.85em; margin-left: 6px;">
            (${rel.sharedTags.map(t => '#' + t).join(', ')})
          </span>
        `;
        item.addEventListener('click', () => {
          this.app.workspace.openLinkText(rel.note.path, '', false);
        });
      });
    }

    // Orphan status
    if (incomingLinks.length === 0 && outgoingLinks.length === 0) {
      const warning = container.createDiv('para-note-warning');
      warning.style.cssText = 'background: var(--background-modifier-error); padding: 12px; border-radius: 8px; margin-top: 16px;';
      warning.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 4px;">⚠️ Orphan Note</div>
        <div style="font-size: 0.9em;">This note has no connections to other notes. Consider linking it to related content.</div>
      `;
    }
  }

  renderNoteHistory(container) {
    // Check for Quick PARA dependency
    if (!this.plugin.hasQuickPARA()) {
      container.createDiv('para-dependency-warning').innerHTML = `
        <div style="background: var(--background-modifier-error); padding: 24px; border-radius: 8px; margin: 20px;">
          <h3 style="margin: 0 0 12px 0; color: var(--text-error);">⚠️ Quick PARA Plugin Required</h3>
          <p style="margin: 0 0 12px 0;">The PARA History feature requires the <strong>Quick PARA</strong> plugin to track note movements.</p>
          <p style="margin: 0 0 12px 0; font-size: 0.9em;">Quick PARA automatically records when you move notes between PARA folders (Inbox → Projects → Archive, etc.).</p>
          <p style="margin: 0; font-size: 0.9em;"><strong>To use this feature:</strong></p>
          <ol style="margin: 8px 0 0 20px; font-size: 0.9em;">
            <li>Install the Quick PARA plugin</li>
            <li>Enable it in Settings → Community Plugins</li>
            <li>Move notes between PARA folders to build history</li>
          </ol>
          <p style="margin: 12px 0 0 0; font-size: 0.85em; color: var(--text-muted);">
            Run "PARA Visualizer: Check Dependencies" command to verify installation.
          </p>
        </div>
      `;
      return;
    }

    if (!this.currentNoteData) {
      container.createDiv('para-empty-state').innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
          <p>📝 No note selected</p>
          <p style="font-size: 0.9em;">Open a note to see its PARA history</p>
        </div>
      `;
      return;
    }

    const { note } = this.currentNoteData;

    // Header
    const header = container.createDiv('para-note-header');
    header.createEl('h2', { text: `PARA Journey: ${note.basename}` });

    // Current location
    const currentSection = container.createDiv('para-note-section');
    currentSection.createEl('h3', { text: '📍 Current Location' });
    const paraColor = PARA_COLORS[note.paraLocation] || '#6b7280';
    currentSection.innerHTML += `
      <div style="padding: 16px; background: ${paraColor}; color: white; border-radius: 8px; text-align: center; font-size: 18px; font-weight: 600; margin-top: 8px;">
        ${note.paraLocation.toUpperCase()}
      </div>
    `;

    // Check if there's any history
    if (!note.paraHistory || note.paraHistory.length === 0) {
      const noHistorySection = container.createDiv('para-note-section');
      noHistorySection.innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
          <p>📋 No movement history recorded</p>
          <p style="font-size: 0.9em;">This note hasn't moved between PARA locations yet.</p>
          <p style="font-size: 0.9em; margin-top: 12px;">The Quick PARA plugin tracks movements automatically when you move files between PARA folders.</p>
        </div>
      `;
      return;
    }

    // History timeline
    const timelineSection = container.createDiv('para-note-section');
    timelineSection.createEl('h3', { text: '📜 Movement History' });
    timelineSection.createEl('p', {
      text: `This note has moved ${note.paraHistory.length} time${note.paraHistory.length > 1 ? 's' : ''}`,
      attr: { style: 'color: var(--text-muted); font-size: 0.9em; margin-bottom: 16px;' }
    });

    const timeline = timelineSection.createDiv('para-history-timeline');
    timeline.style.cssText = 'position: relative; padding-left: 32px;';

    // Add vertical line
    const line = timeline.createDiv('para-history-line');
    line.style.cssText = 'position: absolute; left: 11px; top: 0; bottom: 0; width: 2px; background: var(--background-modifier-border);';

    // Sort history by date (most recent first)
    const sortedHistory = [...note.paraHistory].sort((a, b) => {
      const dateA = new Date(a.timestamp || a.date);
      const dateB = new Date(b.timestamp || b.date);
      return dateB - dateA;
    });

    sortedHistory.forEach((move, index) => {
      const item = timeline.createDiv('para-history-item');
      item.style.cssText = 'position: relative; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--background-modifier-border);';

      // Dot
      const dot = item.createDiv('para-history-dot');
      dot.style.cssText = 'position: absolute; left: -26px; top: 4px; width: 12px; height: 12px; border-radius: 50%; background: var(--interactive-accent); border: 2px solid var(--background-primary);';

      // Date
      const date = item.createDiv('para-history-date');
      const moveDate = new Date(move.timestamp || move.date);
      const dateStr = moveDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      const timeStr = moveDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      date.style.cssText = 'font-size: 0.85em; color: var(--text-muted); margin-bottom: 4px;';
      date.textContent = `${dateStr} at ${timeStr}`;

      // Movement
      const movement = item.createDiv('para-history-movement');
      movement.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-top: 8px;';

      const fromColor = PARA_COLORS[move.from] || '#6b7280';
      const toColor = PARA_COLORS[move.to] || '#6b7280';

      movement.innerHTML = `
        <span style="background: ${fromColor}; color: white; padding: 4px 12px; border-radius: 6px; font-weight: 500; font-size: 0.9em;">
          ${move.from.toUpperCase()}
        </span>
        <span style="font-size: 1.2em;">→</span>
        <span style="background: ${toColor}; color: white; padding: 4px 12px; border-radius: 6px; font-weight: 500; font-size: 0.9em;">
          ${move.to.toUpperCase()}
        </span>
      `;

      // Add context if this was the most recent move
      if (index === 0) {
        const badge = item.createDiv('para-history-badge');
        badge.style.cssText = 'display: inline-block; background: var(--interactive-accent); color: var(--text-on-accent); padding: 2px 8px; border-radius: 4px; font-size: 0.75em; font-weight: 600; margin-top: 8px;';
        badge.textContent = 'MOST RECENT';
      }
    });

    // Flow visualization
    const flowSection = container.createDiv('para-note-section');
    flowSection.createEl('h3', { text: '🌊 PARA Flow Diagram' });

    // Get unique locations in order
    const locations = ['inbox', 'projects', 'areas', 'resources', 'archive'];
    const visitedLocations = new Set();

    // Add all locations from history
    sortedHistory.forEach(move => {
      visitedLocations.add(move.from);
      visitedLocations.add(move.to);
    });
    visitedLocations.add(note.paraLocation); // Current location

    const flowDiagram = flowSection.createDiv('para-flow-diagram');
    flowDiagram.style.cssText = 'display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 12px; padding: 24px; background: var(--background-secondary); border-radius: 8px;';

    locations.forEach(location => {
      if (visitedLocations.has(location)) {
        const box = flowDiagram.createDiv('para-flow-box');
        const color = PARA_COLORS[location] || '#6b7280';
        const isCurrent = location === note.paraLocation;

        box.style.cssText = `
          background: ${color};
          color: white;
          padding: 12px 20px;
          border-radius: 8px;
          font-weight: 600;
          text-align: center;
          ${isCurrent ? 'box-shadow: 0 0 0 3px var(--interactive-accent); transform: scale(1.1);' : ''}
        `;
        box.textContent = location.toUpperCase();

        if (isCurrent) {
          const currentBadge = box.createDiv();
          currentBadge.style.cssText = 'font-size: 0.7em; margin-top: 4px; opacity: 0.9;';
          currentBadge.textContent = '(Current)';
        }
      }
    });

    // Stats
    const statsSection = container.createDiv('para-note-section');
    statsSection.createEl('h3', { text: '📊 Movement Statistics' });

    const stats = statsSection.createDiv('para-note-stats');
    stats.style.cssText = 'display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 12px;';

    const firstMove = sortedHistory[sortedHistory.length - 1];
    const lastMove = sortedHistory[0];
    const firstDate = firstMove ? new Date(firstMove.timestamp || firstMove.date) : null;
    const lastDate = lastMove ? new Date(lastMove.timestamp || lastMove.date) : null;

    const statBoxes = [
      { label: 'Total Moves', value: note.paraHistory.length, icon: '🔄' },
      { label: 'Locations Visited', value: visitedLocations.size, icon: '📍' },
      {
        label: 'First Move',
        value: firstDate ? firstDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A',
        icon: '🕐'
      },
      {
        label: 'Last Move',
        value: lastDate ? lastDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A',
        icon: '🕑'
      }
    ];

    statBoxes.forEach(stat => {
      const box = stats.createDiv('para-stat-box');
      box.style.cssText = 'background: var(--background-secondary); padding: 12px; border-radius: 8px; text-align: center;';
      box.innerHTML = `
        <div style="font-size: 1.2em; margin-bottom: 4px;">${stat.icon} ${stat.value}</div>
        <div style="font-size: 0.85em; color: var(--text-muted);">${stat.label}</div>
      `;
    });
  }

  renderNoteTasks(container) {
    if (!this.currentNoteData) {
      container.createDiv('para-empty-state').innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
          <p>📝 No note selected</p>
          <p style="font-size: 0.9em;">Open a note to see its tasks</p>
        </div>
      `;
      return;
    }

    const { note, tasks } = this.currentNoteData;

    // Header
    const header = container.createDiv('para-note-header');
    header.createEl('h2', { text: `Tasks in ${note.basename}` });

    if (tasks.length === 0) {
      container.createDiv('para-empty-state').innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
          <p>✅ No tasks found</p>
          <p style="font-size: 0.9em;">This note doesn't contain any tasks</p>
        </div>
      `;
      return;
    }

    // Task stats
    const completed = tasks.filter(t => t.completed).length;
    const open = tasks.length - completed;
    const completionRate = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0;

    const stats = container.createDiv('para-note-stats');
    stats.style.cssText = 'display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 20px 0;';

    const statBoxes = [
      { label: 'Total Tasks', value: tasks.length, icon: '📋' },
      { label: 'Completed', value: completed, icon: '✅' },
      { label: 'Open', value: open, icon: '⬜' }
    ];

    statBoxes.forEach(stat => {
      const box = stats.createDiv('para-stat-box');
      box.style.cssText = 'background: var(--background-secondary); padding: 12px; border-radius: 8px; text-align: center;';
      box.innerHTML = `
        <div style="font-size: 1.5em; margin-bottom: 4px;">${stat.icon} ${stat.value}</div>
        <div style="font-size: 0.85em; color: var(--text-muted);">${stat.label}</div>
      `;
    });

    // Completion bar
    const progressSection = container.createDiv('para-note-section');
    progressSection.createEl('h3', { text: 'Completion Progress' });
    const progressBar = progressSection.createDiv('para-progress-bar');
    progressBar.style.cssText = 'background: var(--background-secondary); height: 30px; border-radius: 8px; overflow: hidden; position: relative;';

    const progressFill = progressBar.createDiv('para-progress-fill');
    progressFill.style.cssText = `background: linear-gradient(90deg, #10b981, #059669); width: ${completionRate}%; height: 100%; transition: width 0.3s ease;`;

    const progressText = progressBar.createDiv('para-progress-text');
    progressText.style.cssText = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-weight: 600; color: var(--text-normal);';
    progressText.textContent = `${completionRate}%`;

    // Open tasks
    const openTasks = tasks.filter(t => !t.completed);
    if (openTasks.length > 0) {
      const section = container.createDiv('para-note-section');
      section.createEl('h3', { text: `⬜ Open Tasks (${openTasks.length})` });

      const list = section.createEl('ul');
      list.style.cssText = 'list-style: none; padding-left: 0;';

      openTasks.forEach(task => {
        const item = list.createEl('li');
        item.style.cssText = 'padding: 8px; background: var(--background-secondary); margin-bottom: 6px; border-radius: 6px;';

        let taskHTML = `<input type="checkbox" disabled style="margin-right: 8px;"> ${task.text}`;

        if (task.dueDate) {
          const dueDate = new Date(task.dueDate);
          const now = new Date();
          const isOverdue = dueDate < now;
          const dueDateStr = task.dueDate;

          taskHTML += ` <span style="color: ${isOverdue ? '#ef4444' : 'var(--text-muted)'}; font-size: 0.85em; margin-left: 8px;">📅 ${dueDateStr}</span>`;
        }

        item.innerHTML = taskHTML;
      });
    }

    // Completed tasks
    const completedTasks = tasks.filter(t => t.completed);
    if (completedTasks.length > 0) {
      const section = container.createDiv('para-note-section');
      section.createEl('h3', { text: `✅ Completed Tasks (${completedTasks.length})` });

      const list = section.createEl('ul');
      list.style.cssText = 'list-style: none; padding-left: 0;';

      completedTasks.slice(0, 10).forEach(task => {
        const item = list.createEl('li');
        item.style.cssText = 'padding: 8px; background: var(--background-secondary); margin-bottom: 6px; border-radius: 6px; opacity: 0.7;';

        let taskHTML = `<input type="checkbox" checked disabled style="margin-right: 8px;"> <s>${task.text}</s>`;

        if (task.completionDate) {
          taskHTML += ` <span style="color: var(--text-muted); font-size: 0.85em; margin-left: 8px;">✅ ${task.completionDate}</span>`;
        }

        item.innerHTML = taskHTML;
      });

      if (completedTasks.length > 10) {
        section.createEl('p', {
          text: `...and ${completedTasks.length - 10} more completed`,
          attr: { style: 'color: var(--text-muted); font-size: 0.85em; font-style: italic;' }
        });
      }
    }
  }

  async onClose() {
    // Cleanup
  }
}

class PARAVisualizerPlugin extends Plugin {
  async onload() {
    console.log('Loading PARA Visualizer plugin');

    // Check for Quick PARA plugin
    this.checkDependencies();

    // Register view
    this.registerView(
      VIEW_TYPE_PARA_VISUALIZER,
      (leaf) => new PARAVisualizerView(leaf, this)
    );

    // Add ribbon icon
    this.addRibbonIcon('bar-chart-2', 'PARA Visualizer', () => {
      this.activateView();
    });

    // Add command
    this.addCommand({
      id: 'open-para-visualizer',
      name: 'Open PARA Visualizer',
      callback: () => {
        this.activateView();
      }
    });

    // Add dependency check command
    this.addCommand({
      id: 'check-para-dependencies',
      name: 'Check Dependencies',
      callback: () => {
        this.checkDependencies(true);
      }
    });
  }

  checkDependencies(showSuccess = false) {
    const quickParaPlugin = this.app.plugins.plugins['quick-para'];

    if (!quickParaPlugin) {
      new Notice('⚠️ PARA Visualizer: Quick PARA plugin not found', 8000);
      new Notice('Some features require Quick PARA plugin. Install it from Community Plugins.', 10000);
      console.warn('PARA Visualizer: Quick PARA plugin is not installed. Some features may not work correctly.');
      return false;
    }

    if (!this.app.plugins.enabledPlugins.has('quick-para')) {
      new Notice('⚠️ PARA Visualizer: Quick PARA plugin is disabled', 8000);
      new Notice('Enable Quick PARA plugin in Settings → Community Plugins for full functionality.', 10000);
      console.warn('PARA Visualizer: Quick PARA plugin is installed but disabled.');
      return false;
    }

    if (showSuccess) {
      new Notice('✅ All dependencies are installed and enabled!', 5000);
    }

    return true;
  }

  hasQuickPARA() {
    return this.app.plugins.enabledPlugins.has('quick-para');
  }

  async activateView() {
    const { workspace } = this.app;

    let leaf = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_PARA_VISUALIZER);

    if (leaves.length > 0) {
      // View already exists, reveal it
      leaf = leaves[0];
    } else {
      // Create new leaf in right sidebar
      const rightLeaf = workspace.getRightLeaf(false);
      await rightLeaf.setViewState({
        type: VIEW_TYPE_PARA_VISUALIZER,
        active: true
      });
      leaf = rightLeaf;
    }

    workspace.revealLeaf(leaf);
  }

  onunload() {
    console.log('Unloading PARA Visualizer plugin');
  }
}

module.exports = PARAVisualizerPlugin;
