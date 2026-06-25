# x2pad
Team Name: 0x02

Proposed Level of Achievement: Apollo 11

Poster: 

Video: 

Github Repo: 

App Download: 

# Motivation
Modern note-taking apps often prioritise a "click-heavy" visual interface that disrupts the "flow state" of power users. For developers and students, the constant context-switching between the keyboard and mouse is an ergonomic bottleneck that slows down thought-to-text translation.

# Aim
To build a keyboard-first note-taking editor where structure, computation, and AI assistance can be triggered without leaving the typing flow. By utilizing a "Command-Line Interface (CLI) within a Doc" approach, we hope to provide a seamless experience where structural changes, code execution, and AI assistance are all triggered via the home row. The best part of this would be that it will all be done without the need to memorise any keyboard shortcuts!

# What sets us apart?
Most applications force the user to choose between speed and design, offering either a lightning-fast, keyboard-driven tool burdened by a steep learning curve, or a beautiful, minimalist workspace that requires breaking concentration to navigate click-heavy menus. Furthermore, while traditional productivity apps attempt to solve this with keyboard shortcuts, they disrupt the flow state by relying on rigid memorization of complex key combinations like `Ctrl+Shift+K`. x2pad bridges this gap by introducing a completely friction-free, conversational approach to the document editor. Through its built-in command registry, the application allows users to simply type what they need without their hands ever leaving the home row. 

Ultimately, it delivers the zero-mouse execution speed of an advanced developer tool while entirely removing the cognitive load required to access its features, all wrapped in a polished, translucent interface that feels natively premium.

# User Stories
1. The Focused Student
- As a student taking fast-paced lecture notes, I want to create complex tables using only Tab and Enter so that I can structure information without interrupting my typing flow.
2. The Agile Developer
- As a coder brainstorming logic, I want to type //code to run a snippet and see the output in my notes to verify my ideas immediately
3. The Academic Writer
- As an essay writer, I want to type \\prompt to get instant AI feedback or expansion without leaving my editor.
4. The Privacy Conscious User
- As a user handling sensitive data, I want my notes saved locally in the .x2 format so that I have complete ownership over my files without relying on cloud storage.
5. The UI/UX Enthusiast
- As a user who values aesthetics, I want a minimalist workspace with clean typography, rounded edges, and translucent sidebars so that the editor feels modern and unobtrusive.

# Feature 1
The Notepad (18 May - 31 May)
- Blank page for users to type
- Has all the standard features with good markup system
- Able to save notes in `.x2` format and export them as PDF files

# Feature 2
The // Registry (1 Jun - 11 Jun)
- Type an action without having to click the mouse
- Change font sizes, text formats, create tables, code boxes, etc.
- //cmd

# Feature 3
The `\\` Registry (12 Jun - 29 Jun)
- AI search
- Generate suggestions or answer questions user has
- `\\<prompt>`

# Feature 4
Code Box (1 Jul - 10 Jul)
- Allow users to type code with standard coding formatting
- Run C++ and Python code (may extend to more languages if time permits)

# Feature 5
Tables (11 Jul - 20 Jul)
- Enter and Tab to extend rows and columns
- Table commands such as SUM, AVERAGE, etc.

# Feature 6
Fuzzy Search (21 Jul - 27 Jul)
- Gives suggestions when users type //
- Displayed in a dropdown menu, with selection controlled using the up and down arrow keys
- Eliminates need to memorise commands

# Tech Stack

## Frontend

1. React 19
- Used to build the editor interface as reusable UI components, including the editor page, sidebar, toolbar, command menu, and status bar. Its state management is useful for tracking live editor settings such as bold, italic, underline, strikethrough, selected font style, font size, and command menu visibility.

2. TypeScript
- Adds static type checking on top of JavaScript, helping reduce bugs as the command system grows more complex.

3. CodeMirror 6
- Powers the main text editor. Standard text areas cannot support a "CLI within a Doc" experience, so CodeMirror's modular state architecture is essential for detecting specific character sequences like `//` or `\\` in real time without lagging the editor.

4. Fuse.js
- Provides lightweight fuzzy search for the command menu. This ensures that when a user triggers the command menu, the list filters instantaneously, maintaining the "flow state" of a power user.

5. CSS
- Defines the visual design and layout of the application, including the dark editor theme, title bar, toolbar, command menu, editor container, and status bar.

## Backend / Desktop Layer

1. Tauri V2
- Packages x2pad as a lightweight desktop application by relying on the operating system's native webview, resulting in a significantly smaller application size and faster startup times.

2. Rust
- Handles backend logic such as file I/O, saving custom `.x2` files, exporting documents, and process execution. Rust guarantees memory safety without a garbage collector, ensuring the desktop app remains fast and free of memory leaks.

