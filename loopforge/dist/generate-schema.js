#!/usr/bin/env node
/** Generate JSON Schema (draft 2020-12) from protocol.ts TypeScript definitions.
 *
 * Uses the TypeScript Compiler API to parse type declarations and emit a
 * self-consistent JSON Schema. The generated schema is the single source of
 * truth for the wire protocol — it is regenerated on every build.
 *
 * Usage: node dist/generate-schema.js
 *   or:  npx tsx src/generate-schema.ts   (during development)
 */
import * as ts from "typescript";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
// ═══════════════════════════════════════════════════════════════════════════
// JSDoc extraction
// ═══════════════════════════════════════════════════════════════════════════
function getNodeDescription(node) {
    const jsDocs = ts.getJSDocCommentsAndTags(node);
    if (!jsDocs || jsDocs.length === 0)
        return undefined;
    const first = jsDocs[0];
    if (ts.isJSDoc(first)) {
        if (typeof first.comment === "string")
            return first.comment.trim();
        if (Array.isArray(first.comment)) {
            return first.comment.map((t) => t.text).join("").trim();
        }
    }
    return undefined;
}
// ═══════════════════════════════════════════════════════════════════════════
// Enum conversion
// ═══════════════════════════════════════════════════════════════════════════
function convertEnum(node) {
    const values = [];
    for (const member of node.members) {
        const init = member.initializer;
        if (init && ts.isStringLiteral(init)) {
            values.push(init.text);
        }
        else {
            // Numeric or computed — fall back to member name
            values.push(member.name.getText());
        }
    }
    const result = {
        type: "string",
        enum: values,
    };
    const desc = getNodeDescription(node);
    if (desc)
        result.description = desc;
    return result;
}
// ═══════════════════════════════════════════════════════════════════════════
// Type node conversion (core recursive dispatcher)
// ═══════════════════════════════════════════════════════════════════════════
function convertTypeNode(typeNode, checker) {
    // Primitives
    if (typeNode.kind === ts.SyntaxKind.StringKeyword)
        return { type: "string" };
    if (typeNode.kind === ts.SyntaxKind.NumberKeyword)
        return { type: "number" };
    if (typeNode.kind === ts.SyntaxKind.BooleanKeyword)
        return { type: "boolean" };
    // Arrays: T[]
    if (ts.isArrayTypeNode(typeNode)) {
        const elementType = convertTypeNode(typeNode.elementType, checker);
        return { type: "array", items: elementType };
    }
    // Union types: T | null, A | B, etc.
    if (ts.isUnionTypeNode(typeNode)) {
        const types = typeNode.types;
        // null in TS AST: LiteralType wrapping NullKeyword
        const nullIndex = types.findIndex((t) => t.kind === ts.SyntaxKind.NullKeyword ||
            t.kind === ts.SyntaxKind.UndefinedKeyword ||
            (ts.isLiteralTypeNode(t) &&
                (t.literal.kind === ts.SyntaxKind.NullKeyword ||
                    t.literal.kind === ts.SyntaxKind.UndefinedKeyword)));
        const nonNull = types.filter((_, i) => i !== nullIndex);
        // Simple `T | null` or `T | undefined`
        if (nullIndex >= 0 && nonNull.length === 1) {
            const inner = convertTypeNode(nonNull[0], checker);
            // `{ type: [T, "null"] }` can only carry `type`. A $ref cannot sit
            // beside it, and an inline object would lose its properties — which is
            // how `LoopProjection.focus` was published as "object or null" with no
            // shape at all. Only the bare-type case collapses; anything richer
            // states its two arms as anyOf.
            const bareType = inner.$ref === undefined && inner.type !== undefined &&
                Object.keys(inner).length === 1;
            if (bareType) {
                return { type: [inner.type, "null"] };
            }
            return { anyOf: [inner, { type: "null" }] };
        }
        // Multi-type union without simple null — anyOf
        const anyOf = [];
        for (const t of types) {
            const kind = t.kind;
            if (kind === ts.SyntaxKind.NullKeyword ||
                kind === ts.SyntaxKind.UndefinedKeyword) {
                anyOf.push({ type: "null" });
            }
            else if (ts.isLiteralTypeNode(t) &&
                (t.literal.kind === ts.SyntaxKind.NullKeyword ||
                    t.literal.kind === ts.SyntaxKind.UndefinedKeyword)) {
                anyOf.push({ type: "null" });
            }
            else {
                anyOf.push(convertTypeNode(t, checker));
            }
        }
        return { anyOf };
    }
    // Type references: InterfaceName, EnumName, Record<K,V>, Array<T>
    if (ts.isTypeReferenceNode(typeNode)) {
        const sym = checker.getSymbolAtLocation(typeNode.typeName);
        if (sym) {
            const name = sym.getName();
            // Record<string, unknown> → object with additionalProperties
            if (name === "Record" && typeNode.typeArguments?.length === 2) {
                const valueType = typeNode.typeArguments[1];
                // unknown values → open object
                if (valueType.kind === ts.SyntaxKind.UnknownKeyword ||
                    valueType.kind === ts.SyntaxKind.AnyKeyword) {
                    return { type: "object", additionalProperties: true };
                }
                // Record<string, T> → object with additionalProperties: T
                const valSchema = convertTypeNode(valueType, checker);
                return { type: "object", additionalProperties: valSchema };
            }
            // Array<T> (generic form)
            if (name === "Array" && typeNode.typeArguments?.length === 1) {
                const elementType = convertTypeNode(typeNode.typeArguments[0], checker);
                return { type: "array", items: elementType };
            }
            // Resolve to known $defs name
            const declarations = sym.getDeclarations();
            if (declarations?.length) {
                const decl = declarations[0];
                if (ts.isInterfaceDeclaration(decl) || ts.isEnumDeclaration(decl)) {
                    return { $ref: `#/$defs/${decl.name.text}` };
                }
                if (ts.isTypeAliasDeclaration(decl)) {
                    // Function type aliases (e.g. AgentExecutor) can't be represented
                    // in JSON Schema — return a descriptive placeholder instead of
                    // a dangling $ref to a non-existent definition.
                    if (decl.type.kind === ts.SyntaxKind.FunctionType ||
                        (ts.isUnionTypeNode(decl.type) &&
                            decl.type.types.some((t) => t.kind === ts.SyntaxKind.FunctionType))) {
                        return {
                            description: `Function signature: ${name}. Omitted from JSON Schema.`,
                        };
                    }
                    // Non-function type alias — $ref to definition
                    return { $ref: `#/$defs/${decl.name.text}` };
                }
            }
            // Fallback: use symbol name as $ref
            return { $ref: `#/$defs/${name}` };
        }
        // Unresolved type reference — fallback to type name text
        const typeName = typeNode.typeName.getText();
        if (typeName === "Record" || typeName === "Array") {
            return { type: "object" };
        }
        return { type: "string" }; // safest fallback
    }
    // Inline object type: { a: string; b?: number }. These used to fall through
    // to the `{ type: "string" }` catch-all, so every inline shape in the
    // protocol (the projection's focus/phase/delegation/handoff, the todo list,
    // the reported test counts, the capability rows) was published as a string.
    if (ts.isTypeLiteralNode(typeNode)) {
        const properties = {};
        const required = [];
        for (const member of typeNode.members) {
            if (!ts.isPropertySignature(member))
                continue;
            const name = member.name.getText();
            if (!member.questionToken && !typeIncludesNull(member.type))
                required.push(name);
            properties[name] = member.type
                ? convertTypeNode(member.type, checker)
                : { type: "string" };
        }
        const out = { type: "object", properties };
        if (required.length > 0)
            out.required = required;
        return out;
    }
    // `typeof CONST` — a pinned literal. The published schema used to call
    // PROMPT_ARTIFACT_SCHEMA_VERSION a string, so a client generated from it
    // serialized a String where the runtime requires the number and hard-breaks
    // the whole round envelope. The source keeps ONE version source (the
    // constant); the generator reads it.
    if (ts.isTypeQueryNode(typeNode)) {
        const sym = checker.getSymbolAtLocation(typeNode.exprName);
        const decl = sym?.getDeclarations()?.[0];
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
            // `= 2 as const` (and a bare parenthesized/asserted literal): the
            // assertion narrows the TYPE, but the VALUE is what the wire contract
            // pins, so unwrap to the literal.
            let init = decl.initializer;
            while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init) ||
                ts.isTypeAssertionExpression(init) || ts.isSatisfiesExpression(init)) {
                init = init.expression;
            }
            if (ts.isNumericLiteral(init))
                return { type: "number", const: Number(init.text) };
            if (ts.isStringLiteral(init))
                return { type: "string", const: init.text };
            if (init.kind === ts.SyntaxKind.TrueKeyword)
                return { type: "boolean", const: true };
            if (init.kind === ts.SyntaxKind.FalseKeyword)
                return { type: "boolean", const: false };
        }
        return unrepresentable(`typeof ${typeNode.exprName.getText()}`);
    }
    // Intersection — JSON Schema's `allOf` says the same thing.
    if (ts.isIntersectionTypeNode(typeNode)) {
        return { allOf: typeNode.types.map((part) => convertTypeNode(part, checker)) };
    }
    // Tuple — a positional array.
    if (ts.isTupleTypeNode(typeNode)) {
        const elements = typeNode.elements.map((element) => convertTypeNode(element, checker));
        return { type: "array", items: elements.length === 1 ? elements[0] : { anyOf: elements } };
    }
    // `readonly T[]` erases to the array; any other operator (`keyof`, `unique`)
    // has no JSON shape.
    if (ts.isTypeOperatorNode(typeNode)) {
        if (typeNode.operator === ts.SyntaxKind.ReadonlyKeyword) {
            return convertTypeNode(typeNode.type, checker);
        }
        return unrepresentable(`type operator ${ts.SyntaxKind[typeNode.operator]}`);
    }
    // `any` / `unknown` constrain nothing; `object` is any non-primitive.
    if (typeNode.kind === ts.SyntaxKind.AnyKeyword ||
        typeNode.kind === ts.SyntaxKind.UnknownKeyword) {
        return {};
    }
    if (typeNode.kind === ts.SyntaxKind.ObjectKeyword)
        return { type: "object" };
    // Literal types: 'foo' | 'bar'
    if (ts.isLiteralTypeNode(typeNode)) {
        const literal = typeNode.literal;
        if (ts.isStringLiteral(literal)) {
            return { type: "string", enum: [literal.text] };
        }
        if (ts.isNumericLiteral(literal)) {
            return { type: "number" };
        }
    }
    // Parenthesized type: (T)
    if (ts.isParenthesizedTypeNode(typeNode)) {
        return convertTypeNode(typeNode.type, checker);
    }
    // Anything left either cannot be a JSON value at all, or is a gap in this
    // converter — and those two must not look alike. A silent `{ type: "string" }`
    // is exactly how this generator dropped the inherited observation fields,
    // the inline objects and the envelope version. A function or a symbol is
    // RECORDED as an omission; anything else FAILS the build, so no future
    // protocol change can degrade the published contract unnoticed.
    return unrepresentable(ts.SyntaxKind[typeNode.kind]);
}
/** Node kinds with no JSON Schema counterpart. Recording the omission is the
 *  honest answer ("this cannot appear on the wire"); guessing a shape is not.
 *  Everything that reaches the catch-all and is NOT in this list is a
 *  converter gap, and throws instead. */
