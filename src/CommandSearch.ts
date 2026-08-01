import Fuse from "fuse.js";
import { CommandRegistry } from "./CommandRegistry";

export type CommandSuggestion = (typeof CommandRegistry)[number];

const commandFuse = new Fuse(CommandRegistry, {
  includeScore: true,
  ignoreLocation: true,
  threshold: 0.4,
  keys: [
    { name: "name", weight: 0.9 },
    { name: "description", weight: 0.1 }
  ]
});

function isOrderedLetterMatch(commandName: string, query: string) {
  let queryIndex = 0;

  for (const character of commandName.toLowerCase()) {
    if (character === query[queryIndex]) {
      queryIndex += 1;
    }

    if (queryIndex === query.length) {
      return true;
    }
  }

  return false;
}

export function getCommandSuggestions(query: string): CommandSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return CommandRegistry;
  }

  const prefixMatches = CommandRegistry.filter((command) => (
    command.name.toLowerCase().startsWith(normalizedQuery)
  ));
  const abbreviatedMatches = CommandRegistry.filter((command) => (
    !prefixMatches.includes(command) && isOrderedLetterMatch(command.name, normalizedQuery)
  ));
  const fuzzyMatches = commandFuse.search(normalizedQuery).map(({ item }) => item);

  return [
    ...prefixMatches,
    ...abbreviatedMatches,
    ...fuzzyMatches.filter((command) => (
      !prefixMatches.includes(command) && !abbreviatedMatches.includes(command)
    ))
  ];
}
