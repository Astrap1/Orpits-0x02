import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent, MutableRefObject } from "react";
import { useNavigate, useParams } from "react-router-dom";
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

const notes = [
  {
    id: "sample-note",
    title: "Sample Note",
    updatedAt: "Today",
    content:
      "Welcome to x2pad.\n\nType //title, //header, //body, //bold, //italic, //size 12, //bulletlist, //numberlist, //date, //time, //wordcount, or //color red and press Enter to change the writing style.\n\n// color red\nThis line is a custom registry command, so it gets its own visual language."
  },
  {
    id: "second-sample-note",
    title: "Second Sample Note",
    updatedAt: "Just now",
    content:
      "This is a second sample note.\n\nUse it to test switching between notes from the Vault sidebar while keeping the editor aligned like a normal writing surface."
  }
];

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

interface LoadedX2Note {
  title: string;
  content: string;
  savedAt: string;
  path: string;
  styles?: TextStyleRange[];
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

  for (let index = 1; index <= doc.lines; index += 1) {
    const line = doc.line(index);

    if (line.text.trimStart().startsWith("//")) {
      builder.add(line.from, line.from, Decoration.line({ class: "cm-command-line" }));
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

function getSafeFileName(title: string, extension: "x2" | "pdf") {
  const baseName = title
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim() || "Untitled Note";

  return `${baseName}.${extension}`;
}

function ensurePathExtension(path: string, extension: "x2" | "pdf") {
  return path.toLowerCase().endsWith(`.${extension}`) ? path : `${path}.${extension}`;
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
  const navigate = useNavigate();
  const { noteId } = useParams();
  const initialNote = notes.find((note) => note.id === noteId) ?? notes[0];
  const sidebarRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const pendingStyleRestoreRef = useRef<PendingStyleRestore | null>(null);
  const styleRangesRef = useRef<TextStyleRange[]>([]);
  const forcedStyleRangesRef = useRef<TextStyleRange[] | null>(null);

  const [activeNoteId, setActiveNoteId] = useState(initialNote.id);
  const [openedNoteTitle, setOpenedNoteTitle] = useState<string | null>(null);
  const [openedNotePath, setOpenedNotePath] = useState<string | null>(null);
  const [value, setValue] = useState(initialNote.content);
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

  const [selectedFont, setSelectedFont] = useState("Body");
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [textColor, setTextColor] = useState("White");
  const [isBold, setBold] = useState(false);
  const [isItalic, setItalic] = useState(false);
  const [isStrike, setStrike] = useState(false);
  const [isUnderline, setUnderline] = useState(false);

  const filteredNotes = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    if (!query) return notes;
    return notes.filter((note) => note.title.toLowerCase().includes(query));
  }, [searchValue]);

  const activeNote = notes.find((note) => note.id === activeNoteId) ?? notes[0];
  const activeNoteTitle = openedNoteTitle ?? activeNote.title;
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
    const activeNoteIndex = filteredNotes.findIndex((note) => note.id === activeNoteId);

    if (activeNoteIndex >= 0) {
      setSidebarSelection(activeNoteIndex + 1);
      setShowLogoPane(false);
    }

    setShowCommands(false);
    setCommandQuery("");

    requestAnimationFrame(() => {
      sidebarRef.current?.focus();
    });
  }, [activeNoteId, filteredNotes]);

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

  const setActiveNote = useCallback((noteIdToActivate: string, shouldNavigate = false) => {
    const nextNote = notes.find((note) => note.id === noteIdToActivate);
    if (!nextNote) return;

    setActiveNoteId(nextNote.id);
    setOpenedNoteTitle(null);
    setOpenedNotePath(null);
    pendingStyleRestoreRef.current = null;
    styleRangesRef.current = [];
    setValue(nextNote.content);
    setShowLogoPane(false);
    setShowCommands(false);
    setCommandQuery("");

    requestAnimationFrame(() => {
      editorViewRef.current?.dispatch({
        selection: { anchor: 0 },
        effects: replaceTextStyleDecorations.of([])
      });
    });

    if (shouldNavigate) {
      navigate(`/editor/${nextNote.id}`);
    }
  }, [navigate]);

  const showSearchPane = useCallback(() => {
    setSidebarSelection(0);
    setShowLogoPane(true);
    setShowCommands(false);
    setCommandQuery("");
  }, []);

  const runFileCommand = useCallback(async (
    commandName: "save" | "open" | "export",
    documentText: string,
    title: string,
    currentPath: string | null,
    styles: TextStyleRange[]
  ) => {
    const isTauri = "__TAURI_INTERNALS__" in window;

    if (!isTauri) {
      setFileStatus("Open, save, and export require the desktop app.");
      setFileStatusKind("error");
      return;
    }

    const isSaveCommand = commandName === "save";
    const isOpenCommand = commandName === "open";
    const extension = isSaveCommand ? "x2" : "pdf";
    let outputPath = currentPath && isSaveCommand ? currentPath : null;

    if (isOpenCommand) {
      const selectedPath = await open({
        multiple: false,
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
        const note = await invoke<LoadedX2Note>("load_x2_note", { path: selectedPath });
        openLoadedX2Note(note);
      } catch (error) {
        setFileStatus(String(error));
        setFileStatusKind("error");
      }

      return;
    }

    if (!outputPath) {
      const selectedPath = await save({
        defaultPath: getSafeFileName(title, extension),
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
        setOpenedNoteTitle(title || "Untitled Note");
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
  }, [openLoadedX2Note]);

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

    if (commandName === "save" || commandName === "open" || commandName === "export") {
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
        run: (view) => runCommandAtCursor(view) || continueListAtCursor(view)
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
  ], [fontSize, textColor, isBold, isItalic, isStrike, isUnderline, runCommandAtCursor]);

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

      const selectedNote = filteredNotes[sidebarSelection - 1];
      if (selectedNote) {
        setActiveNote(selectedNote.id, true);
        focusEditorAtStart();
      }
      return;
    }

    const maxSelection = filteredNotes.length;
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

    const selectedNote = filteredNotes[nextSelection - 1];
    if (selectedNote) {
      setActiveNote(selectedNote.id);
    }
  };

  useEffect(() => {
    const noteIndex = filteredNotes.findIndex((note) => note.id === activeNoteId);
    if (noteIndex >= 0 && !showLogoPane) {
      setSidebarSelection(noteIndex + 1);
    }
  }, [activeNoteId, filteredNotes, showLogoPane]);

  useEffect(() => {
    sidebarRef.current?.focus();
  }, []);

  useEffect(() => {
    const isTauri = "__TAURI_INTERNALS__" in window;

    if (!isTauri) {
      return;
    }

    void invoke<LoadedX2Note | null>("load_startup_x2_note")
      .then((note) => {
        if (!note) {
          return;
        }

        openLoadedX2Note(note);
      })
      .catch((error) => {
        setFileStatus(String(error));
        setFileStatusKind("error");
      });
  }, [openLoadedX2Note]);

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
      if (event.key !== "Escape") {
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
  }, [focusSidebarOnActiveNote, showCommands]);

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
            {filteredNotes.map((note, index) => {
              const selectionIndex = index + 1;
              const isSelected = sidebarSelection === selectionIndex;
              const isActive = activeNoteId === note.id && !showLogoPane;

              return (
                <button
                  type="button"
                  className={`note-link ${isSelected || isActive ? "active" : ""}`}
                  key={note.id}
                  onMouseEnter={() => {
                    setSidebarSelection(selectionIndex);
                    setActiveNote(note.id);
                  }}
                  onFocus={() => {
                    setSidebarSelection(selectionIndex);
                    setActiveNote(note.id);
                  }}
                  onClick={() => setActiveNote(note.id, true)}
                >
                  <span className="note-link-title">{note.title}</span>
                  <span className="note-link-meta">{note.updatedAt}</span>
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
            <a className="note-title-anchor" href={`#/editor/${activeNote.id}`} tabIndex={-1}>
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
          </section>
        </main>
      </div>
    </div>
  );
}

export default Editor;
