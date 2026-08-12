import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { FormEvent, KeyboardEvent, MutableRefObject } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { cppLanguage } from "@codemirror/lang-cpp";
import { pythonLanguage } from "@codemirror/lang-python";
import { indentWithTab, invertedEffects } from "@codemirror/commands";
import { ChangeSet, EditorState, Prec, RangeSetBuilder, StateEffect, StateField, Text } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, keymap, scrollPastEnd, WidgetType } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CommandRegistry, TEXT_COLOR_OPTIONS } from "../CommandRegistry";
import { getCommandSuggestions, getTableFormulaSuggestions } from "../CommandSearch";
import "../styles/Editor.css";

const DEFAULT_FONT_SIZE = "14";
const COMMAND_MENU_MAX_HEIGHT = 360;
const COMMAND_MENU_VERTICAL_GAP = 8;
const COMMAND_MENU_PADDING = 16;
const COMMAND_MENU_ITEM_HEIGHT = 41;
const COMMANDS_WITH_ARGUMENTS = new Set(["code", "color", "size"]);
const BULLET_LIST_MARKER = "\u2022 ";
const BROWSER_GEMINI_API_KEY_STORAGE_KEY = "x2pad.geminiApiKey";
const GEMINI_MODEL = "gemini-3.5-flash";

type AiSessionStatus = "thinking" | "ready" | "error";
type SetupStep = "folder" | "gemini" | null;

type AiPlacementMode =
  | "command-location"
  | "current-cursor"
  | "below-current-line"
  | "after-nearest-heading"
  | "end-of-document";

interface AiPlacement {
  mode: AiPlacementMode;
  label: string;
  heading?: string;
}

interface AiSession {
  id: string;
  status: AiSessionStatus;
  prompt: string;
  anchor: number;
  activeLineTo: number;
  answer: string;
  placements: AiPlacement[];
  placementIndex: number;
  error?: string;
  isMock?: boolean;
}

interface AiModelPlacement {
  mode?: AiPlacementMode;
  heading?: string;
}

interface AiModelResponse {
  answer: string;
  placement?: AiModelPlacement;
}

interface CommandFeedback {
  title: string;
  detail: string;
}

const EMPTY_NOTE_TITLE = "Untitled Note";

const colorValues = TEXT_COLOR_OPTIONS.reduce<Record<string, string>>((values, color) => {
  values[color.label] = color.value;
  return values;
}, {});

interface ActiveTextStyle {
  fontSize: string;
  textColor: string;
  isBold: boolean;
  isItalic: boolean;
  isStrike: boolean;
  isUnderline: boolean;
}

interface TextStyleRange {
  from: number;
  to: number;
  style: ActiveTextStyle;
}

interface ParsedAiFormattedText {
  text: string;
  ranges: TextStyleRange[];
}

interface LoadedX2Note {
  title: string;
  content: string;
  savedAt: string;
  path: string;
  styles?: TextStyleRange[];
  tables?: StructuredTable[];
}

interface LoadedX2Folder {
  notes: LoadedX2Note[];
  activePath: string;
}

type CodeLanguage = "python" | "cpp";

interface CodeBlock {
  language: CodeLanguage;
  code: string;
  blockFrom: number;
  blockTo: number;
  from: number;
  to: number;
  openingLineFrom: number;
  closingLineFrom: number;
}

interface CodeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  phase: "compile" | "run";
}

interface CodeRunState {
  status: "idle" | "running" | "success" | "error";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  message: string;
}

interface CodeBoxOutput extends CodeRunState {
  blockFrom: number;
  runId: string;
}

interface TableCell {
  text: string;
  rowIndex: number;
  columnIndex: number;
  from: number;
  to: number;
  lineFrom: number;
  lineTo: number;
}

interface TableBlock {
  from: number;
  to: number;
  headerLineFrom: number;
  separatorLineFrom: number;
  lineFroms: number[];
  columnCount: number;
  cells: TableCell[];
}

interface StructuredTableCell {
  text: string;
  formula?: string;
  styles?: TextStyleRange[];
  activeStyle?: ActiveTextStyle;
}

interface StructuredTable {
  id: string;
  columns: string[];
  rows: StructuredTableCell[][];
}

interface StructuredTableCellTarget {
  tableId: string;
  rowIndex: number;
  columnIndex: number;
}

interface StructuredTableFormulaMenuState {
  target: StructuredTableCellTarget;
  query: string;
  top: number;
  left: number;
  placement: "below" | "above";
}

interface PendingStyleRestore {
  content: string;
  styles: TextStyleRange[];
}

const addTextStyleDecoration = StateEffect.define<{
  from: number;
  to: number;
  style: ActiveTextStyle;
}>();

const replaceTextStyleDecorations = StateEffect.define<TextStyleRange[]>();

const STRUCTURED_TABLE_ANCHOR_PATTERN = /\[\[x2-table:([a-zA-Z0-9_-]+)\]\]/g;
const TABLE_WIDGET_INPUT_EVENT = "x2pad-table-cell-input";
const TABLE_WIDGET_KEY_EVENT = "x2pad-table-cell-key";
const TABLE_WIDGET_FOCUS_EVENT = "x2pad-table-cell-focus";
const TABLE_WIDGET_FORMULA_MENU_KEY_EVENT = "x2pad-table-formula-menu-key";
const AUTO_SAVE_DELAY_MS = 3000;
const editorCursorScrollMargin = EditorView.scrollMargins.of(() => ({ bottom: 48 }));

const keepEditorCursorInView = EditorState.transactionExtender.of((transaction) => (
  transaction.selection
    ? {
        effects: EditorView.scrollIntoView(transaction.newSelection.main.head, {
          y: "nearest",
          x: "nearest",
          yMargin: 8,
          xMargin: 12
        })
      }
    : null
));

const getResolvedColor = (color: string) => colorValues[color] ?? color;

const defaultTextStyle: ActiveTextStyle = {
  fontSize: DEFAULT_FONT_SIZE,
  textColor: "White",
  isBold: false,
  isItalic: false,
  isStrike: false,
  isUnderline: false
};

const AI_MARKDOWN_DELIMITERS = ["**", "__", "*", "_"] as const;

const isDefaultTextStyle = (style: ActiveTextStyle) => (
  style.fontSize === defaultTextStyle.fontSize &&
  style.textColor === defaultTextStyle.textColor &&
  style.isBold === defaultTextStyle.isBold &&
  style.isItalic === defaultTextStyle.isItalic &&
  style.isStrike === defaultTextStyle.isStrike &&
  style.isUnderline === defaultTextStyle.isUnderline
);

const getTextStyleAttribute = (style: ActiveTextStyle) => {
  const styles = [
    `font-size: ${style.fontSize}px;`,
    `color: ${getResolvedColor(style.textColor)};`
  ];
  const textDecorations = [];

  if (style.isBold) {
    styles.push("font-weight: 700;");
  }

  if (style.isItalic) {
    styles.push("font-style: italic;");
  }

  if (style.isStrike) {
    textDecorations.push("line-through");
  }

  if (style.isUnderline) {
    textDecorations.push("underline");
  }

  if (textDecorations.length > 0) {
    styles.push(`text-decoration: ${textDecorations.join(" ")};`);
  }

  return styles.join(" ");
};

function createTextStyleMark(style: ActiveTextStyle) {
  return Decoration.mark({
    attributes: {
      style: getTextStyleAttribute(style)
    }
  });
}

function buildTextStyleDecorationSet(ranges: TextStyleRange[], docLength: number) {
  const builder = new RangeSetBuilder<Decoration>();

  ranges
    .filter((range) => range.from < range.to)
    .map((range) => ({
      from: Math.max(0, Math.min(range.from, docLength)),
      to: Math.max(0, Math.min(range.to, docLength)),
      style: range.style
    }))
    .filter((range) => range.from < range.to)
    .sort((left, right) => left.from - right.from || left.to - right.to)
    .forEach((range) => {
      builder.add(range.from, range.to, createTextStyleMark(range.style));
    });

  return builder.finish();
}

const textStyleDecorations = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    let mappedDecorations = decorations.map(transaction.changes);

    for (const effect of transaction.effects) {
      if (effect.is(replaceTextStyleDecorations)) {
        mappedDecorations = buildTextStyleDecorationSet(
          effect.value,
          transaction.state.doc.length
        );
      } else if (effect.is(addTextStyleDecoration)) {
        const { from, to, style } = effect.value;

        if (from < to) {
          mappedDecorations = mappedDecorations.update({
            add: [
              createTextStyleMark(style).range(from, to)
            ]
          });
        }
      }
    }

    return mappedDecorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

function getSelectionOffsetWithin(element: HTMLElement) {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0) {
    const textLength = element.textContent?.length ?? 0;
    return { from: textLength, to: textLength };
  }

  const range = selection.getRangeAt(0);

  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) {
    const textLength = element.textContent?.length ?? 0;
    return { from: textLength, to: textLength };
  }

  const getOffset = (container: Node, offset: number) => {
    const measure = document.createRange();
    measure.selectNodeContents(element);
    measure.setEnd(container, offset);
    return measure.toString().length;
  };
  const from = getOffset(range.startContainer, range.startOffset);
  const to = getOffset(range.endContainer, range.endOffset);

  return {
    from: Math.min(from, to),
    to: Math.max(from, to)
  };
}

function dispatchTableWidgetEvent(name: string, detail: Record<string, unknown>) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

function getStructuredTableCellSelector(target: StructuredTableCellTarget) {
  return [
    `.structured-table-cell-editor[data-table-id="${target.tableId}"]`,
    `[data-row-index="${target.rowIndex}"]`,
    `[data-column-index="${target.columnIndex}"]`
  ].join("");
}

function placeCaretAtEnd(element: HTMLElement) {
  const selection = window.getSelection();
  const range = document.createRange();

  range.selectNodeContents(element);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function placeCaretAtStart(element: HTMLElement) {
  const selection = window.getSelection();
  const range = document.createRange();

  range.selectNodeContents(element);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function keepStructuredCellCaretContained(
  editor: HTMLElement,
  event: globalThis.KeyboardEvent
) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    return;
  }

  const selectionOffset = getSelectionOffsetWithin(editor);
  const textLength = editor.textContent?.length ?? 0;

  if (
    (event.key === "ArrowLeft" && selectionOffset.from === 0 && selectionOffset.to === 0) ||
    (event.key === "ArrowRight" && selectionOffset.from === textLength && selectionOffset.to === textLength)
  ) {
    event.preventDefault();
    return;
  }

  requestAnimationFrame(() => {
    const selection = window.getSelection();
    const selectionStayedInside = !!selection?.anchorNode &&
      !!selection.focusNode &&
      editor.contains(selection.anchorNode) &&
      editor.contains(selection.focusNode);

    if (selectionStayedInside) {
      return;
    }

    editor.focus();
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      placeCaretAtStart(editor);
    } else {
      placeCaretAtEnd(editor);
    }
  });
}

function scheduleStructuredCellFocus(target: StructuredTableCellTarget, message?: string) {
  let attempts = 0;

  const focusCell = () => {
    attempts += 1;
    const element = document.querySelector<HTMLElement>(getStructuredTableCellSelector(target));

    if (element) {
      const wrapper = element.closest<HTMLElement>(".structured-table-widget");

      if (element.dataset.formula) {
        element.textContent = element.dataset.formula;
      }

      wrapper
        ?.querySelectorAll(
          ".structured-table-cell-editor.is-navigating, " +
          ".structured-table-cell-editor.is-row-selected, " +
          ".structured-table-cell-editor.is-column-selected"
        )
        .forEach((cell) => {
          cell.classList.remove("is-navigating", "is-row-selected", "is-column-selected");
        });
      if (wrapper) {
        setStructuredTableRovingCell(wrapper, element);
        setStructuredTableAriaSelection(wrapper, [element]);
        setStructuredTableGuideMode(wrapper, "editing");
        announceStructuredTable(wrapper, message ?? getStructuredTableSelectionAnnouncement(target, "editing"));
      }
      element.focus();
      placeCaretAtEnd(element);
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }

    if (attempts < 12) {
      window.setTimeout(() => requestAnimationFrame(focusCell), 16);
    }
  };

  requestAnimationFrame(focusCell);
}

type StructuredTableSelectionMode = "cell" | "row" | "column";
type StructuredTableGuideMode = "inactive" | "document" | "navigating" | "editing" | "row" | "column";

const STRUCTURED_TABLE_GUIDES: Record<Exclude<StructuredTableGuideMode, "inactive">, Array<{
  key: string;
  label: string;
}>> = {
  document: [
    { key: "Enter", label: "Open table" },
    { key: "Backspace", label: "Delete table" },
    { key: "↑ / ↓", label: "Move past" }
  ],
  navigating: [
    { key: "Arrow keys", label: "Move" },
    { key: "Enter", label: "Edit" },
    { key: "Shift", label: "Select row / column" },
    { key: "Shift+Enter", label: "Insert row" },
    { key: "Shift+Tab", label: "Insert column" },
    { key: "Esc", label: "Exit" }
  ],
  editing: [
    { key: "Tab", label: "Next / add column" },
    { key: "Enter", label: "Next / add row" },
    { key: "Shift+Tab", label: "Insert column" },
    { key: "Shift+Enter", label: "Insert row" },
    { key: "Esc", label: "Select cell" }
  ],
  row: [
    { key: "Shift", label: "Select column" },
    { key: "Shift+Enter", label: "Insert row" },
    { key: "Backspace", label: "Delete row" },
    { key: "Esc", label: "Exit" }
  ],
  column: [
    { key: "Shift", label: "Select cell" },
    { key: "Shift+Tab", label: "Insert column" },
    { key: "Backspace", label: "Delete column" },
    { key: "Esc", label: "Exit" }
  ]
};

function getStructuredTableGuideLabel(mode: Exclude<StructuredTableGuideMode, "inactive">) {
  return STRUCTURED_TABLE_GUIDES[mode]
    .map((shortcut) => `${shortcut.key}: ${shortcut.label}`)
    .join(". ");
}

function placeCaretAtTextOffset(element: HTMLElement, offset: number) {
  const selection = window.getSelection();
  const range = document.createRange();
  const textNode = element.firstChild;

  if (!textNode) {
    placeCaretAtEnd(element);
    return;
  }

  range.setStart(textNode, Math.max(0, Math.min(offset, textNode.textContent?.length ?? 0)));
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function getStructuredTableCellAccessibleLabel(
  rowIndex: number,
  columnIndex: number,
  columnName = ""
) {
  const columnLabel = getStructuredTableColumnLabel(columnIndex);
  const namedColumn = columnName.trim();

  if (rowIndex < 0) {
    return namedColumn
      ? `Column ${columnLabel} header, ${namedColumn}`
      : `Column ${columnLabel} header`;
  }

  return namedColumn
    ? `Cell ${columnLabel}${rowIndex + 1}, column ${namedColumn}`
    : `Cell ${columnLabel}${rowIndex + 1}`;
}

function getStructuredTableSelectionAnnouncement(
  target: StructuredTableCellTarget,
  mode: StructuredTableSelectionMode | "editing"
) {
  const columnLabel = getStructuredTableColumnLabel(target.columnIndex);

  if (mode === "row") {
    return `Row ${target.rowIndex + 1} selected.`;
  }
  if (mode === "column") {
    return `Column ${columnLabel} selected.`;
  }

  const location = target.rowIndex < 0
    ? `Column ${columnLabel} header`
    : `Cell ${columnLabel}${target.rowIndex + 1}`;
  return mode === "editing" ? `Editing ${location}.` : `${location} selected.`;
}

function setStructuredTableRovingCell(wrapper: HTMLElement, activeCell: HTMLElement) {
  wrapper.querySelectorAll<HTMLElement>(".structured-table-cell-editor")
    .forEach((cell) => {
      cell.tabIndex = cell === activeCell ? 0 : -1;
    });
}

function setStructuredTableAriaSelection(wrapper: HTMLElement, selectedEditors: HTMLElement[]) {
  const selectedCells = new Set(selectedEditors.map((editor) => editor.parentElement));

  wrapper.querySelectorAll<HTMLElement>("[role=\"gridcell\"], [role=\"columnheader\"]")
    .forEach((cell) => {
      cell.setAttribute("aria-selected", selectedCells.has(cell) ? "true" : "false");
    });
}

function announceStructuredTable(wrapper: HTMLElement, message: string) {
  const announcement = wrapper.querySelector<HTMLElement>(".structured-table-accessibility-announcement");
  if (!announcement) {
    return;
  }

  announcement.textContent = "";
  requestAnimationFrame(() => {
    announcement.textContent = message;
  });
}

function setStructuredTableGuideMode(wrapper: HTMLElement, mode: StructuredTableGuideMode) {
  if (wrapper.dataset.tableGuideMode === mode) {
    return;
  }

  wrapper.dataset.tableGuideMode = mode;
  const announcement = wrapper.querySelector<HTMLElement>(".structured-table-shortcut-announcement");
  if (announcement) {
    announcement.textContent = mode === "inactive" ? "" : getStructuredTableGuideLabel(mode);
  }
}

function createStructuredTableShortcutGuide(tableId: string) {
  const guide = document.createElement("div");
  guide.className = "structured-table-shortcut-guide";
  guide.id = `structured-table-guide-${tableId}`;
  guide.setAttribute("role", "group");
  guide.setAttribute("aria-label", "Table keyboard shortcuts");

  for (const [mode, shortcuts] of Object.entries(STRUCTURED_TABLE_GUIDES)) {
    const group = document.createElement("div");
    group.className = "structured-table-shortcut-group";
    group.dataset.guideMode = mode;

    for (const shortcut of shortcuts) {
      const item = document.createElement("span");
      item.className = "structured-table-shortcut-item";
      const key = document.createElement("kbd");
      const label = document.createElement("span");
      key.textContent = shortcut.key;
      label.textContent = shortcut.label;
      item.append(key, label);
      group.append(item);
    }

    guide.append(group);
  }

  const announcement = document.createElement("span");
  announcement.className = "structured-table-shortcut-announcement";
  announcement.setAttribute("role", "status");
  announcement.setAttribute("aria-live", "polite");
  guide.append(announcement);

  const accessibilityAnnouncement = document.createElement("span");
  accessibilityAnnouncement.className = "structured-table-accessibility-announcement";
  accessibilityAnnouncement.setAttribute("role", "status");
  accessibilityAnnouncement.setAttribute("aria-live", "polite");
  accessibilityAnnouncement.setAttribute("aria-atomic", "true");
  guide.append(accessibilityAnnouncement);
  return guide;
}

function scheduleStructuredCellNavigation(
  target: StructuredTableCellTarget,
  selectionMode: StructuredTableSelectionMode = "cell",
  message?: string
) {
  let attempts = 0;

  const selectCell = () => {
    attempts += 1;
    const element = document.querySelector<HTMLElement>(getStructuredTableCellSelector(target));
    const wrapper = element?.closest<HTMLElement>(".structured-table-widget");

    if (element && wrapper) {
      wrapper.querySelectorAll(
        ".structured-table-cell-editor.is-navigating, " +
        ".structured-table-cell-editor.is-row-selected, " +
        ".structured-table-cell-editor.is-column-selected"
      ).forEach((cell) => {
        cell.classList.remove("is-navigating", "is-row-selected", "is-column-selected");
      });

      if (selectionMode === "row") {
        const selectedCells = Array.from(wrapper.querySelectorAll<HTMLElement>(
          `.structured-table-cell-editor[data-row-index="${target.rowIndex}"]`
        ));
        selectedCells.forEach((cell) => cell.classList.add("is-row-selected"));
        setStructuredTableAriaSelection(wrapper, selectedCells);
      } else if (selectionMode === "column") {
        const selectedCells = Array.from(wrapper.querySelectorAll<HTMLElement>(
          `.structured-table-cell-editor[data-column-index="${target.columnIndex}"]`
        ));
        selectedCells.forEach((cell) => cell.classList.add("is-column-selected"));
        setStructuredTableAriaSelection(wrapper, selectedCells);
      } else {
        element.classList.add("is-navigating");
        setStructuredTableAriaSelection(wrapper, [element]);
      }
      setStructuredTableRovingCell(wrapper, element);
      setStructuredTableGuideMode(wrapper, selectionMode === "cell" ? "navigating" : selectionMode);
      announceStructuredTable(
        wrapper,
        message ?? getStructuredTableSelectionAnnouncement(target, selectionMode)
      );
      wrapper.focus();
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }

    if (attempts < 12) {
      window.setTimeout(() => requestAnimationFrame(selectCell), 16);
    }
  };

  requestAnimationFrame(selectCell);
}

function getStructuredTableCellCommand(text: string) {
  const formulaCommand = text.match(/\/\/(sum|avg|mean|median|min|max|count)\(([A-Z]+\d+:[A-Z]+\d+)\)\s*$/i);

  if (formulaCommand) {
    return {
      name: formulaCommand[1].toLowerCase(),
      argument: formulaCommand[2],
      length: formulaCommand[0].length
    };
  }

  const spacedCommand = text.match(/\/\/([a-z]+)(?:\s+([^\s]+))?\s*$/i);

  if (!spacedCommand) {
    return null;
  }

  return {
    name: spacedCommand[1].toLowerCase(),
    argument: spacedCommand[2] ?? "",
    length: spacedCommand[0].length
  };
}

function getStructuredTableColumnLabel(index: number) {
  let label = "";
  let value = index + 1;

  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }

  return label;
}

