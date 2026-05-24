import { useState, useEffect, useRef } from "react";
import ItemRow from "./ItemRow";

interface FileSystemItem {
  id: string;
  name: string;
  type: "folder" | "note";
  lastEdited: Date;
}

interface ItemsListProps {
  items: FileSystemItem[];
  onSelectItem: (item: FileSystemItem) => void;
  onNavigateBack: () => void;
}

function ItemsList({ items, onSelectItem, onNavigateBack }: ItemsListProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isCreating, setIsCreating] = useState(false);
  const [creatingType, setCreatingType] = useState<"folder" | "note" | null>(null);
  const [creatingName, setCreatingName] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when creating
  useEffect(() => {
    if (isCreating && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isCreating]);

  // Scroll to keep selected item visible
  useEffect(() => {
    if (listRef.current) {
      const selectedElement = listRef.current.children[selectedIndex] as HTMLElement;
      if (selectedElement) {
        selectedElement.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // If creating, handle input-specific keys
    if (isCreating) {
      if (e.key === "Enter") {
        e.preventDefault();
        setIsCreating(false);
        setCreatingName("");
        setCreatingType(null);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setIsCreating(false);
        setCreatingName("");
        setCreatingType(null);
      }
      return;
    }

    // Navigation keys
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        break;
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
        break;
      case "Home":
        e.preventDefault();
        setSelectedIndex(0);
        break;
      case "End":
        e.preventDefault();
        setSelectedIndex(items.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        if (items[selectedIndex]) {
          onSelectItem(items[selectedIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        onNavigateBack();
        break;
      default:
        // Check for Ctrl+N (new note) and Ctrl+Shift+N (new folder)
        if (e.ctrlKey) {
          if (e.key === "n") {
            e.preventDefault();
            setIsCreating(true);
            setCreatingType("note");
          } else if (e.key === "N" || (e.shiftKey && e.key === "n")) {
            e.preventDefault();
            setIsCreating(true);
            setCreatingType("folder");
          }
        }
    }
  };

  return (
    <div className="items-list-container">
      <div
        className="items-list"
        ref={listRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {items.map((item, index) => (
          <ItemRow
            key={item.id}
            item={item}
            isSelected={index === selectedIndex}
            onClick={() => {
              setSelectedIndex(index);
              onSelectItem(item);
            }}
            onHover={() => setSelectedIndex(index)}
          />
        ))}

        {/* Creating new item input */}
        {isCreating && (
          <div className="item-row creating-row">
            <div className="item-header">
              <span className="item-icon">
                {creatingType === "folder" ? "📁" : "📄"}
              </span>
              <input
                ref={inputRef}
                type="text"
                className="create-input"
                placeholder={`Type ${creatingType} name...`}
                value={creatingName}
                onChange={(e) => setCreatingName(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ItemsList;
