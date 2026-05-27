export interface CommandActionContext {
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
  action: (context: CommandActionContext, argument?: string) => boolean;
}

const setFontSizeCommand = (font: string, size: number) => {
  return ({ setFontSize, setSelectedFont }: CommandActionContext) => {
    setSelectedFont(font);
    setFontSize(String(size));
    return true;
  };
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
  setTextColor("Cyan");
  setBold(false);
  setItalic(false);
  setStrike(false);
  setUnderline(false);
  return true;
};

const notImplemented = () => false;

const colorAliases: Record<string, string> = {
  blue: "Blue",
  cyan: "Cyan",
  green: "Green",
  purple: "Purple",
  red: "Red",
  white: "White",
  yellow: "Yellow"
};

// Central registry for all keyboard-driven actions
export const CommandRegistry: Command[] = [
  {
    name: "table",
    description: "Insert a 1x1 grid",
    action: notImplemented
  },
  {
    name: "code",
    description: "Create a sandboxed code block",
    action: notImplemented
  },
  {
    name: "title",
    description: "Change font size",
    action: setFontSizeCommand("Title", 24)
  },
  {
    name: "header",
    description: "Change font size",
    action: setFontSizeCommand("Header", 16)
  },
  {
    name: "body",
    description: "Change font size",
    action: setFontSizeCommand("Body", 14)
  },
  {
    name: "font",
    description: "Change font size",
    action: ({ setFontSize }, size) => {
      if (!size) return false;
      setFontSize(size);
      return true;
    }
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
    description: "Change the text colour",
    action: ({ setTextColor }, color) => {
      if (!color) return false;
      const normalizedColor = colorAliases[color.toLowerCase()];
      if (!normalizedColor && !/^#[0-9a-f]{6}$/i.test(color)) return false;
      setTextColor(normalizedColor ?? color);
      return true;
    }
  },
  {
    name: "bulletlist",
    description: "Create a bullet point",
    action: notImplemented
  },
  {
    name: "numberlist",
    description: "Create a number list",
    action: notImplemented
  },
  {
    name: "linebreak",
    description: "Insert a linebreak",
    action: notImplemented
  },
  {
    name: "date",
    description: "Insert the date",
    action: notImplemented
  },
  {
    name: "time",
    description: "Insert the time",
    action: notImplemented
  },
  {
    name: "wordcount",
    description: "Insert the wordcount",
    action: notImplemented
  },
  {
    name: "Save",
    description: "Save note",
    action: notImplemented
  },
  {
    name: "Export",
    description: "Export note",
    action: notImplemented
  }
];
