import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { FormEvent, KeyboardEvent, MutableRefObject } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { Prec, RangeSetBuilder, StateEffect, StateField, Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, keymap } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CommandRegistry, TEXT_COLOR_OPTIONS } from "../CommandRegistry";
import "../styles/Editor.css";

const DEFAULT_FONT_SIZE = "14";
const COMMAND_MENU_MAX_HEIGHT = 360;
const COMMAND_MENU_VERTICAL_GAP = 8;
const COMMAND_MENU_PADDING = 16;
const COMMAND_MENU_ITEM_HEIGHT = 41;
const COMMANDS_WITH_ARGUMENTS = new Set(["color", "size"]);
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
}

interface LoadedX2Folder {
  notes: LoadedX2Note[];
  activePath: string;
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
  return {
    ...defaultTextStyle,
    isBold: delimiter !== "_",
    isItalic: delimiter === "_"
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

  for (let index = 1; index <= doc.lines; index += 1) {
    const line = doc.line(index);

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

function getCommandAtCursor(view: EditorView) {
  const selection = view.state.selection.main;

  if (!selection.empty) {
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
  const sidebarRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const pendingStyleRestoreRef = useRef<PendingStyleRestore | null>(null);
  const styleRangesRef = useRef<TextStyleRange[]>([]);
  const forcedStyleRangesRef = useRef<TextStyleRange[] | null>(null);
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);

  const [openedNoteTitle, setOpenedNoteTitle] = useState<string | null>(null);
  const [openedNotePath, setOpenedNotePath] = useState<string | null>(null);
  const [openedNotes, setOpenedNotes] = useState<LoadedX2Note[]>([]);
  const [value, setValue] = useState("");
  const [searchValue, setSearchValue] = useState("");
  const [sidebarSelection, setSidebarSelection] = useState(1);
  const [showLogoPane, setShowLogoPane] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
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
    const query = commandQuery.trim().toLowerCase();

    if (!query) {
      return CommandRegistry;
    }

    return CommandRegistry.filter((command) => command.name.toLowerCase().startsWith(query));
  }, [commandQuery]);

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
    setOpenedNoteTitle(note.title || "Untitled Note");
    setOpenedNotePath(note.path);
    setValue(note.content);
    setShowLogoPane(false);
    setShowCommands(false);
    setCommandQuery("");
    setFileStatus("Opened .x2 file.");
    setFileStatusKind("success");
  }, []);

  const cacheCurrentOpenedNote = useCallback(() => {
    if (!openedNotePath) {
      return;
    }

    const activePathKey = getPathKey(openedNotePath);
    const currentStyles = styleRangesRef.current.map((range) => ({
      ...range,
      style: { ...range.style }
    }));

    setOpenedNotes((currentNotes) => currentNotes.map((note) => (
      getPathKey(note.path) === activePathKey
        ? {
            ...note,
            title: openedNoteTitle || note.title,
            content: value,
            styles: currentStyles
          }
        : note
    )));
  }, [openedNotePath, openedNoteTitle, value]);

  const activateOpenedNote = useCallback((path: string) => {
    const targetPathKey = getPathKey(path);
    const targetNote = openedNotes.find((note) => getPathKey(note.path) === targetPathKey);

    if (!targetNote) {
      return;
    }

    if (getPathKey(openedNotePath ?? "") === targetPathKey) {
      setShowLogoPane(false);
      setShowCommands(false);
      setCommandQuery("");
      return;
    }

    cacheCurrentOpenedNote();
    openLoadedX2Note(targetNote);
  }, [cacheCurrentOpenedNote, openLoadedX2Note, openedNotePath, openedNotes]);

  const openLoadedX2Folder = useCallback((folder: LoadedX2Folder) => {
    const activePathKey = getPathKey(folder.activePath);
    const activeNote = folder.notes.find((note) => getPathKey(note.path) === activePathKey)
      ?? folder.notes[0];

    if (!activeNote) {
      setOpenedNotes([]);
      setOpenedNoteTitle(null);
      setOpenedNotePath(null);
      pendingStyleRestoreRef.current = {
        content: "",
        styles: []
      };
      setValue("");
      setShowLogoPane(true);
      setShowCommands(false);
      setCommandQuery("");
      setFileStatus("Notes folder selected. Create your first note.");
      setFileStatusKind("success");
      return;
    }

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

  const runFileCommand = useCallback(async (
    commandName: "save" | "new" | "open" | "export",
    documentText: string,
    title: string,
    currentPath: string | null,
    styles: TextStyleRange[]
  ) => {
    const isTauri = "__TAURI_INTERNALS__" in window;

    if (!isTauri) {
      setFileStatus("New, open, save, and export require the desktop app.");
      setFileStatusKind("error");
      return;
    }

    const isSaveCommand = commandName === "save";
    const isNewCommand = commandName === "new";
    const isOpenCommand = commandName === "open";
    const extension = isSaveCommand ? "x2" : "pdf";
    let outputPath = currentPath && isSaveCommand ? currentPath : null;
    const defaultNoteFolder = await invoke<string>("get_default_note_folder").catch(() => "");

    if (isOpenCommand) {
      const selectedPath = await open({
        multiple: false,
        defaultPath: defaultNoteFolder || undefined,
        filters: [
          {
            name: "x2 note",
            extensions: ["x2"]
          }
        ]
      });

      if (!selectedPath || Array.isArray(selectedPath)) {
        setFileStatus("Open cancelled.");
        setFileStatusKind("idle");
        return;
      }

      try {
        setFileStatus("Opening .x2 file...");
        setFileStatusKind("idle");
        const folder = await invoke<LoadedX2Folder>("load_x2_folder", { path: selectedPath });
        openLoadedX2Folder(folder);
      } catch (error) {
        setFileStatus(String(error));
        setFileStatusKind("error");
      }

      return;
    }

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
        styles: []
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
      styles
    };

    try {
      setFileStatus(isSaveCommand ? "Saving..." : "Exporting PDF...");
      setFileStatusKind("idle");

      if (isSaveCommand) {
        await invoke("save_x2_note", { path: outputPath, note });
        const savedTitle = title || "Untitled Note";
        const savedPathKey = getPathKey(outputPath);
        const savedNote: LoadedX2Note = {
          title: savedTitle,
          content: documentText,
          savedAt: new Date().toISOString(),
          path: outputPath,
          styles
        };

        setOpenedNotes((currentNotes) => {
          const existingIndex = currentNotes.findIndex((currentNote) => (
            getPathKey(currentNote.path) === savedPathKey
          ));

          if (existingIndex < 0) {
            return [...currentNotes, savedNote];
          }

          return currentNotes.map((currentNote, index) => (
            index === existingIndex ? savedNote : currentNote
          ));
        });
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
  }, [openLoadedX2Folder]);

  const createNewNote = useCallback(() => {
    const currentStyles = styleRangesRef.current.map((range) => ({
      ...range,
      style: { ...range.style }
    }));

    void runFileCommand("new", value, activeNoteTitle, openedNotePath, currentStyles);
  }, [activeNoteTitle, openedNotePath, runFileCommand, value]);

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

  const runCommandAtCursor = useCallback((view: EditorView) => {
    const pendingCommand = getCommandAtCursor(view);

    if (!pendingCommand) {
      return false;
    }

    const command = CommandRegistry.find(
      (registeredCommand) => registeredCommand.name.toLowerCase() === pendingCommand.name
    );

    if (!command) {
      return false;
    }

    if (pendingCommand.argument && !COMMANDS_WITH_ARGUMENTS.has(command.name.toLowerCase())) {
      return false;
    }

    const commandName = command.name.toLowerCase();
    const documentText = (
      view.state.doc.sliceString(0, pendingCommand.from) +
      view.state.doc.sliceString(pendingCommand.to)
    );
    const documentStyles = removeTextRangeFromStyleRanges(
      styleRangesRef.current,
      pendingCommand.from,
      pendingCommand.to
    );

    if (commandName === "save" || commandName === "new" || commandName === "open" || commandName === "export") {
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
      void runFileCommand(commandName, documentText, activeNoteTitle, openedNotePath, documentStyles);
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
      pendingCommand.argument
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
  }, [activeNoteTitle, openedNotePath, runFileCommand]);

  const editorExtensions = useMemo(() => [
    markdown(),
    EditorView.lineWrapping,
    textStyleDecorations,
    commandLineDecorations,
    Prec.highest(keymap.of([
      {
        key: "Enter",
        run: (view) => acceptAiSession(view) || runAiCommandAtCursor(view) || runCommandAtCursor(view) || continueListAtCursor(view)
      },
      {
        key: "Tab",
        run: () => aiSession?.status === "ready" ? cycleAiPlacement() : false
      },
      {
        key: "Escape",
        run: () => aiSession ? cancelAiSession() : false
      },
      {
        key: "Backspace",
        run: deleteListMarkerAtCursor
      }
    ])),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) {
        return;
      }

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
    cycleAiPlacement,
    runAiCommandAtCursor,
    runCommandAtCursor
  ]);

  const onChange = useCallback((val: string, viewUpdate: any) => {
    setValue(val);

    const state = viewUpdate.state;
    const cursor = state.selection.main.head;
    const line = state.doc.lineAt(cursor);
    const cursorOffset = cursor - line.from;
    const textBeforeCursor = line.text.slice(0, cursorOffset);
    const commandMatch = textBeforeCursor.match(/\/\/([a-z]*)(?:\s+[^/\s]*)?$/i);

    if (commandMatch) {
      const nextCommandQuery = commandMatch[1].toLowerCase();
      const nextVisibleCommandCount = nextCommandQuery
        ? CommandRegistry.filter((command) => command.name.toLowerCase().startsWith(nextCommandQuery)).length
        : CommandRegistry.length;

      setShowCommands(true);
      setCommandQuery(nextCommandQuery);

      const coords = viewUpdate.view.coordsAtPos(cursor);
      if (coords) {
        setMenuPos(getCommandMenuPosition(coords, nextVisibleCommandCount));
      }
    } else {
      setShowCommands(false);
      setCommandQuery("");
    }
  }, []);

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
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (aiSession?.status === "ready" && event.key === "Enter") {
        const editorView = editorViewRef.current;

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

      if (showCommands) {
        setShowCommands(false);
        setCommandQuery("");
        return;
      }

      const activeElement = document.activeElement;
      const sidebarElement = sidebarRef.current;
      const isInSidebar = !!activeElement && !!sidebarElement?.contains(activeElement);

      if (!isInSidebar) {
        event.preventDefault();
        focusSidebarOnActiveNote();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [acceptAiSession, aiSession, cancelAiSession, cycleAiPlacement, focusSidebarOnActiveNote, showCommands]);

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
            onMouseEnter={showSearchPane}
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
              onMouseEnter={() => setSidebarSelection(1)}
              onFocus={() => setSidebarSelection(1)}
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
              const isActive = getPathKey(openedNotePath ?? "") === getPathKey(note.path) && !showLogoPane;

              return (
                <button
                  type="button"
                  className={`note-link ${isSelected || isActive ? "active" : ""}`}
                  key={note.path}
                  title={note.path}
                  onMouseEnter={() => {
                    setSidebarSelection(selectionIndex);
                    activateOpenedNote(note.path);
                  }}
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
                {visibleCommands.length > 0 ? visibleCommands.map((command) => (
                  <div className="command-menu-item" key={command.name}>
                    <code>//{command.name}</code>
                    <span>
                      {command.description}
                      {command.arguments ? `: ${command.arguments.join(", ")}` : ""}
                    </span>
                  </div>
                )) : (
                  <div className="command-menu-empty">
                    No commands match //{commandQuery}
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
