import { useMemo } from "react";

interface FileSystemItem {
  id: string;
  name: string;
  type: "folder" | "note";
  lastEdited: Date;
}

interface ItemRowProps {
  item: FileSystemItem;
  isSelected: boolean;
  onClick: () => void;
  onHover: () => void;
}

// Function to convert date to relative time format
function getRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks}w ago`;
  }

  // Format as "Mar 24" for older dates
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function ItemRow({ item, isSelected, onClick, onHover }: ItemRowProps) {
  const relativeTime = useMemo(() => getRelativeTime(item.lastEdited), [item.lastEdited]);

  return (
    <div
      className={`item-row ${isSelected ? "selected" : ""}`}
      onClick={onClick}
      onMouseEnter={onHover}
    >
      <div className="item-header">
        <span className="item-icon">
          {item.type === "folder" ? "📁" : "📄"}
        </span>
        <span className="item-name">{item.name}</span>
        <span className="item-time">Last edited {relativeTime}</span>
      </div>
    </div>
  );
}

export default ItemRow;
