import { useState, useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { CommandRegistry } from "../CommandRegistry";
import "../styles/Editor.css";

function Editor() {
  const navigate = useNavigate();
  const { noteId } = useParams();

  const [value, setValue] = useState("Welcome to 0x02. Type // to begin.");
  const [showCommands, setShowCommands] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  // Toolbar state
  const [selectedFont, setSelectedFont] = useState("Body");
  const [fontSize, setFontSize] = useState("12");
  const [textColor, setTextColor] = useState("#4d94ff");

  // The "Input Interceptor" logic
  const onChange = useCallback((val: string, viewUpdate: any) => {
    setValue(val);

    // Get cursor position to check what was just typed
    const state = viewUpdate.state;
    const cursor = state.selection.main.head;
    const lastTwoChars = state.sliceDoc(cursor - 2, cursor);

    if (lastTwoChars === "//") {
      // Trigger the command menu
      setShowCommands(true);

      // Basic logic to position the menu near the cursor
      const coords = viewUpdate.view.coordsAtPos(cursor);
      setMenuPos({ top: coords.bottom, left: coords.left });
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
            <option value="Heading">Heading</option>
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
            <button className="format-btn" title="Bold">
              <strong>B</strong>
            </button>
            <button className="format-btn" title="Italic">
              <em>I</em>
            </button>
            <button className="format-btn" title="Underline">
              <u>U</u>
            </button>
            <button className="format-btn strikethrough" title="Strikethrough">
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
          extensions={[markdown()]}
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
