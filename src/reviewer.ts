import * as core from '@actions/core';
import * as github from '@actions/github';
import Anthropic from '@anthropic-ai/sdk';
import { getOctokit } from './utils';

async function run() {
  const octokit = getOctokit();
  const anthropicKey = core.getInput('anthropic_key');
  const context = github.context;
  const pr = (context.payload as any)?.pull_request;

  if (!pr || !pr.title?.startsWith('AI:')) {
    console.log('No AI PR to review. Skipping.');
    return;
  }

  console.log(`Architect reviewing PR #${pr.number}: ${pr.title}`);

  const diff =
    process.env.NODE_ENV === 'test'
      ? { data: 'diff --git a/file b/file' }
      : await octokit.rest.pulls.get({
          owner: context.repo.owner,
          repo: context.repo.repo,
          pull_number: pr.number,
          mediaType: { format: 'diff' },
        });

  let review;
  if (process.env.NODE_ENV === 'test') {
    review = { approved: true, comment: 'Looks good.' };
  } else {
    const baseUrl = core.getInput('base_url');
    const anthropicOptions: any = { apiKey: anthropicKey };
    if (baseUrl) {
      anthropicOptions.baseURL = baseUrl;
    }
    const anthropic = new Anthropic(anthropicOptions);
    const prompt = `
      You are a Code Reviewer.
      Review this diff. Does it accomplish the goal in the title?
      Are there syntax errors?

      Diff:
      ${diff?.data || ''}

      Output JSON:
      { "approved": true, "comment": "Looks good." } 
      OR 
      { "approved": false, "comment": "Fix syntax error on line 5." }
    `;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    try {
      const text = (msg as any)?.content?.[0]?.text || '{}';
      // Extract JSON from markdown code blocks if present
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
      const jsonText = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text;
      review = JSON.parse(jsonText.trim());
    } catch {
      review = { approved: false, comment: 'Unable to parse review response.' };
    }
  }

  if (review.approved) {
    console.log('Approving and Merging...');
    await octokit.rest.pulls.merge({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number,
      merge_method: 'squash',
    });
    await checkUpstreamPR(octokit, context, pr.base.ref);
  } else {
    console.log('Rejecting PR...');
    await octokit.rest.pulls.createReview({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number,
      body: review.comment || 'Changes requested.',
      event: 'REQUEST_CHANGES',
    });
  }
}

async function checkUpstreamPR(octokit: ReturnType<typeof getOctokit>, context: typeof github.context, featureBranch: string) {
  if (featureBranch === 'main') return;

  const existingPrs =
    (await octokit?.rest?.pulls?.list({
      owner: context.repo.owner,
      repo: context.repo.repo,
      head: `${context.repo.owner}:${featureBranch}`,
      base: 'main',
    })) || { data: [] };

  if (existingPrs.data.length === 0) {
    const payload = {
      owner: context.repo.owner,
      repo: context.repo.repo,
      title: `Director Review: ${featureBranch}`,
      head: featureBranch,
      base: 'main',
      body: 'Subsystem implementation ready for review.',
    };

    if (process.env.NODE_ENV === 'test' && (global as any).__TEST_STATE) {
      (global as any).__TEST_STATE.prs.push(payload);
      return;
    }

    if (octokit?.rest?.pulls?.create) {
      await octokit.rest.pulls.create(payload);
    }
  }
}

export { run };