const NOT_REPRESENTABLE = new Set([
    "FunctionType",
    "SymbolKeyword",
    "UniqueKeyword",
    "NeverKeyword",
    "ConditionalType",
    "MappedType",
    "TemplateLiteralType",
    "IndexedAccessType",
    "TypePredicate",
    "ThisType",
    "ImportType",
]);
function unrepresentable(kind) {
    if (!NOT_REPRESENTABLE.has(kind)) {
        throw new Error(`generate-schema: type node "${kind}" has no branch in convertTypeNode. ` +
            "JSON Schema can express it, so the published protocol schema must too — " +
            "add the branch (or, if it truly cannot appear on the wire, add it to " +
            "NOT_REPRESENTABLE with the reason).");
    }
    process.stderr.write(`generate-schema: ${kind} is not representable in JSON Schema — recorded as a description.\n`);
    return { description: `Not representable in JSON Schema: ${kind}` };
}
// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
/** Collect every `#/$defs/<name>` reference in a schema subtree. */
function collectRefNames(node, out) {
    if (!node || typeof node !== "object")
        return;
    if (typeof node.$ref === "string") {
        const match = /^#\/\$defs\/(.+)$/.exec(node.$ref);
        if (match)
            out.add(match[1]);
    }
    if (node.properties) {
        for (const child of Object.values(node.properties))
            collectRefNames(child, out);
    }
    if (node.items)
        collectRefNames(node.items, out);
    if (Array.isArray(node.anyOf)) {
        for (const child of node.anyOf)
            collectRefNames(child, out);
    }
}
/** Convert one top-level statement into a $defs entry, when possible.
 *  Returns true when a definition was added. Mirrors the main pass so the
 *  cross-file sweep and the protocol.ts pass share one conversion path. */
