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

  // Just one mock note for testing the design
  const mockItems: FileSystemItem[] = [
    {
      id: "sample-note",
      name: "Sample Note",
      type: "note",
      lastEdited: new Date(Date.now() - 30 * 60 * 1000), // 30 minutes ago
    },
  ];

  // Sort items: folders first (alphabetically), then notes (by last edited, newest first)
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
      {/* Header */}
      <div className="start-page-header">
        <h1>x2pad</h1>
      </div>

      {/* Search Bar */}
      <div className="search-bar-container">
        <div className="search-bar">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            placeholder="Search notes (Ctrl + F)..."
            // TODO: Add search functionality
          />
        </div>
      </div>

      <ItemsList
        items={sortedItems}
        onSelectItem={(item) => {
          if (item.type === "folder") {
            // TODO: Navigate to folder view
          } else {
            // Navigate to editor
            navigate(`/editor/${item.id}`);
          }
        }}
        onNavigateBack={() => {
          // TODO: Go back to parent folder
        }}
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
