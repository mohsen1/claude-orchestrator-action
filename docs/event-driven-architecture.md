# Event-Driven Architecture for Claude Code Orchestrator

## Current Problem

The current architecture has a fundamental flaw: the `issue_labeled` event handler tries to execute **all work** in a single GitHub Actions job:

```
issue_labeled → analyze → plan EMs → start ALL EMs → execute ALL workers → wait...
                                                    ↑
                                            This takes 30+ minutes
```

This causes:
- Jobs running for hours
- GitHub Actions timeouts (6 hour limit)
- No ability to scale horizontally
- Single point of failure
- Claude API rate limiting issues

## Proposed Architecture

### Core Principle: One Event = One Action = Exit

Each event handler should:
1. Load state
2. Perform ONE logical action
3. Save state
4. Trigger next event (if needed)
5. **EXIT**

### Event Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EVENT-DRIVEN FLOW                                  │
└─────────────────────────────────────────────────────────────────────────────┘

issue_labeled (cco)
    │
    ▼
┌──────────────────┐
│  ANALYZE PHASE   │  ← Single Claude call to break down issue
│  Duration: ~60s  │
└────────┬─────────┘
         │ dispatch: start_em (for each EM)
         ▼
┌──────────────────┐
│  START EM        │  ← Create EM branch, break down into workers
│  Duration: ~30s  │     One workflow run per EM (parallel)
└────────┬─────────┘
         │ dispatch: execute_worker (for each worker)
         ▼
┌──────────────────┐
│ EXECUTE WORKER   │  ← Run Claude SDK, create PR
│ Duration: 2-5min │     One workflow run per worker (parallel)
└────────┬─────────┘
         │ pull_request created
         ▼
┌──────────────────┐
│ AWAIT REVIEW     │  ← Wait for Copilot/human review
│ (external)       │
└────────┬─────────┘
         │ pull_request_review
         ▼
┌──────────────────┐
│ ADDRESS REVIEW   │  ← Fix issues if needed, or merge
│ Duration: 1-3min │
└────────┬─────────┘
         │ pull_request merged
         ▼
┌──────────────────┐
│ ON PR MERGE      │  ← Update state, trigger next steps
│ Duration: ~10s   │
└────────┬─────────┘
         │ Check: all workers done?
         ▼
┌──────────────────┐
│ CREATE EM PR     │  ← Merge worker branches into EM PR
│ Duration: ~30s   │
└────────┬─────────┘
         │ pull_request merged (EM)
         ▼
┌──────────────────┐
│ CHECK COMPLETE   │  ← All EMs done? Create final PR
│ Duration: ~10s   │
└─────────────────┘
```

### New Event Types

```typescript
type OrchestratorEventType =
  // External GitHub events
  | 'issue_labeled'        // User adds 'cco' label
  | 'issue_closed'         // User closes issue (cleanup)
  | 'pull_request_merged'  // PR was merged
  | 'pull_request_review'  // Review submitted
  
  // Internal dispatch events (new)
  | 'start_em'            // Start a specific EM
  | 'execute_worker'      // Execute a specific worker
  | 'create_em_pr'        // Create PR for EM after workers done
  | 'check_completion'    // Check if orchestration is complete
  | 'retry_failed'        // Retry a failed worker/EM
```

### Workflow Dispatch for Internal Events

```yaml
# .github/workflows/orchestrator.yml
on:
  workflow_dispatch:
    inputs:
      event_type:
        type: choice
        options:
          - start_em
          - execute_worker
          - create_em_pr
          - check_completion
          - retry_failed
      issue_number:
        type: string
        required: true
      em_id:
        type: string
        description: 'EM ID (for start_em, execute_worker, create_em_pr)'
      worker_id:
        type: string
        description: 'Worker ID (for execute_worker)'