function createStructuredTableCellElement(
  tableId: string,
  rowIndex: number,
  columnIndex: number,
  columnName: string,
  cell: StructuredTableCell
) {
  const cellElement = document.createElement("td");
  const editor = document.createElement("div");

  cellElement.setAttribute("role", "gridcell");
  cellElement.setAttribute("aria-selected", "false");
  cellElement.setAttribute(
    "headers",
    `structured-table-${tableId}-column-${columnIndex} structured-table-${tableId}-row-${rowIndex}`
  );

  editor.className = "structured-table-cell-editor";
  editor.contentEditable = "true";
  editor.spellcheck = false;
  editor.dataset.tableId = tableId;
  editor.dataset.rowIndex = String(rowIndex);
  editor.dataset.columnIndex = String(columnIndex);
  if (cell.formula) {
    editor.dataset.formula = cell.formula;
    editor.dataset.computedValue = cell.text;
  }
  editor.tabIndex = -1;
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", getStructuredTableCellAccessibleLabel(rowIndex, columnIndex, columnName));
  editor.setAttribute("style", getTextStyleAttribute(cell.activeStyle ?? defaultTextStyle));
  appendStyledText(editor, cell.text, cell.styles ?? []);

  editor.addEventListener("focus", () => {
    const wrapper = editor.closest<HTMLElement>(".structured-table-widget");
    if (editor.dataset.formula) {
      editor.textContent = editor.dataset.formula;
      placeCaretAtEnd(editor);
    }
    if (wrapper) {
      setStructuredTableRovingCell(wrapper, editor);
      setStructuredTableAriaSelection(wrapper, [editor]);
      setStructuredTableGuideMode(wrapper, "editing");
      announceStructuredTable(
        wrapper,
        getStructuredTableSelectionAnnouncement({ tableId, rowIndex, columnIndex }, "editing")
      );
    }
    dispatchTableWidgetEvent(TABLE_WIDGET_FOCUS_EVENT, { tableId, rowIndex, columnIndex });
  });
  editor.addEventListener("input", () => {
    delete editor.dataset.formula;
    delete editor.dataset.computedValue;
    const text = editor.textContent ?? "";
    const formulaMenuQuery = getStructuredTableFormulaMenuQuery(text);
    const bounds = editor.getBoundingClientRect();
    dispatchTableWidgetEvent(TABLE_WIDGET_INPUT_EVENT, {
      tableId,
      rowIndex,
      columnIndex,
      text,
      formulaMenuQuery,
      menuCoords: {
        top: bounds.top,
        bottom: bounds.bottom,
        left: bounds.left
      }
    });
  });
  editor.addEventListener("blur", () => {
    if (editor.dataset.formula) {
      editor.textContent = editor.dataset.computedValue ?? "";
    }
  });
  editor.addEventListener("keydown", (event) => {
    keepStructuredCellCaretContained(editor, event);
    const text = editor.textContent ?? "";
    const formulaMenuQuery = getStructuredTableFormulaMenuQuery(text);
    const command = getStructuredTableCellCommand(text);

    if (
      formulaMenuQuery !== null &&
      ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      dispatchTableWidgetEvent(TABLE_WIDGET_FORMULA_MENU_KEY_EVENT, {
        tableId,
        rowIndex,
        columnIndex,
        key: event.key
      });
      return;
    }

    if (
      event.key === "Tab" ||
      event.key === "Enter" ||
      (event.key.toLowerCase() === "tab" && event.ctrlKey) ||
      (event.key === "Enter" && command)
    ) {
      event.preventDefault();
      dispatchTableWidgetEvent(TABLE_WIDGET_KEY_EVENT, {
        tableId,
        rowIndex,
        columnIndex,
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey || event.metaKey,
        commandName: command?.name ?? "",
        commandArgument: command?.argument ?? "",
        commandLength: command?.length ?? 0,
        selection: getSelectionOffsetWithin(editor)
      });
    }
  });

  cellElement.append(editor);
  return cellElement;
}

class StructuredTableWidget extends WidgetType {
  constructor(
    private readonly table: StructuredTable,
    private readonly isSelected: boolean
  ) {
    super();
  }

  eq(widget: StructuredTableWidget) {
    return widget.isSelected === this.isSelected &&
      JSON.stringify(widget.table) === JSON.stringify(this.table);
  }

  toDOM() {
    const wrapper = document.createElement("div");
    const tableElement = document.createElement("table");
    const hasColumnNames = this.table.columns.some((column) => column.trim().length > 0);

    wrapper.className = [
      "structured-table-widget",
      this.isSelected ? "is-selected" : ""
    ].filter(Boolean).join(" ");
    wrapper.contentEditable = "false";
    wrapper.tabIndex = -1;
    wrapper.dataset.tableId = this.table.id;
    wrapper.dataset.tableGuideMode = this.isSelected ? "document" : "inactive";
    tableElement.className = "structured-table";
    tableElement.setAttribute("role", "grid");
    tableElement.setAttribute(
      "aria-label",
      `Structured table with ${this.table.rows.length} rows and ${this.table.columns.length} columns`
    );
    tableElement.setAttribute("aria-rowcount", String(this.table.rows.length + (hasColumnNames ? 2 : 1)));
    tableElement.setAttribute("aria-colcount", String(this.table.columns.length + 1));
    tableElement.setAttribute("aria-describedby", `structured-table-guide-${this.table.id}`);

    const thead = document.createElement("thead");
    const formulaHeaderRow = document.createElement("tr");
    const cornerHeader = document.createElement("th");

    formulaHeaderRow.className = "structured-table-formula-axis-row";
    formulaHeaderRow.setAttribute("role", "row");
    cornerHeader.className = "structured-table-axis-corner";
    cornerHeader.setAttribute("aria-hidden", "true");
    formulaHeaderRow.append(cornerHeader);

    this.table.columns.forEach((_, columnIndex) => {
      const labelHeader = document.createElement("th");

      labelHeader.className = "structured-table-axis-header";
      labelHeader.id = `structured-table-${this.table.id}-column-${columnIndex}`;
      labelHeader.textContent = getStructuredTableColumnLabel(columnIndex);
      labelHeader.scope = "col";
      labelHeader.setAttribute("role", "columnheader");
      labelHeader.setAttribute("aria-selected", "false");
      labelHeader.setAttribute("aria-label", `Formula column ${getStructuredTableColumnLabel(columnIndex)}`);
      formulaHeaderRow.append(labelHeader);
    });

    thead.append(formulaHeaderRow);

    if (hasColumnNames) {
      const headerRow = document.createElement("tr");
      const headerCorner = document.createElement("th");

      headerRow.setAttribute("role", "row");
      headerCorner.className = "structured-table-axis-corner";
      headerCorner.setAttribute("aria-hidden", "true");
      headerRow.append(headerCorner);
      this.table.columns.forEach((column, columnIndex) => {
        const header = document.createElement("th");
        const headerEditor = document.createElement("div");

        headerEditor.className = "structured-table-cell-editor structured-table-header-editor";
        headerEditor.contentEditable = "true";
        headerEditor.spellcheck = false;
        headerEditor.textContent = column;
        headerEditor.dataset.tableId = this.table.id;
        headerEditor.dataset.rowIndex = "-1";
        headerEditor.dataset.columnIndex = String(columnIndex);
        headerEditor.tabIndex = -1;
        headerEditor.setAttribute("role", "textbox");
        headerEditor.setAttribute(
          "aria-label",
          getStructuredTableCellAccessibleLabel(-1, columnIndex, column)
        );
        header.setAttribute("role", "columnheader");
        header.setAttribute("aria-selected", "false");
        header.setAttribute("headers", `structured-table-${this.table.id}-column-${columnIndex}`);
        headerEditor.addEventListener("input", () => {
          dispatchTableWidgetEvent(TABLE_WIDGET_INPUT_EVENT, {
            tableId: this.table.id,
            rowIndex: -1,
            columnIndex,
            text: headerEditor.textContent ?? ""
          });
        });
        headerEditor.addEventListener("focus", () => {
          const wrapper = headerEditor.closest<HTMLElement>(".structured-table-widget");
          if (wrapper) {
            setStructuredTableRovingCell(wrapper, headerEditor);
            setStructuredTableAriaSelection(wrapper, [headerEditor]);
            setStructuredTableGuideMode(wrapper, "editing");
            announceStructuredTable(
              wrapper,
              getStructuredTableSelectionAnnouncement({
                tableId: this.table.id,
                rowIndex: -1,
                columnIndex
              }, "editing")
            );
          }
          dispatchTableWidgetEvent(TABLE_WIDGET_FOCUS_EVENT, {
            tableId: this.table.id,
            rowIndex: -1,
            columnIndex
          });
        });
        headerEditor.addEventListener("keydown", (event) => {
          keepStructuredCellCaretContained(headerEditor, event);
          if (event.key === "Tab" || event.key === "Enter") {
            event.preventDefault();
            dispatchTableWidgetEvent(TABLE_WIDGET_KEY_EVENT, {
              tableId: this.table.id,
              rowIndex: -1,
              columnIndex,
              key: event.key,
              shiftKey: event.shiftKey,
              ctrlKey: event.ctrlKey || event.metaKey,
              commandName: "",
              commandArgument: "",
              commandLength: 0,
              selection: getSelectionOffsetWithin(headerEditor)
            });
          }
        });

        header.append(headerEditor);
        headerRow.append(header);
      });

      thead.append(headerRow);
    }

    tableElement.append(thead);

    const tbody = document.createElement("tbody");
    this.table.rows.forEach((row, rowIndex) => {
      const rowElement = document.createElement("tr");
      const rowLabel = document.createElement("th");

      rowElement.setAttribute("role", "row");
      rowLabel.className = "structured-table-axis-header structured-table-row-axis";
      rowLabel.id = `structured-table-${this.table.id}-row-${rowIndex}`;
      rowLabel.textContent = String(rowIndex + 1);
      rowLabel.scope = "row";
      rowLabel.setAttribute("role", "rowheader");
      rowLabel.setAttribute("aria-label", `Formula row ${rowIndex + 1}`);
      rowElement.append(rowLabel);

      this.table.columns.forEach((_, columnIndex) => {
        rowElement.append(createStructuredTableCellElement(
          this.table.id,
          rowIndex,
          columnIndex,
          this.table.columns[columnIndex] ?? "",
          row[columnIndex] ?? { text: "", styles: [] }
        ));
      });

      tbody.append(rowElement);
    });
    tableElement.append(tbody);
    wrapper.append(tableElement, createStructuredTableShortcutGuide(this.table.id));
    return wrapper;
  }

  ignoreEvent(event: Event) {
    return event.type !== "blur";
  }
}

function getStructuredTableAnchors(doc: Text) {
  return [...doc.toString().matchAll(STRUCTURED_TABLE_ANCHOR_PATTERN)].map((match) => ({
    id: match[1],
    from: match.index ?? 0,
    to: (match.index ?? 0) + match[0].length
  }));
}

function getStructuredTableAnchorById(doc: Text, tableId: string) {
  return getStructuredTableAnchors(doc).find((anchor) => anchor.id === tableId) ?? null;
}

function getSelectedStructuredTableAnchor(view: EditorView) {
  const head = view.state.selection.main.head;
  return getStructuredTableAnchors(view.state.doc).find((anchor) => anchor.from === head) ?? null;
}

function getStructuredTableAnchorAtSelection(view: EditorView) {
  const selection = view.state.selection.main;

  return getStructuredTableAnchors(view.state.doc).find((anchor) => {
    if (selection.empty) {
      return anchor.from <= selection.head && selection.head <= anchor.to;
    }

    return selection.from <= anchor.to && selection.to >= anchor.from;
  }) ?? null;
}

function buildStructuredTableDecorations(doc: Text, tables: StructuredTable[], selectionHead: number) {
  const builder = new RangeSetBuilder<Decoration>();
  const tableById = new Map(tables.map((table) => [table.id, table]));

  for (const anchor of getStructuredTableAnchors(doc)) {
    const table = tableById.get(anchor.id);

    if (!table) {
      continue;
    }

    builder.add(anchor.from, anchor.to, Decoration.replace({
      widget: new StructuredTableWidget(table, selectionHead === anchor.from),
      block: true,
      inclusive: true
    }));
  }

  return builder.finish();
}

interface StructuredTableDecorationState {
  decorations: DecorationSet;
  hasSelectedTable: boolean;
}

function structuredTableDecorations(
  tablesRef: MutableRefObject<StructuredTable[]>
) {
  return StateField.define<StructuredTableDecorationState>({
    create(state) {
      const selectionHead = state.selection.main.head;
      return {
        decorations: buildStructuredTableDecorations(
          state.doc,
          tablesRef.current,
          selectionHead
        ),
        hasSelectedTable: getStructuredTableAnchors(state.doc).some(
          (anchor) => anchor.from <= selectionHead && selectionHead <= anchor.to
        )
      };
    },
    update(previous, transaction) {
      const selectionHead = transaction.state.selection.main.head;
      const hasSelectedTable = getStructuredTableAnchors(transaction.state.doc).some(
        (anchor) => anchor.from <= selectionHead && selectionHead <= anchor.to
      );

      if (transaction.docChanged || transaction.selection) {
        return {
          decorations: buildStructuredTableDecorations(
            transaction.state.doc,
            tablesRef.current,
            selectionHead
          ),
          hasSelectedTable
        };
      }

      return {
        decorations: previous.decorations.map(transaction.changes),
        hasSelectedTable
      };
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.editorAttributes.from(field, (value) => ({
        class: value.hasSelectedTable ? "cm-structured-table-selected" : ""
      }))
    ]
  });
}

function moveAroundStructuredTable(view: EditorView, direction: "up" | "down") {
  const selection = view.state.selection.main;

  if (!selection.empty) {
    return false;
  }

  const selectedTable = getSelectedStructuredTableAnchor(view);

  if (selectedTable) {
    const tableLine = view.state.doc.lineAt(selectedTable.from);
    const targetLineNumber = tableLine.number + (direction === "up" ? -1 : 1);

    if (targetLineNumber < 1) {
      view.dispatch({
        changes: { from: 0, to: 0, insert: "\n" },
        selection: { anchor: 0 },
        scrollIntoView: true
      });
      return true;
    }

    if (targetLineNumber > view.state.doc.lines) {
      const insertAt = view.state.doc.length;
      view.dispatch({
        changes: { from: insertAt, to: insertAt, insert: "\n" },
        selection: { anchor: insertAt + 1 },
        scrollIntoView: true
      });
      return true;
    }

    view.dispatch({
      selection: { anchor: view.state.doc.line(targetLineNumber).from },
      scrollIntoView: true
    });
    return true;
  }

  const currentLine = view.state.doc.lineAt(selection.head);
  const targetLineNumber = currentLine.number + (direction === "up" ? -1 : 1);

  if (targetLineNumber < 1 || targetLineNumber > view.state.doc.lines) {
    return false;
  }

  const targetLine = view.state.doc.line(targetLineNumber);
  const targetTable = getStructuredTableAnchors(view.state.doc).find(
    (anchor) => anchor.from === targetLine.from
  );

  if (!targetTable) {
    return false;
  }

  view.dispatch({
    selection: { anchor: targetTable.from },
    scrollIntoView: true
  });
  return true;
}

const protectStructuredTableAnchors = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged) {
    return transaction;
  }

  const anchors = getStructuredTableAnchors(transaction.startState.doc);
  const replacements: TransactionSpec[] = [];

  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    for (const anchor of anchors) {
      const touchesAnchor = fromA <= anchor.to && toA >= anchor.from;

      if (!touchesAnchor) {
        continue;
      }

      const line = transaction.startState.doc.lineAt(anchor.from);
      replacements.push({
        changes: {
          from: line.from,
          to: line.to < transaction.startState.doc.length ? line.to + 1 : line.to,
          insert: inserted.length > 0 ? inserted.toString() : ""
        },
        selection: { anchor: line.from }
      });
    }
  });

  return replacements.length > 0 ? replacements : transaction;
});

function removeTextRangeFromStyleRanges(ranges: TextStyleRange[], from: number, to: number) {
  const removedLength = to - from;
  const nextRanges: TextStyleRange[] = [];

  for (const range of ranges) {
    if (range.to <= from) {
      nextRanges.push(range);
      continue;
    }

    if (range.from >= to) {
      nextRanges.push({
        ...range,
        from: range.from - removedLength,
        to: range.to - removedLength
      });
      continue;
    }

    if (range.from < from) {
      nextRanges.push({
        ...range,
        to: from
      });
    }

    if (range.to > to) {
      nextRanges.push({
        ...range,
        from,
        to: range.to - removedLength
      });
    }
  }

  return nextRanges.filter((range) => range.from < range.to);
}

function mapStyleRangesThroughChanges(
  ranges: TextStyleRange[],
  changes: { mapPos: (position: number, assoc?: number) => number },
  docLength: number
) {
  return ranges
    .map((range) => ({
      ...range,
      from: Math.max(0, Math.min(changes.mapPos(range.from, 1), docLength)),
      to: Math.max(0, Math.min(changes.mapPos(range.to, -1), docLength))
    }))
    .filter((range) => range.from < range.to);
}

function isEscaped(text: string, index: number) {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }

  return slashCount % 2 === 1;
}

function getAiMarkdownDelimiter(text: string, index: number) {
  if (isEscaped(text, index)) {
    return null;
  }

  return AI_MARKDOWN_DELIMITERS.find((delimiter) => text.startsWith(delimiter, index)) ?? null;
}

function canOpenAiMarkdownDelimiter(text: string, index: number, delimiter: string) {
  const nextCharacter = text[index + delimiter.length];
  return !!nextCharacter && !/\s/.test(nextCharacter);
}

function canCloseAiMarkdownDelimiter(text: string, index: number) {
  const previousCharacter = text[index - 1];
  return !!previousCharacter && !/\s/.test(previousCharacter);
}

function findAiMarkdownClosingDelimiter(text: string, from: number, delimiter: string) {
  for (let index = from; index < text.length; index += 1) {
    if (
      text.startsWith(delimiter, index) &&
      !isEscaped(text, index) &&
      canCloseAiMarkdownDelimiter(text, index)
    ) {
      return index;
    }
  }

  return -1;
}

function getAiMarkdownStyle(delimiter: string): ActiveTextStyle {
  const isDoubleDelimiter = delimiter.length === 2;

  return {
    ...defaultTextStyle,
    isBold: isDoubleDelimiter,
    isItalic: !isDoubleDelimiter
  };
}

function getAiMarkdownHeadingStyle(level: number): ActiveTextStyle {
  return {
    ...defaultTextStyle,
    fontSize: level === 1 ? "24" : level === 2 ? "20" : "16",
    isBold: true
  };
}

