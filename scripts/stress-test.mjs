import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { EditorState, StateEffect, Text } = require("@codemirror/state");
const { history, invertedEffects, redo, undo } = require("@codemirror/commands");
let checks = 0;

function check(actual, expected, message) {
  const normalizedActual = actual !== null && typeof actual === "object"
    ? JSON.parse(JSON.stringify(actual))
    : actual;
  assert.deepEqual(normalizedActual, expected, message);
  checks += 1;
}

function checkMatches(actual, pattern, message) {
  assert.match(actual, pattern, message);
  checks += 1;
}

function loadCommandRegistry() {
  const source = fs.readFileSync(new URL("../src/CommandRegistry.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const context = {
    exports: {},
    module: { exports: {} },
    Date,
    console
  };
  context.module.exports = context.exports;
  vm.runInNewContext(compiled, context, { filename: "CommandRegistry.ts" });
  return context.exports;
}

function loadEditorSupport() {
  const source = fs.readFileSync(new URL("../src/pages/Editor.tsx", import.meta.url), "utf8");
  const sourceFile = ts.createSourceFile(
    "Editor.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const names = new Set([
    "DEFAULT_FONT_SIZE",
    "BULLET_LIST_MARKER",
    "EMPTY_NOTE_TITLE",
    "AI_MARKDOWN_DELIMITERS",
    "defaultTextStyle",
    "removeTextRangeFromStyleRanges",
    "isEscaped",
    "getAiMarkdownDelimiter",
    "canOpenAiMarkdownDelimiter",
    "canCloseAiMarkdownDelimiter",
    "findAiMarkdownClosingDelimiter",
    "getAiMarkdownStyle",
    "getAiMarkdownHeadingStyle",
    "getAiMarkdownHeading",
    "parseAiFormattedText",
    "normalizeCodeLanguage",
    "resolveCodeCommandLanguage",
    "getCommandMenuQuery",
    "getCodeTemplate",
    "getCodeBlocks",
    "getCodeBlockAtPosition",
    "getCommandAtCursor",
    "removeStructuredTableFromHistory",
    "restoreStructuredTableFromHistory",
    "structuredTableHistory",
    "applyStructuredTableHistoryEffects",
    "isPotentialTableLine",
    "isMarkdownTableSeparator",
    "parseTableLineCells",
    "getMarkdownTables",
    "getMarkdownTableAtPosition",
    "getTableCellAtPosition",
    "getTableCellByIndexes",
    "columnLettersToIndex",
    "parseTableFormula",
    "parseStructuredTableFormula",
    "normalizeStructuredTable",
    "normalizeStructuredTables",
    "evaluateStructuredTableFormula",
    "evaluateTableFormula",
    "getSafeFileName",
    "getMarkdownHeadings",
    "getNearestPreviousHeading",
    "getPlacementFromModelSuggestion",
    "getAiPlacements",
    "stripJsonCodeFence",
    "parseAiModelResponse",
    "buildAiInstruction",
    "getGeminiText",
    "ensurePathExtension",
    "getPathKey",
    "getSavedNoteMeta",
    "joinFolderPath",
    "getNoteTitleFromPath",
    "getListLineInfo"
  ]);
  const statements = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text)) {
      statements.push(statement.getFullText(sourceFile));
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const declaredNames = statement.declarationList.declarations
        .map((declaration) => ts.isIdentifier(declaration.name) ? declaration.name.text : "");
      if (declaredNames.some((name) => names.has(name))) {
        statements.push(statement.getFullText(sourceFile));
      }
    }
  }

  const missing = [...names].filter((name) => (
    !statements.some((statement) => new RegExp(`\\b${name}\\b`).test(statement))
  ));
  assert.deepEqual(missing, [], `Could not extract editor helpers: ${missing.join(", ")}`);

  const supportNames = [...names].filter((name) => ![
    "DEFAULT_FONT_SIZE",
    "BULLET_LIST_MARKER",
    "EMPTY_NOTE_TITLE",
    "AI_MARKDOWN_DELIMITERS",
    "defaultTextStyle"
  ].includes(name));
  const testSource = `${statements.join("\n")}\n` +
    `globalThis.__editorSupport = { ${supportNames.join(", ")} };`;
  const compiled = ts.transpileModule(testSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const context = { StateEffect, Text, invertedEffects, console };
  vm.runInNewContext(compiled, context, { filename: "Editor.test-support.ts" });
  return context.__editorSupport;
}

