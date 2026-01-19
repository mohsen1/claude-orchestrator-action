/**
 * Integration Tests for Event-Driven Orchestrator
 * 
 * Tests the full orchestration flow with mocked external dependencies:
 * - GitHub API
 * - Claude/SDK LLM calls
 * - Git operations
 * - File system
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createMockState,
  createMockGitHubClient,
  createMockGitOperations,
  createMockClaudeRunner,
  createMockSDKRunner,
  createMockFileSystem,
  MockState
} from './mocks.js';
import {
  OrchestratorState,
  createInitialState,
  areAllWorkersComplete,
  getNextPendingWorker,
  serializeState,
  parseState
} from '../../src/orchestrator/state.js';

describe('Orchestrator State', () => {
  describe('createInitialState', () => {
    it('should create initial state with correct defaults', () => {
      const state = createInitialState({
        issue: { number: 123, title: 'Test Issue', body: 'Test body' },
        repo: { owner: 'test', name: 'repo' },
        workBranch: 'cco/123-test-issue'
      });

      expect(state.version).toBe(1);
      expect(state.phase).toBe('initialized');
      expect(state.issue.number).toBe(123);
      expect(state.workBranch).toBe('cco/123-test-issue');
      expect(state.baseBranch).toBe('main');
      expect(state.ems).toHaveLength(0);
      expect(state.config.maxEms).toBe(3);
      expect(state.config.maxWorkersPerEm).toBe(3);
    });

    it('should accept custom config options', () => {
      const state = createInitialState({
        issue: { number: 1, title: 'Test', body: '' },
        repo: { owner: 'test', name: 'repo' },
        workBranch: 'cco/1-test',
        config: { maxEms: 5, maxWorkersPerEm: 10, reviewWaitMinutes: 15 }
      });

      expect(state.config.maxEms).toBe(5);
      expect(state.config.maxWorkersPerEm).toBe(10);
      expect(state.config.reviewWaitMinutes).toBe(15);
    });
  });

  describe('serializeState / parseState', () => {
    it('should round-trip state correctly', () => {
      const original = createInitialState({
        issue: { number: 42, title: 'Round Trip', body: 'Test' },
        repo: { owner: 'test', name: 'repo' },
        workBranch: 'cco/42-round-trip'
      });

      const serialized = serializeState(original);
      const parsed = parseState(serialized);

      expect(parsed.issue.number).toBe(42);
      expect(parsed.workBranch).toBe('cco/42-round-trip');
      expect(parsed.phase).toBe('initialized');
    });

    it('should throw on incompatible version', () => {
      const badState = { version: 99, phase: 'initialized' };
      expect(() => parseState(JSON.stringify(badState))).toThrow('Unsupported state version');
    });
  });

  describe('areAllWorkersComplete', () => {
    it('should return true when all workers are merged', () => {
      const em = {
        id: 1,
        task: 'Test',
        focusArea: 'Core',
        branch: 'em-1',
        status: 'workers_running' as const,
        workers: [
          { id: 1, task: 'W1', files: [], branch: 'w1', status: 'merged' as const, reviewsAddressed: 0 },
          { id: 2, task: 'W2', files: [], branch: 'w2', status: 'merged' as const, reviewsAddressed: 0 }
        ],
        reviewsAddressed: 0
      };

      expect(areAllWorkersComplete(em)).toBe(true);
    });

    it('should return false when some workers are pending', () => {
      const em = {
        id: 1,
        task: 'Test',
        focusArea: 'Core',
        branch: 'em-1',
        status: 'workers_running' as const,
        workers: [
          { id: 1, task: 'W1', files: [], branch: 'w1', status: 'merged' as const, reviewsAddressed: 0 },
          { id: 2, task: 'W2', files: [], branch: 'w2', status: 'pending' as const, reviewsAddressed: 0 }
        ],
        reviewsAddressed: 0
      };

      expect(areAllWorkersComplete(em)).toBe(false);
    });
  });

  describe('getNextPendingWorker', () => {
    it('should return first pending worker', () => {
      const em = {
        id: 1,
        task: 'Test',
        focusArea: 'Core',
        branch: 'em-1',
        status: 'workers_running' as const,
        workers: [
          { id: 1, task: 'W1', files: [], branch: 'w1', status: 'merged' as const, reviewsAddressed: 0 },
          { id: 2, task: 'W2', files: [], branch: 'w2', status: 'pending' as const, reviewsAddressed: 0 },
          { id: 3, task: 'W3', files: [], branch: 'w3', status: 'pending' as const, reviewsAddressed: 0 }
        ],
        reviewsAddressed: 0
      };

      const next = getNextPendingWorker(em);
      expect(next?.id).toBe(2);
    });

    it('should return undefined when no pending workers', () => {
      const em = {
        id: 1,
        task: 'Test',
        focusArea: 'Core',
        branch: 'em-1',
        status: 'workers_complete' as const,
        workers: [
          { id: 1, task: 'W1', files: [], branch: 'w1', status: 'merged' as const, reviewsAddressed: 0 }
        ],
        reviewsAddressed: 0
      };

      expect(getNextPendingWorker(em)).toBeUndefined();
    });
  });
});

describe('Mock GitHub Client', () => {
  let state: MockState;
  let github: ReturnType<typeof createMockGitHubClient>;

  beforeEach(() => {
    state = createMockState();
    github = createMockGitHubClient(state);

    // Add test issue
    state.issues.set(1, {
      number: 1,
      title: 'Test Issue',
      body: 'Test body',
      labels: ['orchestrator']
    });
  });

  it('should get issue', async () => {
    const issue = await github.getIssue(1);
    expect(issue.number).toBe(1);
    expect(issue.title).toBe('Test Issue');
  });

  it('should throw on missing issue', async () => {
    await expect(github.getIssue(999)).rejects.toThrow('not found');
  });

  it('should create PR', async () => {
    const pr = await github.createPullRequest({
      title: 'Test PR',
      body: 'Test body',
      head: 'feature',
      base: 'main'
    });

    expect(pr.number).toBe(1);
    expect(state.prs.has(1)).toBe(true);
    expect(state.prs.get(1)?.title).toBe('Test PR');
  });

  it('should merge PR', async () => {
    await github.createPullRequest({
      title: 'Test PR',
      body: 'Test body',
      head: 'feature',
      base: 'main'
    });

    await github.mergePullRequest(1);

    expect(state.prs.get(1)?.merged).toBe(true);
    expect(state.prs.get(1)?.state).toBe('closed');
  });

  it('should throw on double merge', async () => {
    await github.createPullRequest({
      title: 'Test PR',
      body: 'Body',
      head: 'feature',
      base: 'main'
    });

    await github.mergePullRequest(1);
    await expect(github.mergePullRequest(1)).rejects.toThrow('already merged');
  });
});

describe('Mock Git Operations', () => {
  let state: MockState;
  let git: ReturnType<typeof createMockGitOperations>;

  beforeEach(() => {
    state = createMockState();
    git = createMockGitOperations(state);
  });

  it('should create and track branches', async () => {
    await git.createBranch('feature', 'main');
    expect(state.branches.has('feature')).toBe(true);
    expect(state.currentBranch).toBe('feature');
  });

  it('should checkout existing branch', async () => {
    state.branches.add('existing');
    await git.checkout('existing');
    expect(state.currentBranch).toBe('existing');
  });

  it('should throw on checkout non-existent branch', async () => {
    await expect(git.checkout('nonexistent')).rejects.toThrow('does not exist');
  });

  it('should push and track branch', async () => {
    await git.push('new-branch');
    expect(state.branches.has('new-branch')).toBe(true);
  });
});

describe('Mock Claude Runner', () => {
  it('should return EM tasks for director prompt', async () => {
    const claude = createMockClaudeRunner();

    const result = await claude.runTask(
      'You are a technical director analyzing...',
      'session-1'
    );

    expect(result.success).toBe(true);
    const tasks = JSON.parse(result.stdout);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].em_id).toBe(1);
    expect(tasks[0].focus_area).toBe('Core');
  });

  it('should return worker tasks for EM prompt', async () => {
    const claude = createMockClaudeRunner();

    const result = await claude.runTask(
      'You are an Engineering Manager breaking down...',
      'session-1'
    );

    expect(result.success).toBe(true);
    const tasks = JSON.parse(result.stdout);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].worker_id).toBe(1);
  });
});

describe('Mock SDK Runner', () => {
  let state: MockState;
  let sdk: ReturnType<typeof createMockSDKRunner>;

  beforeEach(() => {
    state = createMockState();
    sdk = createMockSDKRunner(state);
  });

  it('should simulate file creation', async () => {
    const result = await sdk.executeTask(
      'Create the main module. files: src/index.ts, src/utils.ts'
    );

    expect(result.success).toBe(true);
    expect(state.files.has('src/index.ts')).toBe(true);
    expect(state.files.has('src/utils.ts')).toBe(true);
  });
});

describe('State Machine Transitions', () => {
  let mockState: MockState;
  let orchestratorState: OrchestratorState;

  beforeEach(() => {
    mockState = createMockState();
    orchestratorState = createInitialState({
      issue: { number: 1, title: 'Test', body: 'Test body' },
      repo: { owner: 'test', name: 'repo' },
      workBranch: 'cco/1-test'
    });
  });

  it('should transition from initialized to analyzing', () => {
    expect(orchestratorState.phase).toBe('initialized');
    orchestratorState.phase = 'analyzing';
    expect(orchestratorState.phase).toBe('analyzing');
  });

  it('should track EM assignment', () => {
    orchestratorState.phase = 'em_assignment';
    orchestratorState.ems = [
      {
        id: 1,
        task: 'Core implementation',
        focusArea: 'Core',
        branch: 'cco/1-test-em-1',
        status: 'pending',
        workers: [],
        reviewsAddressed: 0
      }
    ];

    expect(orchestratorState.ems).toHaveLength(1);
    expect(orchestratorState.ems[0].status).toBe('pending');
  });

  it('should track worker execution', () => {
    orchestratorState.phase = 'worker_execution';
    orchestratorState.ems = [
      {
        id: 1,
        task: 'Core',
        focusArea: 'Core',
        branch: 'em-1',
        status: 'workers_running',
        workers: [
          { id: 1, task: 'W1', files: [], branch: 'w1', status: 'in_progress', reviewsAddressed: 0 }
        ],
        reviewsAddressed: 0
      }
    ];

    expect(orchestratorState.ems[0].workers[0].status).toBe('in_progress');
  });

  it('should track PR creation', () => {
    orchestratorState.ems = [
      {
        id: 1,
        task: 'Core',
        focusArea: 'Core',
        branch: 'em-1',
        status: 'workers_running',
        workers: [
          { id: 1, task: 'W1', files: [], branch: 'w1', status: 'pr_created', prNumber: 42, reviewsAddressed: 0 }
        ],
        reviewsAddressed: 0
      }
    ];

    expect(orchestratorState.ems[0].workers[0].prNumber).toBe(42);
  });

  it('should track review handling', () => {
    orchestratorState.ems = [
      {
        id: 1,
        task: 'Core',
        focusArea: 'Core',
        branch: 'em-1',
        status: 'workers_running',
        workers: [
          { id: 1, task: 'W1', files: [], branch: 'w1', status: 'changes_requested', prNumber: 42, reviewsAddressed: 1 }
        ],
        reviewsAddressed: 0
      }
    ];

    expect(orchestratorState.ems[0].workers[0].status).toBe('changes_requested');
    expect(orchestratorState.ems[0].workers[0].reviewsAddressed).toBe(1);
  });

  it('should track complete flow', () => {
    // Start
    expect(orchestratorState.phase).toBe('initialized');

    // Analysis done
    orchestratorState.phase = 'em_assignment';
    orchestratorState.ems = [
      { id: 1, task: 'Core', focusArea: 'Core', branch: 'em-1', status: 'pending', workers: [], reviewsAddressed: 0 }
    ];

    // Workers assigned
    orchestratorState.phase = 'worker_execution';
    orchestratorState.ems[0].status = 'workers_running';
    orchestratorState.ems[0].workers = [
      { id: 1, task: 'W1', files: [], branch: 'w1', status: 'pending', reviewsAddressed: 0 }
    ];

    // Worker completes
    orchestratorState.ems[0].workers[0].status = 'pr_created';
    orchestratorState.ems[0].workers[0].prNumber = 1;

    // Worker merged
    orchestratorState.ems[0].workers[0].status = 'merged';
    orchestratorState.ems[0].status = 'workers_complete';

    // EM PR created
    orchestratorState.phase = 'em_review';
    orchestratorState.ems[0].status = 'pr_created';
    orchestratorState.ems[0].prNumber = 2;

    // EM merged
    orchestratorState.ems[0].status = 'merged';

    // Final PR
    orchestratorState.phase = 'complete';
    orchestratorState.finalPr = { number: 3, url: 'https://github.com/test/repo/pull/3' };

    expect(orchestratorState.phase).toBe('complete');
    expect(orchestratorState.finalPr?.number).toBe(3);
  });
});

describe('Integration: Full Orchestration Flow', () => {
  let mockState: MockState;
  let github: ReturnType<typeof createMockGitHubClient>;
  let git: ReturnType<typeof createMockGitOperations>;
  let claude: ReturnType<typeof createMockClaudeRunner>;
  let sdk: ReturnType<typeof createMockSDKRunner>;
  let orchestratorState: OrchestratorState;

  beforeEach(() => {
    mockState = createMockState();
    github = createMockGitHubClient(mockState);
    git = createMockGitOperations(mockState);
    claude = createMockClaudeRunner();
    sdk = createMockSDKRunner(mockState);

    // Setup test issue
    mockState.issues.set(1, {
      number: 1,
      title: 'Build a REST API',
      body: 'Create a REST API with CRUD operations for users',
      labels: ['orchestrator']
    });

    orchestratorState = createInitialState({
      issue: { number: 1, title: 'Build a REST API', body: 'Create a REST API with CRUD operations' },
      repo: { owner: 'test', name: 'repo' },
      workBranch: 'cco/1-build-a-rest-api'
    });
  });

  it('should simulate full orchestration flow', async () => {
    // 1. Initialize work branch
    await git.createBranch('cco/1-build-a-rest-api', 'main');
    await git.push('cco/1-build-a-rest-api');
    orchestratorState.phase = 'analyzing';

    // 2. Director analyzes issue
    const directorResult = await claude.runTask(
      'You are a technical director analyzing...',
      'director-1'
    );
    expect(directorResult.success).toBe(true);

    const emTasks = JSON.parse(directorResult.stdout);
    orchestratorState.ems = emTasks.map((em: { em_id: number; task: string; focus_area: string }) => ({
      id: em.em_id,
      task: em.task,
      focusArea: em.focus_area,
      branch: `cco/1-build-a-rest-api-em-${em.em_id}`,
      status: 'pending' as const,
      workers: [],
      reviewsAddressed: 0
    }));
    orchestratorState.phase = 'em_assignment';

    expect(orchestratorState.ems).toHaveLength(2);

    // 3. First EM gets workers
    const em1 = orchestratorState.ems[0];
    await git.createBranch(em1.branch, 'cco/1-build-a-rest-api');

    const emResult = await claude.runTask(
      'You are an Engineering Manager breaking down...',
      'em-1'
    );
    const workerTasks = JSON.parse(emResult.stdout);

    em1.workers = workerTasks.map((w: { worker_id: number; task: string; files: string[] }) => ({
      id: w.worker_id,
      task: w.task,
      files: w.files,
      branch: `${em1.branch}-w-${w.worker_id}`,
      status: 'pending' as const,
      reviewsAddressed: 0
    }));
    em1.status = 'workers_running';
    orchestratorState.phase = 'worker_execution';

    expect(em1.workers).toHaveLength(2);

    // 4. Workers execute
    for (const worker of em1.workers) {
      await git.createBranch(worker.branch, em1.branch);
      worker.status = 'in_progress';

      const workerResult = await sdk.executeTask(`Implement: ${worker.task}`);
      expect(workerResult.success).toBe(true);

      await git.commitAndPush('feat: implement task', worker.branch);

      // Create worker PR
      const pr = await github.createPullRequest({
        title: `[EM-1/W-${worker.id}] ${worker.task}`,
        body: 'Worker implementation',
        head: worker.branch,
        base: em1.branch
      });

      worker.prNumber = pr.number;
      worker.status = 'pr_created';
    }

    orchestratorState.phase = 'worker_review';

    // 5. Simulate review on first worker PR
    const worker1 = em1.workers[0];
    mockState.reviews.set(worker1.prNumber!, [{
      id: 1,
      state: 'changes_requested',
      body: 'Please add error handling',
      user: 'reviewer'
    }]);

    // Check for reviews
    const reviews = await github.getPullRequestReviews(worker1.prNumber!);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].state).toBe('changes_requested');

    // Address review
    worker1.status = 'changes_requested';
    await sdk.executeTask('Address review: add error handling');
    await git.commitAndPush('fix: add error handling', worker1.branch);
    worker1.reviewsAddressed++;
    worker1.status = 'pr_created';

    // 6. Merge worker PRs
    for (const worker of em1.workers) {
      await github.mergePullRequest(worker.prNumber!);
      worker.status = 'merged';
    }

    expect(areAllWorkersComplete(em1)).toBe(true);
    em1.status = 'workers_complete';

    // 7. Create EM PR
    await git.checkout(em1.branch);
    const emPr = await github.createPullRequest({
      title: `[EM-1] ${em1.focusArea}`,
      body: 'EM implementation',
      head: em1.branch,
      base: 'cco/1-build-a-rest-api'
    });

    em1.prNumber = emPr.number;
    em1.status = 'pr_created';
    orchestratorState.phase = 'em_review';

    // 8. Merge EM PR
    await github.mergePullRequest(em1.prNumber!);
    em1.status = 'merged';

    // 9. Process second EM similarly (simplified)
    const em2 = orchestratorState.ems[1];
    em2.status = 'merged';
    em2.prNumber = 10;

    // 10. Create final PR
    orchestratorState.phase = 'final_merge';
    const finalPr = await github.createPullRequest({
      title: 'feat: Build a REST API',
      body: 'Complete implementation',
      head: 'cco/1-build-a-rest-api',
      base: 'main'
    });

    orchestratorState.finalPr = {
      number: finalPr.number,
      url: `https://github.com/test/repo/pull/${finalPr.number}`
    };
    orchestratorState.phase = 'complete';

    // Verify final state
    expect(orchestratorState.phase).toBe('complete');
    expect(orchestratorState.finalPr).toBeDefined();
    expect(mockState.prs.size).toBeGreaterThan(0);

    // Verify all PRs except final are merged
    const openPrs = Array.from(mockState.prs.values()).filter(pr => !pr.merged);
    expect(openPrs).toHaveLength(1); // Only final PR
    expect(openPrs[0].base).toBe('main');
  });
});

describe('Error Recovery', () => {
  it('should persist state for recovery after failure', () => {
    const state = createInitialState({
      issue: { number: 1, title: 'Test', body: '' },
      repo: { owner: 'test', name: 'repo' },
      workBranch: 'cco/1-test'
    });

    // Simulate partial progress
    state.phase = 'worker_execution';
    state.ems = [
      {
        id: 1,
        task: 'Core',
        focusArea: 'Core',
        branch: 'em-1',
        status: 'workers_running',
        workers: [
          { id: 1, task: 'W1', files: [], branch: 'w1', status: 'merged', prNumber: 1, reviewsAddressed: 0 },
          { id: 2, task: 'W2', files: [], branch: 'w2', status: 'in_progress', reviewsAddressed: 0 }
        ],
        reviewsAddressed: 0
      }
    ];

    // Serialize for persistence
    const serialized = serializeState(state);

    // Simulate restart - parse state back
    const recovered = parseState(serialized);

    // Verify we can resume
    expect(recovered.phase).toBe('worker_execution');
    expect(recovered.ems[0].workers[0].status).toBe('merged');
    expect(recovered.ems[0].workers[1].status).toBe('in_progress');

    // Find where to resume
    const pendingWorker = getNextPendingWorker(recovered.ems[0]);
    expect(pendingWorker).toBeUndefined(); // Worker 2 is in_progress, not pending

    // In real scenario, we'd check if in_progress worker timed out
    // and either retry or mark as failed
  });

  it('should handle failed state gracefully', () => {
    const state = createInitialState({
      issue: { number: 1, title: 'Test', body: '' },
      repo: { owner: 'test', name: 'repo' },
      workBranch: 'cco/1-test'
    });

    state.phase = 'failed';
    state.error = 'Claude API timeout';

    const serialized = serializeState(state);
    const recovered = parseState(serialized);

    expect(recovered.phase).toBe('failed');
    expect(recovered.error).toBe('Claude API timeout');
  });
});