3. Gemini API
- Powers the `\\<prompt>` AI assistant feature. Using an established API allows the engineering focus to remain on complex UX challenges, such as asynchronous streaming and graceful degradation, rather than model hosting.

# Design Ideas
![main editor](project-docs/01_windows_obsidian_main_editor.png)
![cmd registry](project-docs/02_windows_obsidian_command_registry.png)
![ai assist](project-docs/03_windows_obsidian_ai_inline.png)

# Command Registry
<table>
    <tr>
        <th>Commands Registry:</th>
        <th>Excel Commands:</th>
    </tr>
    <tr>
        <td valign="top">
            <ol>
                <li>//title, //header, //body</li>
                <li>//bold, //italic, //strike, //underline</li>
                <li>//size</li>
                <li>//color</li>
                <li>//bulletlist, //numberlist</li>
                <li>//linebreak</li>
                <li>//code</li>
                <li>//table</li>
                <li>//date, //time</li>
                <li>//wordcount</li>
                <li>//save, //export</li>
            </ol>
        </td>
        <td valign="top">
            <ol>
                <li>//sum()</li>
                <li>//avg(), //mean(), //median()</li>
                <li>//min(), //max()</li>
                <li>//count()</li>
            </ol>
        </td>
    </tr>
</table>

# .x2 Note Format
The `.x2` file format is the local-first storage format used by x2pad. It allows notes to be saved directly to the user's device while preserving the note text and the formatting ranges applied through the editor.

For the current version, `.x2` files are stored as JSON. This makes the format readable, easy to debug, and simple to parse from both the React frontend and the Rust/Tauri backend.

The save process works like this:
1. The user writes normally in the editor and may apply commands such as `//bold`, `//header`, `//color`, or `//size`.
2. The editor stores the note content as text and tracks formatting as style ranges.
3. When the user runs `//save`, the app removes the command text from the editor and sends the note title, content, and style ranges to the Rust/Tauri backend.
4. The backend converts the note into the `.x2` JSON structure and writes it to the user's local device.
5. When the user runs `//open`, the app reads the selected `.x2` file, validates its format and version, reloads the note content, and reapplies the saved style ranges in the editor.

The current `.x2` file includes:
- `format`: Identifies the file as an x2pad note file.
- `version`: Tracks the file format version so future versions can remain compatible.
- `title`: Stores the note title.
- `content`: Stores the note text as a single string.
- `styles`: Stores formatting ranges such as font size, colour, bold, italic, strikethrough, and underline.
- `savedAt`: Stores the timestamp for when the note was last saved.

This gives the app a working persistence layer for the current editor features. In future versions, the `.x2` format can be expanded to support richer structured blocks for tables, code boxes, AI-generated content, and additional metadata.

# Architecture
![architecture](project-docs/architecture.jpg)

# Current Milestone Objectives
For the current milestone, our main objective is to complete the core `//` command registry and begin building the `\\` AI registry

The milestone objectives are:
- Complete the core `//` command registry
- Improve the command menu so it filters commands as the user types (not exactly the fuzzy search feature yet)
- Add note persistence, including saving and loading `.x2` files
- Refine the editor UI based on prototype testing and user feedback

# Current Milestone Progress
In this milestone, we completed a usable version of the editor interface. The editor supports continuous typing in a CodeMirror-based writing area, and users can apply formatting or insert content through typed commands from the command registry. The current implemented `//` commands include:
- `//title` to switch to title-sized text
- `//header` to switch to header-sized text
- `//body` to return to body-sized text
- `//bold` to enable bold text
- `//italic` to enable italic text
- `//strike` to enable strikethrough text
- `//underline` to enable underlined text
- `//default` to reset text formatting
- `//size` to adjust the text size
- `//color` to change the text color
- `//bulletlist` to add bullet points
- `//numberlist` to start a numbered list
- `//date` to add the date
- `//time` to add the time
- `//wordcount` to insert the current word count
- `//save` to save the document in .x2 format
- `//export` to export the document in PDF format

The command menu also filters available commands as the user types, making the keyboard-first workflow easier to discover.

We also worked on the first usable version of the AI engine, using the `\\` command.

# Software Engineering Evidence
1. Modular frontend structure
- The project separates pages, components, styles, and command logic into different files. This makes the editor easier to maintain as more features are added.
2. Central command registry
- Keyboard commands are stored in `src/CommandRegistry.ts` instead of being hardcoded throughout the editor. This makes it easier to add, test, and update commands such as `//table`, `//code`, and future AI prompts.
3. Incremental feature delivery
- The project is split into milestones and features. We are building the editor foundation first, then adding commands, AI, code boxes, tables, and fuzzy search in later stages.

