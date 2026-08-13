import { useNavigate } from "react-router-dom";
import "../styles/StartPage.css";
import ItemsList from "../components/ItemsList";

interface FileSystemItem {
  id: string;
  name: string;
  type: "folder" | "note";
  lastEdited: Date;
}

function StartPage() {
  const navigate = useNavigate();

  const mockItems: FileSystemItem[] = [
    {
      id: "sample-note",
      name: "Sample Note",
      type: "note",
      lastEdited: new Date(Date.now() - 30 * 60 * 1000),
    },
  ];

  const sortedItems = [...mockItems].sort((a, b) => {
    if (a.type === "folder" && b.type === "note") return -1;
    if (a.type === "note" && b.type === "folder") return 1;
    if (a.type === "folder" && b.type === "folder") {
      return a.name.localeCompare(b.name);
    }
    return b.lastEdited.getTime() - a.lastEdited.getTime();
  });

  return (
    <div className="start-page">
      <div className="start-page-header">
        <h1>x2pad</h1>
      </div>

      <div className="search-bar-container">
        <div className="search-bar">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            placeholder="Search notes (Ctrl + F)..."
          />
        </div>
      </div>

      <ItemsList
        items={sortedItems}
        onSelectItem={(item) => {
          if (item.type !== "folder") {
            navigate(`/editor/${item.id}`);
          }
        }}
        onNavigateBack={() => {}}
      />

      <footer className="start-page-footer">
        <div className="shortcut-item">
          <span className="shortcut-key">Ctrl+N</span>
          <span>New Note</span>
        </div>
        <div className="shortcut-item">
          <span className="shortcut-key">Ctrl+F</span>
          <span>Fuzzy Search</span>
        </div>
        <div className="shortcut-item">
          <span className="shortcut-key">↑ ↓</span>
          <span>Navigate</span>
        </div>
        <div className="shortcut-item">
          <span className="shortcut-key">Enter</span>
          <span>Open Note</span>
        </div>
        <div className="shortcut-item">
          <span className="shortcut-key">?</span>
          <span>Shortcuts Help</span>
        </div>
      </footer>
    </div>
  );
}

export default StartPage;
