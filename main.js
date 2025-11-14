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

class PARAVisualizerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentView = 'heatmap'; // Default view
    this.dateRange = 90; // days
    this.vaultData = null;
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
        links: []
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
    }
  }

  renderTabs(container) {
    const tabsContainer = container.createDiv('para-visualizer-tabs');

    const tabs = [
      { id: 'heatmap', label: 'Activity Heatmap', icon: '📅' },
      { id: 'graph', label: 'Knowledge Graph', icon: '🕸️' },
      { id: 'sankey', label: 'PARA Flow', icon: '🌊' },
      { id: 'tasks', label: 'Task Analytics', icon: '✅' },
      { id: 'tags', label: 'Tag Cloud', icon: '🏷️' },
      { id: 'stats', label: 'Statistics', icon: '📊' }
    ];

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

  async onClose() {
    // Cleanup
  }
}

class PARAVisualizerPlugin extends Plugin {
  async onload() {
    console.log('Loading PARA Visualizer plugin');

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
