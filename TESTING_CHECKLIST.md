# Comprehensive Stress Testing Checklist

## <¯ Test Environment Setup

- [ ] Fresh Obsidian install (no other plugins)
- [ ] Test vault with known structure
- [ ] Enable developer console (Cmd+Option+I)
- [ ] Document Obsidian version
- [ ] Document plugin version

---

## 1. File Operation Stress Tests

### Create Operations
- [ ] Create note with visualizer closed
- [ ] Create note with visualizer open (vault view)
- [ ] **Create note with visualizer open (note view)**   Known crash
- [ ] Create 10 notes rapidly in succession
- [ ] Create note while another note is selected
- [ ] Create note in each PARA folder
- [ ] Create note with special characters in name
- [ ] Create note with very long name (200+ chars)

### Move/Rename Operations
- [ ] Move note with visualizer closed
- [ ] **Move note with visualizer open (note view)**  Fixed
- [ ] Move note with visualizer open (vault view)
- [ ] Move note between PARA folders (inbox ’ projects)
- [ ] Move multiple notes rapidly
- [ ] Rename note while viewing it
- [ ] Move note to subfolder within same PARA location
- [ ] Move note out of PARA structure entirely

### Delete Operations
- [ ] Delete note with visualizer closed
- [ ] Delete note with visualizer open (note view)
- [ ] Delete currently selected note
- [ ] Delete multiple notes rapidly
- [ ] Delete PARA folder (should handle gracefully)

### Batch Operations
- [ ] Create, move, and delete 50+ notes in 30 seconds
- [ ] Rapid folder restructuring
- [ ] Undo/redo operations
- [ ] Cut/paste notes between folders

---

## 2. PARA History Tracking

### Movement Tracking
- [ ] Move note inbox ’ projects, verify history updated
- [ ] Move note projects ’ archive, verify second movement tracked
- [ ] Move note back to previous location (roundtrip)
- [ ] Move note through all PARA locations in order
- [ ] Move note outside PARA, then back in
- [ ] Verify timestamps are correct
- [ ] Verify `para_history` array format

### History Display
- [ ] Open note with no history (empty state)
- [ ] Open note with 1 movement
- [ ] Open note with 10+ movements
- [ ] Verify timeline shows correct dates
- [ ] Verify flow diagram highlights visited locations
- [ ] Click items in history timeline

### Edge Cases
- [ ] Note created outside PARA (no initial location)
- [ ] Manually edited `para_history` (malformed data)
- [ ] Missing `timestamp` field (only `date`)
- [ ] Future-dated movements (clock drift)
- [ ] Duplicate movements (same from/to/date)

---

## 3. Vault Size Stress Tests

### Small Vaults (0-50 notes)
- [ ] Empty vault (0 notes)
- [ ] Single note
- [ ] 10 notes evenly distributed across PARA
- [ ] 50 notes all in one location

### Medium Vaults (50-500 notes)
- [ ] 100 notes
- [ ] 250 notes
- [ ] 500 notes with complex link structure
- [ ] Measure initial load time
- [ ] Measure refresh time

### Large Vaults (500-5000 notes)
- [ ] 1000 notes
- [ ] 2500 notes
- [ ] 5000 notes
- [ ] Monitor memory usage
- [ ] Monitor CPU usage
- [ ] Test knowledge graph rendering performance
- [ ] Test tag cloud with 500+ unique tags

### Extreme Cases
- [ ] 10,000+ notes (if feasible)
- [ ] Single note with 1000+ links
- [ ] Note with 100+ tags
- [ ] 1000+ tasks in single note

---

## 4. Link Structure Tests

### Simple Links
- [ ] Note with no links (orphan)
- [ ] Note with 1 incoming link
- [ ] Note with 1 outgoing link
- [ ] Note with bidirectional links (A ” B)

### Complex Networks
- [ ] Hub note (100+ incoming links)
- [ ] Chain of notes (A ’ B ’ C ’ ... ’ Z)
- [ ] Circular reference (A ’ B ’ C ’ A)
- [ ] Dense cluster (all notes link to each other)
- [ ] Multiple disconnected clusters

