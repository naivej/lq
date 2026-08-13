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
 * Help content is harvested from the `HELP_PAGES` catalog in src/help.ts
 * (dev log 113): every page title, section heading and body, and
 * further-reading hint becomes a `help` entry, and the `renderPage` render
 * path inside `printHelpPage` is treated as help output rather than generic
 * stdout.
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

/**
 * Fold a chain of string literals joined by `+` into one string, so catalog
 * section bodies (authored as concatenations) resolve to their full static
 * text. Returns undefined when any operand is not a static string.
 */
function foldedStaticText(expression: ts.Expression | undefined): string | undefined {
  if (expression === undefined) return undefined;
  const unwrapped = unwrapExpression(expression);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text;
  }
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldedStaticText(unwrapped.left);
    const right = foldedStaticText(unwrapped.right);
    return left !== undefined && right !== undefined ? left + right : undefined;
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
  const literal = foldedStaticText(expression);
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
  // A direct reference to the help catalog.
  if (propertyAccessPath(expression)?.[0] === "HELP_PAGES") return true;
  // The render path: `console.log(renderPage(page, rich))` inside printHelpPage.
  const unwrapped = unwrapExpression(expression);
  return ts.isCallExpression(unwrapped) && propertyAccessPath(unwrapped.expression)?.[0] === "renderPage";
}

/** The initializer of the named property in an object literal, if any. */
function propertyValue(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of objectLiteral.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name) {
      return property.initializer;
    }
  }
  return undefined;
}

/**
 * The static string field of one catalog entry, whether authored as an object
 * literal property (`{ heading, body }`) or a constructor call
 * (`sec(heading, body)` / `fr(page, hint)`). Returns undefined when the field
 * is absent or not a static string literal.
 */
function catalogField(
  node: ts.Expression,
  propertyName: string,
  argumentIndex: number,
): ts.Expression | undefined {
  const unwrapped = unwrapExpression(node);
  if (ts.isObjectLiteralExpression(unwrapped)) {
    const value = propertyValue(unwrapped, propertyName);
    return value !== undefined && staticText(value) !== undefined ? value : undefined;
  }
  if (ts.isCallExpression(unwrapped) && unwrapped.arguments.length > argumentIndex) {
    return unwrapped.arguments[argumentIndex];
  }
  return undefined;
}

function collectHelpEntries(
  node: ts.VariableDeclaration,
  sourceFile: ts.SourceFile,
  packageRoot: string,
  entries: MessageRecord[],
): void {
  if (!ts.isIdentifier(node.name) || node.name.text !== "HELP_PAGES" || node.initializer === undefined) return;
  const initializer = unwrapExpression(node.initializer);
  if (!ts.isArrayLiteralExpression(initializer)) return;

  initializer.elements.forEach((element) => {
    const page = unwrapExpression(element);
    if (!ts.isObjectLiteralExpression(page)) return;
    const id = staticText(propertyValue(page, "id"));
    if (id === undefined) return;

    const title = propertyValue(page, "title");
    if (title !== undefined && staticText(title) !== undefined) {
      entries.push(makeRecord(sourceFile, packageRoot, title, title, "help", "stdout", `HELP_PAGES.${id}.title`));
    }

    const sections = propertyValue(page, "sections");
    if (sections !== undefined) {
      const list = unwrapExpression(sections);
      if (ts.isArrayLiteralExpression(list)) {
        list.elements.forEach((sectionElement, index) => {
          const heading = catalogField(sectionElement, "heading", 0);
          const body = catalogField(sectionElement, "body", 1);
          if (heading !== undefined) {
            entries.push(
              makeRecord(
                sourceFile,
                packageRoot,
                heading,
                heading,
                "help",
                "stdout",
                `HELP_PAGES.${id}.sections[${index}].heading`,
              ),
            );
          }
          if (body !== undefined) {
            entries.push(
              makeRecord(
                sourceFile,
                packageRoot,
                body,
                body,
                "help",
                "stdout",
                `HELP_PAGES.${id}.sections[${index}].body`,
              ),
            );
          }
        });
      }
    }

    const furtherReading = propertyValue(page, "furtherReading");
    if (furtherReading !== undefined) {
      const list = unwrapExpression(furtherReading);
      if (ts.isArrayLiteralExpression(list)) {
        list.elements.forEach((linkElement, index) => {
          const hint = catalogField(linkElement, "hint", 1);
          if (hint !== undefined) {
            entries.push(
              makeRecord(
                sourceFile,
                packageRoot,
                hint,
                hint,
                "help",
                "stdout",
                `HELP_PAGES.${id}.furtherReading[${index}].hint`,
              ),
            );
          }
        });
      }
    }
  });
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
    callee.length === 3 &&
    (callee[1] === "stdout" || callee[1] === "stderr") &&
    (callee[2] === "write" || callee[2] === "writeSync")
  ) {
    // Only actual stream writes are output. Property queries such as
    // `Deno.stdout.isTerminal()` are not user-visible writes.
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRecords(left: MessageRecord, right: MessageRecord): number {
  const kindDifference = MESSAGE_KINDS.indexOf(left.kind) - MESSAGE_KINDS.indexOf(right.kind);
  if (kindDifference !== 0) return kindDifference;
  // Line and column compare numerically, not lexicographically, so a page at
  // line 69 sorts before one at line 100.
  const fileDifference = compareStrings(left.file, right.file);
  if (fileDifference !== 0) return fileDifference;
  const lineDifference = left.line - right.line;
  if (lineDifference !== 0) return lineDifference;
  const columnDifference = left.column - right.column;
  if (columnDifference !== 0) return columnDifference;
  return compareStrings(left.sink, right.sink);
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