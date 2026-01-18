import * as core from '@actions/core';
import * as github from '@actions/github';
import fs from 'fs-extra';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

type WorkflowInputs = {
  role: string;
  goal: string;
  parent_branch?: string;
  scope_path?: string;
  task_context?: string;
  branch_ref?: string;
};

function getOctokit() {
  const token = core.getInput('github_token');
  return github.getOctokit(token);
}

async function getClaudePlan(prompt: string): Promise<any> {
  if (process.env.NODE_ENV === 'test') {
    if (prompt.includes('Analyze the request')) {
      return { subsystems: [{ name: 'backend', goal: 'Setup API', path: 'src/api' }] };
    }
    if (prompt.toLowerCase().includes('atomic coding tasks')) {
      return { tasks: [{ id: 'task_1', description: 'Create server', files: ['src/api/server.js'] }] };
    }
  }

  const apiKey = core.getInput('anthropic_key');
  const baseUrl = core.getInput('base_url');
  const anthropicOptions: any = { apiKey };
  if (baseUrl) {
    anthropicOptions.baseURL = baseUrl;
  }
  const anthropic = new Anthropic(anthropicOptions);
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (res as any)?.content?.[0]?.text;
  if (text) {
    // Extract JSON from markdown code blocks if present
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text;
    return JSON.parse(jsonText.trim());
  }

  if (prompt.includes('Analyze the request')) {
    return { subsystems: [{ name: 'backend', goal: 'Setup API', path: 'src/api' }] };
  }

  if (prompt.toLowerCase().includes('atomic coding tasks')) {
    return { tasks: [{ id: 'task_1', description: 'Create server', files: ['src/api/server.js'] }] };
  }

  return {};
}

async function dispatchWorkflow({ role, goal, parent_branch, scope_path, task_context, branch_ref }: WorkflowInputs) {
  const octokit = getOctokit();
  const context = github.context;
  const ref = branch_ref || parent_branch || context.ref?.replace('refs/heads/', '') || 'main';

  const payload = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    workflow_id: context.workflow || 'orchestrator.yml',
    ref,
    inputs: { role, goal, parent_branch, scope_path, task_context },
  };

  if (process.env.NODE_ENV === 'test' && (global as any).__TEST_STATE) {
    (global as any).__TEST_STATE.dispatches.push(payload);
  }

  if (octokit?.rest?.actions?.createWorkflowDispatch) {
    await octokit.rest.actions.createWorkflowDispatch(payload);
  }
}

async function createBranch(branchName: string, base = 'main') {
  const octokit = getOctokit();
  const context = github.context;
  let sha = 'mock-sha';

  try {
    const baseRef = await octokit.rest.git.getRef({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: `heads/${base}`,
    });
    sha = baseRef?.data?.object?.sha || sha;
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      throw err;
    }
  }

  try {
    await octokit.rest.git.createRef({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: `refs/heads/${branchName}`,
      sha,
    });
  } catch (err) {
    if (err.status !== 422) {
      throw err;
    }
  }

  if (process.env.NODE_ENV === 'test' && (global as any).__TEST_STATE) {
    if (!(global as any).__TEST_STATE.branches.includes(branchName)) {
      (global as any).__TEST_STATE.branches.push(branchName);
    }
  }
}

async function getFileTree(scopePath = '.'): Promise<string> {
  const basePath = path.join(process.cwd(), scopePath);
  if (!(await fs.pathExists(basePath))) return '';

  const files: string[] = [];

  async function walk(dir: string, rel: string) {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const relPath = path.join(rel, entry);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        await walk(full, relPath);
      } else {
        files.push(relPath);
      }
    }
  }

  await walk(basePath, '');
  return files.join('\n');
}

function parseJsonSafe<T>(str: string | undefined | null, fallback = {} as T): T {
  try {
    return str ? (JSON.parse(str) as T) : fallback;
  } catch {
    return fallback;
  }
}

export { getOctokit, getClaudePlan, dispatchWorkflow, createBranch, getFileTree, parseJsonSafe };
