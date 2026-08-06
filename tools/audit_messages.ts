/**
 * Audit user-visible diagnostics and output in the production lq sources.
 *
 * Usage from lq/:
 *   deno task audit:messages
 *   deno task audit:messages -- --format json
 *   deno task audit:messages -- --format md --output path/to/report.md
 *
 * The scanner parses TypeScript rather than searching text, so comments,
 * string contents, multiline calls, and formatting changes do not create
 * false positives. It records the known lq message helpers, every direct
 * console or Deno stream write, and Error construction/calls in main.ts and
 * src/. Dynamic expressions are retained as source expressions and marked
 * dynamic because static analysis cannot evaluate their runtime values.
 *
 * With no --output, reports are written below lq/audit/. That directory is
 * generated output; pass an explicit path when a report should be retained
 * somewhere else. The report is deterministic and contains no timestamp.
 */

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import ts from "typescript";

export type MessageKind = "warning" | "error" | "exception" | "help" | "stdout" | "stderr";
export type MessageChannel = "stdout" | "stderr" | "thrown";

export interface MessageRecord {
  kind: MessageKind;
  channel: MessageChannel;
  sink: string;
  file: string;
  line: number;
  column: number;
  expression: string;
  message: string;
  dynamic: boolean;
  code?: string;
}

export interface AuditReport {
  sourceFiles: string[];
  summary: {
    total: number;
    byKind: Record<MessageKind, number>;
    byChannel: Record<MessageChannel, number>;
  };
  entries: MessageRecord[];
}

type Format = "json" | "md";

const SCRIPT_DIR = path.dirname(path.fromFileUrl(import.meta.url));
const DEFAULT_PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const MESSAGE_KINDS: MessageKind[] = ["warning", "error", "exception", "help", "stdout", "stderr"];
const MESSAGE_CHANNELS: MessageChannel[] = ["stdout", "stderr", "thrown"];

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticText(expression: ts.Expression | undefined): string | undefined {
  if (expression === undefined) return undefined;
  const unwrapped = unwrapExpression(expression);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text;
  }
  return undefined;
}

function expressionText(expression: ts.Expression, sourceFile: ts.SourceFile): string {
  return expression.getText(sourceFile).trim();
}

function propertyAccessPath(expression: ts.Expression): string[] | null {
  let current = unwrapExpression(expression);
  const parts: string[] = [];

  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      parts.unshift(current.name.text);
      current = unwrapExpression(current.expression);
    } else {
      const property = staticText(current.argumentExpression);
      if (property === undefined) return null;
      parts.unshift(property);
      current = unwrapExpression(current.expression);
    }
  }

  if (!ts.isIdentifier(current)) return null;
  parts.unshift(current.text);
  return parts;
}

function relativePath(packageRoot: string, filePath: string): string {
  return path.relative(packageRoot, filePath).replaceAll("\\", "/");
}

function positionOf(node: ts.Node, sourceFile: ts.SourceFile): { line: number; column: number } {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
}

function describeExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): { expression: string; message: string; dynamic: boolean } {
  const source = expressionText(expression, sourceFile);
  const literal = staticText(expression);
  return {
    expression: source,
    message: literal ?? source,
    dynamic: literal === undefined,
  };
}

function makeRecord(
  sourceFile: ts.SourceFile,
  packageRoot: string,
  node: ts.Node,
  expression: ts.Expression,
  kind: MessageKind,
  channel: MessageChannel,
  sink: string,
  code?: string,
): MessageRecord {
  const position = positionOf(node, sourceFile);
  const description = describeExpression(expression, sourceFile);
  return {
    kind,
    channel,
    sink,
    file: relativePath(packageRoot, sourceFile.fileName),
    ...position,
    ...description,
    ...(code === undefined ? {} : { code }),
  };
}

function isErrorName(name: string | undefined): boolean {
  return name !== undefined && (name === "Error" || name.endsWith("Error"));
}

function isHelpExpression(expression: ts.Expression): boolean {
  return propertyAccessPath(expression)?.[0] === "HELP_TEXTS";
}

function propertyName(propertyName: ts.PropertyName, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName) || ts.isNumericLiteral(propertyName)) {
    return propertyName.text;
  }
  return propertyName.getText(sourceFile);
}

