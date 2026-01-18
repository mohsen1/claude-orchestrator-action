import * as core from '@actions/core';
import * as github from '@actions/github';
import fs from 'fs-extra';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { getOctokit, parseJsonSafe } from './utils';

async function run() {
  const goal = core.getInput('goal');
  const parentBranch = core.getInput('parent_branch') || 'main';
  const taskContext = core.getInput('task_context');
  const task = parseJsonSafe<{ files?: string[] }>(taskContext, {});
  const files = task.files || [];

  if (files.length === 0) {
    console.log('No files to edit. Skipping worker.');
    return;
  }

  const anthropic = new Anthropic({ apiKey: core.getInput('anthropic_key') });
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
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    responseText =
      msg?.content?.[0]?.text?.trim() ||
      `FILE: ${files[0]}
console.log('placeholder');`;
  }
  await writeFilesFromResponse(files, responseText);

  await openPullRequest({
    goal,
    parentBranch,
    body: taskContext,
  });
}

async function writeFilesFromResponse(files: string[], responseText: string) {
  const map = extractFileContents(responseText);
  for (const file of files) {
    const content = map[file] || responseText;
    const targetPath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    await fs.ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, content.trim() + '\n');
    console.log(`Wrote file ${targetPath}`);
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

async function openPullRequest({ goal, parentBranch, body }: { goal: string; parentBranch: string; body?: string }) {
  const octokit = getOctokit();
  const context = github.context;
  const headBranch = context.ref?.replace('refs/heads/', '') || 'main';

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
