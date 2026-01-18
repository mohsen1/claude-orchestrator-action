import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import fs from 'fs-extra';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { getOctokit, parseJsonSafe, createBranch } from './utils';

async function run() {
  const goal = core.getInput('goal');
  const parentBranch = core.getInput('parent_branch') || 'main';
  const taskContext = core.getInput('task_context');
  const task = parseJsonSafe<{ id?: string; files?: string[] }>(taskContext, {});
  const files = task.files || [];

  if (files.length === 0) {
    console.log('No files to edit. Skipping worker.');
    return;
  }

  // Create a unique branch for this worker's changes
  const taskId = task.id || 'task';
  const timestamp = Date.now().toString(36);
  const branchName = `worker-${taskId}-${timestamp}`;
  console.log(`Creating worker branch: ${branchName}`);
  await createBranch(branchName, parentBranch);

  const apiKey = core.getInput('anthropic_key');
  const baseUrl = core.getInput('base_url');
  const anthropicOptions: any = { apiKey };
  if (baseUrl) {
    anthropicOptions.baseURL = baseUrl;
  }
  const anthropic = new Anthropic(anthropicOptions);
  const prompt = `
    You are a code worker.
    GOAL: ${goal}
    FILES TO EDIT:
    ${files.join('\n')}

    Provide full file contents for the files above. If multiple files are needed, prefix each section with "FILE: <path>".
  `;

  let responseText: string;

  if (process.env.NODE_ENV === 'test') {
    responseText = `FILE: ${files[0]}
const express = require('express');
const app = express();
module.exports = app;`;
  } else {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    responseText =
      msg?.content?.[0]?.text?.trim() ||
      `FILE: ${files[0]}
console.log('placeholder');`;
  }
  await writeFilesFromResponse(files, responseText);

  // Commit the files to git
  await commitFiles(branchName, goal);

  await openPullRequest({
    goal,
    parentBranch,
    body: taskContext,
    branchName,
  });
}

async function writeFilesFromResponse(files: string[], responseText: string) {
  const map = extractFileContents(responseText);
  for (const file of files) {
    if (!(file in map)) {
      console.log(`Warning: No content found for ${file} in response`);
      continue;
    }
    const content = map[file];
    const targetPath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    await fs.ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, content.trim() + '\n');
    console.log(`Wrote file ${targetPath}`);
  }
}

async function commitFiles(branchName: string, goal: string) {
  try {
    // Configure git
    await exec.exec('git', ['config', 'user.name', 'github-actions[bot]']);
    await exec.exec('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);

    // Check if there are any changes to commit
    let statusOutput = '';
    await exec.exec('git', ['status', '--porcelain'], {
      listeners: {
        stdout: (data: Buffer) => {
          statusOutput += data.toString();
        },
      },
    });

    if (!statusOutput.trim()) {
      console.log('No changes to commit');
      return;
    }

    // Add all changes
    await exec.exec('git', ['add', '-A']);

    // Commit with the goal as the message
    const commitMessage = `AI: ${goal}`;
    await exec.exec('git', ['commit', '-m', commitMessage]);

    // Push the branch
    await exec.exec('git', ['push', '-u', 'origin', branchName]);

    console.log(`Committed and pushed changes to ${branchName}`);
  } catch (error) {
    console.error(`Error committing files: ${error}`);
    throw error;
  }
}

function extractFileContents(text: string) {
  const result: Record<string, string> = {};
  const regex = /FILE:\s*([^\n]+)\n([\s\S]*?)(?=FILE:|$)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    result[match[1].trim()] = match[2].trim();
  }
  return result;
}

async function openPullRequest({
  goal,
  parentBranch,
  body,
  branchName,
}: {
  goal: string;
  parentBranch: string;
  body?: string;
  branchName?: string;
}) {
  const octokit = getOctokit();
  const context = github.context;
  const headBranch = branchName || context.ref?.replace('refs/heads/', '') || 'main';

  const payload = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    title: `AI: ${goal}`,
    head: headBranch,
    base: parentBranch,
    body: body || 'Automated worker output.',
  };

  if (process.env.NODE_ENV === 'test' && (global as any).__TEST_STATE) {
    (global as any).__TEST_STATE.prs.push(payload);
  }

  if (octokit?.rest?.pulls?.create) {
    await octokit.rest.pulls.create(payload);
  }
}

export { run };
