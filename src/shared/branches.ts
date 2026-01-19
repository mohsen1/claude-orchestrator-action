// Branch naming utilities for the orchestrator
// Format: cco/{issue_number}-{slug} for Director
//         cco/{issue_number}-{slug}-em{id} for EM
//         cco/{issue_number}-{slug}-em{id}-w{id} for Worker

const MAX_SLUG_LENGTH = 50;

/**
 * Convert an issue title to a URL-friendly slug
 * - Convert to lowercase
 * - Replace spaces with hyphens
 * - Remove special characters
 * - Truncate to MAX_SLUG_LENGTH
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    // Replace spaces and underscores with hyphens
    .replace(/[\s_]+/g, '-')
    // Remove special characters except hyphens
    .replace(/[^a-z0-9-]/g, '')
    // Remove consecutive hyphens
    .replace(/-+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    // Truncate to max length
    .substring(0, MAX_SLUG_LENGTH);
}

/**
 * Generate the Director work branch name
 * @param issueNumber - The GitHub issue number
 * @param slug - Slugified issue title
 * @returns Branch name in format: cco/{issue}-{slug}
 */
export function getDirectorBranch(issueNumber: number, slug: string): string {
  return `cco/${issueNumber}-${slug}`;
}

/**
 * Generate an EM branch name
 * @param directorBranch - The Director's work branch name
 * @param emId - The EM ID
 * @returns Branch name in format: {directorBranch}-em{id}
 */
export function getEmBranch(directorBranch: string, emId: number): string {
  return `${directorBranch}-em${emId}`;
}

/**
 * Generate a Worker branch name
 * @param emBranch - The EM's branch name
 * @param workerId - The Worker ID
 * @returns Branch name in format: {emBranch}-w{id}
 */
export function getWorkerBranch(emBranch: string, workerId: number): string {
  return `${emBranch}-w${workerId}`;
}

/**
 * Parsed component information from a branch name
 */
export interface ParsedComponent {
  type: 'director' | 'em' | 'worker' | null;
  issueNumber: number | null;
  emId: number | null;
  workerId: number | null;
}

/**
 * Parse a branch name to extract component information
 * Supports formats:
 * - cco/{issue}-{slug} -> Director
 * - cco/{issue}-{slug}-em{id} -> EM
 * - cco/{issue}-{slug}-em{id}-w{id} -> Worker
 * @param branch - The branch name to parse
 * @returns Parsed component information
 */
export function parseComponentFromBranch(branch: string): ParsedComponent {
  const result: ParsedComponent = {
    type: null,
    issueNumber: null,
    emId: null,
    workerId: null
  };

  // Check if this is an orchestrator branch
  if (!branch.startsWith('cco/')) {
    return result;
  }

  // Remove 'cco/' prefix
  const branchPart = branch.substring(4);

  // Parse issue number (first number after 'cco/')
  const issueMatch = branchPart.match(/^(\d+)/);
  if (!issueMatch) {
    return result;
  }
  result.issueNumber = parseInt(issueMatch[1], 10);

  // Check for EM suffix: -em{id}
  const emMatch = branchPart.match(/-em(\d+)/);
  if (emMatch) {
    result.emId = parseInt(emMatch[1], 10);
    result.type = 'em';

    // Check for Worker suffix: -w{id}
    const workerMatch = branchPart.match(/-w(\d+)$/);
    if (workerMatch) {
      result.workerId = parseInt(workerMatch[1], 10);
      result.type = 'worker';
    }
  } else {
    result.type = 'director';
  }

  return result;
}

/**
 * Validate that a branch name follows the expected format
 * @param branch - The branch name to validate
 * @returns true if valid, false otherwise
 */
export function isValidOrchestratorBranch(branch: string): boolean {
  const parsed = parseComponentFromBranch(branch);
  return parsed.type !== null && parsed.issueNumber !== null;
}

/**
 * Extract the base branch from a component branch
 * - For EM: returns Director branch
 * - For Worker: returns EM branch
 * - For Director: returns 'main'
 * @param branch - The branch name
 * @returns The base branch name
 */
export function getBaseBranch(branch: string): string {
  const parsed = parseComponentFromBranch(branch);

  if (parsed.type === 'worker') {
    // Worker -> EM
    const workerMatch = branch.match(/^(.*-w\d+)$/);
    if (workerMatch) {
      const emBranch = workerMatch[1].replace(/-w\d+$/, '');
      return emBranch;
    }
  } else if (parsed.type === 'em') {
    // EM -> Director
    const emMatch = branch.match(/^(.*-em\d+)$/);
    if (emMatch) {
      const directorBranch = emMatch[1].replace(/-em\d+$/, '');
      return directorBranch;
    }
  }

  // Director or unknown -> main
  return 'main';
}
