/**
 * Convert an issue title to a URL-friendly slug
 * - Convert to lowercase
 * - Replace spaces with hyphens
 * - Remove special characters
 * - Truncate to MAX_SLUG_LENGTH
 */
export declare function slugify(title: string): string;
/**
 * Generate the Director work branch name
 * @param issueNumber - The GitHub issue number
 * @param slug - Slugified issue title
 * @returns Branch name in format: cco/{issue}-{slug}
 */
export declare function getDirectorBranch(issueNumber: number, slug: string): string;
/**
 * Generate an EM branch name
 * @param directorBranch - The Director's work branch name
 * @param emId - The EM ID
 * @returns Branch name in format: {directorBranch}-em{id}
 */
export declare function getEmBranch(directorBranch: string, emId: number): string;
/**
 * Generate a Worker branch name
 * @param emBranch - The EM's branch name
 * @param workerId - The Worker ID
 * @returns Branch name in format: {emBranch}-w{id}
 */
export declare function getWorkerBranch(emBranch: string, workerId: number): string;
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
export declare function parseComponentFromBranch(branch: string): ParsedComponent;
/**
 * Validate that a branch name follows the expected format
 * @param branch - The branch name to validate
 * @returns true if valid, false otherwise
 */
export declare function isValidOrchestratorBranch(branch: string): boolean;
/**
 * Extract the base branch from a component branch
 * - For EM: returns Director branch
 * - For Worker: returns EM branch
 * - For Director: returns 'main'
 * @param branch - The branch name
 * @returns The base branch name
 */
export declare function getBaseBranch(branch: string): string;
//# sourceMappingURL=branches.d.ts.map