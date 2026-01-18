import path from 'path';
import fs from 'fs-extra';
import { dir as tmpDir } from 'tmp-promise';
import { run as directorRun } from '../src/director';
import { run as architectRun } from '../src/architect';
import { run as workerRun } from '../src/worker';
import { run as reviewerRun } from '../src/reviewer';
import { state, setInputs, setContext, resetState, setupAnthropicMock } from './mocks';

jest.mock('@actions/core', () => ({ getInput: jest.fn(), setFailed: jest.fn() }));
jest.mock('@actions/github', () => ({
  context: { repo: { owner: '', repo: '' }, ref: '', workflow: '', payload: {} },
  getOctokit: jest.fn(),
}));
jest.mock('@anthropic-ai/sdk', () => jest.fn());
jest.mock('@actions/exec', () => ({
  exec: jest.fn((cmd: string, args: string[], options?: any) => {
    // Mock git status to return nothing (no changes)
    if (cmd === 'git' && args?.[0] === 'status') {
      options?.listeners?.stdout?.(Buffer.from(''));
    }
    return Promise.resolve(0);
  }),
}));

describe('Virtual GitHub Simulator', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let originalCwd: string;

  beforeEach(async () => {
    tmp = await tmpDir({ unsafeCleanup: true });
    originalCwd = process.cwd();
    process.chdir(tmp.path);
    resetState(tmp.path);
    (global as any).__TEST_STATE = state;
    setupAnthropicMock();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await tmp.cleanup();
    jest.clearAllMocks();
  });

  test('director dispatches architects for subsystems', async () => {
    setInputs({
      role: 'director',
      goal: 'Build product',
      anthropic_key: 'test',
      github_token: 'gh',
    });
    setContext();

    await directorRun();

    expect(state.dispatches[0].inputs.role).toBe('architect');
    expect(state.branches).toContain('feature/backend');
  });

  test('architect dispatches workers with task context', async () => {
    setInputs({
      role: 'architect',
      goal: 'Setup API',
      scope_path: 'src/api',
      anthropic_key: 'test',
      github_token: 'gh',
    });
    setContext({ ref: 'refs/heads/feature/backend' });

    await architectRun();

    expect(state.dispatches[0].inputs.role).toBe('worker');
    expect(state.dispatches[0].inputs.task_context).toContain('task_1');
  });

  test('worker writes files and opens PR to parent branch', async () => {
    const taskContext = JSON.stringify({
      id: 'task_1',
      files: ['src/api/server.js'],
      description: 'Create server',
    });

    setInputs({
      role: 'worker',
      goal: 'Create server',
      parent_branch: 'feature/backend',
      scope_path: 'src/api',
      task_context: taskContext,
      anthropic_key: 'test',
      github_token: 'gh',
    });
    setContext({ ref: 'refs/heads/task/backend-api-01' });

    await workerRun();

    const filePath = path.join(process.cwd(), 'src/api/server.js');
    expect(await fs.pathExists(filePath)).toBe(true);
    const contents = await fs.readFile(filePath, 'utf8');
    expect(contents).toContain('express');
    expect(state.prs[0].base).toBe('feature/backend');
  });

  test('reviewer merges worker PR and ensures upstream PR exists', async () => {
    state.prs.push({
      title: 'AI: Create server',
      head: 'task/backend-api-01',
      base: 'feature/backend',
    });

    setInputs({
      role: 'reviewer',
      anthropic_key: 'test',
      github_token: 'gh',
    });
    setContext({
      ref: 'refs/heads/feature/backend',
      payload: {
        pull_request: {
          number: 1,
          title: 'AI: Create server',
          base: { ref: 'feature/backend' },
          head: { ref: 'task/backend-api-01' },
        },
      },
    });

    await reviewerRun();

    expect(state.prs.find((pr) => pr.title?.startsWith('Director Review'))).toBeTruthy();
  });
});