function getAiMarkdownHeading(lineText: string) {
  const match = lineText.match(/^[ \t]{0,3}(#{1,6})[ \t]+(.+?)\s*$/);

  if (!match) {
    return null;
  }

  return {
    level: match[1].length,
    text: match[2]
  };
}

function parseAiFormattedText(text: string): ParsedAiFormattedText {
  let parsedText = "";
  const ranges: TextStyleRange[] = [];
  let index = 0;

  while (index < text.length) {
    if (index === 0 || text[index - 1] === "\n") {
      const lineEnd = text.indexOf("\n", index);
      const lineToParse = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
      const heading = getAiMarkdownHeading(lineToParse);

      if (heading) {
        const inner = parseAiFormattedText(heading.text);
        const rangeFrom = parsedText.length;

        parsedText += inner.text;
        ranges.push(
          ...inner.ranges.map((range) => ({
            ...range,
            from: rangeFrom + range.from,
            to: rangeFrom + range.to
          }))
        );

        if (inner.text.length > 0) {
          ranges.push({
            from: rangeFrom,
            to: rangeFrom + inner.text.length,
            style: getAiMarkdownHeadingStyle(heading.level)
          });
        }

        index += lineToParse.length;
        continue;
      }
    }

    if (text[index] === "\\" && ["*", "_"].includes(text[index + 1] ?? "")) {
      parsedText += text[index + 1];
      index += 2;
      continue;
    }

    const delimiter = getAiMarkdownDelimiter(text, index);

    if (!delimiter || !canOpenAiMarkdownDelimiter(text, index, delimiter)) {
      parsedText += text[index];
      index += 1;
      continue;
    }

    const innerFrom = index + delimiter.length;
    const closingIndex = findAiMarkdownClosingDelimiter(text, innerFrom, delimiter);

    if (closingIndex === -1) {
      parsedText += text[index];
      index += 1;
      continue;
    }

    const inner = parseAiFormattedText(text.slice(innerFrom, closingIndex));
    const rangeFrom = parsedText.length;

    parsedText += inner.text;
    ranges.push(
      ...inner.ranges.map((range) => ({
        ...range,
        from: rangeFrom + range.from,
        to: rangeFrom + range.to
      }))
    );

    if (inner.text.length > 0) {
      ranges.push({
        from: rangeFrom,
        to: rangeFrom + inner.text.length,
        style: getAiMarkdownStyle(delimiter)
      });
    }

    index = closingIndex + delimiter.length;
  }

  return {
    text: parsedText,
    ranges
  };
}

function applyPendingStyleRestore(
  editorView: EditorView | null,
  pendingStyleRestoreRef: MutableRefObject<PendingStyleRestore | null>,
  styleRangesRef: MutableRefObject<TextStyleRange[]>
) {
  const pendingStyleRestore = pendingStyleRestoreRef.current;

  if (!editorView || !pendingStyleRestore) {
    return false;
  }

  if (editorView.state.doc.toString() !== pendingStyleRestore.content) {
    return false;
  }

  editorView.dispatch({
    effects: replaceTextStyleDecorations.of(pendingStyleRestore.styles)
  });
  styleRangesRef.current = pendingStyleRestore.styles;
  pendingStyleRestoreRef.current = null;
  return true;
}

function buildCommandLineDecorations(doc: Text) {
  const builder = new RangeSetBuilder<Decoration>();
  const commandTokenPattern = /(\/\/[a-z]*)(?:\s+([^/\s]+))?/gi;
  const aiCommandPattern = /\\\\.+/g;
  const codeBlocks = getCodeBlocks(doc);
  const tables = getMarkdownTables(doc);

  for (let index = 1; index <= doc.lines; index += 1) {
    const line = doc.line(index);

    if (
      codeBlocks.some((block) => block.blockFrom <= line.from && line.from <= block.blockTo) ||
      tables.some((table) => table.from <= line.from && line.from <= table.to)
    ) {
      continue;
    }

    if (line.text.trimStart().startsWith("//")) {
      builder.add(line.from, line.from, Decoration.line({ class: "cm-command-line" }));
    }

    if (line.text.trimStart().startsWith("\\\\")) {
      builder.add(line.from, line.from, Decoration.line({ class: "cm-ai-command-line" }));
    }

    for (const match of line.text.matchAll(commandTokenPattern)) {
      const commandToken = match[1] ?? "";
      const commandName = commandToken.slice(2).toLowerCase();
      const commandFrom = line.from + (match.index ?? 0);
      let commandTo = commandFrom + commandToken.length;

      if (commandName && COMMANDS_WITH_ARGUMENTS.has(commandName) && match[2]) {
        commandTo = commandFrom + match[0].length;
      }

      builder.add(commandFrom, commandTo, Decoration.mark({ class: "cm-command-command" }));
    }

    for (const match of line.text.matchAll(aiCommandPattern)) {
      const commandFrom = line.from + (match.index ?? 0);
      const commandTo = commandFrom + match[0].length;

      builder.add(commandFrom, commandTo, Decoration.mark({ class: "cm-ai-command" }));
    }
  }

  return builder.finish();
}

const commandLineDecorations = StateField.define<DecorationSet>({
  create(state) {
    return buildCommandLineDecorations(state.doc);
  },
  update(decorations, transaction) {
    if (transaction.docChanged) {
      return buildCommandLineDecorations(transaction.state.doc);
    }

    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field)
});

function buildTableDecorations(doc: Text) {
  const builder = new RangeSetBuilder<Decoration>();
  const ranges: { from: number; to: number; decoration: Decoration }[] = [];

  for (const table of getMarkdownTables(doc)) {
    for (const lineFrom of table.lineFroms) {
      const line = doc.lineAt(lineFrom);
      const lineClass = lineFrom === table.headerLineFrom
        ? "cm-table-line cm-table-header"
        : lineFrom === table.separatorLineFrom
          ? "cm-table-line cm-table-separator"
          : "cm-table-line cm-table-row";

      ranges.push({
        from: line.from,
        to: line.from,
        decoration: Decoration.line({ class: lineClass })
      });

      for (let index = 0; index < line.text.length; index += 1) {
        if (line.text[index] === "|") {
          ranges.push({
            from: line.from + index,
            to: line.from + index + 1,
            decoration: Decoration.mark({ class: "cm-table-pipe" })
          });
        }
      }
    }

    for (const cell of table.cells) {
      if (cell.from < cell.to) {
        ranges.push({
          from: Math.max(cell.lineFrom, cell.from),
          to: Math.max(cell.lineFrom, cell.to),
          decoration: Decoration.mark({ class: cell.rowIndex < 0 ? "cm-table-cell cm-table-cell-header" : "cm-table-cell" })
        });
      }
    }
  }

  ranges
    .sort((left, right) => left.from - right.from || left.to - right.to)
    .forEach((range) => {
      builder.add(range.from, range.to, range.decoration);
    });

  return builder.finish();
}

function appendStyledText(parent: HTMLElement, text: string, styles: TextStyleRange[]) {
  if (!text) {
    parent.append(document.createTextNode(""));
    return;
  }

  let index = 0;

  while (index < text.length) {
    const style = styles
      .filter((range) => range.from <= index && index < range.to)
      .slice(-1)[0]?.style ?? defaultTextStyle;
    let nextIndex = index + 1;

    while (nextIndex < text.length) {
      const nextStyle = styles
        .filter((range) => range.from <= nextIndex && nextIndex < range.to)
        .slice(-1)[0]?.style ?? defaultTextStyle;

      if (!isSameActiveTextStyle(style, nextStyle)) {
        break;
      }

      nextIndex += 1;
    }

    const span = document.createElement("span");
    span.textContent = text.slice(index, nextIndex);
    span.setAttribute("style", getTextStyleAttribute(style));
    parent.append(span);
    index = nextIndex;
  }
}

function isSameActiveTextStyle(left: ActiveTextStyle, right: ActiveTextStyle) {
  return left.fontSize === right.fontSize &&
    left.textColor === right.textColor &&
    left.isBold === right.isBold &&
    left.isItalic === right.isItalic &&
    left.isStrike === right.isStrike &&
    left.isUnderline === right.isUnderline;
}

const tableDecorations = StateField.define<DecorationSet>({
  create(state) {
    return buildTableDecorations(state.doc);
  },
  update(decorations, transaction) {
    if (transaction.docChanged) {
      return buildTableDecorations(transaction.state.doc);
    }

    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field)
});

const removeStructuredTableFromHistory = StateEffect.define<StructuredTable>();
const restoreStructuredTableFromHistory = StateEffect.define<StructuredTable>();
const structuredTableHistory = invertedEffects.of((transaction) => {
  const inverseEffects: StateEffect<unknown>[] = [];

  for (const effect of transaction.effects) {
    if (effect.is(removeStructuredTableFromHistory)) {
      inverseEffects.push(restoreStructuredTableFromHistory.of(effect.value));
    } else if (effect.is(restoreStructuredTableFromHistory)) {
      inverseEffects.push(removeStructuredTableFromHistory.of(effect.value));
    }
  }

  return inverseEffects;
});

function applyStructuredTableHistoryEffects(
  tables: StructuredTable[],
  effects: readonly StateEffect<unknown>[]
) {
  let nextTables = tables;

  for (const effect of effects) {
    if (effect.is(removeStructuredTableFromHistory)) {
      nextTables = nextTables.filter((table) => table.id !== effect.value.id);
    } else if (effect.is(restoreStructuredTableFromHistory)) {
      nextTables = normalizeStructuredTables([
        ...nextTables.filter((table) => table.id !== effect.value.id),
        effect.value
      ]);
    }
  }

  return nextTables;
}

const setSelectedCodeBox = StateEffect.define<number | null>();
const setSelectedCodeBoxColumn = StateEffect.define<number>();
const setEditingCodeBox = StateEffect.define<number | null>();
const setCodeBoxOutputs = StateEffect.define<CodeBoxOutput[]>();

interface CodeBoxPresentation {
  selectedBlockFrom: number | null;
  selectedColumn: number;
  editingBlockFrom: number | null;
  outputs: CodeBoxOutput[];
}

interface CodeBoxDecorationState extends CodeBoxPresentation {
  decorations: DecorationSet;
}

class CodeBoxOutputWidget extends WidgetType {
  constructor(
    readonly output: CodeRunState,
    readonly isSelected: boolean,
    readonly isEditing: boolean
  ) {
    super();
  }

  eq(other: CodeBoxOutputWidget) {
    return this.isSelected === other.isSelected &&
      this.isEditing === other.isEditing &&
      this.output.status === other.output.status &&
      this.output.stdout === other.output.stdout &&
      this.output.stderr === other.output.stderr &&
      this.output.exitCode === other.output.exitCode &&
      this.output.message === other.output.message;
  }

  toDOM() {
    const root = document.createElement("section");
    root.className = [
      "cm-code-box-output",
      `is-${this.output.status}`,
      this.isSelected ? "is-selected" : "",
      this.isEditing ? "is-editing" : ""
    ].filter(Boolean).join(" ");
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");

    const header = document.createElement("div");
    header.className = "cm-code-box-output-header";

    const title = document.createElement("span");
    title.textContent = "Output";
    header.appendChild(title);

    const status = document.createElement("span");
    status.textContent = this.output.exitCode === null
      ? this.output.status
      : `exit ${this.output.exitCode}`;
    header.appendChild(status);
    root.appendChild(header);

    const message = document.createElement("div");
    message.className = "cm-code-box-output-message";
    message.textContent = this.output.message;
    root.appendChild(message);

    if (this.output.stdout) {
      const stdout = document.createElement("pre");
      stdout.textContent = this.output.stdout;
      root.appendChild(stdout);
    }

    if (this.output.stderr) {
      const stderr = document.createElement("pre");
      stderr.className = "cm-code-box-stderr";
      stderr.textContent = this.output.stderr;
      root.appendChild(stderr);
    }

    const shortcut = document.createElement("div");
    shortcut.className = "cm-code-box-shortcut";
    shortcut.textContent = "Ctrl+Enter run · Esc select box";
    root.appendChild(shortcut);
    return root;
  }

  ignoreEvent() {
    return true;
  }
}

const idleCodeOutput = (language: CodeLanguage): CodeRunState => ({
  status: "idle",
  stdout: "",
  stderr: "",
  exitCode: null,
  message: `Not run yet. Press Ctrl+Enter to run this ${getCodeLanguageLabel(language)} box.`
});

function buildCodeBoxDecorations(
  doc: Text,
  presentation: CodeBoxPresentation
) {
  const builder = new RangeSetBuilder<Decoration>();

  for (const block of getCodeBlocks(doc)) {
    const isSelected = presentation.selectedBlockFrom === block.blockFrom;
    const isEditing = !isSelected && presentation.editingBlockFrom === block.blockFrom;
    const modeClass = isSelected ? " cm-code-box-selected" : isEditing ? " cm-code-box-editing" : "";
    const openingLine = doc.lineAt(block.openingLineFrom);
    const closingLine = doc.lineAt(block.closingLineFrom);

    for (let lineNumber = openingLine.number; lineNumber <= closingLine.number; lineNumber += 1) {
      const line = doc.line(lineNumber);
      const partClass = lineNumber === openingLine.number
        ? `cm-code-box-header cm-code-box-language-${block.language}`
        : lineNumber === closingLine.number
          ? "cm-code-box-footer"
          : "cm-code-box-source";
      builder.add(
        line.from,
        line.from,
        Decoration.line({ class: `cm-code-box-line ${partClass}${modeClass}` })
      );
    }

    const output = presentation.outputs.find((item) => item.blockFrom === block.blockFrom) ?? idleCodeOutput(block.language);
    builder.add(
      block.blockTo,
      block.blockTo,
      Decoration.widget({
        widget: new CodeBoxOutputWidget(output, isSelected, isEditing),
        block: true,
        side: 1
      })
    );
  }

  return builder.finish();
}

const codeBoxDecorations = StateField.define<CodeBoxDecorationState>({
  create(state) {
    const presentation: CodeBoxPresentation = {
      selectedBlockFrom: null,
      selectedColumn: 0,
      editingBlockFrom: null,
      outputs: []
    };
    return {
      ...presentation,
      decorations: buildCodeBoxDecorations(state.doc, presentation)
    };
  },
  update(previous, transaction) {
    let selectedBlockFrom = previous.selectedBlockFrom;
    let selectedColumn = previous.selectedColumn;
    let editingBlockFrom = previous.editingBlockFrom;
    let outputs = previous.outputs;
    let modeWasExplicitlySet = false;

    if (transaction.docChanged) {
      selectedBlockFrom = selectedBlockFrom === null
        ? null
        : transaction.changes.mapPos(selectedBlockFrom, 1);
      editingBlockFrom = editingBlockFrom === null
        ? null
        : transaction.changes.mapPos(editingBlockFrom, 1);
      outputs = outputs.map((output) => ({
        ...output,
        blockFrom: transaction.changes.mapPos(output.blockFrom, 1)
      }));
    }

    for (const effect of transaction.effects) {
      if (effect.is(setSelectedCodeBox)) {
        selectedBlockFrom = effect.value;
        modeWasExplicitlySet = true;
      } else if (effect.is(setSelectedCodeBoxColumn)) {
        selectedColumn = effect.value;
      } else if (effect.is(setEditingCodeBox)) {
        editingBlockFrom = effect.value;
        modeWasExplicitlySet = true;
      } else if (effect.is(setCodeBoxOutputs)) {
        outputs = effect.value;
      }
    }

    if (
      transaction.selection &&
      !modeWasExplicitlySet
    ) {
      const selectionHead = transaction.state.selection.main.head;
      const selectedBlock = selectedBlockFrom === null
        ? null
        : getCodeBlocks(transaction.state.doc).find(
            (block) => block.blockFrom === selectedBlockFrom
          ) ?? null;
      const editingBlock = getCodeBlockAtPosition(transaction.state.doc, selectionHead);

      if (!selectedBlock || selectionHead !== selectedBlock.blockFrom) {
        selectedBlockFrom = null;
      }

      editingBlockFrom = editingBlock && editingBlock.from <= selectionHead && selectionHead <= editingBlock.to
        ? editingBlock.blockFrom
        : null;
    }

    const presentation = { selectedBlockFrom, selectedColumn, editingBlockFrom, outputs };
    return {
      ...presentation,
      decorations: buildCodeBoxDecorations(
        transaction.state.doc,
        presentation
      )
    };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
});

function getSelectedCodeBlock(view: EditorView) {
  const selectedBlockFrom = view.state.field(codeBoxDecorations).selectedBlockFrom;
  return selectedBlockFrom === null || view.state.selection.main.head !== selectedBlockFrom
    ? null
    : getCodeBlocks(view.state.doc).find((block) => block.blockFrom === selectedBlockFrom) ?? null;
}

function getEditingCodeBlock(view: EditorView) {
  const editingBlockFrom = view.state.field(codeBoxDecorations).editingBlockFrom;
  const block = editingBlockFrom === null
    ? null
    : getCodeBlocks(view.state.doc).find((candidate) => candidate.blockFrom === editingBlockFrom) ?? null;

  if (
    !block ||
    view.state.selection.main.from < block.from ||
    view.state.selection.main.to > block.to
  ) {
    return null;
  }

  return block;
}

function selectCodeBox(view: EditorView, block: CodeBlock) {
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head);
  const selectedColumn = view.state.selection.main.head - cursorLine.from;
  view.dispatch({
    selection: { anchor: block.blockFrom },
    effects: [
      setSelectedCodeBox.of(block.blockFrom),
      setSelectedCodeBoxColumn.of(selectedColumn),
      setEditingCodeBox.of(null)
    ],
    scrollIntoView: true
  });
  return true;
}

function enterSelectedCodeBox(view: EditorView) {
  const block = getSelectedCodeBlock(view);

  if (!block) {
    return false;
  }

  view.dispatch({
    selection: { anchor: block.from },
    effects: [
      setSelectedCodeBox.of(null),
      setEditingCodeBox.of(block.blockFrom)
    ],
    scrollIntoView: true
  });
  return true;
}

function deleteSelectedCodeBox(view: EditorView) {
  const block = getSelectedCodeBlock(view);

  if (!block) {
    return false;
  }

  const deleteTo = block.blockTo < view.state.doc.length &&
    view.state.doc.sliceString(block.blockTo, block.blockTo + 1) === "\n"
    ? block.blockTo + 1
    : block.blockTo;

  view.dispatch({
    changes: { from: block.blockFrom, to: deleteTo, insert: "" },
    selection: { anchor: block.blockFrom },
    effects: [
      setSelectedCodeBox.of(null),
      setEditingCodeBox.of(null)
    ],
    scrollIntoView: true
  });
  return true;
}

function keepDeletionInsideEmptyCodeBox(view: EditorView) {
  const selection = view.state.selection.main;

  if (!selection.empty) {
    return false;
  }

  const block = getEditingCodeBlock(view);
  return !!block && block.code.length === 0 && selection.head === block.from;
}

function movePastSelectedCodeBox(view: EditorView, direction: "up" | "down") {
  const block = getSelectedCodeBlock(view);

  if (!block) {
    return false;
  }

  const openingLine = view.state.doc.lineAt(block.openingLineFrom);
  const closingLine = view.state.doc.lineAt(block.closingLineFrom);
  const selectedColumn = view.state.field(codeBoxDecorations).selectedColumn;

  if (direction === "up" && openingLine.number === 1) {
    view.dispatch({
      changes: { from: 0, to: 0, insert: "\n" },
      selection: { anchor: 0 },
      effects: [setSelectedCodeBox.of(null), setEditingCodeBox.of(null)],
      scrollIntoView: true
    });
    return true;
  }

  if (direction === "down" && closingLine.number === view.state.doc.lines) {
    view.dispatch({
      changes: { from: block.blockTo, to: block.blockTo, insert: "\n" },
      selection: { anchor: block.blockTo + 1 },
      effects: [setSelectedCodeBox.of(null), setEditingCodeBox.of(null)],
      scrollIntoView: true
    });
    return true;
  }

  const anchor = direction === "up"
    ? (() => {
        const targetLine = view.state.doc.line(openingLine.number - 1);
        return targetLine.from + Math.min(selectedColumn, targetLine.length);
      })()
    : (() => {
        const targetLine = view.state.doc.line(closingLine.number + 1);
        return targetLine.from + Math.min(selectedColumn, targetLine.length);
      })();
  view.dispatch({
    selection: { anchor },
    effects: [setSelectedCodeBox.of(null), setEditingCodeBox.of(null)],
    scrollIntoView: true
  });
  return true;
}

function moveOutsideCodeBoxOneLine(view: EditorView, direction: "up" | "down") {
  const selection = view.state.selection.main;

  if (!selection.empty) {
    return false;
  }

  if (getSelectedCodeBlock(view)) {
    return movePastSelectedCodeBox(view, direction);
  }

  if (getCodeSourceBlockAtSelection(view)) {
    return false;
  }

  const cursorLine = view.state.doc.lineAt(selection.head);
  const targetLineNumber = cursorLine.number + (direction === "up" ? -1 : 1);

  if (targetLineNumber < 1 || targetLineNumber > view.state.doc.lines) {
    return true;
  }

  const targetLine = view.state.doc.line(targetLineNumber);
  const targetBlock = getCodeBlockAtPosition(view.state.doc, targetLine.from);

  if (targetBlock) {
    return selectCodeBox(view, targetBlock);
  }

  const column = selection.head - cursorLine.from;
  const anchor = targetLine.from + Math.min(column, targetLine.length);
  view.dispatch({
    selection: { anchor },
    effects: [setSelectedCodeBox.of(null), setEditingCodeBox.of(null)],
    scrollIntoView: true
  });
  return true;
}

function returnToSelectedCodeBox(view: EditorView) {
  const block = getEditingCodeBlock(view) ?? getCodeBlockAtPosition(
    view.state.doc,
    view.state.selection.main.head
  );
  return block ? selectCodeBox(view, block) : false;
}

function getCodeSourceBlockAtSelection(view: EditorView) {
  const selection = view.state.selection.main;

  return getCodeBlocks(view.state.doc).find((block) => (
    block.from <= selection.from && selection.to <= block.to
  )) ?? null;
}

function moveInsideCodeBoxOneLine(view: EditorView, direction: "up" | "down") {
  const selection = view.state.selection.main;
  const block = getCodeSourceBlockAtSelection(view);

  if (!block) {
    return false;
  }

  const currentLine = view.state.doc.lineAt(selection.head);
  const firstLineNumber = view.state.doc.lineAt(block.from).number;
  const lastLineNumber = view.state.doc.lineAt(block.to).number;
  const targetLineNumber = currentLine.number + (direction === "up" ? -1 : 1);

  if (targetLineNumber < firstLineNumber || targetLineNumber > lastLineNumber) {
    return true;
  }

  const targetLine = view.state.doc.line(targetLineNumber);
  const column = selection.head - currentLine.from;
  const anchor = targetLine.from + Math.min(column, targetLine.length);
  view.dispatch({
    selection: { anchor },
    effects: [
      setSelectedCodeBox.of(null),
      setEditingCodeBox.of(block.blockFrom)
    ],
    scrollIntoView: true
  });
  return true;
}

function keepHorizontalArrowInsideCodeBox(view: EditorView, direction: "left" | "right") {
  const selection = view.state.selection.main;
  const block = getCodeSourceBlockAtSelection(view);

  if (!block || !selection.empty) {
    return false;
  }

  return direction === "left" ? selection.head === block.from : selection.head === block.to;
}

function indentInsideCodeBox(view: EditorView) {
  const selection = view.state.selection.main;
  const block = getCodeSourceBlockAtSelection(view);

  if (!block || selection.from < block.from || selection.to > block.to) {
    return false;
  }

  return indentWithTab.run?.(view) ?? false;
}

function getCommandAtCursor(view: EditorView) {
  const selection = view.state.selection.main;

  if (!selection.empty) {
    return null;
  }

  if (getCodeBlockAtPosition(view.state.doc, selection.head)) {
    return null;
  }

  if (getMarkdownTableAtPosition(view.state.doc, selection.head)) {
    return null;
  }

  const line = view.state.doc.lineAt(selection.head);
  const cursorOffset = selection.head - line.from;
  const textBeforeCursor = line.text.slice(0, cursorOffset);
  const match = textBeforeCursor.match(/\/\/([a-z]+)(?:\s+([^/\s]+))?\s*$/i);

  if (!match) {
    return null;
  }

  const commandText = match[0];
  const commandStartOffset = cursorOffset - commandText.length;

  return {
    name: match[1].toLowerCase(),
    argument: match[2]?.trim(),
    from: line.from + commandStartOffset,
    to: selection.head
  };
}

function getAiCommandAtCursor(view: EditorView) {
  const selection = view.state.selection.main;

  if (!selection.empty) {
    return null;
  }

  if (getCodeBlockAtPosition(view.state.doc, selection.head)) {
    return null;
  }

  if (getMarkdownTableAtPosition(view.state.doc, selection.head)) {
    return null;
  }

  const line = view.state.doc.lineAt(selection.head);
  const cursorOffset = selection.head - line.from;
  const textBeforeCursor = line.text.slice(0, cursorOffset);
  const match = textBeforeCursor.match(/\\\\(.+?)\s*$/);

  if (!match) {
    return null;
  }

  const prompt = match[1].trim();

  if (!prompt) {
    return null;
  }

  return {
    prompt,
    from: line.from + (match.index ?? 0),
    to: selection.head,
    lineTo: line.to
  };
}

function normalizeCodeLanguage(language?: string): CodeLanguage | null {
  const normalized = language?.trim().toLowerCase();

  if (!normalized || normalized === "python" || normalized === "py") {
    return "python";
  }

  if (normalized === "c++" || normalized === "cpp") {
    return "cpp";
  }

  return null;
}

function getStructuredTableFormulaMenuQuery(text: string) {
  const match = text.match(/^\/\/([a-z]*)$/i);
  return match ? match[1].toLowerCase() : null;
}

function resolveCodeCommandLanguage(argument?: string, selectedCommandName?: string) {
  const selectedAlias = selectedCommandName
    ?.trim()
    .toLowerCase()
    .match(/^code\s+(.+)$/)?.[1];

  if (!argument) {
    return normalizeCodeLanguage(selectedAlias);
  }

  return normalizeCodeLanguage(argument) ?? (
    selectedAlias ? normalizeCodeLanguage(selectedAlias) : null
  );
}

function getCommandMenuQuery(textBeforeCursor: string) {
  const commandMatch = textBeforeCursor.match(/\/\/([a-z]*)(?:\s+[^/\s]*)?$/i);
  return commandMatch ? commandMatch[0].slice(2).trim().toLowerCase() : null;
}

function getCodeLanguageLabel(language: CodeLanguage) {
  return language === "cpp" ? "C++" : "Python";
}

function getCodeTemplate(language: CodeLanguage) {
  return language === "cpp"
    ? "```cpp\n#include <iostream>\n\nint main() {\n    std::cout << \"Hello from x2pad\";\n    return 0;\n}\n```\n"
    : "```python\nprint(\"Hello from x2pad\")\n```\n";
}

function getCodeBlocks(doc: Text): CodeBlock[] {
  const documentText = doc.toString();
  const fencePattern = /```(python|py|cpp|c\+\+)\s*\n([\s\S]*?)\n```/gi;
  const blocks: CodeBlock[] = [];

  for (const match of documentText.matchAll(fencePattern)) {
    const blockFrom = match.index ?? 0;
    const fullText = match[0] ?? "";
    const language = normalizeCodeLanguage(match[1]);
    const code = match[2] ?? "";

    if (!language) {
      continue;
    }

    const openingLineEnd = fullText.indexOf("\n");
    const codeFrom = blockFrom + openingLineEnd + 1;
    const codeTo = codeFrom + code.length;
    const blockTo = blockFrom + fullText.length;
    blocks.push({
      language,
      code,
      blockFrom,
      blockTo,
      from: codeFrom,
      to: codeTo,
      openingLineFrom: doc.lineAt(blockFrom).from,
      closingLineFrom: doc.lineAt(blockTo).from
    });
  }

  return blocks;
}

function getCodeBlockAtPosition(doc: Text, position: number) {
  return getCodeBlocks(doc).find(
    (block) => block.blockFrom <= position && position <= block.blockTo
  ) ?? null;
}

function isPotentialTableLine(text: string) {
  const trimmed = text.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.split("|").length >= 4;
}

function isMarkdownTableSeparator(text: string) {
  if (!isPotentialTableLine(text)) {
    return false;
  }

  return text
    .trim()
    .slice(1, -1)
    .split("|")
    .every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseTableLineCells(lineText: string, lineFrom: number, rowIndex: number) {
  const cells: TableCell[] = [];
  const pipeIndexes: number[] = [];

  for (let index = 0; index < lineText.length; index += 1) {
    if (lineText[index] === "|") {
      pipeIndexes.push(index);
    }
  }

  for (let index = 0; index < pipeIndexes.length - 1; index += 1) {
    const rawFrom = pipeIndexes[index] + 1;
    const rawTo = pipeIndexes[index + 1];
    const rawText = lineText.slice(rawFrom, rawTo);
    const leadingWhitespace = rawText.match(/^\s*/)?.[0].length ?? 0;
    const trailingWhitespace = rawText.match(/\s*$/)?.[0].length ?? 0;
    const contentFrom = rawFrom + leadingWhitespace;
    const contentTo = rawTo - trailingWhitespace;
    const emptyAnchor = rawFrom + Math.floor(rawText.length / 2);
    const from = lineFrom + (contentFrom <= contentTo ? contentFrom : emptyAnchor);
    const to = lineFrom + (contentFrom <= contentTo ? contentTo : emptyAnchor);

    cells.push({
      text: rawText.trim(),
      rowIndex,
      columnIndex: index,
      from,
      to,
      lineFrom,
      lineTo: lineFrom + lineText.length
    });
  }

  return cells;
}

function getMarkdownTables(doc: Text): TableBlock[] {
  const tables: TableBlock[] = [];
  let lineNumber = 1;

  while (lineNumber <= doc.lines) {
    if (lineNumber + 1 > doc.lines) {
      break;
    }

    const headerLine = doc.line(lineNumber);
    const separatorLine = doc.line(lineNumber + 1);

    if (!isPotentialTableLine(headerLine.text) || !isMarkdownTableSeparator(separatorLine.text)) {
      lineNumber += 1;
      continue;
    }

    const lineFroms = [headerLine.from, separatorLine.from];
    let cursorLineNumber = lineNumber + 2;

    while (cursorLineNumber <= doc.lines) {
      const rowLine = doc.line(cursorLineNumber);

      if (!isPotentialTableLine(rowLine.text) || isMarkdownTableSeparator(rowLine.text)) {
        break;
      }

      lineFroms.push(rowLine.from);
      cursorLineNumber += 1;
    }

    const columnCount = parseTableLineCells(headerLine.text, headerLine.from, -1).length;
    const cells: TableCell[] = [];

    for (let index = 0; index < lineFroms.length; index += 1) {
      if (index === 1) {
        continue;
      }

      const line = doc.lineAt(lineFroms[index]);
      const rowIndex = index === 0 ? -1 : index - 2;
      cells.push(...parseTableLineCells(line.text, line.from, rowIndex));
    }

    const lastLine = doc.lineAt(lineFroms[lineFroms.length - 1]);
    tables.push({
      from: headerLine.from,
      to: lastLine.to,
      headerLineFrom: headerLine.from,
      separatorLineFrom: separatorLine.from,
      lineFroms,
      columnCount,
      cells
    });

    lineNumber = cursorLineNumber;
  }

  return tables;
}

function getMarkdownTableAtPosition(doc: Text, position: number) {
  return getMarkdownTables(doc).find((table) => table.from <= position && position <= table.to) ?? null;
}

function getTableCellAtPosition(doc: Text, position: number) {
  const table = getMarkdownTableAtPosition(doc, position);

  if (!table) {
    return null;
  }

  const cell = table.cells.find((candidate) => (
    candidate.from <= position && position <= candidate.to
  )) ?? table.cells.find((candidate) => (
    candidate.lineFrom <= position &&
    position <= candidate.lineTo &&
    candidate.from <= candidate.to
  ));

  return cell ? { table, cell } : null;
}

function getTableCellByIndexes(table: TableBlock, rowIndex: number, columnIndex: number) {
  return table.cells.find((cell) => cell.rowIndex === rowIndex && cell.columnIndex === columnIndex) ?? null;
}

function getEmptyMarkdownTableRow(columnCount: number) {
  return `| ${Array.from({ length: columnCount }, () => "").join(" | ")} |`;
}

function getMarkdownTableLineCells(text: string) {
  return text
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function getPipeIndexes(text: string) {
  const indexes: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "|") {
      indexes.push(index);
    }
  }

  return indexes;
}

function buildNormalizedTableLines(doc: Text, table: TableBlock) {
  const tableRows = table.lineFroms.map((lineFrom) => {
    const line = doc.lineAt(lineFrom);
    return {
      line,
      cells: getMarkdownTableLineCells(line.text),
      isSeparator: line.from === table.separatorLineFrom
    };
  });
  const widths = Array.from({ length: table.columnCount }, (_, columnIndex) => (
    Math.max(
      3,
      ...tableRows
        .filter((row) => !row.isSeparator)
        .map((row) => row.cells[columnIndex]?.length ?? 0)
    )
  ));

  return tableRows.map((row) => {
    const cells = Array.from({ length: table.columnCount }, (_, columnIndex) => {
      if (row.isSeparator) {
        return "---".padEnd(widths[columnIndex], " ");
      }

      return (row.cells[columnIndex] ?? "").padEnd(widths[columnIndex], " ");
    });

    return `| ${cells.join(" | ")} |`;
  });
}

function normalizeTable(view: EditorView, table: TableBlock) {
  const nextLines = buildNormalizedTableLines(view.state.doc, table);
  const changes = table.lineFroms
    .map((lineFrom, index) => {
      const line = view.state.doc.lineAt(lineFrom);
      const insert = nextLines[index];

      if (line.text === insert) {
        return null;
      }

      return {
        from: line.from,
        to: line.to,
        insert
      };
    })
    .filter((change): change is { from: number; to: number; insert: string } => change !== null);

  if (changes.length === 0) {
    return false;
  }

  view.dispatch({
    changes,
    scrollIntoView: true
  });
  return true;
}

function moveToTableCell(view: EditorView, cell: TableCell) {
  view.dispatch({
    selection: { anchor: cell.from },
    scrollIntoView: true
  });
  return true;
}

function normalizeTableAndMoveToCell(
  view: EditorView,
  table: TableBlock,
  rowIndex: number,
  columnIndex: number
) {
  normalizeTable(view, table);

  const nextTable = getMarkdownTableAtPosition(view.state.doc, table.from);
  const targetCell = nextTable ? getTableCellByIndexes(nextTable, rowIndex, columnIndex) : null;

  if (targetCell) {
    return moveToTableCell(view, targetCell);
  }

  return true;
}

function normalizeTableAndKeepCursor(view: EditorView, table: TableBlock, cell: TableCell, cursorPosition: number) {
  const cellOffset = Math.max(0, cursorPosition - cell.from);

  if (!normalizeTable(view, table)) {
    return false;
  }

  const nextTable = getMarkdownTableAtPosition(view.state.doc, table.from);
  const nextCell = nextTable ? getTableCellByIndexes(nextTable, cell.rowIndex, cell.columnIndex) : null;

  if (nextCell) {
    view.dispatch({
      selection: { anchor: Math.min(nextCell.to, nextCell.from + cellOffset) },
      scrollIntoView: true
    });
  }

  return true;
}

function tableWasChanged(changes: ChangeSet, table: TableBlock) {
  let changed = false;

  changes.iterChanges((_fromA: number, _toA: number, fromB: number, toB: number) => {
    if (fromB <= table.to && toB >= table.from) {
      changed = true;
    }
  });

  return changed;
}

function moveTableCell(view: EditorView, direction: "next" | "previous" | "up" | "down") {
  const context = getTableCellAtPosition(view.state.doc, view.state.selection.main.head);

  if (!context) {
    return false;
  }

  const { table, cell } = context;
  let targetRow = cell.rowIndex;
  let targetColumn = cell.columnIndex;

  if (direction === "next") {
    targetColumn += 1;
    if (targetColumn >= table.columnCount) {
      targetColumn = 0;
      targetRow += 1;
    }
  } else if (direction === "previous") {
    targetColumn -= 1;
    if (targetColumn < 0) {
      targetColumn = table.columnCount - 1;
      targetRow -= 1;
    }
  } else {
    targetRow += direction === "down" ? 1 : -1;
  }

  if (targetRow < -1) {
    return false;
  }

  const targetCell = getTableCellByIndexes(table, targetRow, targetColumn);
  return targetCell
    ? normalizeTableAndMoveToCell(view, table, targetCell.rowIndex, targetCell.columnIndex)
    : false;
}

function addTableRowAfter(view: EditorView, table: TableBlock, columnIndex: number) {
  const insert = `\n${getEmptyMarkdownTableRow(table.columnCount)}`;

  view.dispatch({
    changes: { from: table.to, to: table.to, insert },
    selection: { anchor: table.to + insert.length },
    scrollIntoView: true
  });

  const nextTable = getMarkdownTableAtPosition(view.state.doc, table.from);
  const targetCell = nextTable
    ? getTableCellByIndexes(nextTable, nextTable.lineFroms.length - 3, columnIndex)
    : null;

  return nextTable && targetCell
    ? normalizeTableAndMoveToCell(view, nextTable, targetCell.rowIndex, targetCell.columnIndex)
    : true;
}

function moveTableCellOrAddRow(view: EditorView) {
  const context = getTableCellAtPosition(view.state.doc, view.state.selection.main.head);

  if (!context) {
    return false;
  }

  const { table, cell } = context;

  if (cell.rowIndex < 0) {
    return moveTableCell(view, "down");
  }

  const nextCell = getTableCellByIndexes(table, cell.rowIndex + 1, cell.columnIndex);
  return nextCell
    ? normalizeTableAndMoveToCell(view, table, nextCell.rowIndex, nextCell.columnIndex)
    : addTableRowAfter(view, table, cell.columnIndex);
}

function addTableColumnAfter(view: EditorView) {
  const context = getTableCellAtPosition(view.state.doc, view.state.selection.main.head);

  if (!context) {
    return false;
  }

  const { table, cell } = context;
  const changes = table.lineFroms
    .map((lineFrom) => {
      const line = view.state.doc.lineAt(lineFrom);
      const pipeIndexes = getPipeIndexes(line.text);
      const isLastColumn = cell.columnIndex >= table.columnCount - 1;
      const insertAt = isLastColumn
        ? line.to
        : line.from + pipeIndexes[cell.columnIndex + 1] + 1;
      const insert = lineFrom === table.headerLineFrom
        ? " New Column |"
        : lineFrom === table.separatorLineFrom
          ? " --- |"
          : "  |";

      return {
        from: insertAt,
        to: insertAt,
        insert
      };
    });

  view.dispatch({
    changes,
    scrollIntoView: true
  });

  const nextTable = getMarkdownTableAtPosition(view.state.doc, table.from);
  const targetCell = nextTable
    ? getTableCellByIndexes(nextTable, cell.rowIndex, cell.columnIndex + 1)
    : null;

  return nextTable && targetCell
    ? normalizeTableAndMoveToCell(view, nextTable, targetCell.rowIndex, targetCell.columnIndex)
    : true;
}

function moveTableCellAtHorizontalBoundary(view: EditorView, direction: "left" | "right") {
  const selection = view.state.selection.main;

  if (!selection.empty) {
    return false;
  }

  const context = getTableCellAtPosition(view.state.doc, selection.head);

  if (!context) {
    return false;
  }

  const { cell } = context;

  if (direction === "left" && selection.head <= cell.from) {
    return moveTableCell(view, "previous");
  }

  if (direction === "right" && selection.head >= cell.to) {
    return moveTableCell(view, "next");
  }

  return false;
}

const legacyMarkdownTableImplementation = {
  tableDecorations,
  normalizeTableAndKeepCursor,
  tableWasChanged,
  moveTableCellOrAddRow,
  addTableColumnAfter,
  moveTableCellAtHorizontalBoundary
};

function columnLettersToIndex(letters: string) {
  return letters.toUpperCase().split("").reduce((total, letter) => (
    total * 26 + letter.charCodeAt(0) - 64
  ), 0) - 1;
}

function parseTableFormula(text: string) {
  const match = text.trim().match(/^\/\/(sum|avg|mean|median|min|max|count)\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)$/i);

  if (!match) {
    return null;
  }

  return {
    operation: match[1].toLowerCase(),
    fromColumn: columnLettersToIndex(match[2]),
    fromRow: Number(match[3]) - 1,
    toColumn: columnLettersToIndex(match[4]),
    toRow: Number(match[5]) - 1
  };
}

function parseStructuredTableFormula(commandName: string, commandArgument: string) {
  const operation = commandName.toLowerCase();

  if (!["sum", "avg", "mean", "median", "min", "max", "count"].includes(operation)) {
    return null;
  }

  const match = commandArgument.match(/^\(?([A-Z]+)(\d+):([A-Z]+)(\d+)\)?$/i);

  if (!match) {
    return null;
  }

  return {
    operation,
    fromColumn: columnLettersToIndex(match[1]),
    fromRow: Number(match[2]) - 1,
    toColumn: columnLettersToIndex(match[3]),
    toRow: Number(match[4]) - 1
  };
}

function evaluateStructuredTableFormula(
  table: StructuredTable,
  formula: NonNullable<ReturnType<typeof parseStructuredTableFormula>>
) {
  const normalizedTable = normalizeStructuredTable(table);
  const result = evaluateStructuredTableFormulaValue(
    normalizedTable,
    formula,
    new Set<string>(),
    new Map<string, StructuredTableNumericResult>()
  );

  return result.kind === "number" ? String(result.value) : null;
}

type StructuredTableNumericResult =
  | { kind: "number"; value: number }
  | { kind: "empty" }
  | { kind: "error"; code: "CYCLE" | "VALUE" };

function resolveStructuredTableNumericCell(
  table: StructuredTable,
  rowIndex: number,
  columnIndex: number,
  visiting: Set<string>,
  cache: Map<string, StructuredTableNumericResult>
): StructuredTableNumericResult {
  const key = `${rowIndex}:${columnIndex}`;
  const cached = cache.get(key);

  if (cached) {
    return cached;
  }
  if (visiting.has(key)) {
    return { kind: "error", code: "CYCLE" };
  }

  const cell = table.rows[rowIndex]?.[columnIndex];
  if (!cell) {
    return { kind: "empty" };
  }

  const formula = cell.formula ? parseTableFormula(cell.formula) : null;
  if (cell.formula && !formula) {
    return { kind: "error", code: "VALUE" };
  }

  let result: StructuredTableNumericResult;
  if (formula) {
    visiting.add(key);
    result = evaluateStructuredTableFormulaValue(table, formula, visiting, cache);
    visiting.delete(key);
  } else {
    const cellText = cell.text.trim().replace(/,/g, "");
    const value = Number(cellText);
    result = cellText && Number.isFinite(value)
      ? { kind: "number", value }
      : { kind: "empty" };
  }

  cache.set(key, result);
  return result;
}

function evaluateStructuredTableFormulaValue(
  table: StructuredTable,
  formula: NonNullable<ReturnType<typeof parseStructuredTableFormula>>,
  visiting: Set<string>,
  cache: Map<string, StructuredTableNumericResult>
): StructuredTableNumericResult {
  const fromRow = Math.min(formula.fromRow, formula.toRow);
  const toRow = Math.max(formula.fromRow, formula.toRow);
  const fromColumn = Math.min(formula.fromColumn, formula.toColumn);
  const toColumn = Math.max(formula.fromColumn, formula.toColumn);
  const values: number[] = [];

  if (
    fromRow < 0 ||
    fromColumn < 0 ||
    toRow >= table.rows.length ||
    toColumn >= table.columns.length
  ) {
    return { kind: "error", code: "VALUE" };
  }

  for (let rowIndex = fromRow; rowIndex <= toRow; rowIndex += 1) {
    for (let columnIndex = fromColumn; columnIndex <= toColumn; columnIndex += 1) {
      const result = resolveStructuredTableNumericCell(table, rowIndex, columnIndex, visiting, cache);
      if (result.kind === "error") {
        return result;
      }
      if (result.kind === "number") {
        values.push(result.value);
      }
    }
  }

  if (values.length === 0) {
    return { kind: "empty" };
  }

  if (formula.operation === "count") {
    return { kind: "number", value: values.length };
  }

  if (formula.operation === "sum") {
    return { kind: "number", value: values.reduce((total, value) => total + value, 0) };
  }

  if (formula.operation === "avg" || formula.operation === "mean") {
    return {
      kind: "number",
      value: values.reduce((total, value) => total + value, 0) / values.length
    };
  }

  if (formula.operation === "min") {
    return { kind: "number", value: Math.min(...values) };
  }

  if (formula.operation === "max") {
    return { kind: "number", value: Math.max(...values) };
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sortedValues.length / 2);

  return {
    kind: "number",
    value: sortedValues.length % 2 === 0
      ? (sortedValues[middle - 1] + sortedValues[middle]) / 2
      : sortedValues[middle]
  };
}

function recalculateStructuredTableFormulas(table: StructuredTable): StructuredTable {
  const normalizedTable = normalizeStructuredTable(table);
  const cache = new Map<string, StructuredTableNumericResult>();

  return {
    ...normalizedTable,
    rows: normalizedTable.rows.map((row, rowIndex) => row.map((cell, columnIndex) => {
      if (!cell.formula) {
        return cell;
      }

      const result = resolveStructuredTableNumericCell(
        normalizedTable,
        rowIndex,
        columnIndex,
        new Set<string>(),
        cache
      );
      const text = result.kind === "number"
        ? String(result.value)
        : result.kind === "error" && result.code === "CYCLE"
          ? "#CYCLE!"
          : "#VALUE!";

      return {
        ...cell,
        text,
        styles: []
      };
    }))
  };
}

function syncStructuredTableFormulaDisplays(table: StructuredTable) {
  table.rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      if (!cell.formula) {
        return;
      }

      const editor = document.querySelector<HTMLElement>(getStructuredTableCellSelector({
        tableId: table.id,
        rowIndex,
        columnIndex
      }));
      if (!editor) {
        return;
      }

      editor.dataset.formula = cell.formula;
      editor.dataset.computedValue = cell.text;
      if (document.activeElement !== editor) {
        editor.textContent = cell.text;
      }
    });
  });
}

