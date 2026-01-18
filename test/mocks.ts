import fs from 'fs-extra';

type TestState = {
  prs: Array<any>;
  dispatches: Array<any>;
  branches: string[];
  fileSystemRoot: string;
};

// --- Virtual State ---
const state: TestState = {
  prs: [],
  dispatches: [],
  branches: ['main'],
  fileSystemRoot: '',
};

// --- Mock Octokit (GitHub API) ---
const mockOctokit = {
  rest: {
    actions: {
      createWorkflowDispatch: jest.fn().mockImplementation((payload) => {
        state.dispatches.push(payload);
        return Promise.resolve({ status: 204 });
      }),
    },
    pulls: {
      create: jest.fn().mockImplementation((payload) => {
        state.prs.push(payload);
        return Promise.resolve({ data: { number: state.prs.length, ...payload } });
      }),
      merge: jest.fn().mockResolvedValue({ status: 200 }),
      list: jest.fn().mockImplementation(({ head, base }) => {
        const filtered = state.prs.filter((pr) => {
          const headMatch = !head || pr.head === head || `${pr.owner || ''}:${pr.head}` === head;
          const baseMatch = !base || pr.base === base;
          return headMatch && baseMatch;
        });
        return Promise.resolve({ data: filtered });
      }),
      get: jest.fn().mockResolvedValue({ data: 'diff --git a/file b/file' }),
      createReview: jest.fn().mockResolvedValue({ status: 200 }),
    },
    git: {
      getRef: jest.fn().mockImplementation(({ ref }) => {
        const branch = ref.replace('heads/', '');
        if (!state.branches.includes(branch)) {
          return Promise.reject(Object.assign(new Error('Not found'), { status: 404 }));
        }
        return Promise.resolve({ data: { object: { sha: 'mock-sha' } } });
      }),
      createRef: jest.fn().mockImplementation(({ ref }) => {
        const branch = ref.replace('refs/heads/', '');
        if (!state.branches.includes(branch)) {
          state.branches.push(branch);
        }
        return Promise.resolve({ data: { ref } });
      }),
    },
  },
};

// --- Mock Anthropic (The AI) ---
const mockAnthropic = {
  messages: {
    create: jest.fn().mockImplementation(async ({ messages }) => {
      const prompt = messages[0].content as string;
      const lower = prompt.toLowerCase();

      if (prompt.includes('Analyze the request')) {
        return {
          content: [
            {
              text: JSON.stringify({
                subsystems: [{ name: 'backend', goal: 'Setup API', path: 'src/api' }],
              }),
            },
          ],
        };
      }

      if (lower.includes('atomic coding tasks')) {
        return {
          content: [
            {
              text: JSON.stringify({
                tasks: [{ id: 'task_1', description: 'Create server', files: ['src/api/server.js'] }],
              }),
            },
          ],
        };
      }

      if (prompt.includes('FILES TO EDIT')) {
        return {
          content: [
            {
              text: `FILE: src/api/server.js
const express = require('express');
const app = express();
module.exports = app;`,
            },
          ],
        };
      }

      if (prompt.includes('Review this diff')) {
        return {
          content: [{ text: JSON.stringify({ approved: true, comment: 'Looks good.' }) }],
        };
      }

      return { content: [{ text: '{}' }] };
    }),
  },
};

function setInputs(inputs: Record<string, string>) {
  const core = require('@actions/core');
  core.getInput.mockImplementation((name: string) => inputs[name]);
}

function setContext({
  owner = 'acme',
  repo = 'repo',
  ref = 'refs/heads/main',
  workflow = 'orchestrator.yml',
  payload = {},
}: {
  owner?: string;
  repo?: string;
  ref?: string;
  workflow?: string;
  payload?: any;
} = {}) {
  const github = require('@actions/github');
  github.context.repo = { owner, repo };
  github.context.ref = ref;
  github.context.workflow = workflow;
  github.context.payload = payload;
  github.getOctokit.mockReturnValue(mockOctokit);
}

function resetState(rootPath?: string) {
  state.prs = [];
  state.dispatches = [];
  state.branches = ['main'];
  state.fileSystemRoot = rootPath || '';
  if (rootPath) {
    fs.emptyDirSync(rootPath);
  }
}

function setupAnthropicMock() {
  const Anthropic = require('@anthropic-ai/sdk');
  Anthropic.mockImplementation(() => mockAnthropic);
}

export { state, mockOctokit, mockAnthropic, setInputs, setContext, resetState, setupAnthropicMock };