### Link Types
- [ ] Wikilinks `[[Note]]`
- [ ] Wikilinks with aliases `[[Note|Alias]]`
- [ ] Broken links (target doesn't exist)
- [ ] Links to notes outside PARA folders
- [ ] Embedded files `![[Note]]`
- [ ] Links in frontmatter vs content

---

## 5. Tag and Metadata Tests

### Tag Variations
- [ ] Note with no tags
- [ ] Note with 1 tag
- [ ] Note with 50+ tags
- [ ] Frontmatter tags (YAML array)
- [ ] Inline tags (#tag)
- [ ] Mixed frontmatter + inline tags
- [ ] Nested tags (#parent/child)
- [ ] Tags with special characters (#tag-name_123)
- [ ] System tags (all, inbox, projects, etc.)

### PARA Property
- [ ] Missing `para` property (unknown location)
- [ ] Invalid `para` value (typo: "projet" instead of "projects")
- [ ] Lowercase vs uppercase values
- [ ] Multiple `para` properties (malformed YAML)
- [ ] `para` as array instead of string

### Review Intervals
- [ ] Missing review interval (use defaults)
- [ ] Numeric interval (`review_interval: 7`)
- [ ] String interval (`review_every: "2 weeks"`)
- [ ] Invalid formats (`review: "ASAP"`)
- [ ] Extremely long intervals (365+ days)
- [ ] Zero or negative intervals

---

## 6. Task Tests

### Task Formats
- [ ] No tasks in note
- [ ] Single task `- [ ] Task`
- [ ] Completed task `- [x] Task`
- [ ] 100+ tasks in note
- [ ] Tasks with due dates `=Å 2025-11-20`
- [ ] Tasks with completion dates ` 2025-11-18`
- [ ] Overdue tasks
- [ ] Recurring tasks `= every week`
- [ ] Malformed task checkboxes

### Task Calendar
- [ ] Tasks spanning 4 weeks
- [ ] Multiple tasks on same day
- [ ] Tasks in all PARA locations
- [ ] Tasks without due dates (shouldn't appear)
- [ ] Past tasks (show in overdue)
- [ ] Future tasks (30+ days out)

---

## 7. View Switching Tests

### Scope Toggle
- [ ] Switch vault ’ note while viewing a note
- [ ] Switch note ’ vault
- [ ] Rapid toggling (10x in 5 seconds)
- [ ] Toggle while data is loading
- [ ] Toggle with no active file

### Tab Navigation
- [ ] Click through all vault tabs
- [ ] Click through all note tabs
- [ ] Rapid tab switching
- [ ] Switch tabs while visualization is rendering
- [ ] Switch tabs during data refresh

### Multi-Window
- [ ] Open visualizer in sidebar
- [ ] Open visualizer in new pane
- [ ] Multiple visualizer instances
- [ ] Split view (note + visualizer)

---

## 8. Dependency Tests

### Without Quick PARA
- [ ] Visualizer loads without Quick PARA
- [ ] Warning shown on PARA History tab
- [ ] Vault views still work
- [ ] Note context view still works
- [ ] No crashes when Quick PARA missing

### Quick PARA Disabled
- [ ] Disable Quick PARA mid-session
- [ ] Re-enable Quick PARA mid-session
- [ ] Verify dependency warnings appear/disappear
- [ ] Run "Check Dependencies" command

### Quick PARA Incompatibility
- [ ] Older version of Quick PARA
- [ ] Different `para` property format
- [ ] Conflicting settings

---

## 9. Edge Cases and Error Conditions

### File System Edge Cases
- [ ] Note in root directory (not in PARA folders)
- [ ] Symbolic links
- [ ] Hidden files (start with .)
- [ ] Files without `.md` extension
- [ ] Extremely deep folder nesting (10+ levels)
- [ ] Folder names with special chars

### Metadata Edge Cases
- [ ] Empty frontmatter
- [ ] Malformed YAML
- [ ] Frontmatter without closing `---`
- [ ] Non-standard frontmatter delimiters
- [ ] Extremely large frontmatter (1000+ lines)

### Rendering Edge Cases
- [ ] Very long note names (200+ chars)
- [ ] Unicode characters in names (emoji, CJK, etc.)
- [ ] Notes with no content (only frontmatter)
- [ ] Binary files accidentally in vault

---

## 10. Performance Benchmarks

### Load Times
- [ ] Time to initial render (<2s for 1000 notes)
- [ ] Time to refresh vault data (<1s for 1000 notes)
- [ ] Time to switch visualizations (<500ms)
- [ ] Time to update current note (<200ms)

### Memory Usage
- [ ] Initial memory footprint
- [ ] Memory after 10 minutes idle
- [ ] Memory after 100 file operations
- [ ] Memory leak detection (long session test)

### Responsiveness
- [ ] UI remains responsive during data collection
- [ ] No freezing during graph rendering
- [ ] Smooth scrolling in note lists
- [ ] Quick search/filter operations

---

## 11. User Workflow Scenarios

### Daily Review Workflow
1. [ ] Open visualizer
2. [ ] Check Review Radar for overdue notes
3. [ ] Click overdue note
4. [ ] Review and update note
5. [ ] Move note to different PARA location
6. [ ] Verify history updated
7. [ ] Check updated in radar

### Project Completion Workflow
1. [ ] View project in visualizer
2. [ ] Check task completion stats
3. [ ] Complete remaining tasks
4. [ ] Move project to archive
5. [ ] Verify appears in Pipeline Timeline
6. [ ] Check PARA Flow visualization

### Link Building Workflow
1. [ ] Select note with few links (orphan)
2. [ ] View "Related by Tags" suggestions
3. [ ] Add wikilinks to related notes
4. [ ] Refresh visualizer
5. [ ] Verify incoming/outgoing links updated
6. [ ] Check knowledge graph updated

---

## 12. Browser/Platform Tests

### Operating Systems
- [ ] macOS (primary)
- [ ] Windows
- [ ] Linux

### Browsers (if applicable)
- [ ] Chrome/Chromium
- [ ] Safari
- [ ] Firefox

### Screen Sizes
- [ ] Large display (27"+)
- [ ] Laptop display (13-15")
- [ ] Small display (<13")
- [ ] Ultra-wide display
- [ ] Portrait orientation

---

## 13. Accessibility Tests

### Keyboard Navigation
- [ ] Tab through all controls
- [ ] Arrow keys in lists
- [ ] Enter to activate buttons
- [ ] Escape to close modals

### Screen Reader
- [ ] VoiceOver (macOS)
- [ ] NVDA (Windows)
- [ ] Announce visualizations properly
- [ ] Read stats/metrics clearly

### Visual
- [ ] High contrast mode
- [ ] Dark theme
- [ ] Light theme
- [ ] Color blind friendly (check PARA colors)
- [ ] Font size scaling

---

## 14. Error Recovery Tests

### Graceful Failures
- [ ] Corrupted data.json (settings)
- [ ] Obsidian API unavailable
- [ ] Workspace not ready
- [ ] File read errors
- [ ] JSON parse errors

### Recovery Actions
- [ ] Clear cached data
- [ ] Reset to defaults
- [ ] Reload plugin
- [ ] Restart Obsidian
- [ ] Verify error messages are helpful

---

## 15. Regression Tests

After each fix, re-run:
- [ ] All critical bugs from TESTING_NOTES
- [ ] File move crash scenario (original bug)
- [ ] Create note crash scenario
- [ ] PARA history display
- [ ] All P0 and P1 test cases

---

## =Ê Test Results Template

For each test session:

```
Date: YYYY-MM-DD
Tester: [Name]
Plugin Version: [Version]
Obsidian Version: [Version]
OS: [OS + Version]
Vault Size: [X notes]

Tests Passed: X / Y
Critical Failures: [List]
Non-Critical Issues: [List]
Performance Notes: [Observations]

Console Errors: [Paste if any]
```

---

## =¨ Known Issues to Watch For

1. **Create note crash** - Test with every Obsidian update
2. **PARA history not showing** - Verify Quick PARA integration
3. **Memory leaks** - Watch for increasing memory over time
4. **Stale data after moves** - Ensure vault refresh triggers
5. **Race conditions** - Rapid operations may overlap

---

##  Sign-Off Criteria

Before marking plugin as stable:
- [ ] Zero critical (P0) bugs
- [ ] All P1 bugs resolved or documented
- [ ] 90%+ test pass rate
- [ ] Performance acceptable (<5s load for 5000 notes)
- [ ] No memory leaks in 8-hour session
- [ ] Works without Quick PARA (degraded mode)
- [ ] Clear documentation for all edge cases
