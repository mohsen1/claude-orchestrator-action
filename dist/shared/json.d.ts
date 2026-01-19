/**
 * JSON parsing utilities for LLM outputs
 * Provides robust extraction with multiple fallback strategies
 */
/**
 * Extract JSON from LLM output with multiple fallback strategies
 * @param output - Raw LLM output
 * @returns Parsed JSON object
 * @throws Error if JSON cannot be extracted or parsed
 */
export declare function extractJson(output: string): any;
/**
 * Safely parse JSON with fallback error message
 * @param jsonStr - JSON string to parse
 * @param context - Context for error messages
 * @returns Parsed object
 */
export declare function safeJsonParse(jsonStr: string, context?: string): any;
//# sourceMappingURL=json.d.ts.map