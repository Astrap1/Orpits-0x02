import { useState, useCallback, useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, keymap } from "@codemirror/view";
import { CommandRegistry } from "../CommandRegistry";
import "../styles/Editor.css";

const DEFAULT_FONT_SIZE = "12";
const COMMANDS_WITH_ARGUMENTS = new Set(["color", "font"]);

interface ActiveTextStyle {
  fontSize: string;
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

const getTextStyleAttribute = (style: ActiveTextStyle) => {
  const styles = [`font-size: ${style.fontSize}px;`];
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

function Editor() {
  const navigate = useNavigate();
  const { noteId } = useParams();

  const [value, setValue] = useState("Welcome to 0x02. Type // to begin.");
  const [showCommands, setShowCommands] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  // Toolbar state
  const [selectedFont, setSelectedFont] = useState("Body");
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [textColor, setTextColor] = useState("#4d94ff");
  const [isBold, setBold] = useState(false);
  const [isItalic, setItalic] = useState(false);
  const [isStrike, setStrike] = useState(false);
  const [isUnderline, setUnderline] = useState(false);

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
    textStyleDecorations,
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
      ".cm-content": {
        fontSize: `${DEFAULT_FONT_SIZE}px`,
        lineHeight: "1.5"
      }
    })
  ], [fontSize, isBold, isItalic, isStrike, isUnderline, runCommandAtCursor]);

  // The "Input Interceptor" logic
  const onChange = useCallback((val: string, viewUpdate: any) => {
    setValue(val);

    // Get cursor position to check what was just typed
    const state = viewUpdate.state;
    const cursor = state.selection.main.head;
    const line = state.doc.lineAt(cursor);
    const cursorOffset = cursor - line.from;
    const textBeforeCursor = line.text.slice(0, cursorOffset);
    const isTypingCommand = /\/\/[a-z]*$/i.test(textBeforeCursor);

    if (isTypingCommand) {
      // Trigger the command menu
      setShowCommands(true);

      // Basic logic to position the menu near the cursor
      const coords = viewUpdate.view.coordsAtPos(cursor);
      if (coords) {
        setMenuPos({ top: coords.bottom, left: coords.left });
      }
    } else {
      setShowCommands(false);
    }
  }, []);

  // Calculate word count
  const wordCount = value.trim().split(/\s+/).filter(word => word.length > 0).length;

  // Handle Escape key to go back
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !showCommands) {
        navigate("/");
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [navigate, showCommands]);

  return (
    <div className="editor-page">
      {/* Title Bar */}
      <div className="editor-title-bar">
        <div className="title-bar-left">
          <button className="back-button" onClick={() => navigate("/")} title="Back to notes (Esc)">
            esc
          </button>
          <h1>x2pad</h1>
        </div>
        <div className="title-bar-right">
          <span className="note-name">{noteId || "Untitled"}</span>
        </div>
      </div>

      {/* Toolbar */}
      <div className="editor-toolbar">
        <div className="toolbar-left">
          {/* Font Selection */}
          <select
            className="font-selector"
            value={selectedFont}
            onChange={(e) => setSelectedFont(e.target.value)}
          >
            <option value="Body">Body</option>
            <option value="Header">Header</option>
            <option value="Title">Title</option>
            <option value="Monospace">Monospace</option>
          </select>

          {/* Font Size */}
          <select
            className="font-size-selector"
            value={fontSize}
            onChange={(e) => setFontSize(e.target.value)}
          >
            <option value="10">10</option>
            <option value="11">11</option>
            <option value="12">12</option>
            <option value="14">14</option>
            <option value="16">16</option>
            <option value="18">18</option>
            <option value="20">20</option>
            <option value="24">24</option>
          </select>

          {/* Color Picker */}
          <div className="color-picker-container">
            <input
              type="color"
              className="color-picker"
              value={textColor}
              onChange={(e) => setTextColor(e.target.value)}
            />
          </div>

          {/* Formatting Buttons */}
          <div className="formatting-buttons">
            <button
              className={`format-btn ${isBold ? "active" : ""}`}
              title="Bold"
              onClick={() => setBold((enabled) => !enabled)}
            >
              <strong>B</strong>
            </button>
            <button
              className={`format-btn ${isItalic ? "active" : ""}`}
              title="Italic"
              onClick={() => setItalic((enabled) => !enabled)}
            >
              <em>I</em>
            </button>
            <button
              className={`format-btn ${isUnderline ? "active" : ""}`}
              title="Underline"
              onClick={() => setUnderline((enabled) => !enabled)}
            >
              <u>U</u>
            </button>
            <button
              className={`format-btn strikethrough ${isStrike ? "active" : ""}`}
              title="Strikethrough"
              onClick={() => setStrike((enabled) => !enabled)}
            >
              <span style={{ textDecoration: 'line-through' }}>abc</span>
            </button>
          </div>
        </div>

        <div className="toolbar-right">
          {/* Word/Character Count */}
          <div className="word-count">
            Count: {wordCount}
          </div>
        </div>
      </div>

      {/* Editor Area */}
      <div className="editor-container">
        <CodeMirror
          value={value}
          height="100%"
          theme="dark"
          extensions={editorExtensions}
          onChange={onChange}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
          }}
        />

        {/* Command Menu */}
        {showCommands && (
          <div
            className="command-menu"
            style={{
              position: 'absolute',
              top: menuPos.top,
              left: menuPos.left,
              background: '#2d2d2d',
              border: '1px solid #444',
              padding: '10px',
              zIndex: 1000,
              color: 'white'
            }}
          >
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {CommandRegistry.map(cmd => (
                <li key={cmd.name}>// {cmd.name} - {cmd.description}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="editor-status-bar">
        <div className="status-left">
          <span>Total Pages: 1</span>
        </div>
        <div className="status-right">
          <span>Saved: 2 min ago</span>
        </div>
      </div>
    </div>
  );
}

export default Editor;