function normalizeStructuredTable(table: StructuredTable): StructuredTable {
  return {
    ...table,
    rows: table.rows.map((row) => (
      table.columns.map((_, columnIndex) => row[columnIndex] ?? { text: "", styles: [] })
    ))
  };
}

function normalizeStructuredTables(tables: StructuredTable[]) {
  return tables.map(recalculateStructuredTableFormulas);
}

function evaluateTableFormula(table: TableBlock, formula: NonNullable<ReturnType<typeof parseTableFormula>>) {
  const fromRow = Math.min(formula.fromRow, formula.toRow);
  const toRow = Math.max(formula.fromRow, formula.toRow);
  const fromColumn = Math.min(formula.fromColumn, formula.toColumn);
  const toColumn = Math.max(formula.fromColumn, formula.toColumn);
  const values: number[] = [];

  for (let row = fromRow; row <= toRow; row += 1) {
    for (let column = fromColumn; column <= toColumn; column += 1) {
      const cell = getTableCellByIndexes(table, row, column);
      const cellText = cell?.text.trim().replace(/,/g, "") ?? "";

      if (!cellText) {
        continue;
      }

      const value = Number(cellText);

      if (Number.isFinite(value)) {
        values.push(value);
      }
    }
  }

  if (values.length === 0) {
    return null;
  }

  if (formula.operation === "count") {
    return String(values.length);
  }

  if (formula.operation === "sum") {
    return String(values.reduce((total, value) => total + value, 0));
  }

  if (formula.operation === "avg" || formula.operation === "mean") {
    return String(values.reduce((total, value) => total + value, 0) / values.length);
  }

  if (formula.operation === "min") {
    return String(Math.min(...values));
  }

  if (formula.operation === "max") {
    return String(Math.max(...values));
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? String((sorted[middle - 1] + sorted[middle]) / 2)
    : String(sorted[middle]);
}

function getSafeFileName(title: string, extension: "x2" | "pdf") {
  const baseName = title
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim() || "Untitled Note";

  return `${baseName}.${extension}`;
}

function getMarkdownHeadings(documentText: string) {
  const headings: { title: string; from: number; to: number; level: number }[] = [];
  let offset = 0;

  for (const line of documentText.split("\n")) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);

    if (match) {
      headings.push({
        title: match[2],
        from: offset,
        to: offset + line.length,
        level: match[1].length
      });
    }

    offset += line.length + 1;
  }

  return headings;
}

function getNearestPreviousHeading(documentText: string, anchor: number) {
  const previousHeadings = getMarkdownHeadings(documentText)
    .filter((heading) => heading.from <= anchor);

  return previousHeadings[previousHeadings.length - 1];
}

function getAiPlacementLabel(placement: AiPlacement) {
  if (placement.heading) {
    return `${placement.label} "${placement.heading}"`;
  }

  return placement.label;
}

function getPlacementFromModelSuggestion(
  suggestion: AiModelPlacement | undefined,
  documentText: string,
  anchor: number
): AiPlacement | null {
  if (!suggestion?.mode) {
    return null;
  }

  if (suggestion.mode === "after-nearest-heading") {
    const heading = suggestion.heading
      ? getMarkdownHeadings(documentText).find((candidate) => (
        candidate.title.toLowerCase() === suggestion.heading?.toLowerCase()
      ))
      : getNearestPreviousHeading(documentText, anchor);

    return {
      mode: "after-nearest-heading",
      label: "insert after section",
      heading: heading?.title
    };
  }

  const labels: Record<Exclude<AiPlacementMode, "after-nearest-heading">, string> = {
    "command-location": "insert where command was typed",
    "current-cursor": "insert at cursor",
    "below-current-line": "insert below current line",
    "end-of-document": "append to note"
  };

  return {
    mode: suggestion.mode,
    label: labels[suggestion.mode]
  };
}

function getAiPlacements(documentText: string, anchor: number, modelPlacement?: AiModelPlacement) {
  const nearestHeading = getNearestPreviousHeading(documentText, anchor);
  const placements: AiPlacement[] = [
    {
      mode: "command-location",
      label: "insert where command was typed"
    },
    {
      mode: "below-current-line",
      label: "insert below current line"
    },
    {
      mode: "current-cursor",
      label: "insert at cursor"
    },
    {
      mode: "end-of-document",
      label: "append to note"
    }
  ];

  if (nearestHeading) {
    placements.splice(1, 0, {
      mode: "after-nearest-heading",
      label: "insert after section",
      heading: nearestHeading.title
    });
  }

  const preferredPlacement = getPlacementFromModelSuggestion(modelPlacement, documentText, anchor);

  if (!preferredPlacement) {
    return placements;
  }

  return [
    preferredPlacement,
    ...placements.filter((placement) => (
      placement.mode !== preferredPlacement.mode ||
      placement.heading !== preferredPlacement.heading
    ))
  ];
}

function stripJsonCodeFence(text: string) {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function parseAiModelResponse(text: string): AiModelResponse {
  try {
    const parsed = JSON.parse(stripJsonCodeFence(text)) as Partial<AiModelResponse>;

    if (typeof parsed.answer === "string" && parsed.answer.trim()) {
      return {
        answer: parsed.answer.trim(),
        placement: parsed.placement
      };
    }
  } catch {
    // Fall back to treating the model text as the answer.
  }

  return {
    answer: text.trim()
  };
}

function buildAiInstruction(prompt: string, documentText: string, anchor: number) {
  const lineStart = documentText.lastIndexOf("\n", Math.max(0, anchor - 1)) + 1;
  const nextLineBreak = documentText.indexOf("\n", anchor);
  const lineEnd = nextLineBreak === -1 ? documentText.length : nextLineBreak;
  const surroundingStart = Math.max(0, documentText.lastIndexOf("\n\n", Math.max(0, anchor - 1)));
  const surroundingEndRaw = documentText.indexOf("\n\n", anchor);
  const surroundingEnd = surroundingEndRaw === -1 ? documentText.length : surroundingEndRaw;
  const headings = getMarkdownHeadings(documentText).map((heading) => heading.title);

  return [
    "You are the AI writing assistant inside x2pad, a keyboard-first note editor.",
    "Use the document as context, then answer the user's prompt.",
    "Also suggest where the response should be inserted.",
    "Return only valid JSON with this shape:",
    "{\"answer\":\"...\",\"placement\":{\"mode\":\"command-location|below-current-line|after-nearest-heading|end-of-document\",\"heading\":\"optional exact heading\"}}",
    "",
    `User prompt: ${prompt}`,
    `Cursor offset after command removal: ${anchor}`,
    `Active line: ${documentText.slice(lineStart, lineEnd) || "(blank line)"}`,
    `Nearby paragraph: ${documentText.slice(surroundingStart, surroundingEnd).trim() || "(none)"}`,
    `Headings: ${headings.length ? headings.join(" | ") : "(none)"}`,
    "",
    "Full document:",
    documentText || "(empty document)"
  ].join("\n");
}

function getMockAiResponse(prompt: string): AiModelResponse {
  return {
    answer: [
      `AI draft for: ${prompt}`,
      "",
      "This is a local preview response so you can test the keyboard flow. Save a Gemini API key to generate a real answer with full document context."
    ].join("\n"),
    placement: {
      mode: "command-location"
    }
  };
}

function getGeminiText(responseBody: any) {
  const parts = responseBody?.candidates?.[0]?.content?.parts;

  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => typeof part?.text === "string" ? part.text : "")
    .join("")
    .trim();
}