function makeCommandContext(documentText = "") {
  const state = {
    inserted: [],
    fontSize: null,
    selectedFont: null,
    textColor: null,
    bold: null,
    italic: null,
    strike: null,
    underline: null
  };
  return {
    state,
    context: {
      getDocumentText: () => documentText,
      insertText: (text) => state.inserted.push(text),
      setFontSize: (value) => { state.fontSize = value; },
      setSelectedFont: (value) => { state.selectedFont = value; },
      setTextColor: (value) => { state.textColor = value; },
      setBold: (value) => { state.bold = value; },
      setItalic: (value) => { state.italic = value; },
      setStrike: (value) => { state.strike = value; },
      setUnderline: (value) => { state.underline = value; }
    }
  };
}

function testCommands(registry) {
  const commands = new Map(registry.CommandRegistry.map((command) => [command.name, command]));
  check(commands.size, 21, "Every documented command should be registered once");

  for (const [name, fontSize] of [["title", "24"], ["header", "16"], ["body", "14"]]) {
    const { context, state } = makeCommandContext();
    check(commands.get(name).action(context), true);
    check(state.fontSize, fontSize);
  }

  for (const [argument, expected] of [["1", "1"], ["14.5", "14.5"], ["1e2", "100"]]) {
    const { context, state } = makeCommandContext();
    check(commands.get("size").action(context, argument), true);
    check(state.fontSize, expected);
  }
  for (const argument of [undefined, "", "0", "-1", "NaN", "Infinity", "abc"]) {
    const { context, state } = makeCommandContext();
    check(commands.get("size").action(context, argument), false);
    check(state.fontSize, null);
  }

  for (const color of registry.TEXT_COLOR_OPTIONS) {
    const { context, state } = makeCommandContext();
    check(commands.get("color").action(context, color.name.toUpperCase()), true);
    check(state.textColor, color.label);
  }
  {
    const { context, state } = makeCommandContext();
    check(commands.get("color").action(context, "chartreuse"), false);
    check(state.textColor, null);
  }

  for (const [name, field] of [
    ["bold", "bold"],
    ["italic", "italic"],
    ["strike", "strike"],
    ["underline", "underline"]
  ]) {
    const { context, state } = makeCommandContext();
    check(commands.get(name).action(context), true);
    check(state[field], true);
  }

  {
    const { context, state } = makeCommandContext();
    check(commands.get("default").action(context), true);
    check(
      [state.selectedFont, state.fontSize, state.textColor, state.bold, state.italic, state.strike, state.underline],
      ["Body", "14", "White", false, false, false, false]
    );
  }

  for (const [text, expected] of [
    ["", "Word Count: 0 words"],
    ["one", "Word Count: 1 word"],
    [" one\t two\nthree ", "Word Count: 3 words"],
    ["你好 世界 👋", "Word Count: 3 words"]
  ]) {
    const { context, state } = makeCommandContext(text);
    check(commands.get("wordcount").action(context), true);
    check(state.inserted[0], expected);
  }

  for (const [name, expected] of [["bulletlist", "• "], ["numberlist", "1. "]]) {
    const { context, state } = makeCommandContext();
    check(commands.get(name).action(context), true);
    check(state.inserted[0], expected);
  }

  for (const name of ["code", "table", "save", "export"]) {
    const { context } = makeCommandContext();
    check(commands.get(name).action(context), true);
  }

  check(commands.has("new"), false);
  check(commands.has("open"), false);

  for (const name of ["date", "time"]) {
    const { context, state } = makeCommandContext();
    check(commands.get(name).action(context), true);
    checkMatches(
      state.inserted[0],
      name === "date" ? /^\d{1,2}\/\d{1,2}\/\d{4}$/ : /^\d{1,2}:\d{2}:\d{2} (AM|PM)$/,
      `${name} output format`
    );
  }
}