# Next Milestone Objectives
For the next milestone, we plan to implement the `//code` and `//table` features.

The next milestone objectives are:
- Implement a fully functional `//table` command
- Add table formulas such as SUM, AVERAGE, MIN, MAX, and COUNT
- Implement a fully functional `//code` command
- Add code boxes that can run at least Python and C++ snippets

# Challenges Faced
1. Balancing keyboard-first design with discoverability
- A command-based editor is fast for experienced users, but new users still need clear suggestions so they do not have to memorise every command.
2. Managing editor state correctly
- Formatting commands need to affect newly typed text without unexpectedly changing existing text. This requires careful handling of editor state, cursor position, and text decorations.
3. Avoiding conflicts between normal typing and commands
- Since commands are typed directly into the document, the editor must distinguish between normal text and intentional commands like `//bold` or `//code`.

# Test & Quality Assurance Ideas

## 1. Command Registry Testing
We will test each `//` command to ensure that it produces the expected editor behaviour and does not accidentally affect unrelated text.

Example test cases:
- Typing `//bold` enables bold formatting for newly typed text.
- Typing `//date` inserts the current date correctly.
- Typing `//wordcount` returns an accurate word count.
- Typing an invalid command does not unexpectedly modify the document.
- Executed commands are removed from the editor after they run.

This is important because the command registry is the core interaction model of x2pad. If commands behave inconsistently, the keyboard-first workflow becomes unreliable.

## 2. `.x2` File Persistence Testing
We will test whether notes can be saved and reopened correctly using the `.x2` file format.

Example test cases:
- Save a note with plain text and reopen it.
- Save a note with bold, italic, underline, strikethrough, colour, and font size formatting.
- Check that saved files preserve the note title, content, style ranges, and timestamp.
- Open a corrupted or invalid `.x2` file and ensure the app handles it gracefully.
- Save multiple notes and confirm that each file can be opened independently.

This ensures that users do not lose their work and that x2pad's local-first storage remains reliable.

## 3. Cross-Feature Integration Testing
We will test whether different editor features work correctly together, instead of only testing each feature in isolation.

Example test cases:
- Apply formatting, save the file, reopen it, and confirm the formatting is still present.
- Use multiple commands in the same document without conflicts.
- Combine AI-generated text with manually formatted text.
- Insert date, time, word count, and formatting commands in one note.
- Export a saved note and check that the exported output matches the editor content.

This helps ensure that features continue to work properly when combined in a realistic writing workflow.

## 4. Edge-Case Input Testing
We will test unusual or unexpected user inputs to prevent crashes, accidental command execution, or broken formatting.

Example test cases:
- Typing `//` in a normal sentence without intending to run a command.
- Typing incomplete commands such as `//bo` or `//col`.
- Pasting long paragraphs into the editor.
- Typing special characters, symbols, and mixed-language text.
- Using command-like text inside future code boxes without triggering editor commands accidentally.

This is important because commands are typed directly into the document, so the editor must distinguish between normal writing and intentional actions.

## 5. Performance and Stress Testing
We will test how the editor performs with large documents and repeated user actions.

Example test cases:
- Open notes with 10,000+ lines.
- Type continuously in a large document and check for input lag.
- Trigger the command menu in a large file.
- Save and reopen large `.x2` files.
- Repeatedly apply formatting commands to check that the editor remains responsive.

This ensures that x2pad remains smooth enough for real note-taking, long-form writing, and heavy usage.

## 6. AI Feature Testing
We will test the `\\` AI registry to ensure that AI responses are useful, stable, and handled safely.

Example test cases:
- Submit a normal writing prompt and check that a response appears.
- Submit an empty prompt and show an appropriate error.
- Handle slow API responses with a loading state.
- Handle failed API requests without crashing the editor.
- Confirm that AI-generated content is inserted into the correct location in the document.

This ensures that the AI feature supports the writing flow without making the editor unreliable.

## 7. Pilot Testing
We will distribute the application to a small group of target users, such as students and developers, to evaluate the effectiveness of the keyboard-first workflow in real-world note-taking scenarios.

Example testing approach:
- Ask users to take notes using only keyboard commands.
- Observe whether users can discover commands through the command menu.
- Collect feedback on speed, clarity, comfort, and ease of use.
- Compare the experience against traditional mouse-based note-taking tools.
- Record common pain points and use them to refine the command registry and editor interface.

This helps validate whether x2pad achieves its main goal of reducing mouse usage and preserving the user's flow state.

# Note
For the current state of our app, only the windows version is available. However, for our final product, we would like to create a mac version as well.