function addStatementDef(stmt, checker, defs) {
    if (ts.isEnumDeclaration(stmt)) {
        defs[stmt.name.text] = convertEnum(stmt);
        return true;
    }
    if (ts.isInterfaceDeclaration(stmt)) {
        defs[stmt.name.text] = convertInterface(stmt, checker);
        return true;
    }
    if (!ts.isTypeAliasDeclaration(stmt))
        return false;
    const aliasType = stmt.type;
    if (aliasType.kind === ts.SyntaxKind.FunctionType) {
        return false; // Function signatures can't be represented in JSON Schema
    }
    if (ts.isUnionTypeNode(aliasType)) {
        const allStrings = aliasType.types.every((t) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal));
        if (allStrings) {
            defs[stmt.name.text] = {
                type: "string",
                enum: aliasType.types.map((t) => {
                    const lit = t;
                    if (ts.isStringLiteral(lit.literal))
                        return lit.literal.text;
                    return lit.literal.getText();
                }),
            };
            return true;
        }
        if (aliasType.types.some((t) => t.kind === ts.SyntaxKind.FunctionType)) {
            return false;
        }
    }
    try {
        const converted = convertTypeNode(stmt.type, checker);
        if (converted.$ref) {
            // A pure reference to another type — the target def (or a later sweep
            // round) owns the definition.
            return false;
        }
        defs[stmt.name.text] = converted;
        return true;
    }
    catch {
        // If conversion fails, skip — better a missing def than a broken schema.
        return false;
    }
}
/** Check if a type node includes null (T | null). */
function typeIncludesNull(typeNode) {
    if (!typeNode)
        return false;
    if (typeNode.kind === ts.SyntaxKind.NullKeyword ||
        typeNode.kind === ts.SyntaxKind.UndefinedKeyword) {
        return true;
    }
    if (ts.isUnionTypeNode(typeNode)) {
        return typeNode.types.some((t) => t.kind === ts.SyntaxKind.NullKeyword ||
            t.kind === ts.SyntaxKind.UndefinedKeyword ||
            (ts.isLiteralTypeNode(t) &&
                (t.literal.kind === ts.SyntaxKind.NullKeyword ||
                    t.literal.kind === ts.SyntaxKind.UndefinedKeyword)));
    }
    return false;
}
// ═══════════════════════════════════════════════════════════════════════════
// Interface conversion
// ═══════════════════════════════════════════════════════════════════════════
function convertInterface(node, checker) {
    const properties = {};
    const required = [];
    let hasIndexSignature = false;
    for (const member of node.members) {
        // Index signature: [key: string]: unknown
        if (ts.isIndexSignatureDeclaration(member)) {
            hasIndexSignature = true;
            continue;
        }
        if (!ts.isPropertySignature(member))
            continue;
        const propName = member.name.getText();
        // Optional properties (marked with ?) are NOT required.
        // Properties with T | null type are also treated as optional (JSON
        // has no distinction between absent and null in wire format).
        const isOptional = !!member.questionToken || typeIncludesNull(member.type);
        if (!isOptional) {
            required.push(propName);
        }
        if (member.type) {
            properties[propName] = convertTypeNode(member.type, checker);
        }
        else {
            properties[propName] = { type: "string" }; // untyped → assume string
        }
    }
    // v3.8.1: `extends` is part of the wire contract. Emitting only the own
    // members dropped every inherited field — a GitObservation lost
    // schemaVersion/providerId/phase/startedAt/finishedAt/status/files, exactly
    // the fields every observation must carry — and left the base definition
    // referenced by nothing. `allOf` states inheritance the way the types do:
    // the base is defined ONCE and composed, so a generated client reads
    // `MachineObservationBase & { kind: "git"; data: GitObservationData }`.
    const heritage = (node.heritageClauses ?? []).flatMap((clause) => clause.types);
    if (heritage.length > 0) {
        const branches = heritage.map((type) => {
            const expression = type.expression;
            const name = ts.isIdentifier(expression) ? expression.text : expression.getText();
            return { $ref: `#/$defs/${name}` };
        });
        if (Object.keys(properties).length > 0) {
            const own = { type: "object", properties };
            if (required.length > 0)
                own.required = required;
            branches.push(own);
        }
        const result = { allOf: branches };
        if (hasIndexSignature)
            result.additionalProperties = true;
        const desc = getNodeDescription(node);
        if (desc)
            result.description = desc;
        return result;
    }
    const result = {
        type: "object",
        properties,
    };
    if (required.length > 0)
        result.required = required;
    if (hasIndexSignature)
        result.additionalProperties = true;
    const desc = getNodeDescription(node);
    if (desc)
        result.description = desc;
    return result;
}
// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════
function generateSchema() {
    const srcPath = resolve(process.cwd(), "src/protocol.ts");
    const program = ts.createProgram([srcPath], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.Node16,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
    });
    const sourceFile = program.getSourceFile(srcPath);
    if (!sourceFile) {
        console.error(`ERROR: Could not find source file: ${srcPath}`);
        process.exit(1);
    }
    const checker = program.getTypeChecker();
    const defs = {};
    for (const stmt of sourceFile.statements) {
        addStatementDef(stmt, checker, defs);
    }
    // L5 (v3.7.x): cross-file references. convertTypeNode emits `$ref` for any
    // referenced interface/enum/alias, but the pass above only walks
    // protocol.ts — a type imported from a sibling module (historically
    // PresentedStateSnapshot from canonical-state.ts, deleted in v3.8.1) was
    // referenced but never defined, leaving a DANGLING $ref that breaks JSON
    // Schema validators. Sweep the whole program to a fixpoint: for every
    // referenced-but-missing def, locate its declaration in any
    // non-declaration source file and convert it.
    for (let guard = 0; guard < 20; guard++) {
        const referenced = new Set();
        for (const name of Object.keys(defs)) {
            collectRefNames(defs[name], referenced);
        }
        const missing = [...referenced].filter((name) => !(name in defs));
        if (missing.length === 0)
            break;
        let added = false;
        for (const sf of program.getSourceFiles()) {
            if (sf.isDeclarationFile)
                continue;
            for (const stmt of sf.statements) {
                const name = ts.isEnumDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)
                    || ts.isTypeAliasDeclaration(stmt)
                    ? stmt.name?.text
                    : undefined;
                if (name && missing.includes(name)) {
                    const before = Object.keys(defs).length;
                    addStatementDef(stmt, checker, defs);
                    if (Object.keys(defs).length > before)
                        added = true;
                }
            }
        }
        if (!added)
            break; // nothing more resolvable — stop
    }
    const schema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://loopforge.dev/loopforge-protocol.json",
        title: "LoopForge Protocol",
        description: "JSON Schema for the LoopForge loop-compile protocol. " +
            "Defines the wire format for all 3 modes (loop_compile, feedback, review) " +
            "and internal types. Language-agnostic — reference implementation in TypeScript.",
        type: "object",
        $defs: defs,
    };
    // Optional --out PATH argument (used by scripts/verify-artifacts.mjs to
    // generate into a temporary directory without touching the repo file).
    const outArgIndex = process.argv.indexOf("--out");
    const outputPath = outArgIndex !== -1 && process.argv[outArgIndex + 1]
        ? resolve(process.argv[outArgIndex + 1])
        : resolve(process.cwd(), "..", "loopforge-protocol.json");
    writeFileSync(outputPath, JSON.stringify(schema, null, 2) + "\n");
    console.log(`Generated JSON Schema → ${outputPath} (${Object.keys(defs).length} $defs)`);
}
generateSchema();
//# sourceMappingURL=generate-schema.js.map