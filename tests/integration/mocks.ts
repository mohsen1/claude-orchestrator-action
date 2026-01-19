/**
 * Test Mocks for Integration Testing
 * 
 * Mocks GitHub API, Claude/SDK, and Git operations
 */

import { vi } from 'vitest';

// Mock responses storage
export interface MockState {
  branches: Set<string>;
  prs: Map<number, {
    number: number;
    title: string;
    body: string;
    head: string;
    base: string;
    merged: boolean;
    state: 'open' | 'closed';
  }>;
  issues: Map<number, {
    number: number;
    title: string;
    body: string;
    labels: string[];
  }>;
  comments: Map<number, string[]>;
  reviews: Map<number, Array<{
    id: number;
    state: string;
    body: string;
    user: string;
  }>>;
  files: Map<string, string>;
  currentBranch: string;
  nextPrNumber: number;
}

export function createMockState(): MockState {
  return {
    branches: new Set(['main']),
    prs: new Map(),
    issues: new Map(),
    comments: new Map(),
    reviews: new Map(),
    files: new Map(),
    currentBranch: 'main',
    nextPrNumber: 1
  };
}

/**
 * Create mock GitHub client
 */
export function createMockGitHubClient(state: MockState) {
  return {
    getIssue: vi.fn(async (issueNumber: number) => {
      const issue = state.issues.get(issueNumber);
      if (!issue) throw new Error(`Issue #${issueNumber} not found`);
      return issue;
    }),

    createPullRequest: vi.fn(async (params: { title: string; body: string; head: string; base: string }) => {
      const prNumber = state.nextPrNumber++;
      const pr = {
        number: prNumber,
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
        merged: false,
        state: 'open' as const
      };
      state.prs.set(prNumber, pr);
      return { number: prNumber, html_url: `https://github.com/test/repo/pull/${prNumber}` };
    }),

    mergePullRequest: vi.fn(async (prNumber: number) => {
      const pr = state.prs.get(prNumber);
      if (!pr) throw new Error(`PR #${prNumber} not found`);
      if (pr.merged) throw new Error(`PR #${prNumber} already merged`);
      pr.merged = true;
      pr.state = 'closed';
    }),

    getPullRequest: vi.fn(async (prNumber: number) => {
      const pr = state.prs.get(prNumber);
      if (!pr) throw new Error(`PR #${prNumber} not found`);
      return {
        ...pr,
        html_url: `https://github.com/test/repo/pull/${prNumber}`,
        head: { ref: pr.head, sha: 'abc123' },
        base: { ref: pr.base, sha: 'def456' }
      };
    }),

    getPullRequestReviews: vi.fn(async (prNumber: number) => {
      return state.reviews.get(prNumber) || [];
    }),

    getPullRequestComments: vi.fn(async (_prNumber: number) => {
      return [];
    }),

    addPullRequestComment: vi.fn(async (prNumber: number, body: string) => {
      const comments = state.comments.get(prNumber) || [];
      comments.push(body);
      state.comments.set(prNumber, comments);
    }),

    updateIssueComment: vi.fn(async (issueNumber: number, body: string) => {
      const comments = state.comments.get(issueNumber) || [];
      comments.push(body);
      state.comments.set(issueNumber, comments);
    }),

    replyToReviewComment: vi.fn(async () => {})
  };
}

/**
 * Create mock Git operations
 */
export function createMockGitOperations(state: MockState) {
  return {
    createBranch: vi.fn(async (branchName: string, _fromBranch: string) => {
      state.branches.add(branchName);
      state.currentBranch = branchName;
    }),

    checkout: vi.fn(async (branchName: string) => {
      if (!state.branches.has(branchName)) {
        throw new Error(`Branch ${branchName} does not exist`);
      }
      state.currentBranch = branchName;
    }),

    push: vi.fn(async (branchName?: string) => {
      if (branchName) {
        state.branches.add(branchName);
      }
    }),

    pull: vi.fn(async () => {}),

    hasUncommittedChanges: vi.fn(async () => true),

    commitAndPush: vi.fn(async (_message: string, branchOrFiles?: string | string[]) => {
      if (typeof branchOrFiles === 'string') {
        state.branches.add(branchOrFiles);
      }
    }),

    getCurrentBranch: vi.fn(async () => state.currentBranch),

    configureIdentity: vi.fn(async () => {})
  };
}

/**
 * Create mock Claude runner that returns predictable responses
 */
export function createMockClaudeRunner() {
  let callCount = 0;

  return {
    runTask: vi.fn(async (prompt: string, _sessionId: string) => {
      callCount++;

      // Director analysis - return EM tasks
      if (prompt.includes('technical director')) {
        return {
          success: true,
          stdout: JSON.stringify([
            { em_id: 1, task: 'Implement core functionality', focus_area: 'Core', estimated_workers: 2 },
            { em_id: 2, task: 'Add tests', focus_area: 'Testing', estimated_workers: 1 }
          ]),
          stderr: '',
          exitCode: 0
        };
      }

      // EM breakdown - return worker tasks
      if (prompt.includes('Engineering Manager')) {
        return {
          success: true,
          stdout: JSON.stringify([
            { worker_id: 1, task: 'Create main module', files: ['src/index.ts'] },
            { worker_id: 2, task: 'Add helper functions', files: ['src/utils.ts'] }
          ]),
          stderr: '',
          exitCode: 0
        };
      }

      // Default response
      return {
        success: true,
        stdout: 'Task completed',
        stderr: '',
        exitCode: 0
      };
    }),

    getCallCount: () => callCount
  };
}

/**
 * Create mock SDK runner for file modifications
 */
export function createMockSDKRunner(state: MockState) {
  return {
    executeTask: vi.fn(async (prompt: string) => {
      // Simulate file creation by adding to state
      if (prompt.includes('Create') || prompt.includes('Implement')) {
        const match = prompt.match(/files?[:\s]+([^\n]+)/i);
        if (match) {
          const files = match[1].split(',').map(f => f.trim());
          files.forEach(f => state.files.set(f, '// Generated content'));
        }
      }

      return {
        success: true,
        output: 'Implementation complete. Created files.',
        error: undefined,
        inputTokens: 100,
        outputTokens: 200,
        durationMs: 1000
      };
    })
  };
}

/**
 * Create mock file system operations for state persistence
 */
export function createMockFileSystem(state: MockState) {
  return {
    existsSync: vi.fn((path: string) => state.files.has(path)),
    readFileSync: vi.fn((path: string) => {
      const content = state.files.get(path);
      if (!content) throw new Error(`File not found: ${path}`);
      return content;
    }),
    writeFileSync: vi.fn((path: string, content: string) => {
      state.files.set(path, content);
    }),
    mkdirSync: vi.fn(() => {})
  };
}
