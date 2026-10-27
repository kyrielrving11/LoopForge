/** Stable identity for report-only open questions. */
export declare const OPEN_QUESTION_ID_PATTERN: RegExp;
/** The question text is the only identity input; round and spelling do not
 * change the id. Relationships remain normalized-exact, never fuzzy. */
export declare function deriveOpenQuestionId(text: string): string;
export declare function isOpenQuestionId(value: string): boolean;
//# sourceMappingURL=open-question.d.ts.map