function collectHelpEntries(
  node: ts.VariableDeclaration,
  sourceFile: ts.SourceFile,
  packageRoot: string,
  entries: MessageRecord[],
): void {
  if (!ts.isIdentifier(node.name) || node.name.text !== "HELP_TEXTS" || node.initializer === undefined) return;
  const initializer = unwrapExpression(node.initializer);
  if (!ts.isObjectLiteralExpression(initializer)) return;

  for (const property of initializer.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const value = property.initializer;
    entries.push(
      makeRecord(
        sourceFile,
        packageRoot,
        property,
        value,
        "help",
        "stdout",
        `HELP_TEXTS.${propertyName(property.name, sourceFile)}`,
      ),
    );
  }
}

function collectCallEntry(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  packageRoot: string,
  entries: MessageRecord[],
): void {
  const callee = propertyAccessPath(node.expression);
  const identifier = callee?.length === 1 ? callee[0] : null;

  if (identifier === "pushWarning") {
    const expression = node.arguments[0] ?? node;
    entries.push(makeRecord(sourceFile, packageRoot, node, expression, "warning", "stdout", "pushWarning"));
    return;
  }

  if (identifier === "printError") {
    const expression = node.arguments[1] ?? node.arguments[0] ?? node;
    const code = staticText(node.arguments[0]);
    entries.push(makeRecord(sourceFile, packageRoot, node, expression, "error", "stdout", "printError", code));
    return;
  }

  const calleeName = callee?.[callee.length - 1];
  if (isErrorName(calleeName)) {
    const expression = node.arguments[0] ?? node;
    entries.push(makeRecord(sourceFile, packageRoot, node, expression, "exception", "thrown", callee!.join(".")));
    return;
  }

  if (callee?.[0] === "console" && callee.length === 2) {
    const method = callee[1];
    if (method === "log" && node.arguments[0] !== undefined && isHelpExpression(node.arguments[0])) return;
    const kind: MessageKind = method === "warn" ? "warning" : method === "error" ? "error" : "stdout";
    const channel: MessageChannel = method === "warn" || method === "error" ? "stderr" : "stdout";
    const expression = node.arguments[0] ?? node;
    entries.push(makeRecord(sourceFile, packageRoot, node, expression, kind, channel, callee.join(".")));
    return;
  }

  if (
    callee?.[0] === "Deno" &&
    callee.length >= 3 &&
    (callee[1] === "stdout" || callee[1] === "stderr")
  ) {
    const kind: MessageKind = callee[1];
    const channel: MessageChannel = callee[1];
    const expression = node.arguments[0] ?? node;
    entries.push(makeRecord(sourceFile, packageRoot, node, expression, kind, channel, callee.join(".")));
  }
}

function collectErrorConstructor(
  node: ts.NewExpression,
  sourceFile: ts.SourceFile,
  packageRoot: string,
  entries: MessageRecord[],
): void {
  const callee = propertyAccessPath(node.expression);
  const name = callee?.[callee.length - 1];
  if (!isErrorName(name)) return;
  const expression = node.arguments?.[0] ?? node;
  entries.push(makeRecord(sourceFile, packageRoot, node, expression, "exception", "thrown", `new ${callee!.join(".")}`));
}

