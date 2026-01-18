jest.mock('@actions/core', () => ({ getInput: jest.fn(), setFailed: jest.fn() }));
jest.mock('@actions/github', () => ({
  context: { repo: { owner: '', repo: '' }, ref: '', workflow: '', payload: {} },
  getOctokit: jest.fn(),
}));
jest.mock('@anthropic-ai/sdk', () => jest.fn());

const path = require('path');
const fs = require('fs-extra');
const { dir: tmpDir } = require('tmp-promise');
const director = require('../src/director');
const architect = require('../src/architect');
const worker = require('../src/worker');
const reviewer = require('../src/reviewer');
const { state, setInputs, setContext, resetState, setupAnthropicMock } = require('./mocks');

describe('Virtual GitHub Simulator', () => {
  let tmp;
  let originalCwd;

  beforeEach(async () => {
    tmp = await tmpDir({ unsafeCleanup: true });
    originalCwd = process.cwd();
    process.chdir(tmp.path);
    resetState(tmp.path);
    global.__TEST_STATE = state;
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

    await director.run();

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

    await architect.run();

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

    await worker.run();

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
        },
      },
    });

    await reviewer.run();

    expect(state.prs.find((pr) => pr.title?.startsWith('Director Review'))).toBeTruthy();
  });
});