async function requestGeminiAiResponse(apiKey: string, prompt: string, documentText: string, anchor: number) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: buildAiInstruction(prompt, documentText, anchor)
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: "application/json"
        }
      })
    }
  );

  const responseBody = await response.json().catch(() => null);

  if (!response.ok) {
    const message = responseBody?.error?.message || `Gemini request failed (${response.status}).`;
    throw new Error(message);
  }

  const text = getGeminiText(responseBody);

  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  return parseAiModelResponse(text);
}

function ensurePathExtension(path: string, extension: "x2" | "pdf") {
  return path.toLowerCase().endsWith(`.${extension}`) ? path : `${path}.${extension}`;
}

function getPathKey(path: string) {
  return path.replace(/\\/g, "/").toLowerCase();
}

function getSavedNoteMeta(savedAt: string) {
  const savedDate = new Date(savedAt);
  return Number.isNaN(savedDate.getTime()) ? "Saved note" : savedDate.toLocaleDateString();
}

function joinFolderPath(folder: string, fileName: string) {
  return `${folder.replace(/[\\/]+$/, "")}/${fileName}`;
}

function getNoteTitleFromPath(path: string) {
  const fileName = path.split(/[\\/]/).pop() ?? "";
  return fileName.replace(/\.x2$/i, "").trim() || EMPTY_NOTE_TITLE;
}

function getCommandMenuPosition(
  coords: { top: number; bottom: number; left: number },
  commandCount: number
) {
  const estimatedMenuHeight = Math.min(
    COMMAND_MENU_MAX_HEIGHT,
    COMMAND_MENU_PADDING + Math.max(1, commandCount) * COMMAND_MENU_ITEM_HEIGHT
  );
  const belowTop = coords.bottom + COMMAND_MENU_VERTICAL_GAP;
  const aboveTop = Math.max(
    COMMAND_MENU_VERTICAL_GAP,
    coords.top - COMMAND_MENU_VERTICAL_GAP - estimatedMenuHeight
  );
  const hasEnoughSpaceBelow = belowTop + estimatedMenuHeight <= window.innerHeight - COMMAND_MENU_VERTICAL_GAP;

  return {
    top: hasEnoughSpaceBelow ? belowTop : aboveTop,
    left: coords.left,
    placement: hasEnoughSpaceBelow ? "below" : "above"
  } as const;
}

function getListLineInfo(lineText: string) {
  const numberedMatch = lineText.match(/^([ \t]*)(\d+)\.\s/);

  if (numberedMatch) {
    return {
      indentation: numberedMatch[1],
      markerLength: numberedMatch[0].length,
      nextMarker: `${numberedMatch[1]}${Number(numberedMatch[2]) + 1}. `
    };
  }

  const bulletMatch = lineText.match(/^([ \t]*)(?:[-*]|\u2022)\s/);

  if (bulletMatch) {
    return {
      indentation: bulletMatch[1],
      markerLength: bulletMatch[0].length,
      nextMarker: `${bulletMatch[1]}${BULLET_LIST_MARKER}`
    };
  }

  return null;
}

function continueListAtCursor(view: EditorView) {
  const selection = view.state.selection.main;

  if (!selection.empty) {
    return false;
  }

  const line = view.state.doc.lineAt(selection.head);
  const listLine = getListLineInfo(line.text);
  const cursorOffset = selection.head - line.from;

  if (!listLine || cursorOffset < listLine.markerLength) {
    return false;
  }

  const contentAfterMarker = line.text.slice(listLine.markerLength).trim();

  if (!contentAfterMarker) {
    view.dispatch({
      changes: {
        from: line.from,
        to: line.from + listLine.markerLength,
        insert: ""
      },
      selection: { anchor: line.from }
    });
    return true;
  }

  const insert = `\n${listLine.nextMarker}`;

  view.dispatch({
    changes: {
      from: selection.head,
      to: selection.head,
      insert
    },
    selection: { anchor: selection.head + insert.length }
  });
  return true;
}

function deleteListMarkerAtCursor(view: EditorView) {
  const selection = view.state.selection.main;

  if (!selection.empty) {
    return false;
  }

  const line = view.state.doc.lineAt(selection.head);
  const listLine = getListLineInfo(line.text);
  const cursorOffset = selection.head - line.from;

  if (!listLine || cursorOffset !== listLine.markerLength) {
    return false;
  }

  view.dispatch({
    changes: {
      from: line.from,
      to: line.from + listLine.markerLength,
      insert: ""
    },
    selection: { anchor: line.from }
  });
  return true;
}

function WindowControls() {
  const isTauri = "__TAURI_INTERNALS__" in window;

  const runWindowAction = async (action: "minimize" | "maximize" | "close") => {
    if (!isTauri) return;

    const appWindow = getCurrentWindow();

    if (action === "minimize") {
      await appWindow.minimize();
    } else if (action === "maximize") {
      await appWindow.toggleMaximize();
    } else {
      await appWindow.close();
    }
  };

  return (
    <div className="window-controls">
      <button type="button" className="window-control" onClick={() => runWindowAction("minimize")} aria-label="Minimize">
        <span />
      </button>
      <button type="button" className="window-control" onClick={() => runWindowAction("maximize")} aria-label="Maximize">
        <span />
      </button>
      <button type="button" className="window-control close" onClick={() => runWindowAction("close")} aria-label="Close">
        <span />
      </button>
    </div>
  );
}

