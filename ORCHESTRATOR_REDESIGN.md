# Claude Code Orchestrator - Redesign Proposal

## Executive Summary

After three failed attempts to achieve true parallelization, we need a fundamental redesign. The core issue: **Claude Code ignores prompts about what NOT to create**, leading to merge conflicts and "No unique commits" errors.

**The Solution:** Use GitHub's issue hierarchy as the orchestrator's state machine, treating each issue as a work unit with clear boundaries.

---

## Problem Analysis

### Current Architecture Failures

**Attempt #1:** Setup worker created `src/db/schema.ts`, `src/app/page.tsx`, etc.
- Result: All subsequent workers failed with "No unique commits"

**Attempt #2:** Setup worker created `src/lib/db/schema.ts`, `src/app/globals.css`, `src/lib/types.ts`
- Result: All subsequent workers failed with "No unique commits"

**Attempt #3:** Setup worker created `app/`, `components/`, `lib/`, `hooks/` directories (different structure but same problem)
- Result: All subsequent workers failed with "No unique commits"

### Root Cause

**Claude Code is an autonomous agent that optimizes for completing the task.** When told to "initialize a project", it creates a complete working application because that's what accomplishes the goal. Negative constraints ("don't create X") are weak signals compared to the positive goal ("create a working app").

### Why Prompts Don't Work

1. **Ambiguity**: "Don't create implementation code" is subjective - config files vs implementation is a gray area
2. **Goal-driven behavior**: Claude optimizes for task completion, not constraint satisfaction
3. **File ownership confusion**: Setup worker creates files that "belong" to multiple EMs

---

## Proposed Architecture: Issue-Driven Orchestration

### Core Insight

**GitHub Issues are already designed for hierarchical task tracking.** Instead of fighting Claude's autonomy, embrace it by:
1. Each EM gets its **own GitHub issue** (not just a branch)
2. Workers work on **sub-issues** of their EM's issue
3. File ownership is **explicit per issue**
4. State is **maintained in issue metadata**, not internal state file

### Architecture Overview

```
Main Issue (#475: Build SplitSync)
├── Sub-issue #476: EM-0 Project Setup (CLOSED)
│   └── Worker PRs merged directly to this issue
├── Sub-issue #477: EM-1 Data Layer
│   ├── Worker PR #478: Database schema
│   ├── Worker PR #479: Repository pattern
│   └── Worker PR #480: Zod schemas
│   └── When all workers done: Create summary PR → merge → close issue
├── Sub-issue #478: EM-2 Authentication
├── Sub-issue #479: EM-3 API Routes
├── ... etc
└── Final PR to main issue
```

### Key Design Principles

#### 1. Issue as Work Unit

Each EM is **a GitHub issue**, not just a branch:
- Issue title: `[EM-1] Data Layer - Database schema, repositories, validation`
- Issue body: Detailed task breakdown
- Issue labels: `em`, `em-id:1`, `status:in-progress`
- Comments: Worker PRs linked as comments

#### 2. Explicit File Ownership Per Issue

Each issue declares **exclusive file ownership** in its body:

```markdown
## File Ownership

**This issue OWNS these files/directories:**
- `lib/db/schema.ts` (only EM-1 can modify)
- `lib/db/*.ts` (only EM-1 can modify)
- `lib/repositories/*.ts` (only EM-1 can modify)
- `lib/validation/*.ts` (only EM-1 can modify)

**Other EMs MUST NOT touch these files.**
```

Workers check file ownership before creating PRs.

#### 3. Worker Sub-Issues (Optional Advanced Mode)

For even finer granularity, workers can be sub-issues:
```markdown
## EM-1: Data Layer

### Sub-issues:
- #479: Create database schema (Worker 1)
- #480: Implement repository pattern (Worker 2)
- #481: Add Zod validation schemas (Worker 3)

Each sub-issue has:
- Explicit file list it will modify
- Explicit file list it must NOT touch
- PRs link back to parent EM issue
```

#### 4. Director Creates Issues, Not Just Plans

The director's job changes from "creating a plan" to "creating issues":

```typescript
async function breakdownAndDispatch(): Promise<void> {
  // Analyze the main issue
  const analysis = await analyzeIssue(mainIssue);

  // Create sub-issues for each EM
  for (const em of analysis.ems) {
    const emIssue = await createEMIssue(mainIssue, em);

    // For each EM, create worker tasks (as issues or checklist items)
    for (const worker of em.workers) {
      await createWorkerTask(emIssue, worker);
    }
  }

  // Label main issue to signal EMs can start
  await addLabel(mainIssue, 'ems-created');
}
```

#### 5. State in GitHub, Not Internal Files

**No `.orchestrator/state.json` file in the repo!**

State is tracked through:
- Issue labels (`status:analyzing`, `status:em-assignment`, `status:worker-review`)
- Issue comments (progress updates)
- PR body templates (state snapshots)
- GitHub API queries for current state

This makes the orchestrator:
- **Stateless** (can resume from any point by reading issues)
- **Transparent** (progress visible in issues)
- **Resilient** (no state file corruption)

---

## Implementation Plan

### Phase 1: Simplified Setup (Immediate Fix)

**The Setup Problem:** Setup worker creates too much.

**Solution:** Don't use a setup worker at all. Have the director create minimal config files directly via file operations:

```typescript
async function createProjectConfig(issue: Issue): Promise<void> {
  const files = {
    '.gitignore': gitignoreTemplate,
    'package.json': packageJsonTemplate,
    'tsconfig.json': tsconfigTemplate,
    '.github/workflows/ci.yml': ciTemplate,
    'playwright.config.ts': playwrightTemplate,
    // ... other config files
  };

  // Create files directly in work branch
  for (const [path, content] of Object.entries(files)) {
    await createFileInBranch(path, content);
  }

  // Commit with standard message
  await commitAndPush('chore: initialize project configuration');
}
```

**Why this works:**
- No Claude Code involved in setup (no prompt interpretation issues)
- Config files are deterministic and well-understood
- Workers start with clean slate - no pre-existing files to conflict

### Phase 2: Issue-Based EM Tracking

#### 2.1 Director Creates EM Issues

```typescript
interface EMIssue {
  id: number;
  title: string;
  body: string;
  fileOwnership: string[];
  workerTasks: WorkerTask[];
  labels: string[];
}

async function createEMIssues(mainIssue: Issue, ems: EM[]): Promise<void> {
  for (const em of ems) {
    const issueBody = `
## ${em.focusArea}

### Task Description
${em.task}

### File Ownership
**This issue EXCLUSIVELY OWNS:**
${em.fileOwnership.map(f => `- \`${f}\``).join('\n')}

### Worker Tasks
${em.workers.map((w, i) => `
#### Worker ${i + 1}
- **Task**: ${w.task}
- **Files to create**: ${w.files.join(', ') || 'As needed'}
- **Status**: Pending
`).join('\n')}

---

*Worker PRs will be added as comments to this issue.*
*When all workers complete, a summary PR will be created.*
    `.trim();

    const emIssue = await github.createIssue({
      title: `[EM-${em.id}] ${em.focusArea}`,
      body: issueBody,
      labels: ['em', `em-id:${em.id}`, 'status:pending', `parent:${mainIssue.number}`]
    });

    em.issueNumber = emIssue.number;
  }
}
```

#### 2.2 Workers Work Against EM Issues

```typescript
async function executeWorker(emIssue: Issue, worker: Worker): Promise<void> {
  // Parse file ownership from EM issue
  const fileOwnership = parseFileOwnership(emIssue.body);

  // Execute Claude Code with context
  const prompt = `
You are working on: ${emIssue.title}

**Task**: ${worker.task}

**Files you own (exclusive access):**
${fileOwnership.map(f => `- \`${f}\``).join('\n')}

**Files you MUST NOT modify:**
${getAllOtherEMFileOwnership().map(f => `- \`${f}\``).join('\n')}

Implement your task completely. Only touch files you own.
  `.trim();

  const result = await claude.execute(prompt);

  // Create PR
  const pr = await createPR(result, {
    title: `[${emIssue.title}/W-${worker.id}] ${worker.task.substring(0, 50)}`,
    body: `
## Task
${worker.task}

## Files Modified
${result.files.map(f => `- \`${f}\``).join('\n')}

## Parent Issue
#${emIssue.number}
    `.trim()
  });

  // Add PR as comment to EM issue
  await github.addComment(emIssue.number, `
Worker ${worker.id} completed: PR #${pr.number}

${result.files.length} files modified.
    `.trim());

  // Update checklist in EM issue
  await updateWorkerChecklist(emIssue, worker.id, 'completed');
}
```

#### 2.3 EM Completion and Merging

```typescript
async function completeEM(emIssue: Issue): Promise<void> {
  // Wait for all workers to complete
  await waitForAllWorkers(emIssue);

  // Create summary PR for this EM
  const summaryPR = await createSummaryPR(emIssue);

  // Merge summary PR
  await github.mergePullRequest(summaryPR.number);

  // Close EM issue
  await github.closeIssue(emIssue.number, 'All workers completed successfully');

  // Notify parent issue
  await notifyParentIssue(emIssue);
}
```

### Phase 3: Eliminate Merge Conflicts

#### 3.1 Explicit File Partitioning

The director assigns **non-overlapping file sets** to each EM:

```
EM-0: Project Setup
  - Owns: .gitignore, package.json, tsconfig.json, .github/workflows/ci.yml
  - Creates: Root-level config files only

EM-1: Data Layer
  - Owns: lib/db/schema.ts, lib/repositories/*.ts
  - Creates: Database layer
  - Must NOT touch: lib/api/*, components/*, app/*

EM-2: Authentication
  - Owns: lib/auth/*.ts, lib/middleware/auth.ts
  - Creates: Auth configuration and middleware
  - Must NOT touch: lib/db/*, lib/api/* (except auth endpoints)

EM-3: API Routes
  - Owns: app/api/groups/*.ts, app/api/expenses/*.ts, app/api/settlements/*.ts
  - Creates: API route handlers
  - Must NOT touch: lib/*, components/*

EM-4: UI Components
  - Owns: components/ui/*.ts, components/forms/*.ts
  - Creates: Reusable components
  - Must NOT touch: app/api/*, lib/*, hooks/*

... and so on
```

#### 3.2 Conflict Detection Before PR Creation

Before creating a PR, workers check:

```typescript
async function validateFileOwnership(files: string[]): Promise<boolean> {
  // Get all EM issues
  const allEMIssues = await getOpenEMIssues();

  // Parse file ownership from each
  const ownership = new Map<string, number>(); // file -> EM id
  for (const issue of allEMIssues) {
    const ownedFiles = parseFileOwnership(issue.body);
    for (const file of ownedFiles) {
      ownership.set(file, issue.id);
    }
  }

  // Check if any of our files are owned by another EM
  for (const file of files) {
    if (ownership.has(file) && ownership.get(file) !== this.emId) {
      console.error(`File conflict: ${file} is owned by EM-${ownership.get(file)}`);
      return false;
    }
  }

  return true;
}
```

### Phase 4: Retry Logic with Issue-Level State

```typescript
interface IssueState {
  phase: 'analyzing' | 'em-creation' | 'em-execution' | 'merging' | 'complete' | 'failed';
  retryCount: number;
  lastError?: string;
}

async function runOrchestrator(mainIssue: Issue): Promise<void> {
  const state = await loadStateFromIssue(mainIssue) || { phase: 'analyzing' };

  try {
    switch (state.phase) {
      case 'analyzing':
        const analysis = await breakdownIssue(mainIssue);
        await saveStateToIssue(mainIssue, { ...state, phase: 'em-creation' });
        await createEMIssues(mainIssue, analysis.ems);
        break;

      case 'em-creation':
        await activateEMs(mainIssue);
        await saveStateToIssue(mainIssue, { ...state, phase: 'em-execution' });
        break;

      case 'em-execution':
        await monitorAndCompleteEMs(mainIssue);
        await saveStateToIssue(mainIssue, { ...state, phase: 'merging' });
        break;

      case 'merging':
        await mergeFinalPR(mainIssue);
        await saveStateToIssue(mainIssue, { phase: 'complete' });
        break;
    }
  } catch (error) {
    if (isRetryable(error) && state.retryCount < MAX_RETRIES) {
      await saveStateToIssue(mainIssue, {
        ...state,
        retryCount: state.retryCount + 1,
        lastError: error.message
      });
      // Schedule retry via workflow_dispatch
      await scheduleRetry(mainIssue.number);
    } else {
      await saveStateToIssue(mainIssue, {
        ...state,
        phase: 'failed',
        lastError: error.message
      });
      await addComment(mainIssue, `❌ Failed: ${error.message}`);
    }
  }
}
```

---

## File Ownership System

### Ownership Declaration Format

Each EM issue declares ownership explicitly:

```markdown
## File Ownership Declaration

### Primary Ownership (EXCLUSIVE)
The following files/directories are **exclusively owned by this EM**:
- `lib/db/schema.ts` - Only EM-1 can create/modify
- `lib/db/migrations/` - Only EM-1 can create/modify
- `lib/repositories/` - Only EM-1 can create/modify

### Dependencies (READ-ONLY)
This EM depends on files owned by other EMs:
- `types/index.ts` (owned by EM-0) - Can import, cannot modify
- `package.json` (owned by EM-0) - Can add dependencies via PR to EM-0

### Forbidden Files
This EM MUST NOT modify:
- Any file owned by another EM (violations will cause PR rejection)
- Files outside declared ownership without explicit coordination
```

### Ownership Validation

```typescript
class FileOwnershipRegistry {
  private ownership: Map<string, number>; // file pattern -> EM id

  async validatePR(pr: PullRequest): Promise<{valid: boolean, conflicts: string[]}> {
    const conflicts: string[] = [];

    for (const file of pr.files) {
      const owner = this.ownership.get(file);
      if (owner === undefined) {
        // File not owned by anyone - might be OK if it's a new file
        continue;
      }
      if (owner !== pr.emId) {
        conflicts.push(`${file} is owned by EM-${owner}`);
      }
    }

    return { valid: conflicts.length === 0, conflicts };
  }
}
```

---

## New Workflow

### 1. Director Phase

```
User labels issue #475 with 'cco'
    ↓
Director analyzes issue (via Claude)
    ↓
Director creates EM issues:
  - #476: [EM-0] Project Setup
  - #477: [EM-1] Data Layer
  - #478: [EM-2] Authentication
  - #479: [EM-3] API Routes
  - ... etc
    ↓
Director comments on main issue with breakdown
```

### 2. Setup Phase (Direct File Creation)

```
Orchestrator reads EM issues
    ↓
Creates config files directly (no Claude)
    ↓
Commits to work branch
    ↓
Creates PR for EM-0
    ↓
Merges EM-0 PR
    ↓
Closes EM-0 issue
```

### 3. EM Execution Phase

```
For each EM issue:
  ↓
  Workers execute tasks (via Claude Code)
    ↓
  Each worker creates PR
    ↓
  PR validates file ownership
    ↓
  PR links to EM issue as comment
    ↓
  When all workers done:
    ↓
  Create summary PR for EM
    ↓
  Merge summary PR
    ↓
  Close EM issue
```

### 4. Final Phase

```
When all EM issues closed:
  ↓
  Create final PR to main
    ↓
  Include all changes from all EMs
    ↓
  Add comprehensive summary
    ↓
  Merge final PR
    ↓
  Close main issue
    ↓
  Delete .orchestrator/ state if exists
```

---

## Advantages of Issue-Driven Architecture

### 1. **Transparent State**
- Progress visible in issues
- No hidden state file
- Can resume from any point by reading GitHub issues

### 2. **Clear File Ownership**
- Each EM declares what it owns
- Validation happens at PR creation time
- Conflicts detected before merge

### 3. **Natural Parallelization**
- Each EM is truly independent
- No shared branch - EMs work on their own timeline
- GitHub handles concurrency

### 4. **Better Error Handling**
- When an EM fails, its issue shows the error
- Can retry individual EMs without affecting others
- Clear failure attribution

### 5. **Setup Problem Solved**
- No setup worker prompt battles
- Config files created deterministically
- Workers start with truly clean slate

### 6. **Scalability**
- Can have unlimited EMs working in parallel
- Each EM can have unlimited workers
- GitHub handles the scheduling

---

## Implementation Roadmap

### Step 1: Director Creates Issues (1-2 days)
- Modify director to create GitHub issues for each EM
- Add file ownership declaration to issue body
- Link EM issues to parent issue

### Step 2: Remove Setup Worker (1 day)
- Replace setup worker with direct file creation
- Create template system for config files
- Test setup without Claude Code

### Step 3: Workers Link to EM Issues (2-3 days)
- Modify worker execution to read from EM issue
- Add PR comments to EM issues
- Implement file ownership validation

### Step 4: EM Completion Logic (2-3 days)
- Auto-detect when all workers for an EM complete
- Create summary PR for EM
- Close EM issue on successful merge

### Step 5: Final Assembly (2 days)
- Detect when all EMs complete
- Create final PR to main
- Clean up state files

### Step 6: Remove State File (1 day)
- Eliminate `.orchestrator/state.json`
- Use issue labels/comments for state
- Make orchestrator stateless

---

## File Ownership Matrix Example

For SplitSync app:

| File Pattern | EM Owner | Notes |
|-------------|----------|-------|
| `.gitignore`, `package.json` | EM-0 | Config files |
| `tsconfig.json`, `next.config.js` | EM-0 | Build configs |
| `.github/workflows/ci.yml` | EM-0 | CI/CD |
| `playwright.config.ts` | EM-0 | Test config |
| `lib/db/schema.ts` | EM-1 | Database |
| `lib/repositories/*.ts` | EM-1 | Data access |
| `lib/validation/*.ts` | EM-1 | Zod schemas |
| `lib/auth/config.ts` | EM-2 | Auth config |
| `lib/auth/middleware.ts` | EM-2 | Auth middleware |
| `lib/auth/*.ts` | EM-2 | Auth logic |
| `app/api/groups/*.ts` | EM-3 | Group APIs |
| `app/api/expenses/*.ts` | EM-3 | Expense APIs |
| `app/api/settlements/*.ts` | EM-3 | Settlement APIs |
| `components/ui/button.tsx` | EM-4 | UI component |
| `components/ui/card.tsx` | EM-4 | UI component |
| `components/forms/*.tsx` | EM-4 | Form components |
| `components/expenses/*.tsx` | EM-5 | Feature components |
| `components/groups/*.tsx` | EM-5 | Feature components |
| `app/dashboard/page.tsx` | EM-6 | Page |
| `app/group/[id]/page.tsx` | EM-6 | Page |
| `app/expense/[id]/edit/page.tsx` | EM-6 | Page |
| `lib/socket/server.ts` | EM-7 | Real-time |
| `lib/socket/client.ts` | EM-7 | Real-time |
| `tests/unit/*.test.ts` | EM-8 | Unit tests |
| `tests/e2e/*.spec.ts` | EM-8 | E2E tests |
| `lib/logger.ts` | EM-9 | Logging |
| `lib/monitoring/*.ts` | EM-9 | Monitoring |

**Key:** No overlaps! Each file/directory belongs to exactly one EM.

---

## Transition Strategy

### Phase 1: Hybrid Mode (Backward Compatible)
- Keep existing workflow for now
- Add issue-based tracking as parallel system
- Test with simple projects

### Phase 2: Soft Migration
- Make issue-based tracking optional (via flag)
- Gather feedback and iterate
- Fix bugs based on real usage

### Phase 3: Full Migration
- Make issue-based tracking default
- Deprecate old state-file approach
- Update documentation

### Phase 4: Remove Legacy Code
- Remove state file logic
- Simplify codebase
- Archive old workflows

---

## Risk Mitigation

### Risk 1: Too Many Issues
**Mitigation:** Use issue templates and automation for bulk creation

### Risk 2: Issue Management Complexity
**Mitigation:** Use GitHub's API and labels effectively

### Risk 3: Rate Limits on GitHub API
**Mitigation:** Batch API calls, use graphql for efficiency

### Risk 4: PR Conflicts Still Happen
**Mitigation:** Strict file ownership validation before PR creation

### Risk 5: Lost Work if Issues Deleted
**Mitigation:** Protect main issue, use soft deletes, backup to comments

---

## Success Metrics

### Technical Metrics
- ✅ Zero "No unique commits" errors
- ✅ Zero merge conflicts
- ✅ True parallelization (10+ EMs working simultaneously)
- ✅ State resumable from any point
- ✅ No `.orchestrator/state.json` in final repo

### User Experience Metrics
- ✅ Progress visible in issues (not hidden in logs)
- ✅ Clear failure attribution (which EM/worker failed)
- ✅ Can retry individual EMs without full restart
- ✅ Can monitor progress via GitHub UI

### Developer Experience Metrics
- ✅ Easy to understand (issues = work units)
- ✅ Easy to debug (read issues to see what happened)
- ✅ Easy to extend (add new EM types by adding new issue templates)

---

## Conclusion

The current approach of trying to constrain the setup worker through prompts has failed three times. By reimagining the orchestrator to use GitHub's native issue hierarchy as its state machine, we can:

1. **Eliminate the setup worker problem** - Create configs directly
2. **Achieve true parallelization** - Each EM is independent
3. **Make state transparent** - Progress in issues, not hidden files
4. **Enable easy retries** - Just reopen an issue and retry
5. **Leverage GitHub's strengths** - Issues are designed for this

The redesign shifts from "fighting Claude's autonomy" to "embracing GitHub's architecture" - a much more robust approach.
