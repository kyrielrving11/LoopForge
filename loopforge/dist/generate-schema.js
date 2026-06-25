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
            // If inner is a $ref, use anyOf; otherwise use type array
            if (inner.$ref) {
                return {
                    anyOf: [inner, { type: "null" }],
                };
            }
            const innerType = inner.type;
            return { type: [innerType, "null"] };
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
                const _keyType = typeNode.typeArguments[0];
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
                if (ts.isInterfaceDeclaration(decl) ||
                    ts.isEnumDeclaration(decl) ||
                    ts.isTypeAliasDeclaration(decl)) {
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
    // Fallback: unknown type → string
    return { type: "string" };
}
// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
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
        if (ts.isEnumDeclaration(stmt)) {
            defs[stmt.name.text] = convertEnum(stmt);
        }
        else if (ts.isInterfaceDeclaration(stmt)) {
            defs[stmt.name.text] = convertInterface(stmt, checker);
        }
        // Skip functions, variables, type aliases, etc.
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
    const outputPath = resolve(process.cwd(), "..", "loopforge-protocol.json");
    writeFileSync(outputPath, JSON.stringify(schema, null, 2) + "\n");
    console.log(`Generated JSON Schema → ${outputPath} (${Object.keys(defs).length} $defs)`);
}
generateSchema();
//# sourceMappingURL=generate-schema.js.map