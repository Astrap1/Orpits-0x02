export interface CommandActionContext {
  getDocumentText: () => string;
  insertText: (text: string) => void;
  setFontSize: (size: string) => void;
  setSelectedFont: (font: string) => void;
  setTextColor: (color: string) => void;
  setBold: (enabled: boolean) => void;
  setItalic: (enabled: boolean) => void;
  setStrike: (enabled: boolean) => void;
  setUnderline: (enabled: boolean) => void;
}

interface Command {
  name: string;
  description: string;
  arguments?: string[];
  action: (context: CommandActionContext, argument?: string) => boolean;
}

export const TEXT_COLOR_OPTIONS = [
  { name: "red", label: "Red", value: "#ff8f9b" },
  { name: "orange", label: "Orange", value: "#f59e5b" },
  { name: "yellow", label: "Yellow", value: "#f5d76e" },
  { name: "green", label: "Green", value: "#8ee6a8" },
  { name: "blue", label: "Blue", value: "#7aa2ff" },
  { name: "purple", label: "Purple", value: "#c4a7ff" },
  { name: "black", label: "Black", value: "#111111" },
  { name: "white", label: "White", value: "#ffffff" }
];

const setFontSizeCommand = (font: string, size: number) => {
  return ({ setFontSize, setSelectedFont }: CommandActionContext) => {
    setSelectedFont(font);
    setFontSize(String(size));
    return true;
  };
};

const setCustomFontSize = ({ setFontSize, setSelectedFont }: CommandActionContext, size?: string) => {
  if (!size) return false;

  const numericSize = Number(size);
  if (!Number.isFinite(numericSize) || numericSize <= 0) return false;

  setSelectedFont("Custom");
  setFontSize(String(numericSize));
  return true;
};

const insertListMarker = (marker: string) => {
  return ({ insertText }: CommandActionContext) => {
    insertText(marker);
    return true;
  };
};

const insertCurrentDate = ({ insertText }: CommandActionContext) => {
  const now = new Date();
  insertText(`${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`);
  return true;
};

const insertCurrentTime = ({ insertText }: CommandActionContext) => {
  insertText(new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }));
  return true;
};

const insertWordCount = ({ getDocumentText, insertText }: CommandActionContext) => {
  const words = getDocumentText().trim().match(/\S+/g) ?? [];
  const label = words.length === 1 ? "word" : "words";
  insertText(`Word Count: ${words.length} ${label}`);
  return true;
};

const resetTextStyle = ({
  setBold,
  setFontSize,
  setItalic,
  setSelectedFont,
  setTextColor,
  setStrike,
  setUnderline
}: CommandActionContext) => {
  setSelectedFont("Body");
  setFontSize("14");
  setTextColor("White");
  setBold(false);
  setItalic(false);
  setStrike(false);
  setUnderline(false);
  return true;
};

const handledByEditor = () => true;

const colorAliases = TEXT_COLOR_OPTIONS.reduce<Record<string, string>>((aliases, color) => {
  aliases[color.name] = color.label;
  return aliases;
}, {});

// Central registry for all keyboard-driven actions
export const CommandRegistry: Command[] = [
  {
    name: "title",
    description: "Use title text",
    action: setFontSizeCommand("Title", 24)
  },
  {
    name: "header",
    description: "Use header text",
    action: setFontSizeCommand("Header", 16)
  },
  {
    name: "body",
    description: "Use body text",
    action: setFontSizeCommand("Body", 14)
  },
  {
    name: "size",
    description: "Set font size",
    action: setCustomFontSize
  },
  {
    name: "bold",
    description: "Make text bold",
    action: ({ setBold }) => {
      setBold(true);
      return true;
    }
  },
  {
    name: "italic",
    description: "Make text italic",
    action: ({ setItalic }) => {
      setItalic(true);
      return true;
    }
  },
  {
    name: "strike",
    description: "Strike-through text",
    action: ({ setStrike }) => {
      setStrike(true);
      return true;
    }
  },
  {
    name: "underline",
    description: "Underline text",
    action: ({ setUnderline }) => {
      setUnderline(true);
      return true;
    }
  },
  {
    name: "default",
    description: "Return to normal text",
    action: resetTextStyle
  },
  {
    name: "color",
    description: "Change text color",
    arguments: TEXT_COLOR_OPTIONS.map((color) => color.name),
    action: ({ setTextColor }, color) => {
      if (!color) return false;
      const normalizedColor = colorAliases[color.toLowerCase()];
      if (!normalizedColor) return false;
      setTextColor(normalizedColor);
      return true;
    }
  },
  {
    name: "bulletlist",
    description: "Create a bullet list",
    action: insertListMarker("\u2022 ")
  },
  {
    name: "numberlist",
    description: "Create a numbered list",
    action: insertListMarker("1. ")
  },
  {
    name: "date",
    description: "Insert the date",
    action: insertCurrentDate
  },
  {
    name: "time",
    description: "Insert the time",
    action: insertCurrentTime
  },
  {
    name: "wordcount",
    description: "Insert the word count",
    action: insertWordCount
  },
  {
    name: "code",
    description: "Insert a Python code box",
    action: handledByEditor
  },
  {
    name: "save",
    description: "Save the current .x2 note",
    action: handledByEditor
  },
  {
    name: "export",
    description: "Export the current note as PDF",
    action: handledByEditor
  }
];
