/** Stable identity for report-only open questions. */
import { createHash } from "node:crypto";
import { normalizeText } from "./token-utils.js";
export const OPEN_QUESTION_ID_PATTERN = /^oq-[a-f0-9]{12}$/;
/** The question text is the only identity input; round and spelling do not
 * change the id. Relationships remain normalized-exact, never fuzzy. */
export function deriveOpenQuestionId(text) {
    const key = normalizeText(text);
    return `oq-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}
export function isOpenQuestionId(value) {
    return OPEN_QUESTION_ID_PATTERN.test(value);
}
//# sourceMappingURL=open-question.js.map