function Editor() {
  void legacyMarkdownTableImplementation;

  const sidebarRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const pendingStyleRestoreRef = useRef<PendingStyleRestore | null>(null);
  const styleRangesRef = useRef<TextStyleRange[]>([]);
  const forcedStyleRangesRef = useRef<TextStyleRange[] | null>(null);
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);
  const activeStructuredCellRef = useRef<StructuredTableCellTarget | null>(null);
  const structuredTableModeRef = useRef<"navigating" | "editing" | null>(null);
  const structuredTableSelectionModeRef = useRef<StructuredTableSelectionMode>("cell");
  const tableShiftWasUsedRef = useRef(false);
  const structuredTablesRef = useRef<StructuredTable[]>([]);
  const openedNotesRef = useRef<LoadedX2Note[]>([]);
  const openedNoteTitleRef = useRef<string | null>(null);
  const openedNotePathRef = useRef<string | null>(null);
  const valueRef = useRef("");
  const autoSaveTimersRef = useRef(new Map<string, number>());
  const autoSaveVersionsRef = useRef(new Map<string, number>());
  const noteSaveQueuesRef = useRef(new Map<string, Promise<void>>());
  const isEditorMountedRef = useRef(true);
  const pendingOpenedContentRef = useRef<{ pathKey: string; content: string } | null>(null);

  const [openedNoteTitle, setOpenedNoteTitle] = useState<string | null>(null);
  const [openedNotePath, setOpenedNotePath] = useState<string | null>(null);
  const [openedNotes, setOpenedNotes] = useState<LoadedX2Note[]>([]);
  const [value, setValue] = useState("");
  const [searchValue, setSearchValue] = useState("");
  const [sidebarSelection, setSidebarSelection] = useState(1);
  const [showLogoPane, setShowLogoPane] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [tableFormulaMenu, setTableFormulaMenu] = useState<StructuredTableFormulaMenuState | null>(null);
  const [selectedTableFormulaIndex, setSelectedTableFormulaIndex] = useState(0);
  const [commandFeedback, setCommandFeedback] = useState<CommandFeedback | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; placement: "below" | "above" }>({
    top: 0,
    left: 0,
    placement: "below"
  });
  const [fileStatus, setFileStatus] = useState("Ready");
  const [fileStatusKind, setFileStatusKind] = useState<"idle" | "success" | "error">("idle");
  const [showApiKeyPrompt, setShowApiKeyPrompt] = useState(false);
  const [setupStep, setSetupStep] = useState<SetupStep>(null);
  const [setupStatus, setSetupStatus] = useState("");
  const [isSelectingNoteFolder, setIsSelectingNoteFolder] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyStatus, setApiKeyStatus] = useState("");
  const [isSavingApiKey, setIsSavingApiKey] = useState(false);
  const [aiSession, setAiSession] = useState<AiSession | null>(null);
  const [codeRuns, setCodeRuns] = useState<CodeBoxOutput[]>([]);
  const [, setStructuredTables] = useState<StructuredTable[]>([]);
  const [tableRenderRevision, setTableRenderRevision] = useState(0);

  const [selectedFont, setSelectedFont] = useState("Body");
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [textColor, setTextColor] = useState("White");
  const [isBold, setBold] = useState(false);
  const [isItalic, setItalic] = useState(false);
  const [isStrike, setStrike] = useState(false);
  const [isUnderline, setUnderline] = useState(false);

  const filteredNotes = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    if (!query) return openedNotes;
    return openedNotes.filter((note) => note.title.toLowerCase().includes(query));
  }, [openedNotes, searchValue]);

  const activeNoteTitle = openedNoteTitle ?? EMPTY_NOTE_TITLE;
  const visibleCommands = useMemo(() => {
    return getCommandSuggestions(commandQuery);
  }, [commandQuery]);
  const visibleTableFormulas = useMemo(() => (
    getTableFormulaSuggestions(tableFormulaMenu?.query ?? "")
  ), [tableFormulaMenu?.query]);

  useEffect(() => {
    if (!commandFeedback) {
      return;
    }

    const timeout = window.setTimeout(() => setCommandFeedback(null), 2800);
    return () => window.clearTimeout(timeout);
  }, [commandFeedback]);

  const focusEditorAtStart = useCallback(() => {
    setShowLogoPane(false);
    setShowCommands(false);
    setCommandQuery("");

    requestAnimationFrame(() => {
      const editorView = editorViewRef.current;
      if (!editorView) return;

      editorView.dispatch({
        selection: { anchor: 0 },
        scrollIntoView: true
      });
      editorView.focus();
    });
  }, []);

  const focusSidebarOnActiveNote = useCallback(() => {
    const activePathKey = getPathKey(openedNotePath ?? "");
    const activeNoteIndex = filteredNotes.findIndex((note) => getPathKey(note.path) === activePathKey);

    if (activeNoteIndex >= 0) {
      setSidebarSelection(activeNoteIndex + 2);
      setShowLogoPane(false);
    }

    setShowCommands(false);
    setCommandQuery("");

    requestAnimationFrame(() => {
      sidebarRef.current?.focus();
    });
  }, [filteredNotes, openedNotePath]);

  const openLoadedX2Note = useCallback((note: LoadedX2Note) => {
    pendingStyleRestoreRef.current = {
      content: note.content,
      styles: note.styles ?? []
    };
    const noteTitle = note.title || "Untitled Note";
    openedNoteTitleRef.current = noteTitle;
    openedNotePathRef.current = note.path;
    valueRef.current = note.content;
    pendingOpenedContentRef.current = { pathKey: getPathKey(note.path), content: note.content };
    setOpenedNoteTitle(noteTitle);
    setOpenedNotePath(note.path);
    setValue(note.content);
    const loadedTables = normalizeStructuredTables(note.tables ?? []);
    structuredTablesRef.current = loadedTables;
    setStructuredTables(loadedTables);
    setTableRenderRevision((revision) => revision + 1);
    setCodeRuns([]);
    setShowLogoPane(false);
    setShowCommands(false);
    setCommandQuery("");
    setFileStatus("Opened .x2 file.");
    setFileStatusKind("success");
  }, []);

  const cacheCurrentOpenedNote = useCallback(() => {
    const currentPath = openedNotePathRef.current;
    if (!currentPath) {
      return openedNotesRef.current;
    }

    const activePathKey = getPathKey(currentPath);
    const currentStyles = styleRangesRef.current.map((range) => ({
      ...range,
      style: { ...range.style }
    }));

    const nextNotes = openedNotesRef.current.map((note) => (
      getPathKey(note.path) === activePathKey
        ? {
            ...note,
            title: openedNoteTitleRef.current || note.title,
            content: valueRef.current,
            styles: currentStyles,
            tables: structuredTablesRef.current
          }
        : note
    ));
    openedNotesRef.current = nextNotes;
    setOpenedNotes(nextNotes);
    return nextNotes;
  }, []);

  const activateOpenedNote = useCallback((path: string) => {
    const targetPathKey = getPathKey(path);

    if (getPathKey(openedNotePathRef.current ?? "") === targetPathKey) {
      setShowLogoPane(false);
      setShowCommands(false);
      setCommandQuery("");
      return;
    }

    const cachedNotes = cacheCurrentOpenedNote();
    const targetNote = cachedNotes.find((note) => getPathKey(note.path) === targetPathKey);
    if (!targetNote) {
      return;
    }

    openLoadedX2Note(targetNote);
  }, [cacheCurrentOpenedNote, openLoadedX2Note]);

  const openLoadedX2Folder = useCallback((folder: LoadedX2Folder) => {
    const activePathKey = getPathKey(folder.activePath);
    const activeNote = folder.notes.find((note) => getPathKey(note.path) === activePathKey)
      ?? folder.notes[0];

    if (!activeNote) {
      openedNotesRef.current = [];
      openedNoteTitleRef.current = null;
      openedNotePathRef.current = null;
      valueRef.current = "";
      setOpenedNotes([]);
      setOpenedNoteTitle(null);
      setOpenedNotePath(null);
      pendingStyleRestoreRef.current = {
        content: "",
        styles: []
      };
      setValue("");
      structuredTablesRef.current = [];
      setStructuredTables([]);
      setTableRenderRevision((revision) => revision + 1);
      setCodeRuns([]);
      setShowLogoPane(true);
      setShowCommands(false);
      setCommandQuery("");
      setFileStatus("Notes folder selected. Create your first note.");
      setFileStatusKind("success");
      return;
    }

    openedNotesRef.current = folder.notes;
    setOpenedNotes(folder.notes);
    openLoadedX2Note(activeNote);
    setFileStatus(`Opened ${folder.notes.length} note${folder.notes.length === 1 ? "" : "s"} from folder.`);
  }, [openLoadedX2Note]);

  const showSearchPane = useCallback(() => {
    setSidebarSelection(0);
    setShowLogoPane(true);
    setShowCommands(false);
    setCommandQuery("");
  }, []);

  const selectNoteFolder = useCallback(async () => {
    const isTauri = "__TAURI_INTERNALS__" in window;

    if (!isTauri) {
      setSetupStatus("Folder setup requires the desktop app.");
      return;
    }

    setIsSelectingNoteFolder(true);
    setSetupStatus("");

    try {
      const selectedPath = await open({
        directory: true,
        multiple: false,
        title: "Choose x2pad notes folder"
      });

      if (!selectedPath || Array.isArray(selectedPath)) {
        setSetupStatus("Choose a folder to continue.");
        return;
      }

      const folder = await invoke<LoadedX2Folder>("set_note_folder", { path: selectedPath });
      openLoadedX2Folder(folder);
      const hasGeminiKey = await invoke<boolean>("has_gemini_api_key").catch(() => false);

      setSetupStatus("");
      setSetupStep(hasGeminiKey ? null : "gemini");
    } catch (error) {
      setSetupStatus(String(error));
    } finally {
      setIsSelectingNoteFolder(false);
    }
  }, [openLoadedX2Folder]);

  const saveGeminiApiKey = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedApiKey = apiKeyInput.trim();

    if (!trimmedApiKey) {
      setApiKeyStatus("Enter a key to continue.");
      return;
    }

    setIsSavingApiKey(true);
    setApiKeyStatus("");

    try {
      const isTauri = "__TAURI_INTERNALS__" in window;

      if (isTauri) {
        await invoke("save_gemini_api_key", { apiKey: trimmedApiKey });
      } else {
        window.localStorage.setItem(BROWSER_GEMINI_API_KEY_STORAGE_KEY, trimmedApiKey);
      }

      setApiKeyInput("");
      setShowApiKeyPrompt(false);
      if (setupStep === "gemini") {
        setSetupStep(null);
      }
      setFileStatus("Gemini key saved.");
      setFileStatusKind("success");
    } catch (error) {
      setApiKeyStatus(String(error));
    } finally {
      setIsSavingApiKey(false);
    }
  }, [apiKeyInput, setupStep]);

  const getSavedGeminiApiKey = useCallback(async () => {
    const isTauri = "__TAURI_INTERNALS__" in window;

    if (isTauri) {
      return (await invoke<string | null>("get_gemini_api_key"))?.trim() ?? "";
    }

    return window.localStorage.getItem(BROWSER_GEMINI_API_KEY_STORAGE_KEY)?.trim() ?? "";
  }, []);

  const updateStructuredCell = useCallback((
    tableId: string,
    rowIndex: number,
    columnIndex: number,
    updater: (cell: StructuredTableCell) => StructuredTableCell
  ) => {
    const nextTables = normalizeStructuredTables(structuredTablesRef.current.map((table) => {
      if (table.id !== tableId) {
        return table;
      }

      if (rowIndex < 0) {
        return {
          ...table,
          columns: table.columns.map((column, index) => (
            index === columnIndex ? updater({ text: column, styles: [] }).text : column
          ))
        };
      }

      return recalculateStructuredTableFormulas({
        ...table,
        rows: table.rows.map((row, currentRowIndex) => (
          currentRowIndex === rowIndex
            ? row.map((cell, currentColumnIndex) => (
                currentColumnIndex === columnIndex ? updater(cell) : cell
              ))
            : row
        ))
      });
    }));

    structuredTablesRef.current = nextTables;
    setStructuredTables(nextTables);
    pendingOpenedContentRef.current = null;
    setTableRenderRevision((revision) => revision + 1);
    const updatedTable = nextTables.find((table) => table.id === tableId);
    if (updatedTable) {
      requestAnimationFrame(() => syncStructuredTableFormulaDisplays(updatedTable));
    }
  }, []);

  const insertStructuredTableFormulaTemplate = useCallback((
    target: StructuredTableCellTarget,
    commandName: string
  ) => {
    const editor = document.querySelector<HTMLElement>(getStructuredTableCellSelector(target));
    const template = `//${commandName}()`;

    if (!editor) {
      return;
    }

    editor.textContent = template;
    delete editor.dataset.formula;
    delete editor.dataset.computedValue;
    updateStructuredCell(target.tableId, target.rowIndex, target.columnIndex, (cell) => ({
      text: template,
      activeStyle: cell.activeStyle,
      styles: []
    }));
    setTableFormulaMenu(null);
    setSelectedTableFormulaIndex(0);
    editor.focus();
    placeCaretAtTextOffset(editor, template.length - 1);
  }, [updateStructuredCell]);

  const moveStructuredTableCell = useCallback((target: StructuredTableCellTarget, message?: string) => {
    activeStructuredCellRef.current = target;
    structuredTableModeRef.current = "editing";
    structuredTableSelectionModeRef.current = "cell";
    scheduleStructuredCellFocus(target, message);
  }, []);

  const navigateStructuredTableCell = useCallback((target: StructuredTableCellTarget, message?: string) => {
    activeStructuredCellRef.current = target;
    structuredTableModeRef.current = "navigating";
    structuredTableSelectionModeRef.current = "cell";
    scheduleStructuredCellNavigation(target, "cell", message);
  }, []);

  const selectStructuredTableRange = useCallback((
    target: StructuredTableCellTarget,
    selectionMode: StructuredTableSelectionMode
  ) => {
    activeStructuredCellRef.current = target;
    structuredTableModeRef.current = "navigating";
    structuredTableSelectionModeRef.current = selectionMode;
    scheduleStructuredCellNavigation(target, selectionMode);
  }, []);

  const addStructuredTableColumn = useCallback((
    tableId: string,
    afterColumnIndex: number,
    rowIndex: number,
    nextMode: "navigating" | "editing" = "editing"
  ) => {
    const nextTables = normalizeStructuredTables(structuredTablesRef.current.map((table) => {
      if (table.id !== tableId) {
        return table;
      }

      const insertIndex = Math.max(0, Math.min(afterColumnIndex + 1, table.columns.length));

      return {
        ...table,
        columns: [
          ...table.columns.slice(0, insertIndex),
          "",
          ...table.columns.slice(insertIndex)
        ],
        rows: table.rows.map((row) => [
          ...row.slice(0, insertIndex),
          { text: "", styles: [] },
          ...row.slice(insertIndex)
        ])
      };
    }));

    structuredTablesRef.current = nextTables;
    setStructuredTables(nextTables);
    setTableRenderRevision((revision) => revision + 1);
    const updatedTable = nextTables.find((table) => table.id === tableId);
    const target = {
      tableId,
      rowIndex: Math.max(0, rowIndex),
      columnIndex: afterColumnIndex + 1
    };
    const message = updatedTable
      ? `Column ${getStructuredTableColumnLabel(target.columnIndex)} inserted. Table now has ${updatedTable.columns.length} columns.`
      : undefined;
    if (nextMode === "navigating") {
      navigateStructuredTableCell(target, message);
    } else {
      moveStructuredTableCell(target, message);
    }
  }, [moveStructuredTableCell, navigateStructuredTableCell]);

  const addStructuredTableRow = useCallback((
    tableId: string,
    columnIndex: number,
    afterRowIndex?: number,
    nextMode: "navigating" | "editing" = "editing"
  ) => {
    let nextRowIndex = 0;

    const nextTables = normalizeStructuredTables(structuredTablesRef.current.map((table) => {
      if (table.id !== tableId) {
        return table;
      }

      nextRowIndex = afterRowIndex === undefined
        ? table.rows.length
        : Math.max(0, Math.min(afterRowIndex + 1, table.rows.length));
      const newRow = table.columns.map(() => ({ text: "", styles: [] }));
      return {
        ...table,
        rows: [
          ...table.rows.slice(0, nextRowIndex),
          newRow,
          ...table.rows.slice(nextRowIndex)
        ]
      };
    }));

    structuredTablesRef.current = nextTables;
    setStructuredTables(nextTables);
    setTableRenderRevision((revision) => revision + 1);
    const target = { tableId, rowIndex: nextRowIndex, columnIndex };
    const updatedTable = nextTables.find((table) => table.id === tableId);
    const message = updatedTable
      ? `Row ${nextRowIndex + 1} inserted. Table now has ${updatedTable.rows.length} rows.`
      : undefined;
    if (nextMode === "navigating") {
      navigateStructuredTableCell(target, message);
    } else {
      moveStructuredTableCell(target, message);
    }
  }, [moveStructuredTableCell, navigateStructuredTableCell]);

  const deleteStructuredTableRow = useCallback((
    tableId: string,
    rowIndex: number,
    columnIndex: number
  ) => {
    const table = structuredTablesRef.current.find((candidate) => candidate.id === tableId);

    if (!table || table.rows.length <= 1) {
      setFileStatus("A table must keep at least one row.");
      const wrapper = document.querySelector<HTMLElement>(`.structured-table-widget[data-table-id="${tableId}"]`);
      if (wrapper) {
        announceStructuredTable(wrapper, "Row not deleted. A table must keep at least one row.");
      }
      return;
    }

    const nextRowIndex = Math.min(Math.max(0, rowIndex), table.rows.length - 2);
    const nextTables = normalizeStructuredTables(structuredTablesRef.current.map((candidate) => (
      candidate.id === tableId
        ? {
            ...candidate,
            rows: candidate.rows.filter((_, index) => index !== rowIndex)
          }
        : candidate
    )));

    structuredTablesRef.current = nextTables;
    setStructuredTables(nextTables);
    setTableRenderRevision((revision) => revision + 1);
    navigateStructuredTableCell(
      { tableId, rowIndex: nextRowIndex, columnIndex },
      `Row ${rowIndex + 1} deleted. Table now has ${table.rows.length - 1} rows.`
    );
  }, [navigateStructuredTableCell]);

  const deleteStructuredTableColumn = useCallback((
    tableId: string,
    rowIndex: number,
    columnIndex: number
  ) => {
    const table = structuredTablesRef.current.find((candidate) => candidate.id === tableId);

    if (!table || table.columns.length <= 1) {
      setFileStatus("A table must keep at least one column.");
      const wrapper = document.querySelector<HTMLElement>(`.structured-table-widget[data-table-id="${tableId}"]`);
      if (wrapper) {
        announceStructuredTable(wrapper, "Column not deleted. A table must keep at least one column.");
      }
      return;
    }

    const nextColumnIndex = Math.min(Math.max(0, columnIndex), table.columns.length - 2);
    const nextTables = normalizeStructuredTables(structuredTablesRef.current.map((candidate) => (
      candidate.id === tableId
        ? {
            ...candidate,
            columns: candidate.columns.filter((_, index) => index !== columnIndex),
            rows: candidate.rows.map((row) => (
              row.filter((_, index) => index !== columnIndex)
            ))
          }
        : candidate
    )));

    structuredTablesRef.current = nextTables;
    setStructuredTables(nextTables);
    setTableRenderRevision((revision) => revision + 1);
    navigateStructuredTableCell({
      tableId,
      rowIndex: Math.max(0, rowIndex),
      columnIndex: nextColumnIndex
    }, `Column ${getStructuredTableColumnLabel(columnIndex)} deleted. Table now has ${table.columns.length - 1} columns.`);
  }, [navigateStructuredTableCell]);

  const deleteSelectedStructuredTable = useCallback((view: EditorView) => {
    const tableAnchor = getStructuredTableAnchorAtSelection(view);

    if (!tableAnchor) {
      return false;
    }

    const tableLine = view.state.doc.lineAt(tableAnchor.from);
    const deleteTo = tableLine.to < view.state.doc.length
      ? tableLine.to + 1
      : tableLine.to;

    activeStructuredCellRef.current = null;
    structuredTableModeRef.current = null;
    structuredTableSelectionModeRef.current = "cell";
    const table = structuredTablesRef.current.find(
      (candidate) => candidate.id === tableAnchor.id
    );
    view.dispatch({
      changes: { from: tableLine.from, to: deleteTo, insert: "" },
      selection: { anchor: tableLine.from },
      effects: table ? removeStructuredTableFromHistory.of(table) : undefined,
      scrollIntoView: true
    });
    setFileStatus("Table deleted.");
    return true;
  }, []);

  const getCellStyleForCommand = useCallback((
    commandName: string,
    commandArgument: string,
    currentStyle: ActiveTextStyle
  ): ActiveTextStyle | null => {
    const nextStyle = { ...currentStyle };

    if (commandName === "bold") nextStyle.isBold = true;
    else if (commandName === "italic") nextStyle.isItalic = true;
    else if (commandName === "strike") nextStyle.isStrike = true;
    else if (commandName === "underline") nextStyle.isUnderline = true;
    else if (commandName === "title") {
      nextStyle.fontSize = "24";
      nextStyle.isBold = true;
    } else if (commandName === "header") {
      nextStyle.fontSize = "18";
      nextStyle.isBold = true;
    } else if (commandName === "body") {
      nextStyle.fontSize = DEFAULT_FONT_SIZE;
    } else if (commandName === "default") {
      return defaultTextStyle;
    } else if (commandName === "color" && commandArgument) {
      nextStyle.textColor = commandArgument;
    } else if (commandName === "size" && commandArgument && /^\d+$/.test(commandArgument)) {
      nextStyle.fontSize = commandArgument;
    } else {
      return null;
    }

    return nextStyle;
  }, []);

  const runStructuredTableCellCommand = useCallback((
    tableId: string,
    rowIndex: number,
    columnIndex: number,
    commandName: string,
    commandArgument: string,
    commandLength: number,
    selection: { from: number; to: number }
  ) => {
    const table = structuredTablesRef.current.find((candidate) => candidate.id === tableId);
    const formula = parseStructuredTableFormula(commandName, commandArgument);

    if (table && formula) {
      const result = evaluateStructuredTableFormula(table, formula);

      if (result === null) {
        setFileStatus("Table formula needs a valid range with numeric values.");
        setFileStatusKind("error");
        return;
      }

      updateStructuredCell(tableId, rowIndex, columnIndex, (cell) => {
        const commandFrom = Math.max(0, cell.text.length - commandLength);
        const range = commandArgument.replace(/^\(|\)$/g, "").toUpperCase();

        return {
          text: `${cell.text.slice(0, commandFrom).trimEnd()}${result}`,
          formula: `//${formula.operation}(${range})`,
          activeStyle: cell.activeStyle,
          styles: []
        };
      });
      navigateStructuredTableCell(
        { tableId, rowIndex, columnIndex },
        `Formula result ${result}.`
      );
      setFileStatus("Live table formula saved.");
      setFileStatusKind("success");
      return;
    }

    updateStructuredCell(tableId, rowIndex, columnIndex, (cell) => {
      const commandFrom = Math.max(0, cell.text.length - commandLength);
      const nextText = cell.text.slice(0, commandFrom).trimEnd();
      const currentStyle = cell.styles?.slice(-1)[0]?.style ?? defaultTextStyle;
      const style = getCellStyleForCommand(commandName, commandArgument, currentStyle);

      if (!style) {
        return cell;
      }

      const formattedFrom = selection.from < selection.to ? selection.from : 0;
      const formattedTo = selection.from < selection.to ? selection.to : nextText.length;
      const shiftedStyles = (cell.styles ?? [])
        .filter((range) => range.to <= commandFrom)
        .map((range) => ({
          ...range,
          to: Math.min(range.to, nextText.length)
        }))
        .filter((range) => range.from < range.to);

      return {
        text: nextText,
        activeStyle: nextText.length === 0 ? style : cell.activeStyle,
        styles: formattedFrom < formattedTo
          ? [
              ...shiftedStyles,
              {
                from: formattedFrom,
                to: formattedTo,
                style
              }
            ]
          : shiftedStyles
      };
    });
    moveStructuredTableCell({ tableId, rowIndex, columnIndex });
    setFileStatus(`Applied //${commandName} in table cell.`);
    setFileStatusKind("success");
  }, [getCellStyleForCommand, moveStructuredTableCell, navigateStructuredTableCell, updateStructuredCell]);

  const saveX2NoteQueued = useCallback((path: string, note: {
    title: string;
    content: string;
    styles: TextStyleRange[];
    tables: StructuredTable[];
    codeOutputs?: Array<Omit<CodeBoxOutput, "runId">>;
  }) => {
    const pathKey = getPathKey(path);
    const previousSave = noteSaveQueuesRef.current.get(pathKey) ?? Promise.resolve();
    const queuedSave = previousSave
      .catch(() => undefined)
      .then(async () => {
        await invoke("save_x2_note", { path, note });
      });

    noteSaveQueuesRef.current.set(pathKey, queuedSave);
    void queuedSave.then(
      () => {
        if (noteSaveQueuesRef.current.get(pathKey) === queuedSave) {
          noteSaveQueuesRef.current.delete(pathKey);
        }
      },
      () => {
        if (noteSaveQueuesRef.current.get(pathKey) === queuedSave) {
          noteSaveQueuesRef.current.delete(pathKey);
        }
      }
    );
    return queuedSave;
  }, []);

  const cancelPendingAutoSave = useCallback((path: string) => {
    const pathKey = getPathKey(path);
    const timer = autoSaveTimersRef.current.get(pathKey);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      autoSaveTimersRef.current.delete(pathKey);
    }
    autoSaveVersionsRef.current.set(pathKey, (autoSaveVersionsRef.current.get(pathKey) ?? 0) + 1);
  }, []);

  const scheduleAutoSave = useCallback(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }

    const path = openedNotePathRef.current;
    if (!path) {
      return;
    }

    const pathKey = getPathKey(path);
    const previousTimer = autoSaveTimersRef.current.get(pathKey);
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
    }

    const version = (autoSaveVersionsRef.current.get(pathKey) ?? 0) + 1;
    autoSaveVersionsRef.current.set(pathKey, version);
    setFileStatus("Unsaved changes — auto-save pending...");
    setFileStatusKind("idle");

    const timer = window.setTimeout(() => {
      autoSaveTimersRef.current.delete(pathKey);
      if (autoSaveVersionsRef.current.get(pathKey) !== version) {
        return;
      }

      const isCurrentNote = getPathKey(openedNotePathRef.current ?? "") === pathKey;
      const noteInCache = openedNotesRef.current.find((note) => getPathKey(note.path) === pathKey);
      if (!noteInCache) {
        return;
      }

      const savedAt = new Date().toISOString();
      const note = {
        title: isCurrentNote ? (openedNoteTitleRef.current || noteInCache.title) : noteInCache.title,
        content: isCurrentNote ? valueRef.current : noteInCache.content,
        styles: (isCurrentNote ? styleRangesRef.current : (noteInCache.styles ?? [])).map((range) => ({
          ...range,
          style: { ...range.style }
        })),
        tables: normalizeStructuredTables(isCurrentNote ? structuredTablesRef.current : (noteInCache.tables ?? []))
      };

      if (isCurrentNote) {
        setFileStatus("Auto-saving...");
        setFileStatusKind("idle");
      }

      void saveX2NoteQueued(path, note).then(() => {
        if (!isEditorMountedRef.current || autoSaveVersionsRef.current.get(pathKey) !== version) {
          return;
        }

        const savedNote: LoadedX2Note = { ...note, path, savedAt };
        const nextNotes = openedNotesRef.current.map((currentNote) => (
          getPathKey(currentNote.path) === pathKey ? savedNote : currentNote
        ));
        openedNotesRef.current = nextNotes;
        setOpenedNotes(nextNotes);

        if (getPathKey(openedNotePathRef.current ?? "") === pathKey) {
          setFileStatus("Auto-saved.");
          setFileStatusKind("success");
        }
      }).catch((error) => {
        if (
          isEditorMountedRef.current &&
          autoSaveVersionsRef.current.get(pathKey) === version &&
          getPathKey(openedNotePathRef.current ?? "") === pathKey
        ) {
          setFileStatus(`Auto-save failed: ${String(error)}`);
          setFileStatusKind("error");
        }
      });
    }, AUTO_SAVE_DELAY_MS);

    autoSaveTimersRef.current.set(pathKey, timer);
  }, [saveX2NoteQueued]);

  const runFileCommand = useCallback(async (
    commandName: "save" | "new" | "export",
    documentText: string,
    title: string,
    currentPath: string | null,
    styles: TextStyleRange[],
    tables: StructuredTable[]
  ) => {
    const isTauri = "__TAURI_INTERNALS__" in window;

    if (!isTauri) {
      setFileStatus("New, save, and export require the desktop app.");
      setFileStatusKind("error");
      return;
    }

    const isSaveCommand = commandName === "save";
    const isNewCommand = commandName === "new";
    const extension = isSaveCommand ? "x2" : "pdf";
    let outputPath = currentPath && isSaveCommand ? currentPath : null;
    const defaultNoteFolder = await invoke<string>("get_default_note_folder").catch(() => "");

    if (isNewCommand) {
      const selectedPath = await save({
        defaultPath: defaultNoteFolder
          ? joinFolderPath(defaultNoteFolder, "Untitled Note.x2")
          : "Untitled Note.x2",
        filters: [
          {
            name: "x2 note",
            extensions: ["x2"]
          }
        ]
      });

      if (!selectedPath) {
        setFileStatus("New note cancelled.");
        setFileStatusKind("idle");
        return;
      }

      const newNotePath = ensurePathExtension(selectedPath, "x2");
      const newNote = {
        title: getNoteTitleFromPath(newNotePath),
        content: "",
        styles: [],
        tables: []
      };

      try {
        setFileStatus("Creating note...");
        setFileStatusKind("idle");
        await invoke("save_x2_note", { path: newNotePath, note: newNote });
        const folder = await invoke<LoadedX2Folder>("load_x2_folder", { path: newNotePath });
        openLoadedX2Folder(folder);
        setFileStatus("Created new .x2 note.");
        setFileStatusKind("success");
      } catch (error) {
        setFileStatus(String(error));
        setFileStatusKind("error");
      }

      return;
    }

    if (!outputPath) {
      const selectedPath = await save({
        defaultPath: defaultNoteFolder
          ? joinFolderPath(defaultNoteFolder, getSafeFileName(title, extension))
          : getSafeFileName(title, extension),
        filters: [
          {
            name: isSaveCommand ? "x2 note" : "PDF document",
            extensions: [extension]
          }
        ]
      });

      if (!selectedPath) {
        setFileStatus(isSaveCommand ? "Save cancelled." : "Export cancelled.");
        setFileStatusKind("idle");
        return;
      }

      outputPath = ensurePathExtension(selectedPath, extension);
    }

    const note = {
      title,
      content: documentText,
      styles,
      tables,
      codeOutputs: isSaveCommand
        ? []
        : codeRuns.map(({ runId: _runId, ...output }) => output)
    };

    try {
      setFileStatus(isSaveCommand ? "Saving..." : "Exporting PDF...");
      setFileStatusKind("idle");

      if (isSaveCommand) {
        cancelPendingAutoSave(outputPath);
        await saveX2NoteQueued(outputPath, note);
        const savedTitle = title || "Untitled Note";
        const savedPathKey = getPathKey(outputPath);
        const savedNote: LoadedX2Note = {
          title: savedTitle,
          content: documentText,
          savedAt: new Date().toISOString(),
          path: outputPath,
          styles,
          tables
        };

        const existingIndex = openedNotesRef.current.findIndex((currentNote) => (
          getPathKey(currentNote.path) === savedPathKey
        ));
        const nextOpenedNotes = existingIndex < 0
          ? [...openedNotesRef.current, savedNote]
          : openedNotesRef.current.map((currentNote, index) => (
              index === existingIndex ? savedNote : currentNote
            ));
        openedNotesRef.current = nextOpenedNotes;
        openedNoteTitleRef.current = savedTitle;
        openedNotePathRef.current = outputPath;
        setOpenedNotes(nextOpenedNotes);
        setOpenedNoteTitle(savedTitle);
        setOpenedNotePath(outputPath);
        setFileStatus(`Saved .x2 file (${styles.length} style ${styles.length === 1 ? "range" : "ranges"}).`);
      } else {
        await invoke("export_note_pdf", { path: outputPath, note });
        setFileStatus("Exported PDF.");
      }

      setFileStatusKind("success");
    } catch (error) {
      setFileStatus(String(error));
      setFileStatusKind("error");
    }
  }, [cancelPendingAutoSave, codeRuns, openLoadedX2Folder, saveX2NoteQueued]);

  const createNewNote = useCallback(() => {
    const currentStyles = styleRangesRef.current.map((range) => ({
      ...range,
      style: { ...range.style }
    }));

    void runFileCommand("new", value, activeNoteTitle, openedNotePath, currentStyles, structuredTablesRef.current);
  }, [activeNoteTitle, openedNotePath, runFileCommand, value]);

  const runTableFormulaAtCursor = useCallback((view: EditorView) => {
    const context = getTableCellAtPosition(view.state.doc, view.state.selection.main.head);

    if (!context) {
      return false;
    }

    const formula = parseTableFormula(context.cell.text);

    if (!formula) {
      return false;
    }

    const result = evaluateTableFormula(context.table, formula);

    if (result === null) {
      setFileStatus("Table formula needs a valid range with numeric values.");
      setFileStatusKind("error");
      return true;
    }

    view.dispatch({
      changes: {
        from: context.cell.from,
        to: context.cell.to,
        insert: result
      },
      selection: { anchor: context.cell.from + result.length },
      scrollIntoView: true
    });

    const nextTable = getMarkdownTableAtPosition(view.state.doc, context.table.from);
    const nextCell = nextTable
      ? getTableCellByIndexes(nextTable, context.cell.rowIndex, context.cell.columnIndex)
      : null;

    if (nextTable && nextCell) {
      normalizeTableAndMoveToCell(view, nextTable, nextCell.rowIndex, nextCell.columnIndex);
    }

    setFileStatus("Table formula calculated.");
    setFileStatusKind("success");
    return true;
  }, []);
  void runTableFormulaAtCursor;

  const runCodeBlockAtCursor = useCallback((view: EditorView) => {
    const selectedBlock = getSelectedCodeBlock(view);
    const editingBlock = getEditingCodeBlock(view);
    const codeBlock = selectedBlock ?? editingBlock ?? getCodeBlockAtPosition(
      view.state.doc,
      view.state.selection.main.head
    );

    if (!codeBlock) {
      return false;
    }

    const languageLabel = getCodeLanguageLabel(codeBlock.language);

    const runId = crypto.randomUUID();
    const setInitialBlockOutput = (output: CodeRunState) => {
      setCodeRuns((currentRuns) => [
        ...currentRuns.filter((current) => current.blockFrom !== codeBlock.blockFrom),
        { ...output, blockFrom: codeBlock.blockFrom, runId }
      ]);
    };
    const finishBlockOutput = (output: CodeRunState) => {
      setCodeRuns((currentRuns) => currentRuns.map((current) => (
        current.runId === runId
          ? { ...output, blockFrom: current.blockFrom, runId }
          : current
      )));
    };

    if (!("__TAURI_INTERNALS__" in window)) {
      setInitialBlockOutput({
        status: "error",
        stdout: "",
        stderr: "",
        exitCode: null,
        message: `Running ${languageLabel} requires the x2pad desktop app.`
      });
      return true;
    }

    setInitialBlockOutput({
      status: "running",
      stdout: "",
      stderr: "",
      exitCode: null,
      message: `Running ${languageLabel}...`
    });

    void (async () => {
      try {
        const result = await invoke<CodeRunResult>("run_code_snippet", {
          language: codeBlock.language,
          code: codeBlock.code
        });
        const hasError = result.exitCode === null || result.exitCode !== 0;
        const hasWarnings = !hasError && !!result.stderr.trim();

        finishBlockOutput({
          status: hasError ? "error" : "success",
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          message: hasError
            ? result.phase === "compile"
              ? `${languageLabel} compilation failed.`
              : `${languageLabel} finished with errors.`
            : hasWarnings
              ? `${languageLabel} finished with warnings.`
              : `${languageLabel} finished.`
        });
      } catch (error) {
        finishBlockOutput({
          status: "error",
          stdout: "",
          stderr: "",
          exitCode: null,
          message: String(error)
        });
      } finally {
        view.focus();
      }
    })();

    return true;
  }, []);

  const runAiCommandAtCursor = useCallback((view: EditorView) => {
    const pendingAiCommand = getAiCommandAtCursor(view);

    if (!pendingAiCommand) {
      return false;
    }

    const documentText = (
      view.state.doc.sliceString(0, pendingAiCommand.from) +
      view.state.doc.sliceString(pendingAiCommand.to)
    );
    const documentStyles = removeTextRangeFromStyleRanges(
      styleRangesRef.current,
      pendingAiCommand.from,
      pendingAiCommand.to
    );
    const sessionId = `${Date.now()}-${Math.random()}`;
    const anchor = pendingAiCommand.from;
    const activeLineTo = Math.max(anchor, pendingAiCommand.lineTo - (pendingAiCommand.to - pendingAiCommand.from));

    forcedStyleRangesRef.current = documentStyles;
    view.dispatch({
      changes: {
        from: pendingAiCommand.from,
        to: pendingAiCommand.to,
        insert: ""
      },
      selection: { anchor }
    });
    setShowCommands(false);
    setCommandQuery("");
    setAiSession({
      id: sessionId,
      status: "thinking",
      prompt: pendingAiCommand.prompt,
      anchor,
      activeLineTo,
      answer: "",
      placements: [],
      placementIndex: 0
    });

    void (async () => {
      try {
        const apiKey = await getSavedGeminiApiKey();
        const modelResponse = apiKey
          ? await requestGeminiAiResponse(apiKey, pendingAiCommand.prompt, documentText, anchor)
          : getMockAiResponse(pendingAiCommand.prompt);

        setAiSession((currentSession) => {
          if (!currentSession || currentSession.id !== sessionId) {
            return currentSession;
          }

          return {
            ...currentSession,
            status: "ready",
            answer: modelResponse.answer,
            placements: getAiPlacements(documentText, anchor, modelResponse.placement),
            placementIndex: 0,
            isMock: !apiKey
          };
        });
      } catch (error) {
        setAiSession((currentSession) => {
          if (!currentSession || currentSession.id !== sessionId) {
            return currentSession;
          }

          return {
            ...currentSession,
            status: "error",
            error: error instanceof Error ? error.message : String(error)
          };
        });
      }
    })();

    return true;
  }, [getSavedGeminiApiKey]);

  const cycleAiPlacement = useCallback(() => {
    setAiSession((currentSession) => {
      if (!currentSession || currentSession.status !== "ready" || currentSession.placements.length <= 1) {
        return currentSession;
      }

      return {
        ...currentSession,
        placementIndex: (currentSession.placementIndex + 1) % currentSession.placements.length
      };
    });
    return true;
  }, []);

  const cancelAiSession = useCallback(() => {
    setAiSession(null);
    editorViewRef.current?.focus();
    return true;
  }, []);

  const acceptAiSession = useCallback((view: EditorView) => {
    const currentSession = aiSession;

    if (!currentSession || currentSession.status !== "ready") {
      return false;
    }

    const placement = currentSession.placements[currentSession.placementIndex];

    if (!placement) {
      return false;
    }

    const doc = view.state.doc;
    const docText = doc.toString();
    const clampedAnchor = Math.max(0, Math.min(currentSession.anchor, doc.length));
    const parsedAnswer = parseAiFormattedText(currentSession.answer);
    let insertAt = clampedAnchor;
    let insertPrefix = "";

    if (placement.mode === "current-cursor") {
      insertAt = view.state.selection.main.head;
    } else if (placement.mode === "below-current-line") {
      const line = doc.lineAt(Math.max(0, Math.min(currentSession.activeLineTo, doc.length)));
      insertAt = line.to;
      insertPrefix = "\n";
    } else if (placement.mode === "after-nearest-heading") {
      const heading = placement.heading
        ? getMarkdownHeadings(docText).find((candidate) => candidate.title === placement.heading)
        : getNearestPreviousHeading(docText, clampedAnchor);

      if (heading) {
        const nextHeading = getMarkdownHeadings(docText).find((candidate) => (
          candidate.from > heading.from && candidate.level <= heading.level
        ));
        insertAt = nextHeading ? Math.max(0, nextHeading.from - 1) : doc.length;
        insertPrefix = docText.slice(Math.max(0, insertAt - 2), insertAt).trim() ? "\n\n" : "";
      }
    } else if (placement.mode === "end-of-document") {
      insertAt = doc.length;
      insertPrefix = docText.endsWith("\n\n") || docText.length === 0 ? "" : docText.endsWith("\n") ? "\n" : "\n\n";
    }

    const insertText = `${insertPrefix}${parsedAnswer.text}`;
    const changes = view.state.changes({
      from: insertAt,
      to: insertAt,
      insert: insertText
    });
    const nextDocLength = doc.length + insertText.length;
    const insertedStyleRanges = parsedAnswer.ranges.map((range) => ({
      ...range,
      from: insertAt + insertPrefix.length + range.from,
      to: insertAt + insertPrefix.length + range.to
    }));
    const nextStyleRanges = [
      ...mapStyleRangesThroughChanges(styleRangesRef.current, changes, nextDocLength),
      ...insertedStyleRanges
    ];

    forcedStyleRangesRef.current = nextStyleRanges;
    view.dispatch({
      changes: {
        from: insertAt,
        to: insertAt,
        insert: insertText
      },
      selection: { anchor: insertAt + insertText.length },
      scrollIntoView: true,
      effects: replaceTextStyleDecorations.of(nextStyleRanges)
    });
    setAiSession(null);
    view.focus();
    return true;
  }, [aiSession]);

  const runCommandAtCursor = useCallback((view: EditorView, suggestedCommand?: (typeof CommandRegistry)[number]) => {
    const pendingCommand = getCommandAtCursor(view);

    if (!pendingCommand) {
      return false;
    }

    const exactCommand = CommandRegistry.find(
      (registeredCommand) => registeredCommand.name.toLowerCase() === pendingCommand.name
    );
    // A dropdown choice is more specific than the command text used to open
    // the menu (for example, selecting `code c++` from a bare `//code`).
    const command = suggestedCommand ?? exactCommand;

    if (!command) {
      return false;
    }

    const selectedCommandName = command.name.toLowerCase();
    const codeAliasMatch = selectedCommandName.match(/^code\s+(.+)$/);
    const commandName = codeAliasMatch ? "code" : selectedCommandName;
    const commandArgument = pendingCommand.argument ?? codeAliasMatch?.[1];

    if (pendingCommand.argument && !COMMANDS_WITH_ARGUMENTS.has(commandName)) {
      return false;
    }

    const documentText = (
      view.state.doc.sliceString(0, pendingCommand.from) +
      view.state.doc.sliceString(pendingCommand.to)
    );
    const documentStyles = removeTextRangeFromStyleRanges(
      styleRangesRef.current,
      pendingCommand.from,
      pendingCommand.to
    );

    if (commandName === "table") {
      const tableId = crypto.randomUUID();
      const tableAnchor = `[[x2-table:${tableId}]]\n`;
      const commandLine = view.state.doc.lineAt(pendingCommand.from);
      const textBeforeCommand = view.state.doc.sliceString(
        commandLine.from,
        pendingCommand.from
      );
      const hasExistingLineContent = textBeforeCommand.trim().length > 0;
      const replacementFrom = hasExistingLineContent
        ? commandLine.from + textBeforeCommand.trimEnd().length
        : pendingCommand.from;
      const insertedTableAnchor = hasExistingLineContent
        ? `\n${tableAnchor}`
        : tableAnchor;
      const table: StructuredTable = {
        id: tableId,
        columns: [""],
        rows: [[{ text: "", styles: [] }]]
      };

      view.dispatch({
        changes: {
          from: replacementFrom,
          to: pendingCommand.to,
          insert: insertedTableAnchor
        },
        selection: { anchor: replacementFrom + insertedTableAnchor.length },
        scrollIntoView: true
      });
      setStructuredTables((currentTables) => {
        const nextTables = normalizeStructuredTables([...currentTables, table]);
        structuredTablesRef.current = nextTables;
        return nextTables;
      });
      setTableRenderRevision((revision) => revision + 1);
      moveStructuredTableCell({ tableId, rowIndex: 0, columnIndex: 0 });
      setShowCommands(false);
      setCommandQuery("");
      return true;
    }

    if (commandName === "code") {
      const language = resolveCodeCommandLanguage(commandArgument, selectedCommandName);

      if (!language) {
        setShowCommands(false);
        setCommandQuery("");
        setCommandFeedback({
          title: "Unsupported code language",
          detail: "Use //code python, //code py, //code c++, or //code cpp."
        });
        return true;
      }

      const codeTemplate = getCodeTemplate(language);
      const commandLine = view.state.doc.lineAt(pendingCommand.from);
      const textBeforeCommand = view.state.doc.sliceString(
        commandLine.from,
        pendingCommand.from
      );
      const hasExistingLineContent = textBeforeCommand.trim().length > 0;
      const replacementFrom = hasExistingLineContent
        ? commandLine.from + textBeforeCommand.trimEnd().length
        : pendingCommand.from;
      const codeBlockFrom = replacementFrom + (hasExistingLineContent ? 1 : 0);
      const insertedCode = hasExistingLineContent
        ? `\n${codeTemplate}`
        : codeTemplate;

      view.dispatch({
        changes: {
          from: replacementFrom,
          to: pendingCommand.to,
          insert: insertedCode
        },
        selection: { anchor: codeBlockFrom },
        effects: [
          setSelectedCodeBox.of(codeBlockFrom),
          setSelectedCodeBoxColumn.of(0),
          setEditingCodeBox.of(null)
        ],
        scrollIntoView: true
      });
      setShowCommands(false);
      setCommandQuery("");
      setCodeRuns((currentRuns) => currentRuns.filter(
        (output) => output.blockFrom !== codeBlockFrom
      ));
      return true;
    }

    if (commandName === "save" || commandName === "export") {
      view.dispatch({
        changes: {
          from: pendingCommand.from,
          to: pendingCommand.to,
          insert: ""
        },
        selection: { anchor: pendingCommand.from }
      });
      setShowCommands(false);
      setCommandQuery("");
      void runFileCommand(
        commandName,
        documentText,
        activeNoteTitle,
        openedNotePath,
        documentStyles,
        structuredTablesRef.current
      );
      return true;
    }

    let commandReplacement = "";
    const handled = command.action(
      {
        getDocumentText: () => documentText,
        insertText: (text) => {
          commandReplacement = text;
        },
        setBold,
        setFontSize,
        setItalic,
        setSelectedFont,
        setTextColor,
        setStrike,
        setUnderline
      },
      commandArgument
    );

    if (!handled) {
      return false;
    }

    view.dispatch({
      changes: {
        from: pendingCommand.from,
        to: pendingCommand.to,
        insert: commandReplacement
      },
      selection: { anchor: pendingCommand.from + commandReplacement.length }
    });
    setShowCommands(false);
    setCommandQuery("");
    return true;
  }, [activeNoteTitle, moveStructuredTableCell, openedNotePath, runFileCommand]);

  const discardUnmatchedCommandAtCursor = useCallback((view: EditorView) => {
    const pendingCommand = getCommandAtCursor(view);

    if (!pendingCommand) {
      return false;
    }

    const typedCommand = view.state.doc.sliceString(pendingCommand.from, pendingCommand.to).trim();
    view.dispatch({
      changes: {
        from: pendingCommand.from,
        to: pendingCommand.to,
        insert: ""
      },
      selection: { anchor: pendingCommand.from }
    });
    setShowCommands(false);
    setCommandQuery("");
    setSelectedCommandIndex(0);
    setCommandFeedback({
      title: "Command not found",
      detail: `${typedCommand} was removed - try another command`
    });
    return true;
  }, []);

  const editorExtensions = useMemo(() => [
    markdown({
      codeLanguages: (info) => {
        const language = normalizeCodeLanguage(info);
        return language === "python"
          ? pythonLanguage
          : language === "cpp"
            ? cppLanguage
            : null;
      }
    }),
    EditorView.lineWrapping,
    scrollPastEnd(),
    editorCursorScrollMargin,
    keepEditorCursorInView,
    textStyleDecorations,
    commandLineDecorations,
    structuredTableDecorations(structuredTablesRef),
    protectStructuredTableAnchors,
    structuredTableHistory,
    codeBoxDecorations,
    EditorView.inputHandler.of((view, _from, _to, text) => {
      const block = getSelectedCodeBlock(view);

      if (!block || !text) {
        return false;
      }

      view.dispatch({
        changes: { from: block.from, to: block.from, insert: text },
        selection: { anchor: block.from + text.length },
        effects: [
          setSelectedCodeBox.of(null),
          setEditingCodeBox.of(block.blockFrom)
        ],
        scrollIntoView: true
      });
      return true;
    }),
    Prec.highest(keymap.of([
      {
        key: "Enter",
        run: (view) => {
          const selectedTable = getSelectedStructuredTableAnchor(view);

          if (selectedTable) {
            navigateStructuredTableCell({ tableId: selectedTable.id, rowIndex: 0, columnIndex: 0 });
            return true;
          }

          if (acceptAiSession(view) || enterSelectedCodeBox(view)) {
            return true;
          }

          if (getCodeSourceBlockAtSelection(view)) {
            return false;
          }

          const selectedCommand = commandQuery ? visibleCommands[selectedCommandIndex] : undefined;
          return runAiCommandAtCursor(view) ||
            runCommandAtCursor(view, selectedCommand) ||
            discardUnmatchedCommandAtCursor(view) ||
            continueListAtCursor(view);
        }
      },
      {
        key: "Ctrl-Enter",
        run: runCodeBlockAtCursor
      },
      {
        key: "Cmd-Enter",
        run: runCodeBlockAtCursor
      },
      {
        key: "ArrowDown",
        run: (view) => showCommands && !!commandQuery && visibleCommands.length > 0
          ? (setSelectedCommandIndex((currentIndex) => (
            (currentIndex + 1) % visibleCommands.length
          )), true)
          : moveAroundStructuredTable(view, "down") ||
          moveInsideCodeBoxOneLine(view, "down") ||
          moveOutsideCodeBoxOneLine(view, "down")
      },
      {
        key: "ArrowUp",
        run: (view) => showCommands && !!commandQuery && visibleCommands.length > 0
          ? (setSelectedCommandIndex((currentIndex) => (
            (currentIndex - 1 + visibleCommands.length) % visibleCommands.length
          )), true)
          : moveAroundStructuredTable(view, "up") ||
          moveInsideCodeBoxOneLine(view, "up") ||
          moveOutsideCodeBoxOneLine(view, "up")
      },
      {
        key: "ArrowLeft",
        run: (view) => !!getSelectedCodeBlock(view) || keepHorizontalArrowInsideCodeBox(view, "left")
      },
      {
        key: "ArrowRight",
        run: (view) => !!getSelectedCodeBlock(view) || keepHorizontalArrowInsideCodeBox(view, "right")
      },
      {
        key: "Tab",
        run: (view) => aiSession?.status === "ready" ? cycleAiPlacement() : indentInsideCodeBox(view)
      },
      {
        key: "Shift-Tab",
        run: () => false
      },
      {
        key: "Escape",
        run: (view) => aiSession
          ? cancelAiSession()
          : getSelectedCodeBlock(view)
            ? true
            : returnToSelectedCodeBox(view)
      },
      {
        key: "Backspace",
        run: (view) => deleteSelectedStructuredTable(view) ||
          deleteSelectedCodeBox(view) ||
          keepDeletionInsideEmptyCodeBox(view) ||
          deleteListMarkerAtCursor(view)
      },
      {
        key: "Delete",
        run: (view) => deleteSelectedStructuredTable(view) ||
          deleteSelectedCodeBox(view) ||
          keepDeletionInsideEmptyCodeBox(view)
      }
    ])),
    EditorView.updateListener.of((update) => {
      const transactionEffects = update.transactions.flatMap((transaction) => transaction.effects);
      const nextStructuredTables = applyStructuredTableHistoryEffects(
        structuredTablesRef.current,
        transactionEffects
      );

      if (nextStructuredTables !== structuredTablesRef.current) {
        structuredTablesRef.current = nextStructuredTables;
        setStructuredTables(nextStructuredTables);
        setTableRenderRevision((revision) => revision + 1);
      }

      if (!update.docChanged) {
        return;
      }

      const previousCodeBlocks = getCodeBlocks(update.startState.doc);
      const changedBlockStarts = new Set<number>();
      update.changes.iterChanges((fromA, toA) => {
        for (const block of previousCodeBlocks) {
          const insertionInsideBlock = fromA === toA && block.from <= fromA && fromA <= block.to;
          const changeOverlapsBlock = fromA < block.to && toA > block.from;

          if (insertionInsideBlock || changeOverlapsBlock) {
            changedBlockStarts.add(block.blockFrom);
          }
        }
      });
      const nextCodeBlockStarts = new Set(
        getCodeBlocks(update.state.doc).map((block) => block.blockFrom)
      );
      setCodeRuns((currentRuns) => currentRuns
        .map((output) => {
          const blockFrom = update.changes.mapPos(output.blockFrom, 1);

          if (changedBlockStarts.has(output.blockFrom)) {
            return {
              ...idleCodeOutput(
                getCodeBlocks(update.state.doc).find((block) => block.blockFrom === blockFrom)?.language ?? "python"
              ),
              blockFrom,
              runId: crypto.randomUUID(),
              message: "Source changed. Press Ctrl+Enter to run it again."
            };
          }

          return { ...output, blockFrom };
        })
        .filter((output) => nextCodeBlockStarts.has(output.blockFrom)));

      const forcedStyleRanges = forcedStyleRangesRef.current;

      if (forcedStyleRanges) {
        styleRangesRef.current = forcedStyleRanges;
        forcedStyleRangesRef.current = null;
        return;
      }

      styleRangesRef.current = mapStyleRangesThroughChanges(
        styleRangesRef.current,
        update.changes,
        update.state.doc.length
      );

      const effects: StateEffect<unknown>[] = [];
      const currentStyle = {
        fontSize,
        textColor,
        isBold,
        isItalic,
        isStrike,
        isUnderline
      };

      update.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
        if (
          fromB >= toB ||
          inserted.toString().trim().length === 0 ||
          isDefaultTextStyle(currentStyle)
        ) {
          return;
        }

        const range = {
          from: fromB,
          to: toB,
          style: currentStyle
        };

        styleRangesRef.current = [
          ...styleRangesRef.current,
          range
        ];
        effects.push(addTextStyleDecoration.of(range));
      });

      if (effects.length > 0) {
        update.view.dispatch({ effects });
      }
    }),
    EditorView.theme({
      "&": {
        backgroundColor: "transparent",
        color: "#ffffff"
      },
      ".cm-content": {
        caretColor: "#c4a7ff",
        color: "#ffffff",
        fontFamily: "'Inter', 'SF Pro Text', 'Segoe UI', sans-serif",
        fontSize: `${DEFAULT_FONT_SIZE}px`,
        lineHeight: "1.72",
        padding: "44px 0 80px"
      },
      ".cm-line": {
        color: "#ffffff",
        padding: "0 2px"
      },
      ".cm-cursor": {
        borderLeftColor: "#d8b4fe"
      },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
        backgroundColor: "rgba(168, 85, 247, 0.32)"
      },
      ".cm-scroller": {
        backgroundColor: "transparent"
      },
      ".cm-gutters": {
        display: "none"
      }
    })
  ], [
    fontSize,
    textColor,
    isBold,
    isItalic,
    isStrike,
    isUnderline,
    acceptAiSession,
    aiSession,
    cancelAiSession,
    commandQuery,
    discardUnmatchedCommandAtCursor,
    cycleAiPlacement,
    deleteSelectedStructuredTable,
    runAiCommandAtCursor,
    runCommandAtCursor,
    runCodeBlockAtCursor,
    navigateStructuredTableCell,
    selectedCommandIndex,
    showCommands,
    tableRenderRevision,
    visibleCommands
  ]);

  const onChange = useCallback((val: string, viewUpdate: any) => {
    const eventPathKey = getPathKey(openedNotePath ?? "");
    if (!eventPathKey || eventPathKey !== getPathKey(openedNotePathRef.current ?? "")) {
      return;
    }

    valueRef.current = val;
    setValue(val);
    const openedContent = pendingOpenedContentRef.current;
    const activePathKey = getPathKey(openedNotePathRef.current ?? "");
    if (openedContent?.pathKey === activePathKey && openedContent.content === val) {
      pendingOpenedContentRef.current = null;
    } else {
      pendingOpenedContentRef.current = null;
      scheduleAutoSave();
    }

    const state = viewUpdate.state;
    const cursor = state.selection.main.head;
    const isInsideCommandExcludedBlock = !!getCodeBlockAtPosition(state.doc, cursor) ||
      !!getMarkdownTableAtPosition(state.doc, cursor);

    if (isInsideCommandExcludedBlock) {
      setShowCommands(false);
      setCommandQuery("");
      setSelectedCommandIndex(0);
      return;
    }

    const line = state.doc.lineAt(cursor);
    const cursorOffset = cursor - line.from;
    const textBeforeCursor = line.text.slice(0, cursorOffset);
    const nextCommandQuery = getCommandMenuQuery(textBeforeCursor);

    if (nextCommandQuery !== null) {
      const nextVisibleCommandCount = getCommandSuggestions(nextCommandQuery).length;

      setShowCommands(true);
      setCommandQuery(nextCommandQuery);
      setSelectedCommandIndex(0);

      const coords = viewUpdate.view.coordsAtPos(cursor);
      if (coords) {
        setMenuPos(getCommandMenuPosition(coords, nextVisibleCommandCount));
      }
    } else {
      setShowCommands(false);
      setCommandQuery("");
      setSelectedCommandIndex(0);
    }
  }, [openedNotePath, scheduleAutoSave]);

  useEffect(() => {
    if (tableRenderRevision === 0) {
      return;
    }

    const openedContent = pendingOpenedContentRef.current;
    const activePathKey = getPathKey(openedNotePathRef.current ?? "");
    if (openedContent?.pathKey === activePathKey && openedContent.content === valueRef.current) {
      return;
    }

    scheduleAutoSave();
  }, [scheduleAutoSave, tableRenderRevision]);

  const styleIndicator = [
    selectedFont,
    `${fontSize}px`,
    textColor,
    isBold ? "B" : null,
    isItalic ? "I" : null,
    isUnderline ? "U" : null,
    isStrike ? "S" : null
  ].filter(Boolean).join(" · ");

  const activeAiPlacement = aiSession?.status === "ready"
    ? aiSession.placements[aiSession.placementIndex]
    : null;

  const handleSidebarKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End", "Enter"].includes(event.key)) {
      return;
    }

    event.preventDefault();

    if (event.key === "Enter") {
      if (sidebarSelection === 0) {
        searchInputRef.current?.focus();
        return;
      }

      if (sidebarSelection === 1) {
        createNewNote();
        return;
      }

      const selectedNote = filteredNotes[sidebarSelection - 2];
      if (selectedNote) {
        activateOpenedNote(selectedNote.path);
        focusEditorAtStart();
      }
      return;
    }

    const maxSelection = filteredNotes.length + 1;
    let nextSelection = sidebarSelection;

    if (event.key === "ArrowUp") {
      nextSelection = Math.max(0, sidebarSelection - 1);
    } else if (event.key === "ArrowDown") {
      nextSelection = Math.min(maxSelection, sidebarSelection + 1);
    } else if (event.key === "Home") {
      nextSelection = 0;
    } else if (event.key === "End") {
      nextSelection = maxSelection;
    }

    setSidebarSelection(nextSelection);

    if (nextSelection === 0) {
      setShowLogoPane(true);
      return;
    }

    if (nextSelection === 1) {
      setShowLogoPane(true);
      return;
    }

    const selectedNote = filteredNotes[nextSelection - 2];
    if (selectedNote) {
      activateOpenedNote(selectedNote.path);
    }
  };

  useEffect(() => {
    const activePathKey = getPathKey(openedNotePath ?? "");
    const noteIndex = filteredNotes.findIndex((note) => getPathKey(note.path) === activePathKey);
    if (noteIndex >= 0 && !showLogoPane) {
      setSidebarSelection(noteIndex + 2);
    }
  }, [filteredNotes, openedNotePath, showLogoPane]);

  useEffect(() => {
    sidebarRef.current?.focus();
  }, []);

  useEffect(() => {
    isEditorMountedRef.current = true;
    return () => {
      isEditorMountedRef.current = false;
      autoSaveTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      autoSaveTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    let isCurrent = true;
    const isTauri = "__TAURI_INTERNALS__" in window;

    if (!isTauri) {
      setShowApiKeyPrompt(!window.localStorage.getItem(BROWSER_GEMINI_API_KEY_STORAGE_KEY));
      return;
    }

    void (async () => {
      try {
        const folder = await invoke<LoadedX2Folder | null>("load_startup_x2_folder");

        if (!isCurrent) {
          return;
        }

        if (!folder) {
          const hasNoteFolder = await invoke<boolean>("has_note_folder").catch(() => false);

          if (!isCurrent) {
            return;
          }

          if (!hasNoteFolder) {
            setSetupStep("folder");
            return;
          }
        } else {
          openLoadedX2Folder(folder);
        }

        const hasApiKey = await invoke<boolean>("has_gemini_api_key").catch(() => false);

        if (isCurrent && !hasApiKey) {
          setSetupStep("gemini");
        }
      } catch (error) {
        setFileStatus(String(error));
        setFileStatusKind("error");
        setSetupStep("folder");
      }
    })();

    return () => {
      isCurrent = false;
    };
  }, [openLoadedX2Folder]);

  useEffect(() => {
    if (!showApiKeyPrompt && setupStep !== "gemini") {
      return;
    }

    const animationFrame = requestAnimationFrame(() => {
      apiKeyInputRef.current?.focus();
    });

    return () => cancelAnimationFrame(animationFrame);
  }, [showApiKeyPrompt, setupStep]);

  useEffect(() => {
    if (!pendingStyleRestoreRef.current || !editorViewRef.current) {
      return;
    }

    let attempts = 0;
    let animationFrame = 0;

    const tryRestore = () => {
      attempts += 1;

      if (applyPendingStyleRestore(editorViewRef.current, pendingStyleRestoreRef, styleRangesRef)) {
        return;
      }

      if (attempts < 10) {
        animationFrame = requestAnimationFrame(tryRestore);
      }
    };

    animationFrame = requestAnimationFrame(tryRestore);
    return () => cancelAnimationFrame(animationFrame);
  }, [value]);

  useEffect(() => {
    const editorView = editorViewRef.current;

    if (editorView) {
      editorView.dispatch({ effects: setCodeBoxOutputs.of(codeRuns) });
    }
  }, [codeRuns]);

  useEffect(() => {
    const activeCell = activeStructuredCellRef.current;

    if (activeCell) {
      if (structuredTableModeRef.current === "navigating") {
        scheduleStructuredCellNavigation(
          activeCell,
          structuredTableSelectionModeRef.current
        );
      } else {
        scheduleStructuredCellFocus(activeCell);
      }
    }
  }, [tableRenderRevision]);

  useEffect(() => {
    const handleCellInput = (event: Event) => {
      const detail = (event as CustomEvent).detail as StructuredTableCellTarget & {
        text: string;
        formulaMenuQuery: string | null;
        menuCoords: { top: number; bottom: number; left: number };
      };

      updateStructuredCell(detail.tableId, detail.rowIndex, detail.columnIndex, (cell) => ({
        text: detail.text,
        activeStyle: cell.activeStyle,
        styles: cell.activeStyle && !isDefaultTextStyle(cell.activeStyle)
          ? [{
              from: 0,
              to: detail.text.length,
              style: cell.activeStyle
            }]
          : (cell.styles ?? [])
              .map((range) => ({
                ...range,
                from: Math.min(range.from, detail.text.length),
                to: Math.min(range.to, detail.text.length)
              }))
              .filter((range) => range.from < range.to)
      }));

      if (detail.formulaMenuQuery !== null) {
        const suggestionCount = getTableFormulaSuggestions(detail.formulaMenuQuery).length;
        const position = getCommandMenuPosition(detail.menuCoords, suggestionCount);
        setTableFormulaMenu({
          target: {
            tableId: detail.tableId,
            rowIndex: detail.rowIndex,
            columnIndex: detail.columnIndex
          },
          query: detail.formulaMenuQuery,
          ...position
        });
        setSelectedTableFormulaIndex(0);
      } else {
        setTableFormulaMenu(null);
        setSelectedTableFormulaIndex(0);
      }
    };

    const handleCellFocus = (event: Event) => {
      const detail = (event as CustomEvent).detail as StructuredTableCellTarget;
      activeStructuredCellRef.current = detail;
      structuredTableModeRef.current = "editing";
      setTableFormulaMenu((currentMenu) => (
        currentMenu && (
          currentMenu.target.tableId !== detail.tableId ||
          currentMenu.target.rowIndex !== detail.rowIndex ||
          currentMenu.target.columnIndex !== detail.columnIndex
        ) ? null : currentMenu
      ));
    };

    const handleFormulaMenuKey = (event: Event) => {
      const detail = (event as CustomEvent).detail as StructuredTableCellTarget & { key: string };

      if (!tableFormulaMenu) {
        return;
      }

      if (detail.key === "Escape") {
        setTableFormulaMenu(null);
        setSelectedTableFormulaIndex(0);
        return;
      }
      if (detail.key === "ArrowDown" && visibleTableFormulas.length > 0) {
        setSelectedTableFormulaIndex((currentIndex) => (
          (currentIndex + 1) % visibleTableFormulas.length
        ));
        return;
      }
      if (detail.key === "ArrowUp" && visibleTableFormulas.length > 0) {
        setSelectedTableFormulaIndex((currentIndex) => (
          (currentIndex - 1 + visibleTableFormulas.length) % visibleTableFormulas.length
        ));
        return;
      }
      if (detail.key === "Enter") {
        const command = visibleTableFormulas[selectedTableFormulaIndex];
        if (command) {
          insertStructuredTableFormulaTemplate(tableFormulaMenu.target, command.name);
        }
      }
    };

    const handleCellKey = (event: Event) => {
      const detail = (event as CustomEvent).detail as StructuredTableCellTarget & {
        key: string;
        shiftKey: boolean;
        ctrlKey: boolean;
        commandName: string;
        commandArgument: string;
        commandLength: number;
        selection: { from: number; to: number };
      };
      const table = structuredTablesRef.current.find((candidate) => candidate.id === detail.tableId);

      if (!table) {
        return;
      }

      if (detail.shiftKey && detail.key === "Tab") {
        addStructuredTableColumn(detail.tableId, detail.columnIndex, Math.max(0, detail.rowIndex));
        return;
      }

      if (detail.shiftKey && detail.key === "Enter") {
        addStructuredTableRow(detail.tableId, detail.columnIndex, detail.rowIndex);
        return;
      }

      if (detail.commandName) {
        runStructuredTableCellCommand(
          detail.tableId,
          detail.rowIndex,
          detail.columnIndex,
          detail.commandName,
          detail.commandArgument,
          detail.commandLength,
          detail.selection
        );
        return;
      }

      let targetRow = detail.rowIndex;
      let targetColumn = detail.columnIndex;

      if (detail.key === "Tab") {
        if (!detail.shiftKey && detail.columnIndex === table.columns.length - 1) {
          addStructuredTableColumn(detail.tableId, detail.columnIndex, Math.max(0, detail.rowIndex));
          return;
        }

        targetColumn += detail.shiftKey ? -1 : 1;
        if (targetColumn < 0) {
          targetColumn = table.columns.length - 1;
          targetRow -= 1;
        }
      } else if (detail.key === "Enter") {
        targetRow += 1;
      }

      if (targetRow < -1) {
        editorViewRef.current?.focus();
        return;
      }

      if (targetRow >= table.rows.length) {
        addStructuredTableRow(detail.tableId, targetColumn, detail.rowIndex);
        return;
      }

      moveStructuredTableCell({ tableId: detail.tableId, rowIndex: targetRow, columnIndex: targetColumn });
    };

    document.addEventListener(TABLE_WIDGET_INPUT_EVENT, handleCellInput);
    document.addEventListener(TABLE_WIDGET_FOCUS_EVENT, handleCellFocus);
    document.addEventListener(TABLE_WIDGET_KEY_EVENT, handleCellKey);
    document.addEventListener(TABLE_WIDGET_FORMULA_MENU_KEY_EVENT, handleFormulaMenuKey);
    return () => {
      document.removeEventListener(TABLE_WIDGET_INPUT_EVENT, handleCellInput);
      document.removeEventListener(TABLE_WIDGET_FOCUS_EVENT, handleCellFocus);
      document.removeEventListener(TABLE_WIDGET_KEY_EVENT, handleCellKey);
      document.removeEventListener(TABLE_WIDGET_FORMULA_MENU_KEY_EVENT, handleFormulaMenuKey);
    };
  }, [
    addStructuredTableColumn,
    addStructuredTableRow,
    insertStructuredTableFormulaTemplate,
    moveStructuredTableCell,
    runStructuredTableCellCommand,
    selectedTableFormulaIndex,
    tableFormulaMenu,
    visibleTableFormulas,
    updateStructuredCell
  ]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const editorView = editorViewRef.current;
      const activeElement = document.activeElement;
      const activeTableCell = activeElement instanceof HTMLElement
        ? activeElement.closest<HTMLElement>(".structured-table-cell-editor")
        : null;
      const activeTableWrapper = activeElement instanceof HTMLElement
        ? activeElement.closest<HTMLElement>(".structured-table-widget")
        : null;
      const activeCell = activeStructuredCellRef.current;

      if (event.key === "Shift") {
        tableShiftWasUsedRef.current = false;

        if (
          structuredTableModeRef.current === "navigating" &&
          activeTableWrapper &&
          activeCell
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (event.shiftKey) {
        tableShiftWasUsedRef.current = true;
      }

      if (
        structuredTableModeRef.current === "navigating" &&
        activeTableWrapper &&
        activeCell &&
        activeTableWrapper.dataset.tableId === activeCell.tableId
      ) {
        const table = structuredTablesRef.current.find((candidate) => candidate.id === activeCell.tableId);

        if (event.key === "Backspace") {
          const selectionMode = structuredTableSelectionModeRef.current;

          event.preventDefault();
          event.stopPropagation();
          if (selectionMode === "row" || selectionMode === "column") {
            if (selectionMode === "row") {
              deleteStructuredTableRow(
                activeCell.tableId,
                activeCell.rowIndex,
                activeCell.columnIndex
              );
            } else {
              deleteStructuredTableColumn(
                activeCell.tableId,
                activeCell.rowIndex,
                activeCell.columnIndex
              );
            }
          }
          return;
        }

        if (event.shiftKey && event.key === "Enter" && table) {
          event.preventDefault();
          event.stopPropagation();
          addStructuredTableRow(
            activeCell.tableId,
            activeCell.columnIndex,
            activeCell.rowIndex,
            "navigating"
          );
          return;
        }

        if (event.shiftKey && event.key === "Tab" && table) {
          event.preventDefault();
          event.stopPropagation();
          addStructuredTableColumn(
            activeCell.tableId,
            activeCell.columnIndex,
            activeCell.rowIndex,
            "navigating"
          );
          return;
        }

        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          moveStructuredTableCell(activeCell);
          return;
        }

        if (event.key === "Escape" && editorView) {
          const tableAnchor = getStructuredTableAnchorById(editorView.state.doc, activeCell.tableId);

          if (tableAnchor) {
            event.preventDefault();
            event.stopPropagation();
            activeStructuredCellRef.current = null;
            structuredTableModeRef.current = null;
            editorView.dispatch({
              selection: { anchor: tableAnchor.from },
              scrollIntoView: true
            });
            editorView.focus();
            return;
          }
        }

        const direction = event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey)
          ? "left"
          : event.key === "ArrowRight" || event.key === "Tab"
            ? "right"
            : event.key === "ArrowUp"
              ? "up"
              : event.key === "ArrowDown"
                ? "down"
                : null;

        if (table && direction) {
          event.preventDefault();
          event.stopPropagation();
          const hasHeader = table.columns.some((column) => column.trim().length > 0);
          const minimumRow = hasHeader ? -1 : 0;
          let rowIndex = activeCell.rowIndex;
          let columnIndex = activeCell.columnIndex;

          if (direction === "left") columnIndex = Math.max(0, columnIndex - 1);
          if (direction === "right") columnIndex = Math.min(table.columns.length - 1, columnIndex + 1);
          if (direction === "up") rowIndex = Math.max(minimumRow, rowIndex - 1);
          if (direction === "down") rowIndex = Math.min(table.rows.length - 1, rowIndex + 1);

          navigateStructuredTableCell({ tableId: table.id, rowIndex, columnIndex });
          return;
        }
      }

      if (
        event.key === "Escape" &&
        structuredTableModeRef.current === "editing" &&
        activeTableCell?.dataset.tableId
      ) {
        event.preventDefault();
        event.stopPropagation();
        navigateStructuredTableCell({
          tableId: activeTableCell.dataset.tableId,
          rowIndex: Number(activeTableCell.dataset.rowIndex ?? 0),
          columnIndex: Number(activeTableCell.dataset.columnIndex ?? 0)
        });
        return;
      }

      if (aiSession?.status === "ready" && event.key === "Enter") {
        if (editorView && document.activeElement !== editorView.contentDOM) {
          event.preventDefault();
          acceptAiSession(editorView);
          return;
        }
      }

      if (aiSession?.status === "ready" && event.key === "Tab") {
        event.preventDefault();
        cycleAiPlacement();
        return;
      }

      if (event.key !== "Escape") {
        return;
      }

      if (aiSession) {
        event.preventDefault();
        cancelAiSession();
        return;
      }

      if (editorView && activeTableCell?.dataset.tableId) {
        const tableAnchor = getStructuredTableAnchorById(
          editorView.state.doc,
          activeTableCell.dataset.tableId
        );

        if (tableAnchor) {
          event.preventDefault();
          event.stopPropagation();
          activeStructuredCellRef.current = null;
          editorView.dispatch({
            selection: { anchor: tableAnchor.from },
            scrollIntoView: true
          });
          editorView.focus();
          return;
        }
      }

      const editorHasFocus = !!editorView && editorView.contentDOM.contains(document.activeElement);
      const cursorIsInCodeBox = !!editorView && (
        !!getSelectedCodeBlock(editorView) ||
        !!getCodeBlockAtPosition(
          editorView.state.doc,
          editorView.state.selection.main.head
        )
      );

      if (editorHasFocus && cursorIsInCodeBox) {
        return;
      }

      if (editorHasFocus && getSelectedStructuredTableAnchor(editorView)) {
        return;
      }

      if (showCommands) {
        setShowCommands(false);
        setCommandQuery("");
        return;
      }

      const sidebarElement = sidebarRef.current;
      const isInSidebar = !!activeElement && !!sidebarElement?.contains(activeElement);

      if (!isInSidebar) {
        event.preventDefault();
        focusSidebarOnActiveNote();
      }
    };

    const handleKeyUp = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Shift" ||
        tableShiftWasUsedRef.current ||
        structuredTableModeRef.current !== "navigating"
      ) {
        return;
      }

      const activeElement = document.activeElement;
      const activeTableWrapper = activeElement instanceof HTMLElement
        ? activeElement.closest<HTMLElement>(".structured-table-widget")
        : null;
      const activeCell = activeStructuredCellRef.current;

      if (!activeTableWrapper || !activeCell) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const currentMode = structuredTableSelectionModeRef.current;
      const nextMode: StructuredTableSelectionMode = currentMode === "cell"
        ? "row"
        : currentMode === "row"
          ? "column"
          : "cell";
      selectStructuredTableRange(activeCell, nextMode);
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [
    acceptAiSession,
    addStructuredTableColumn,
    addStructuredTableRow,
    aiSession,
    cancelAiSession,
    cycleAiPlacement,
    deleteStructuredTableColumn,
    deleteStructuredTableRow,
    focusSidebarOnActiveNote,
    moveStructuredTableCell,
    navigateStructuredTableCell,
    selectStructuredTableRange,
    showCommands
  ]);

  return (
    <div className="editor-shell">
      <header className="app-title-bar" data-tauri-drag-region>
        <div className="app-title" data-tauri-drag-region>
          Orpits — x2pad
        </div>
        <WindowControls />
      </header>

      <div className="app-body">
        <aside
          className="vault-sidebar"
          ref={sidebarRef}
          tabIndex={0}
          onKeyDown={handleSidebarKeyDown}
        >
          <div className="vault-header">Vault</div>

          <label
            className={`vault-search ${sidebarSelection === 0 ? "selected" : ""}`}
          >
            <span className="search-glyph" aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchValue}
              placeholder="Search notes"
              onChange={(event) => setSearchValue(event.target.value)}
              onFocus={showSearchPane}
            />
          </label>

          <nav className="notes-nav" aria-label="Notes">
            <button
              type="button"
              className={`note-link new-note-link ${sidebarSelection === 1 ? "active" : ""}`}
              onFocus={() => {
                setSidebarSelection(1);
                setShowLogoPane(true);
                setShowCommands(false);
                setCommandQuery("");
              }}
              onClick={createNewNote}
            >
              <span className="note-link-title">+ New note</span>
              <span className="note-link-meta">Create .x2</span>
            </button>

            {filteredNotes.length === 0 && (
              <div className="notes-empty">
                {openedNotes.length === 0 ? "Create a note to start this folder." : "No matching notes."}
              </div>
            )}

            {filteredNotes.map((note, index) => {
              const selectionIndex = index + 2;
              const isSelected = sidebarSelection === selectionIndex;

              return (
                <button
                  type="button"
                  className={`note-link ${isSelected ? "active" : ""}`}
                  key={note.path}
                  title={note.path}
                  onFocus={() => {
                    setSidebarSelection(selectionIndex);
                    activateOpenedNote(note.path);
                  }}
                  onClick={() => activateOpenedNote(note.path)}
                >
                  <span className="note-link-title">{note.title || EMPTY_NOTE_TITLE}</span>
                  <span className="note-link-meta">{getSavedNoteMeta(note.savedAt)}</span>
                </button>
              );
            })}
          </nav>

          <div className="flow-status">
            <span>Flow Mode</span>
            <strong>Mouse optional · shortcuts optional</strong>
          </div>
        </aside>

        <main className="editor-main">
          <div className="note-status-bar">
            <a className="note-title-anchor" href="#" tabIndex={-1}>
              {showLogoPane ? "Search" : activeNoteTitle}
            </a>
            <div className="style-status">
              <span className={`file-status ${fileStatusKind}`}>{fileStatus}</span>
              <span>{styleIndicator}</span>
              <span className="saved-dot" aria-label="Saved" />
            </div>
          </div>

          <section className={`editor-stage ${showLogoPane ? "logo-mode" : ""}`}>
            {showLogoPane ? (
              <div className="logo-empty-state" aria-label="x2pad">
                <img src="/x2pad-logo.png" alt="" />
              </div>
            ) : (
              <CodeMirror
                key={openedNotePath ?? "empty-note"}
                className="note-editor"
                value={value}
                height="100%"
                theme="dark"
                extensions={editorExtensions}
                onChange={onChange}
                onCreateEditor={(view) => {
                  editorViewRef.current = view;

                  applyPendingStyleRestore(view, pendingStyleRestoreRef, styleRangesRef);
                }}
                basicSetup={{
                  lineNumbers: false,
                  foldGutter: false,
                  highlightActiveLine: false,
                  highlightActiveLineGutter: false
                }}
              />
            )}

            {showCommands && (
              <div
                className={`command-menu ${menuPos.placement === "above" ? "above" : "below"}`}
                style={{
                  top: menuPos.top,
                  left: menuPos.left
                }}
              >
                {visibleCommands.length > 0 ? visibleCommands.map((command, index) => (
                  <button
                    type="button"
                    className={`command-menu-item ${index === selectedCommandIndex ? "selected" : ""}`}
                    key={command.name}
                    onMouseEnter={() => setSelectedCommandIndex(index)}
                    onClick={() => {
                      const editorView = editorViewRef.current;
                      if (editorView) {
                        runCommandAtCursor(editorView, command);
                      }
                    }}
                  >
                    <code>//{command.name}</code>
                    <span>
                      {command.description}
                      {command.arguments ? `: ${command.arguments.join(", ")}` : ""}
                    </span>
                  </button>
                )) : (
                  <div className="command-menu-empty">
                    No commands match //{commandQuery}
                  </div>
                )}
              </div>
            )}

            {tableFormulaMenu && (
              <div
                className={`command-menu table-formula-menu ${tableFormulaMenu.placement}`}
                role="listbox"
                aria-label="Table formulas"
                style={{
                  top: tableFormulaMenu.top,
                  left: tableFormulaMenu.left
                }}
              >
                {visibleTableFormulas.length > 0 ? visibleTableFormulas.map((command, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === selectedTableFormulaIndex}
                    className={`command-menu-item ${index === selectedTableFormulaIndex ? "selected" : ""}`}
                    key={command.name}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setSelectedTableFormulaIndex(index)}
                    onClick={() => insertStructuredTableFormulaTemplate(
                      tableFormulaMenu.target,
                      command.name
                    )}
                  >
                    <code>//{command.name}()</code>
                    <span>{command.description} · {command.signature}</span>
                  </button>
                )) : (
                  <div className="command-menu-empty">
                    No table formulas match //{tableFormulaMenu.query}
                  </div>
                )}
              </div>
            )}

            {aiSession && (
              <div className={`ai-island ${aiSession.status}`} role="status" aria-live="polite">
                <div className="ai-island-mark" aria-hidden="true" />
                <div className="ai-island-content">
                  <div className="ai-island-title">
                    {aiSession.status === "thinking" && "AI thinking"}
                    {aiSession.status === "ready" && (aiSession.isMock ? "AI preview ready" : "AI ready")}
                    {aiSession.status === "error" && "AI stopped"}
                  </div>
                  <div className="ai-island-detail">
                    {aiSession.status === "thinking" && "Reading the note context"}
                    {aiSession.status === "ready" && activeAiPlacement && `Ready: ${getAiPlacementLabel(activeAiPlacement)}`}
                    {aiSession.status === "error" && (aiSession.error || "Something went wrong")}
                  </div>
                  <div className="ai-island-keys">
                    {aiSession.status === "ready" ? "Enter accept  Tab move  Esc cancel" : "Esc cancel"}
                  </div>
                </div>
              </div>
            )}

            {commandFeedback && (
              <div
                className={`command-feedback-island ${aiSession ? "with-ai-island" : ""}`}
                role="status"
                aria-live="polite"
              >
                <div className="command-feedback-mark" aria-hidden="true" />
                <div className="ai-island-content">
                  <div className="ai-island-title">{commandFeedback.title}</div>
                  <div className="ai-island-detail">{commandFeedback.detail}</div>
                </div>
              </div>
            )}

          </section>
        </main>
      </div>

      {setupStep && (
        <div className="setup-overlay">
          {setupStep === "folder" ? (
            <section className="setup-panel" aria-labelledby="setup-folder-title">
              <div className="setup-progress">Step 1 of 2</div>
              <h1 id="setup-folder-title">Choose your notes folder</h1>
              <p>
                x2pad stores notes as local .x2 files and loads the folder into the sidebar.
              </p>
              {setupStatus && (
                <div className="setup-status" role="status">
                  {setupStatus}
                </div>
              )}
              <div className="setup-actions">
                <button type="button" onClick={selectNoteFolder} disabled={isSelectingNoteFolder}>
                  {isSelectingNoteFolder ? "Selecting..." : "Select folder"}
                </button>
              </div>
            </section>
          ) : (
            <form className="setup-panel" onSubmit={saveGeminiApiKey} aria-labelledby="setup-gemini-title">
              <div className="setup-progress">Step 2 of 2</div>
              <h1 id="setup-gemini-title">Connect Gemini</h1>
              <p>
                Add a Gemini API key for AI writing commands, or skip this for now.
              </p>
              <input
                ref={apiKeyInputRef}
                type="password"
                value={apiKeyInput}
                placeholder="Paste key"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setApiKeyInput(event.target.value);
                  setApiKeyStatus("");
                }}
              />
              {apiKeyStatus && (
                <div className="setup-status" role="status">
                  {apiKeyStatus}
                </div>
              )}
              <div className="setup-actions">
                <button type="submit" disabled={isSavingApiKey}>
                  {isSavingApiKey ? "Saving..." : "Save key"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setApiKeyStatus("");
                    setSetupStep(null);
                  }}
                >
                  Skip
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {showApiKeyPrompt && !setupStep && (
        <div className="api-key-overlay">
          <form className="api-key-bubble" onSubmit={saveGeminiApiKey}>
            <div className="api-key-bubble-header">
              <span>Gemini API key</span>
              <button
                type="button"
                className="api-key-dismiss"
                onClick={() => {
                  setApiKeyStatus("");
                  setShowApiKeyPrompt(false);
                }}
                aria-label="Dismiss"
              >
                <span />
              </button>
            </div>
            <input
              ref={apiKeyInputRef}
              type="password"
              value={apiKeyInput}
              placeholder="Paste key"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setApiKeyInput(event.target.value);
                setApiKeyStatus("");
              }}
            />
            {apiKeyStatus && (
              <div className="api-key-status" role="status">
                {apiKeyStatus}
              </div>
            )}
            <div className="api-key-actions">
              <button type="submit" disabled={isSavingApiKey}>
                {isSavingApiKey ? "Saving..." : "Save key"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setApiKeyStatus("");
                  setShowApiKeyPrompt(false);
                }}
              >
                Later
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default Editor;