export function auditSource(
  filePath: string,
  source: string,
  packageRoot: string,
): MessageRecord[] {
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const entries: MessageRecord[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      collectHelpEntries(node, sourceFile, packageRoot, entries);
    }
    if (ts.isCallExpression(node)) {
      collectCallEntry(node, sourceFile, packageRoot, entries);
    }
    if (ts.isNewExpression(node)) {
      collectErrorConstructor(node, sourceFile, packageRoot, entries);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return entries;
}

async function collectSourceFiles(packageRoot: string): Promise<string[]> {
  const files: string[] = [];
  const mainPath = path.join(packageRoot, "main.ts");
  try {
    if ((await Deno.stat(mainPath)).isFile) files.push(mainPath);
  } catch {
    // A missing entry point is allowed so the scanner remains useful for a partial checkout.
  }

  const visit = async (directory: string): Promise<void> => {
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(directory);
    } catch {
      return;
    }
    for await (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory) {
        await visit(entryPath);
      } else if (entry.isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        files.push(entryPath);
      }
    }
  };

  await visit(path.join(packageRoot, "src"));
  files.sort((left, right) => {
    const a = relativePath(packageRoot, left);
    const b = relativePath(packageRoot, right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return files;
}

function emptyCounts<T extends string>(values: T[]): Record<T, number> {
  return Object.fromEntries(values.map(value => [value, 0])) as Record<T, number>;
}

function compareRecords(left: MessageRecord, right: MessageRecord): number {
  const kindDifference = MESSAGE_KINDS.indexOf(left.kind) - MESSAGE_KINDS.indexOf(right.kind);
  if (kindDifference !== 0) return kindDifference;
  const leftKey = `${left.file}\0${left.line}\0${left.column}\0${left.sink}`;
  const rightKey = `${right.file}\0${right.line}\0${right.column}\0${right.sink}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export async function auditPackage(packageRoot = DEFAULT_PACKAGE_ROOT): Promise<AuditReport> {
  const files = await collectSourceFiles(packageRoot);
  const entries: MessageRecord[] = [];

  for (const file of files) {
    const source = await Deno.readTextFile(file);
    entries.push(...auditSource(file, source, packageRoot));
  }
  entries.sort(compareRecords);

  const byKind = emptyCounts(MESSAGE_KINDS);
  const byChannel = emptyCounts(MESSAGE_CHANNELS);
  for (const entry of entries) {
    byKind[entry.kind]++;
    byChannel[entry.channel]++;
  }

  return {
    sourceFiles: files.map(file => relativePath(packageRoot, file)),
    summary: { total: entries.length, byKind, byChannel },
    entries,
  };
}

export function renderJson(report: AuditReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function indentBlock(value: string): string {
  return value.split("\n").map(line => `    ${line}`).join("\n");
}

export function renderMarkdown(report: AuditReport): string {
  const lines = [
    "# lq Message Audit",
    "",
    `Scanned ${report.sourceFiles.length} production TypeScript file(s); found ${report.summary.total} output or diagnostic site(s).`,
    "",
    "## Summary",
    "",
    "| Kind | Count |",
    "| --- | ---: |",
    ...MESSAGE_KINDS.map(kind => `| ${kind} | ${report.summary.byKind[kind]} |`),
    "",
    "## Entries",
    "",
  ];

  for (const entry of report.entries) {
    lines.push(
      `### ${entry.kind}: ${entry.sink}`,
      "",
      `- Source: \`${entry.file}:${entry.line}:${entry.column}\``,
      `- Channel: \`${entry.channel}\``,
      `- Dynamic: ${entry.dynamic ? "yes" : "no"}`,
    );
    if (entry.code !== undefined) lines.push(`- Code: \`${entry.code}\``);
    lines.push("- Message or expression:", indentBlock(entry.message), "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

const USAGE = `Usage: deno task audit:messages -- [options]

Options:
  --format md|json   Report format (default: md)
  --output <path>    Output path (default: audit/messages.<format>)
  --output -         Write the report to stdout
  --help             Show this help
`;

function parseFormat(value: unknown): Format {
  if (value === undefined) return "md";
  if (value === "md" || value === "json") return value;
  throw new Error(`Invalid --format '${String(value)}'. Expected 'md' or 'json'.`);
}

function resolveOutputPath(packageRoot: string, output: unknown, format: Format): string | null {
  if (output === "-") return null;
  if (typeof output === "string") return path.isAbsolute(output) ? output : path.resolve(Deno.cwd(), output);
  return path.join(packageRoot, "audit", `messages.${format}`);
}

async function writeReport(outputPath: string, content: string): Promise<void> {
  await Deno.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(temporaryPath, content);
  await Deno.rename(temporaryPath, outputPath);
}

export async function main(args: string[]): Promise<void> {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const parsed = parseArgs(normalizedArgs, {
    boolean: ["help", "h"],
    string: ["format", "output"],
  });
  if (parsed.help || parsed.h) {
    console.log(USAGE);
    return;
  }

  const allowed = new Set(["_", "help", "h", "format", "output"]);
  const unknown = Object.keys(parsed).filter(key => !allowed.has(key));
  const positional = parsed._.map(String);
  let output = parsed.output;
  if (output === "" && positional.length === 1 && positional[0] === "-") {
    output = "-";
  } else if (output === "") {
    throw new Error("--output requires a path or '-'.");
  }
  if (unknown.length > 0 || (positional.length > 0 && output !== "-")) {
    throw new Error(`Unknown arguments: ${[...unknown, ...positional].join(", ")}`);
  }

  const format = parseFormat(parsed.format);
  const packageRoot = DEFAULT_PACKAGE_ROOT;
  const report = await auditPackage(packageRoot);
  const content = format === "json" ? renderJson(report) : renderMarkdown(report);
  const outputPath = resolveOutputPath(packageRoot, output, format);

  if (outputPath === null) {
    await Deno.stdout.write(new TextEncoder().encode(content));
    return;
  }

  await writeReport(outputPath, content);
  console.log(`Wrote ${path.relative(Deno.cwd(), outputPath) || outputPath}`);
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(`audit_messages: ${(error as Error).message}`);
    Deno.exit(1);
  }
}