```

### Handler Implementations

#### 1. Issue Labeled Handler (Analyze Only)

```typescript
async handleIssueLabeled(event: OrchestratorEvent): Promise<void> {
  // 1. Create work branch
  // 2. Call Claude to analyze and plan EMs
  // 3. Save state with planned EMs
  // 4. Dispatch start_em for EACH EM
  // 5. EXIT
  
  for (const em of plannedEMs) {
    await this.dispatchEvent('start_em', {
      issue_number: event.issueNumber,
      em_id: em.id
    });
  }
  
  // Handler exits here - each EM starts in its own workflow run
}
```

#### 2. Start EM Handler

```typescript
async handleStartEM(event: OrchestratorEvent): Promise<void> {
  // 1. Load state
  // 2. Create EM branch
  // 3. Call Claude to break down into workers
  // 4. Save state with worker tasks
  // 5. Dispatch execute_worker for EACH worker
  // 6. EXIT
  
  for (const worker of em.workers) {
    await this.dispatchEvent('execute_worker', {
      issue_number: event.issueNumber,
      em_id: em.id,
      worker_id: worker.id
    });
  }
  
  // Handler exits here - each worker starts in its own workflow run
}
```

#### 3. Execute Worker Handler

```typescript
async handleExecuteWorker(event: OrchestratorEvent): Promise<void> {
  // 1. Load state
  // 2. Create worker branch
  // 3. Execute Claude SDK task
  // 4. Create PR
  // 5. Save state
  // 6. EXIT (PR creation triggers review flow)
  
  // No dispatch needed - PR creation triggers pull_request events
}
```

### Parallelism Model

```
                    issue_labeled
                         │
                         ▼
                    [ANALYZE]
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   [start_em_1]    [start_em_2]    [start_em_3]    (parallel runs)
        │                │                │
   ┌────┼────┐      ┌────┼────┐      ┌────┼────┐
   ▼    ▼    ▼      ▼    ▼    ▼      ▼    ▼    ▼
  W1   W2   W3     W1   W2   W3     W1   W2   W3   (parallel runs)
   │    │    │      │    │    │      │    │    │
   └────┼────┘      └────┼────┘      └────┼────┘
        ▼                ▼                ▼
   [em_1_pr]       [em_2_pr]       [em_3_pr]
        │                │                │
        └────────────────┼────────────────┘
                         ▼
                   [final_pr]
```

**Key Insight:** With 10 EMs and 3 workers each, instead of 1 job running for 2 hours, we have:
- 1 analyze job (~1 min)
- 10 parallel start_em jobs (~30s each)
- 30 parallel worker jobs (~3 min each)
- 10 parallel em_pr jobs (~30s each)

**Total wall-clock time:** ~5 minutes instead of 2 hours!

### State Management

State is stored in `.orchestrator/state.json` on the work branch. Each handler:

1. **Loads** current state at start
2. **Updates** only its relevant portion
3. **Saves** with merge semantics (to handle parallel updates)

```typescript
interface OrchestratorState {
  phase: Phase;
  issue: IssueInfo;
  workBranch: string;
  
  // Each EM tracks its own state
  ems: {
    [emId: string]: {
      status: 'pending' | 'planning' | 'workers_running' | 'pr_created' | 'merged';
      branch: string;
      workers: {
        [workerId: string]: {
          status: 'pending' | 'running' | 'pr_created' | 'merged' | 'failed';
          prNumber?: number;
        };
      };
    };
  };
}
```

### Dispatch Helper

```typescript
async dispatchEvent(
  eventType: string, 
  inputs: Record<string, string>
): Promise<void> {
  await this.github.getOctokit().rest.actions.createWorkflowDispatch({
    owner: this.ctx.repo.owner,
    repo: this.ctx.repo.name,
    workflow_id: 'orchestrator.yml',
    ref: 'main',
    inputs: {
      event_type: eventType,
      ...inputs
    }
  });
}
```

### Concurrency Control

To prevent race conditions, use GitHub Actions concurrency groups:

```yaml
jobs:
  orchestrate:
    # Prevent multiple handlers for same issue from running simultaneously
    # But allow different issues to run in parallel
    concurrency:
      group: cco-${{ inputs.issue_number }}-${{ inputs.em_id || 'main' }}-${{ inputs.worker_id || 'main' }}
      cancel-in-progress: false
