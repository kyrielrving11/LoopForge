export interface TransactionIdentityExpectation {
    loopId: string;
    round: number;
    schemaVersion?: number;
    transactionId?: string;
}
/** Validate that a stored transaction belongs to its containing Vault entry. */
export declare function transactionIdentityIssue(entry: unknown, expected?: TransactionIdentityExpectation): string | null;
//# sourceMappingURL=transaction-identity.d.ts.map