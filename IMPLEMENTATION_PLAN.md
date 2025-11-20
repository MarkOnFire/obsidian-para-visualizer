# Implementation Plan - Testing Feedback Response

Based on testing feedback from 11/18/2025

## 🐛 Critical Bugs

### 1. Crash when creating new notes with visualizer open
**Status**: 🔴 Critical
**Priority**: P0 - Fix immediately

**Root Cause**: Similar to the move/rename bug - `create` event not handled
- New note appears in vault but not in `vaultData`
- Clicking it causes null reference crash

**Fix**:
```javascript
this.registerEvent(
  this.app.vault.on('create', async (file) => {
    await this.collectVaultData();
    if (this.scope === 'note' && this.app.workspace.getActiveFile() === file) {
      await this.updateCurrentNoteData();
      this.render();
    }
  })
);
```

**Testing**:
- Open visualizer in note view
- Create new note via any method (hotkey, right-click, etc.)
- Click the new note
- Should not crash ✅

---

### 2. PARA History not showing (para_history metadata issue)
**Status**: 🟡 High
**Priority**: P1 - Investigate and fix

**Possible Causes**:
1. Quick PARA plugin not tracking movements properly
2. `para_history` property format mismatch
3. Notes haven't actually been moved yet (user expectation issue)

**Investigation Steps**:
1. Check if Quick PARA is actually writing `para_history`
   - Open a note that's been moved
   - Check frontmatter for `para_history` array
2. Verify Quick PARA's tagging.js movement tracking code
3. Test by manually moving a note and checking frontmatter
4. Add debug logging to see what `note.paraHistory` contains

**Expected Format** (from code):
```yaml
para_history:
  - from: inbox
    to: projects
    date: 2025-11-15
    timestamp: 1700000000000
```

**Fix Options**:
- If Quick PARA isn't tracking: Fix Quick PARA plugin
- If format mismatch: Update visualizer to handle Quick PARA's format
- If notes not moved: Add empty state guidance + example

---

## ✨ Feature Requests

### 3. Project Comparison Visualizations
**Status**: 🟢 New Feature
**Priority**: P2 - Nice to have

**Requirements**:
- Compare projects by task completion (pie chart or bar chart)
- Surface "forgotten" projects/tasks (no activity in X days)

**Design**:

#### 3a. Project Task Completion Pie Chart
- New vault-level tab: "📊 Project Metrics"
- Pie chart showing task completion by project
- Shows: Project name, completed tasks, open tasks, completion %
- Click slice to see project details

#### 3b. Forgotten/Stale Projects Detection
- Same tab as 3a
- List of projects with:
  - No task activity in 30+ days
  - No file modifications in 30+ days
  - Tasks created but never touched
- Sortable by staleness
- Click to open project note
- "Assess Importance" action button

**Implementation**:
```javascript
// Add to vault-level tabs
{ id: 'project-metrics', label: 'Project Metrics', icon: '📊' }

renderProjectMetrics(container) {
  // 1. Task completion pie chart by project
  // 2. Stale/forgotten projects list
  // 3. Task age distribution
}
```

---

### 4. Settings/Config Screen
**Status**: 🟢 New Feature
**Priority**: P2 - Quality of life

**Requirements**:
- Dependency checking (Quick PARA)
- Visualization descriptions
- Toggle visualizations on/off
- Reorder visualization tabs
- Configure default view (vault vs note)
- Configure date ranges
- PARA folder path mappings (sync with Quick PARA)

**Design**:

#### Settings Tabs:
1. **General**
   - Default view mode (Vault / Note)
   - Default vault tab
   - Default note tab
   - Time range default

2. **Visualizations**
   - Checkbox list of all viz types
   - Drag handles to reorder
   - Brief description for each
   - "Show in menu" toggle

3. **Dependencies**
   - Quick PARA status indicator
   - "Check Now" button
   - Link to Quick PARA in Community Plugins
   - Version compatibility warnings

4. **Advanced**
   - Performance settings (max notes for graph, etc.)
   - Debug logging toggle
   - Cache settings

**Implementation**:
- Extend `Plugin` settings pattern
- Use Obsidian `PluginSettingTab`
- Save to `.obsidian/plugins/para-visualizer/data.json`
- Load settings on plugin init
- Apply settings to tab visibility and order

---

## 📋 Implementation Order

### Phase 1: Critical Fixes (This Week)
1. ✅ Fix create event crash (P0)
2. ✅ Investigate PARA history issue (P1)

### Phase 2: Enhanced Visualizations (Next Week)
3. Add Project Metrics tab (P2)
   - Task completion comparison
   - Forgotten projects detection
4. Add Settings screen (P2)
   - Basic settings first
   - Dependency checking
   - Viz toggles

### Phase 3: Polish (Following Week)
5. Visualization reordering in settings
6. Performance optimization
7. Additional project insights

---

## 🧪 Testing Strategy

See `TESTING_CHECKLIST.md` for comprehensive stress testing scenarios.

**Key Test Cases**:
- [ ] Create note with visualizer open (P0)
- [ ] Move note between PARA folders and verify history tracking
- [ ] Test with 1000+ notes (performance)
- [ ] Test with 0 notes (empty vault)
- [ ] Test without Quick PARA installed
- [ ] Test with Quick PARA disabled
- [ ] Rapid file operations (create/move/delete in quick succession)