```

### Error Handling and Retries

```typescript
async handleExecuteWorker(event: OrchestratorEvent): Promise<void> {
  try {
    // ... execute worker
  } catch (error) {
    // Mark as failed in state
    worker.status = 'failed';
    worker.error = error.message;
    worker.retryCount = (worker.retryCount || 0) + 1;
    
    await saveState(this.state);
    
    // Dispatch retry if under limit
    if (worker.retryCount < 3) {
      await this.dispatchEvent('retry_failed', {
        issue_number: event.issueNumber,
        em_id: event.emId,
        worker_id: event.workerId,
        delay_minutes: '5' // exponential backoff
      });
    }
  }
}
```

### Benefits

| Aspect | Current | Proposed |
|--------|---------|----------|
| **Job Duration** | 30-120 min | 1-5 min per job |
| **Parallelism** | Limited (1 job) | Full (N jobs) |
| **Failure Isolation** | All work lost | Only affected worker |
| **Scalability** | Bottlenecked | Linear with EMs |
| **Timeout Risk** | High | Very low |
| **Cost** | High (long runners) | Lower (short runners) |
| **Debuggability** | One huge log | Separate logs per unit |

### Migration Path

1. **Phase 1:** Add dispatch helper and new event types
2. **Phase 2:** Refactor `handleIssueLabeled` to only analyze
3. **Phase 3:** Implement `start_em` and `execute_worker` handlers
4. **Phase 4:** Update workflow to accept new dispatch events
5. **Phase 5:** Remove long-running code paths

### Example: Full Orchestration Timeline

```
T+0:00  issue_labeled received
T+0:01  Analysis complete, 5 EMs planned
T+0:01  Dispatched: start_em x5

T+0:02  start_em_1 received (parallel)
T+0:02  start_em_2 received (parallel)
T+0:02  start_em_3 received (parallel)
T+0:02  start_em_4 received (parallel)
T+0:02  start_em_5 received (parallel)

T+0:30  start_em_1 complete, dispatched 3 workers
T+0:32  start_em_2 complete, dispatched 3 workers
...

T+0:35  execute_worker_1_1 received
T+0:35  execute_worker_1_2 received
T+0:35  execute_worker_1_3 received
T+0:35  execute_worker_2_1 received
... (15 workers starting in parallel)

T+3:00  Worker PRs created, awaiting review
T+4:00  Copilot reviews complete
T+4:30  All workers merged
T+5:00  All EM PRs merged
T+5:30  Final PR created and merged

Total: ~5-6 minutes wall-clock time
```

## Implementation Checklist

- [ ] Add `dispatchEvent` helper to GitHubClient
- [ ] Define new event types in `OrchestratorEvent`
- [ ] Refactor `handleIssueLabeled` to exit after analysis
- [ ] Implement `handleStartEM` handler
- [ ] Implement `handleExecuteWorker` handler  
- [ ] Implement `handleCreateEMPR` handler
- [ ] Implement `handleCheckCompletion` handler
- [ ] Update workflow YAML with new dispatch inputs
- [ ] Add concurrency groups
- [ ] Update state merge logic for parallel updates
- [ ] Add retry mechanism with exponential backoff
- [ ] Update debug logging for new event types
- [ ] Write tests for each handler in isolation

## Conclusion

This event-driven architecture transforms the orchestrator from a monolithic long-running process into a distributed system of short-lived handlers. Each handler does one thing, saves state, and exits. The result is:

- **Faster:** Parallel execution across many workflow runs
- **Reliable:** Isolated failures, automatic retries
- **Scalable:** No bottlenecks, linear scaling
- **Observable:** Clear event logs per action
- **Maintainable:** Simple, focused handlers
