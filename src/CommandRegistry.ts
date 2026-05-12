// Central registry for all keyboard-driven actions
export const CommandRegistry = [
  {
    name: "table",
    description: "Insert a 1x1 grid",
    action: () => console.log("Logic for Feature 1/4 goes here")
  },
  {
    name: "code",
    description: "Create a sandboxed code block",
    action: () => console.log("Logic for Feature 2 goes here")
  },
  {
    name: "title",
    description: "Change font size",
    action: () => console.log(`Changing font to ${16}`)
  },
  {
    name: "header",
    description: "Change font size",
    action: () => console.log(`Changing font to ${14}`)
  },
  {
    name: "body",
    description: "Change font size",
    action: () => console.log(`Changing font to ${12}`)
  },
  {
    name: "font",
    description: "Change font size",
    action: (size: string) => console.log(`Changing font to ${size}`)
  },
  {
    name: "bold",
    description: "Make text bold",
    action: () => console.log("Logic for bold text")
  },
  {
    name: "italic",
    description: "Make text italic",
    action: () => console.log("Logic for italic text")
  },
  {
    name: "strike",
    description: "Strike-through text",
    action: () => console.log("Logic for strike-through")
  },
  {
    name: "underline",
    description: "Underline text",
    action: () => console.log("Logic for underline")
  },
  {
    name: "color",
    description: "Change the text colour",
    action: (color: string) => console.log(`Changing color to ${color}`)
  },
  {
    name: "bulletlist",
    description: "Create a bullet point",
    action: () => console.log("Logic for butllet point")
  },
  {
    name: "numberlist",
    description: "Create a number list",
    action: () => console.log("Logic for number list")
  },
  {
    name: "linebreak",
    description: "Insert a linebreak",
    action: () => console.log("Logic for linebreak")
  },
  {
    name: "date",
    description: "Insert the date",
    action: () => console.log("Logic for date")
  },
  {
    name: "time",
    description: "Insert the time",
    action: () => console.log("Logic for time")
  },
  {
    name: "wordcount",
    description: "Insert the wordcount",
    action: () => console.log("Logic for wordcount")
  },
  {
    name: "Save",
    description: "Save note",
    action: () => console.log("Logic for saving note")
  },
  {
    name: "Export",
    description: "Export note",
    action: () => console.log("Logic for exporting note")
  }
];