function testEditorLogic(editor) {
  for (const operation of ["sum", "avg", "mean", "median", "min", "max", "count"]) {
    check(editor.parseStructuredTableFormula(operation, "(B2:AA10)"), {
      operation,
      fromColumn: 1,
      fromRow: 1,
      toColumn: 26,
      toRow: 9
    });
    check(editor.parseTableFormula(`//${operation}(B2:AA10)`), {
      operation,
      fromColumn: 1,
      fromRow: 1,
      toColumn: 26,
      toRow: 9
    });
  }
  check(editor.parseTableFormula("//sum(A0:A1)"), {
    operation: "sum", fromColumn: 0, fromRow: -1, toColumn: 0, toRow: 0
  });
  check(editor.parseTableFormula("//sum(A1)"), null);
  check(editor.parseStructuredTableFormula("unknown", "A1:B2"), null);

  const structuredTable = {
    id: "stress",
    columns: ["A", "B", "C"],
    rows: [
      [{ text: "1" }, { text: "2.5" }, { text: "" }],
      [{ text: "-3" }, { text: "1,000" }, { text: "not a number" }],
      [{ text: "4" }]
    ]
  };
  const formula = (operation, range = "A1:C3") => (
    editor.parseStructuredTableFormula(operation, range)
  );
  check(editor.evaluateStructuredTableFormula(structuredTable, formula("sum")), "1004.5");
  check(editor.evaluateStructuredTableFormula(structuredTable, formula("count")), "5");
  check(editor.evaluateStructuredTableFormula(structuredTable, formula("avg")), "200.9");
  check(editor.evaluateStructuredTableFormula(structuredTable, formula("mean")), "200.9");
  check(editor.evaluateStructuredTableFormula(structuredTable, formula("median")), "2.5");
  check(editor.evaluateStructuredTableFormula(structuredTable, formula("min")), "-3");
  check(editor.evaluateStructuredTableFormula(structuredTable, formula("max")), "1000");
  check(editor.evaluateStructuredTableFormula(structuredTable, formula("sum", "C3:A1")), "1004.5");
  check(editor.evaluateStructuredTableFormula(structuredTable, formula("sum", "A1:D2")), null);
  check(editor.evaluateStructuredTableFormula(structuredTable, formula("sum", "C1:C3")), null);

  const markdownDoc = Text.of([
    "| A | B | C |",
    "| --- | --- | --- |",
    "| 1 | 2.5 | |",
    "| -3 | 1,000 | nope |",
    "| 4 | | |"
  ]);
  const markdownTable = editor.getMarkdownTables(markdownDoc)[0];
  check(markdownTable.columnCount, 3);
  check(markdownTable.cells.length, 12);
  check(editor.evaluateTableFormula(markdownTable, editor.parseTableFormula("//count(A1:C3)")), "5");
  check(editor.evaluateTableFormula(markdownTable, editor.parseTableFormula("//median(A1:C3)")), "2.5");

  const codeDoc = Text.of([
    "before",
    "```python",
    "print('one')",
    "```",
    "middle",
    "```PYTHON",
    "print('two')",
    "```",
    "```cpp",
    "#include <iostream>",
    "```",
    "after"
  ]);
  const blocks = editor.getCodeBlocks(codeDoc);
  check(blocks.length, 3);
  check(blocks.map((block) => block.language), ["python", "python", "cpp"]);
  check(blocks.map((block) => block.code), ["print('one')", "print('two')", "#include <iostream>"]);
  check(editor.getCodeBlockAtPosition(codeDoc, blocks[0].from)?.code, "print('one')");
  check(editor.getCodeBlockAtPosition(Text.of(["```javascript", "1", "```"]), 5), null);
  check(editor.normalizeCodeLanguage(undefined), "python");
  check(editor.normalizeCodeLanguage("py"), "python");
  check(editor.normalizeCodeLanguage("c++"), "cpp");
  check(editor.normalizeCodeLanguage("cpp"), "cpp");
  check(editor.normalizeCodeLanguage("javascript"), null);
  check(editor.resolveCodeCommandLanguage("c", "code c++"), "cpp");
  check(editor.resolveCodeCommandLanguage("p", "code py"), "python");
  check(editor.resolveCodeCommandLanguage("cpp", "code py"), "cpp");
  check(editor.resolveCodeCommandLanguage("c", "code"), null);
  check(editor.getCommandMenuQuery("//code c"), "code c");
  check(editor.getCommandMenuQuery("some text //code p"), "code p");
  check(editor.getCommandMenuQuery("//code "), "code");
  check(editor.getCommandMenuQuery("ordinary text"), null);
  check(editor.getCodeTemplate("python").startsWith("```python\n"), true);
  check(editor.getCodeTemplate("cpp").startsWith("```cpp\n"), true);

  const codeCommandDoc = Text.of(["//code c++"]);
  const codeCommandView = {
    state: {
      doc: codeCommandDoc,
      selection: { main: { empty: true, head: codeCommandDoc.length } }
    }
  };
  check(editor.getCommandAtCursor(codeCommandView), {
    name: "code",
    argument: "c++",
    from: 0,
    to: codeCommandDoc.length
  });

  const cppAliasCommandDoc = Text.of(["//code cpp"]);
  const cppAliasCommandView = {
    state: {
      doc: cppAliasCommandDoc,
      selection: { main: { empty: true, head: cppAliasCommandDoc.length } }
    }
  };
  check(editor.getCommandAtCursor(cppAliasCommandView), {
    name: "code",
    argument: "cpp",
    from: 0,
    to: cppAliasCommandDoc.length
  });

  const deletedCodeBoxText = editor.getCodeTemplate("cpp");
  let codeHistoryState = EditorState.create({
    doc: deletedCodeBoxText,
    extensions: [history()]
  });
  codeHistoryState = codeHistoryState.update({
    changes: { from: 0, to: codeHistoryState.doc.length, insert: "" }
  }).state;
  let codeUndoTransaction = null;
  const codeHistoryView = {
    get state() { return codeHistoryState; },
    dispatch(transaction) {
      codeUndoTransaction = transaction;
      codeHistoryState = transaction.state;
    }
  };
  check(undo(codeHistoryView), true);
  check(codeHistoryState.doc.toString(), deletedCodeBoxText);
  check(editor.getCodeBlocks(codeHistoryState.doc).map((block) => block.language), ["cpp"]);
  check(codeUndoTransaction.docChanged, true);

  const undoTable = {
    id: "undo-table",
    columns: ["Column 1"],
    rows: [[{ text: "restored cell", styles: [] }]]
  };
  const tableAnchorText = `[[x2-table:${undoTable.id}]]\n`;
  let tableHistoryState = EditorState.create({
    doc: tableAnchorText,
    extensions: [history(), editor.structuredTableHistory]
  });
  let tableCollection = [undoTable];
  const tableDeleteTransaction = tableHistoryState.update({
    changes: { from: 0, to: tableHistoryState.doc.length, insert: "" },
    effects: editor.removeStructuredTableFromHistory.of(undoTable)
  });
  tableHistoryState = tableDeleteTransaction.state;
  tableCollection = editor.applyStructuredTableHistoryEffects(
    tableCollection,
    tableDeleteTransaction.effects
  );
  check(tableHistoryState.doc.toString(), "");
  check(tableCollection, []);

  let tableHistoryTransaction = null;
  const tableHistoryView = {
    get state() { return tableHistoryState; },
    dispatch(transaction) {
      tableHistoryTransaction = transaction;
      tableHistoryState = transaction.state;
    }
  };
  check(undo(tableHistoryView), true);
  tableCollection = editor.applyStructuredTableHistoryEffects(
    tableCollection,
    tableHistoryTransaction.effects
  );
  check(tableHistoryState.doc.toString(), tableAnchorText);
  check(tableCollection, [undoTable]);
  check(
    tableHistoryTransaction.effects.some((effect) => effect.is(editor.restoreStructuredTableFromHistory)),
    true
  );

  check(redo(tableHistoryView), true);
  tableCollection = editor.applyStructuredTableHistoryEffects(
    tableCollection,
    tableHistoryTransaction.effects
  );
  check(tableHistoryState.doc.toString(), "");
  check(tableCollection, []);
  check(
    tableHistoryTransaction.effects.some((effect) => effect.is(editor.removeStructuredTableFromHistory)),
    true
  );

  const parsedMarkdown = editor.parseAiFormattedText(
    "# Heading\nPlain **bold** and *italic*, escaped \\*literal\\*, __both__."
  );
  check(parsedMarkdown.text, "Heading\nPlain bold and italic, escaped *literal*, both.");
  check(parsedMarkdown.ranges.length, 4);
  check(parsedMarkdown.ranges.some((range) => range.style.isBold && range.style.fontSize === "24"), true);
  check(parsedMarkdown.ranges.some((range) => range.style.isItalic), true);
  check(editor.parseAiFormattedText("unclosed **bold").text, "unclosed **bold");

  check(editor.parseAiModelResponse("```json\n{\"answer\":\" okay \",\"placement\":{\"mode\":\"end-of-document\"}}\n```"), {
    answer: "okay",
    placement: { mode: "end-of-document" }
  });
  check(editor.parseAiModelResponse("not JSON"), { answer: "not JSON" });
  check(editor.getMarkdownHeadings("# A\ntext\n### C").map((heading) => heading.title), ["A", "C"]);
  check(
    editor.getAiPlacements("# A\ntext", 8, { mode: "after-nearest-heading", heading: "A" })[0],
    { mode: "after-nearest-heading", label: "insert after section", heading: "A" }
  );
  checkMatches(editor.buildAiInstruction("summarise", "# A\ntext", 8), /User prompt: summarise/);
  check(editor.getGeminiText({ candidates: [{ content: { parts: [{ text: "one" }, {}, { text: "two" }] } }] }), "onetwo");
  check(editor.getGeminiText({ candidates: [] }), "");

  check(editor.getSafeFileName('  bad<>:"/\\|?* title  ', "x2"), "bad- title.x2");
  check(editor.ensurePathExtension("NOTE.X2", "x2"), "NOTE.X2");
  check(editor.ensurePathExtension("note", "pdf"), "note.pdf");
  check(editor.getPathKey("C:\\Notes\\ONE.X2"), "c:/notes/one.x2");
  check(editor.joinFolderPath("C:\\Notes\\", "one.x2"), "C:\\Notes/one.x2");
  check(editor.getNoteTitleFromPath("C:\\Notes\\ONE.X2"), "ONE");
  check(editor.getNoteTitleFromPath(".x2"), "Untitled Note");
  check(editor.getListLineInfo("  9. item")?.nextMarker, "  10. ");
  check(editor.getListLineInfo("\t• item")?.nextMarker, "\t• ");
  check(editor.getListLineInfo("ordinary"), null);

  const style = {
    fontSize: "14", textColor: "White", isBold: true,
    isItalic: false, isStrike: false, isUnderline: false
  };
  check(editor.removeTextRangeFromStyleRanges([{ from: 2, to: 8, style }], 4, 6), [
    { from: 2, to: 4, style },
    { from: 4, to: 6, style }
  ]);

  // A deterministic high-volume pass catches range-order and numeric coercion regressions.
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    const values = Array.from({ length: 25 }, (_, index) => ((iteration + index * 17) % 401) - 200);
    const table = {
      id: `table-${iteration}`,
      columns: Array.from({ length: 5 }, (_, index) => String(index)),
      rows: Array.from({ length: 5 }, (_, row) => (
        Array.from({ length: 5 }, (_, column) => ({ text: String(values[row * 5 + column]) }))
      ))
    };
    const sum = values.reduce((total, value) => total + value, 0);
    check(editor.evaluateStructuredTableFormula(table, formula("sum", "A1:E5")), String(sum));
    check(editor.evaluateStructuredTableFormula(table, formula("count", "E5:A1")), "25");
  }
}

const registry = loadCommandRegistry();
const editor = loadEditorSupport();
testCommands(registry);
testEditorLogic(editor);
console.log(`Frontend logic stress test passed: ${checks} assertions.`);
