/** The ONE actionable instruction table for verification checks.
 *
 *  Kept separate from the prompt assembler so the evaluation-field guidance
 *  can quote the same action without depending on a renderer. Keys are the
 *  plain check-name strings (NOT imported from verification-gate.ts — it
 *  already imports loop-compiler, which imports the prompt layer, so
 *  importing back would cycle). Full coverage of every CHECK_* constant is
 *  enforced by a test that iterates the verification-gate module's CHECK_
 *  exports; a new constant can never silently lack an action entry.
 */
export declare const VERIFICATION_ACTIONS: Readonly<Record<string, string>>;
export declare function verificationActionFor(check: string): string;
//# sourceMappingURL=verification-actions.d.ts.map