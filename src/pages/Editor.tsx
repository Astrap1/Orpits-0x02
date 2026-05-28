import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { Prec, RangeSetBuilder, StateEffect, StateField, Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, keymap } from "@codemirror/view";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CommandRegistry } from "../CommandRegistry";
import "../styles/Editor.css";

const DEFAULT_FONT_SIZE = "14";
const COMMANDS_WITH_ARGUMENTS = new Set(["color", "font"]);

const notes = [
  {
    id: "sample-note",
    title: "Sample Note",
    updatedAt: "Today",
    content:
      "Welcome to x2pad.\n\nType //title, //header, //body, //bold, //italic, or //color cyan and press Enter to change the writing style.\n\n// color cyan\nThis line is a custom registry command, so it gets its own visual language."
  },
  {
    id: "second-sample-note",
    title: "Second Sample Note",
    updatedAt: "Just now",
    content:
      "This is a second sample note.\n\nUse it to test switching between notes from the Vault sidebar while keeping the editor aligned like a normal writing surface."
  }
];

const colorValues: Record<string, string> = {
  Blue: "#7aa2ff",
  Cyan: "#67e8f9",
  Green: "#8ee6a8",
  Purple: "#c4a7ff",
  Red: "#ff8f9b",
  White: "#f7f2ff",
  Yellow: "#f5d76e"
};

interface ActiveTextStyle {
  fontSize: string;
  textColor: string;
  isBold: boolean;
  isItalic: boolean;
  isStrike: boolean;
  isUnderline: boolean;
}

const addTextStyleDecoration = StateEffect.define<{
  from: number;
  to: number;
  style: ActiveTextStyle;
}>();

const getResolvedColor = (color: string) => colorValues[color] ?? color;

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

const textStyleDecorations = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    let mappedDecorations = decorations.map(transaction.changes);

    for (const effect of transaction.effects) {
      if (effect.is(addTextStyleDecoration)) {
        const { from, to, style } = effect.value;

        if (from < to) {
          mappedDecorations = mappedDecorations.update({
            add: [
              Decoration.mark({
                attributes: {
                  style: getTextStyleAttribute(style)
                }
              }).range(from, to)
            ]
          });
        }
      }
    }

    return mappedDecorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

function buildCommandLineDecorations(doc: Text) {
  const builder = new RangeSetBuilder<Decoration>();

  for (let index = 1; index <= doc.lines; index += 1) {
    const line = doc.line(index);

    if (line.text.trimStart().startsWith("//")) {
      builder.add(line.from, line.from, Decoration.line({ class: "cm-command-line" }));
      builder.add(line.from, line.to, Decoration.mark({ class: "cm-command-command" }));
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

  const [activeNoteId, setActiveNoteId] = useState(initialNote.id);
  const [value, setValue] = useState(initialNote.content);
  const [searchValue, setSearchValue] = useState("");
  const [sidebarSelection, setSidebarSelection] = useState(1);
  const [showLogoPane, setShowLogoPane] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  const [selectedFont, setSelectedFont] = useState("Body");
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [textColor, setTextColor] = useState("Cyan");
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

  const focusEditorAtStart = useCallback(() => {
    setShowLogoPane(false);
    setShowCommands(false);

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

    requestAnimationFrame(() => {
      sidebarRef.current?.focus();
    });
  }, [activeNoteId, filteredNotes]);

  const setActiveNote = useCallback((noteIdToActivate: string, shouldNavigate = false) => {
    const nextNote = notes.find((note) => note.id === noteIdToActivate);
    if (!nextNote) return;

    setActiveNoteId(nextNote.id);
    setValue(nextNote.content);
    setShowLogoPane(false);
    setShowCommands(false);

    requestAnimationFrame(() => {
      editorViewRef.current?.dispatch({ selection: { anchor: 0 } });
    });

    if (shouldNavigate) {
      navigate(`/editor/${nextNote.id}`);
    }
  }, [navigate]);

  const showSearchPane = useCallback(() => {
    setSidebarSelection(0);
    setShowLogoPane(true);
    setShowCommands(false);
  }, []);

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

    const handled = command.action(
      {
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
        insert: ""
      }
    });
    setShowCommands(false);
    return true;
  }, []);

  const editorExtensions = useMemo(() => [
    markdown(),
    EditorView.lineWrapping,
    textStyleDecorations,
    commandLineDecorations,
    Prec.highest(keymap.of([
      {
        key: "Enter",
        run: runCommandAtCursor
      }
    ])),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) {
        return;
      }

      const effects: StateEffect<unknown>[] = [];

      update.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
        if (fromB >= toB || inserted.toString().trim().length === 0) {
          return;
        }

        effects.push(addTextStyleDecoration.of({
          from: fromB,
          to: toB,
          style: {
            fontSize,
            textColor,
            isBold,
            isItalic,
            isStrike,
            isUnderline
          }
        }));
      });

      if (effects.length > 0) {
        update.view.dispatch({ effects });
      }
    }),
    EditorView.theme({
      "&": {
        backgroundColor: "transparent",
        color: "#f2eefc"
      },
      ".cm-content": {
        caretColor: "#c4a7ff",
        fontFamily: "'Inter', 'SF Pro Text', 'Segoe UI', sans-serif",
        fontSize: `${DEFAULT_FONT_SIZE}px`,
        lineHeight: "1.72",
        padding: "44px 0 80px"
      },
      ".cm-line": {
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
    const isTypingCommand = /\/\/[a-z]*(?:\s+[^/\s]*)?$/i.test(textBeforeCursor);

    if (isTypingCommand) {
      setShowCommands(true);

      const coords = viewUpdate.view.coordsAtPos(cursor);
      if (coords) {
        setMenuPos({ top: coords.bottom + 8, left: coords.left });
      }
    } else {
      setShowCommands(false);
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
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      if (showCommands) {
        setShowCommands(false);
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
              {showLogoPane ? "Search" : activeNote.title}
            </a>
            <div className="style-status">
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
                className="command-menu"
                style={{
                  top: menuPos.top,
                  left: menuPos.left
                }}
              >
                {CommandRegistry.map((command) => (
                  <div className="command-menu-item" key={command.name}>
                    <code>// {command.name}</code>
                    <span>{command.description}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

export default Editor;
