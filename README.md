# x2pad
Team Name: 0x02

Proposed Level of Achievement: Apollo 11

Poster: https://drive.google.com/file/d/1HlmQSmKyazfOEh1AZi91UpB2ZltoFydT/view?usp=drive_link

Video: https://drive.google.com/file/d/1XQnf3WxhFC2shKk1xLNM-pZRd3zSfNJH/view?usp=drive_link

App Download: https://drive.google.com/file/d/1Xe2NOQxCawUEi9L9gnE2Ygp2jl3mmRxB/view?usp=drive_link

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

# Features
## 1. The Notepad (18 May - 31 May)
This is the foundation of x2pad. It provides users with a clean writing space where they can type notes, format text and build structured documents without needing to switch between keyboard and mouse. 

The main editor is built using CodeMirror 6, which provides a flexible text-editing engine. Instead of relying on a standard HTML text area, CodeMirror allows x2pad to track editor state, cursor position, formatting ranges, and command input more precisely.

## 2. The `//` Registry (1 Jun - 11 Jun)
This is the main interaction system of x2pad. It allows users to perform actions by typing commands directly into the document instead of clicking toolbar buttons or memorising keyboard shortcuts. This supports the main goal of x2pad: keeping users in their typing flow.

The command registry is stored centrally in `src/CommandRegistry.ts`, making it easier to add, update, or remove commands without scattering command logic throughout the application.

### How It Works
When the user types `//`, the editor detects that a command may be starting and opens a command menu. As the user continues typing, the available commands are filtered based on the input.

Eg. typing `//bo` may suggest `//bold`, while typing `//date` can trigger the insertion of the current date.

## 3. The `\\` Registry (12 Jun - 29 Jun)
The `\\` registry is designed to provide AI assistance directly inside the editor. Instead of copying text into a separate chatbot or browser window, users can ask for help while staying inside their notes.

This feature supports use cases such as idea expansion, summarisation, rewriting, explanation and study assistance. The AI workflow is intended to feel like a natural extension of typing, rather than a separate tool.

### How It Works
When the user types `\\` followed by a prompt, x2pad treats the input as an AI request. The prompt is sent to the Gemini API, and the response can be inserted back into the editor.

Eg. `\\summarise this paragraph`

Eg. `\\give me 3 essay points about climate change`

Eg. `\\explain this code in simple terms`

Currently, we require users to input their Gemini API key into the app in order to use this feature. Maybe in the future, we can create a tracking system, allow users to use the AI feature without having their own API key, and then pay at the end of the month. 

## 4. Code Box (1 Jul - 10 Jul)
The code box allows users to write and run code snippets directly inside their notes. This is especially useful for students, developers, and technical users who want to test ideas without leaving the editor. The goal is to make x2pad useful not only for writing, but also for lightweight experimentation.

### How It Works
Users will be able to type the command `//code` to insert a code block into the document. Inside the code box, users can write code with proper formatting and then run it from within the app. 

The backend can handle code execution through the Tauri/Rust layer, which is better suited for interacting with the local system than the frontend alone.

The initial plan is to support Python and C++, with the possibility of adding more languages in the future.

## 5. Tables (11 Jul - 20 Jul)
The table feature is designed to help users structure information quickly without relying on mouse-heavy table editing tools. This is useful for lecture notes, comparison charts, planning, and lightweight calculations. The goal is to make table editing feel natural inside a keyboard-first note-taking environment.

### How It Works
Users will be able to create tables using `//table`. Once a table is created, keyboard actions such as arrow keys, `Tab` and `Enter` can be used to move between cells, add columns or create new rows.

## 6. Fuzzy Search (21 Jul - 27 Jul)
This improves the discoverability of commands. Since x2pad depends heavily on typed commands, users should not need to memorise every command exactly. Fuzzy search allows users to type partial or imperfect command names and still find the command they want.

### How It Works
When the command menu opens, Fuse.js can compare the user's input against the list of available commands. Instead of only matching exact prefixes, it can return close matches.

Eg. typing `//blt` could suggest `//bulletlist`

Eg. typing `//wrd` could suggest `//wordcount`

Eg. typing `//hdr` could suggest `//header`

This makes the command system more forgiving and beginner-friendly.

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

# Current Design

## Main Editor Interface
![main editor](<project-docs/Screenshot 2026-06-26 141027.png>)
This screenshot shows the current x2pad editor interface, including the writing area, toolbar and overall dark theme.

## Command Registry
![cmd registry](<project-docs/Screenshot 2026-06-26 141128.png>)
This screenshot shows the command menu appearing after the user types `//`. The menu helps users discover available commands without memorising shortcuts.

## AI Registry
![prompt](<project-docs/Screenshot 2026-06-27 141616.png>)
This screenshot shows the user typing an AI prompt with the `\\` command. The prompt is highlighted in green to distinguish it from normal note content.
![thinking](<project-docs/Screenshot 2026-06-27 141636.png>)
This screenshot shows the AI status panel while x2pad is reading the note context and generating a response.
![ai ready](<project-docs/Screenshot 2026-06-27 141648.png>)
This screenshot shows the AI response ready state. The user can press `Tab` to switch between insertion positions, `Enter` to insert the response, or `Esc` to cancel.

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

For the current version, `.x2` files are stored as JSON. We chose JSON because it is readable, easy to debug, and simple to parse from both the React frontend and the Rust/Tauri backend. During development, this is useful because the team can open a saved `.x2` file and immediately inspect whether the title, content, style ranges, and timestamp were saved correctly.

JSON also fits the current complexity of the project. x2pad does not need a binary file format because the current note data is mostly structured text and metadata. A binary format may be smaller, but it would be harder to inspect and harder to debug. JSON gives us a practical balance: it is structured enough for the app to validate and extend, but still simple enough for developers to understand without special tools.

Another reason for choosing JSON is compatibility with the frontend and backend stack. The editor state already exists in TypeScript as objects such as the note title, content, and style ranges. The Rust backend can serialise and deserialise the same structure using `serde`. This reduces unnecessary conversion work between the frontend and backend.

## Why `.x2` Stores Plain Text Plus Style Ranges
x2pad stores the main note content as plain text and stores formatting separately as style ranges. This is a deliberate alternative to storing the whole note as HTML.

Using plain text plus style ranges has several benefits:
- the note content remains easy to read and process;
- commands can operate on text without needing to parse HTML;
- saving and loading is easier to debug;
- style information can be reapplied by CodeMirror decorations;
- PDF export can transform the same style ranges into styled PDF text;
- future export systems can decide how to represent the styles.

If x2pad stored notes directly as HTML, formatting might be easier at first, but the data format would become more tightly coupled to the current UI representation. It would also make features like command parsing, code boxes, and table formulas harder to manage cleanly because the app would need to work around HTML tags mixed into the note content.

The current approach separates content from presentation. The `content` field stores what the user wrote, while the `styles` field stores how selected ranges should appear. This keeps the meaning of the note independent from how it is displayed on screen.

The save process works like this:
1. The user writes normally in the editor and may apply commands such as `//bold`, `//header`, `//color`, or `//size`.
2. The editor stores the note content as text and tracks formatting as style ranges.
3. When the user runs `//save`, the app removes the command text from the editor and sends the note title, content, and style ranges to the Rust/Tauri backend.
4. The backend converts the note into the `.x2` JSON structure and writes it to the user's local device.
5. When the user opens an existing `.x2` file through the app's file-opening interface, the app reads the selected file, validates its format and version, reloads the note content, and reapplies the saved style ranges in the editor.

The current `.x2` file includes:
- `format`: Identifies the file as an x2pad note file.
- `version`: Tracks the file format version so future versions can remain compatible.
- `title`: Stores the note title.
- `content`: Stores the note text as a single string.
- `styles`: Stores formatting ranges such as font size, color, bold, italic, strikethrough, and underline.
- `savedAt`: Stores the timestamp for when the note was last saved.

This gives the app a working persistence layer for the current editor features. In future versions, the `.x2` format can be expanded to support richer structured blocks for tables, code boxes, AI-generated content, and additional metadata.

# Architecture
![architecture](project-docs/architecture.jpg)
x2pad is built as a desktop application using Tauri, React, TypeScript, CodeMirror, and Rust. The application is split into two main layers: the frontend editor layer and the backend desktop layer.

The frontend layer is responsible for the user interface, editor behaviour, command detection, and visual feedback. The backend layer is responsible for desktop-specific operations such as saving files, opening files, exporting documents, and running system-level tasks.

This separation allows x2pad to feel like a modern web-based editor while still having access to native desktop features.

## 1. Frontend Responsibilities
The frontend is built using React, TypeScript, CodeMirror 6, Fuse.js, and CSS. It is responsible for everything the user directly interacts with inside the editor.

The frontend handles:
- Rendering the main editor interface
- Displaying the toolbar, sidebar, command menu, and status bar
- Managing editor state such as text content, cursor position, and formatting
- Detecting typed commands such as `//bold`, `//save`, and `\\<prompt>`
- Filtering command suggestions as the user types
- Applying visual formatting such as bold, italic, underline, strikethrough, font size, and color
- Sending save, export, and AI requests to the backend when needed

CodeMirror 6 is especially important because it gives x2pad more control than a normal text area. It allows the app to track document changes, command triggers, and formatting behaviour in a more structured way.

React is used to organise the interface into reusable components, while TypeScript helps keep the command and editor logic safer as the app becomes more complex.

## 2. Rust/Tauri Backend Responsibilities
The backend is built using Rust through the Tauri framework. It acts as the bridge between the frontend editor and the user's operating system.

The backend handles:
- Saving notes as `.x2` files
- Opening existing `.x2` files
- Exporting notes to other formats such as PDF
- Accessing the local file system
- Running local processes for future code execution features
- Handling backend operations that should not be done directly in the frontend

Tauri allows the app to use the operating system's native webview instead of bundling a full browser engine. This helps keep the application smaller and faster than many Electron-based desktop apps.

Rust is used because it is fast, memory-safe, and suitable for low-level desktop operations such as file handling and process execution.

## 3. How Commands Flow Through the App
The command system is one of the most important parts of x2pad. It allows users to control the editor by typing commands directly into the document.

A typical `//` command flow works like this:
1. The user types `//` in the editor.
2. The frontend detects that the user may be entering a command.
3. The command menu appears and displays matching commands.
4. As the user continues typing, the command list is filtered.
5. The user selects or completes a command such as `//bold`.
6. The editor checks the command against the central command registry.
7. The command is executed.
8. The command text is removed from the document.
9. The editor updates the document state or formatting.

Eg. when the user types `//bold`, x2pad recognises the command, removes `//bold` from the editor, and enables bold formatting for the next text the user types.

This design keeps the user in the typing flow because they do not need to stop and search through menus or memorise complex keyboard shortcuts.

## 4. How Saving and Loading Works
x2pad uses a local-first saving system based on the `.x2` file format. This allows users to store their notes directly on their own device.

The save flow works like this:
1. The user types `//save`.
2. The frontend recognises the save command.
3. The editor collects the note title, text content, and formatting ranges.
4. The frontend sends this data to the Rust/Tauri backend.
5. The backend converts the note into the `.x2` JSON structure.
6. The backend writes the `.x2` file to the user's local file system.
7. The editor can show feedback that the note has been saved.

The loading flow works like this:
1. The user opens an existing `.x2` file.
2. The Rust/Tauri backend reads the file from the local file system.
3. The backend validates that the file is a supported x2pad note.
4. The note content and style ranges are sent back to the frontend.
5. The frontend reloads the text into CodeMirror.
6. The saved formatting is reapplied inside the editor.

This system allows x2pad to preserve both the user's writing and the formatting applied through typed commands.

## 5. How AI Requests Are Handled
The `\\` AI registry is designed to let users request AI assistance without leaving the editor. Unlike a simple chatbot prompt, x2pad can send the user's prompt together with document context so that the AI response is aware of what the user is currently working on.

A typical AI request flow works like this:
1. The user types a prompt using the `\\` command.
2. The frontend detects that the input is an AI request.
3. The prompt text is extracted from the editor.
4. The frontend collects additional context from the note, such as the active line, nearby paragraph, document headings, and full document text.
5. The app sends the prompt and document context to the AI service.
6. The AI service returns a response that is more relevant to the current note.
7. The response is prepared for insertion back into the editor.
8. The user can accept the response and continue writing without switching applications.

Eg. a user may type: `\\summarise this paragraph`

x2pad can send the prompt together with the current note context to the Gemini API, allowing the generated response to better match the user's existing document.

In future versions, the AI flow can be improved with loading states, streamed responses, error handling, and options for where the AI response should be inserted. For privacy, the app should also make it clear when text or document context is being sent to an external AI service.

## 6. How PDF Export Works
PDF export is handled through the Rust/Tauri backend because PDF generation is closer to a desktop file operation than a normal frontend rendering task. The frontend already knows the current note title, text content, and style ranges, but the backend is better suited for creating and writing the final PDF file to the user's device.

The PDF export flow works like this:
1. The user runs `//export`.
2. The frontend recognises the export command and collects the note title, content, and style ranges.
3. The user chooses where to save the PDF file.
4. The frontend sends the note data and output path to the Rust/Tauri backend.
5. The backend creates a PDF document using `printpdf`.
6. The backend converts the note content into styled text segments using the saved style ranges.
7. The backend wraps long lines so they fit within the PDF page width.
8. The backend writes styled text to the PDF, including font size, colour, bold, italic, underline, and strikethrough where supported.
9. If the note exceeds one page, the backend creates additional pages.
10. The PDF is written to the selected file path.

This flow shows why x2pad separates editor state from export logic. The editor stores the note in a format that is useful while writing, while the backend transforms that same data into a document format that is useful for sharing or submission.

## 7. How Sidebar and Folder Loading Works
x2pad also includes a sidebar that behaves like a lightweight local note browser. Instead of opening a single isolated file each time, the app can remember a notes folder and load `.x2` files from that folder into the sidebar.

The folder loading flow works like this:
1. When the app starts, the backend checks whether a notes folder has already been configured.
2. If a folder has not been configured, the app asks the user to choose one.
3. The selected folder path is saved in the app configuration directory.
4. The backend reads the folder and filters for files with the `.x2` extension.
5. Each `.x2` file is parsed and validated before being shown in the sidebar.
6. The frontend receives the loaded notes and displays them as selectable items.
7. When the user selects a note, the editor loads that note's content and reapplies its style ranges.

This design supports the local-first model of x2pad. Notes remain normal files on the user's device, but the app still provides a smoother workspace experience by remembering the folder and listing available notes automatically.

The sidebar also has its own interaction state, such as the current search value, selected sidebar item, active note path, and whether the logo/search pane is being shown. This keeps note navigation separate from the actual editor content.

## 8. State Management Explanation
x2pad has several different kinds of state, and they are handled in different places depending on what the state represents.

React state is used for interface-level information such as:
- the current editor value;
- the selected note title and active note path;
- command menu visibility and command search query;
- current formatting controls such as font size, colour, bold, italic, underline, and strikethrough;
- AI session status, response text, and insertion placement;
- sidebar search and selection state.

CodeMirror state is used for editor-specific behaviour such as:
- document changes;
- cursor position;
- keyboard handling;
- command-line highlighting;
- AI command highlighting;
- text style decorations.

Refs are used for values that need to persist across renders without always causing a full React re-render. For example, style ranges are tracked in refs so the editor can update formatting ranges as text changes, while still allowing those ranges to be saved into the `.x2` file later.

This split is important because x2pad is not just displaying plain text. It has to handle typed commands, formatting ranges, AI insertion, saved style restoration, and sidebar navigation at the same time. Keeping these responsibilities in the correct state layer helps the editor remain responsive and reduces the chance that one interaction accidentally breaks another.

## 9. Why This Architecture Fits x2pad
This architecture fits x2pad because the app needs both a flexible editor interface and native desktop capabilities.

The frontend is responsible for delivering a smooth writing experience, while the Rust/Tauri backend handles operations that require access to the local system. This separation keeps the editor responsive while still allowing features such as local file saving, exporting, and future code execution.

By combining React, CodeMirror, Tauri, and Rust, x2pad can provide the feel of a modern web editor while behaving like a lightweight desktop application.

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
- `//size` to adjust the text size [Eg. `//size 16`]
- `//color` to change the text color [Eg. `//color red`]
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
This section explains the software engineering principles that were applied while building x2pad. Instead of only listing features, it shows how the project was structured, why certain design decisions were made, and how the implementation choices support maintainability, reliability, extensibility, and user experience.

## 1. Separation of Concerns
x2pad is split into a frontend editor layer and a backend desktop layer. This is one of the most important software engineering decisions in the project because the app needs both a smooth writing interface and access to native operating system features.

Since the frontend and backend responsibilities were already explained in the architecture section, the important software engineering point here is why the split matters. The frontend focuses on the user's editing experience, while the backend handles operations that require native desktop access. This prevents the editor interface from becoming mixed together with file-system logic, PDF writing, and operating-system configuration.

This separation also prevents the backend from needing to understand React UI state. Each side has a clearer responsibility, which makes the code easier to reason about and easier to extend.

For example, saving a note is not handled entirely inside the React editor. The frontend collects the note data, then calls the backend command `save_x2_note`. The backend then serialises the data and writes the file. This keeps the user interface responsive while also keeping file-system operations inside the layer that is designed to handle them.

## 2. Modular Frontend Structure
The frontend is organised into separate files for pages, components, styles, and command logic. This supports modularity because each file has a more focused purpose.

Current examples include:
- `src/pages/Editor.tsx`: contains the main editor workflow, editor state, command detection, note loading, AI interaction, and CodeMirror setup.
- `src/pages/StartPage.tsx`: contains the starting page of the app.
- `src/components/ItemsList.tsx` and `src/components/ItemRow.tsx`: separate reusable UI pieces from the page-level logic.
- `src/CommandRegistry.ts`: stores command definitions separately from the editor page.
- `src/styles/Editor.css` and `src/styles/StartPage.css`: separate styling from component logic.
- `src-tauri/src/lib.rs`: contains native commands for persistence, PDF export, folder loading, and settings storage.

This is useful because x2pad is expected to grow. Future features such as `//table`, `//code`, formulas, and fuzzy command search would become difficult to maintain if all logic was placed in one large file. By separating features into clearer modules, future changes can be made with less risk of accidentally breaking unrelated behaviour.

## 3. Central Command Registry
One of the clearest examples of maintainable design in x2pad is the central command registry in `src/CommandRegistry.ts`.

Instead of hardcoding every command directly inside the editor event loop, commands are represented as structured objects. Each command has:
- a `name`, such as `bold`, `color`, or `wordcount`;
- a `description`, which can be displayed in the command menu;
- optional `arguments`, such as the supported values for `//color`;
- an `action`, which performs the command.

This design follows the open-closed principle. The editor does not need to be rewritten every time a basic formatting command is added. A new command can be added by adding a new entry to the registry, while the surrounding command menu and execution flow can remain mostly unchanged.

For example, the `//date`, `//time`, and `//wordcount` commands all share the same command execution pathway, even though they produce different results. The editor only needs to detect the command and pass control to the registered action.

This design also improves discoverability. Because each command includes a description, the same data structure that powers command execution can also power the command menu. This avoids duplicating command names and descriptions in separate parts of the codebase.

## 4. Type-Safe Command Actions
The command registry uses TypeScript interfaces to describe what a command is allowed to do. The `CommandActionContext` interface defines the functions that a command can call, such as:
- `insertText`
- `setFontSize`
- `setSelectedFont`
- `setTextColor`
- `setBold`
- `setItalic`
- `setStrike`
- `setUnderline`
- `getDocumentText`

This is an example of information hiding. Commands do not need direct access to the entire editor implementation. They receive a controlled context containing only the operations they need.

This reduces coupling between the command registry and the editor page. For example, `//wordcount` does not need to know how CodeMirror stores text internally. It only calls `getDocumentText()` and inserts the result through `insertText()`.

This design is safer than allowing commands to directly modify arbitrary editor state. It makes each command easier to test mentally, easier to review, and easier to replace later.

## 5. Defensive Programming and Input Validation
x2pad applies defensive programming in several areas where user input or file input could be invalid.

For command arguments, `//size` checks that the provided size is numeric, finite, and greater than zero before applying it. This prevents invalid values such as `//size abc`, `//size -5`, or an empty argument from corrupting the editor state.

For colour commands, `//color` only accepts supported colour aliases from `TEXT_COLOR_OPTIONS`. If a user types an unsupported colour, the command returns `false` instead of applying an unknown value.

For file loading, the Rust backend checks that:
- the file has the `.x2` extension;
- the parsed JSON has the expected `format` value;
- the file version matches the version supported by the app.

This prevents the app from blindly trusting arbitrary files. If a user accidentally opens the wrong file, the app can reject it cleanly instead of crashing or loading corrupted data.

Defensive programming is important for x2pad because commands are typed directly into the document. The app must be forgiving when the user types incomplete commands, invalid commands, or command-like text that should not be executed.

## 6. Local-First Data Ownership
x2pad uses local `.x2` files instead of storing notes in a remote database. This was a deliberate design choice based on the target users and the privacy-focused user story.

For the current project scope, local files are better than a database because:
- users keep direct ownership of their notes
- the app can work without account creation
- the app can work without cloud infrastructure
- notes can be backed up, copied, or shared like normal files

## 7. Versioned `.x2` File Format
The `.x2` format includes both a `format` field and a `version` field. This is an important maintainability decision.

The `format` field identifies the file as an x2pad note file. This allows the app to distinguish a valid x2pad note from a random JSON file.

The `version` field allows the file format to evolve. For example, the current version stores:
- title
- content
- style ranges
- saved timestamp

Future versions may need to store:
- tables
- code boxes
- formula cells
- AI response metadata
- embedded command history
- richer block structures

By including a version number now, the app can later introduce migration logic instead of breaking old notes. This is an example of designing for future compatibility without overbuilding the current implementation.

## 8. Controlled State Management in the Editor
The architecture section explains the different state layers in more detail. From a software engineering perspective, the important point is that x2pad does not treat all state as one large object.

React state is used for interface-level behaviour, CodeMirror state is used for editor-specific behaviour, and refs are used for values that need to persist across renders without constantly updating the interface. This separation keeps the editor more predictable because command detection, formatting, AI insertion, note selection, and style restoration do not all compete for the same state mechanism.

## 9. Backend Validation and Error Handling
The Rust backend returns `Result<..., String>` from Tauri commands. This allows backend failures to be reported to the frontend instead of causing uncontrolled crashes.

Examples include:
- `save_x2_note` returns an error if the `.x2` file cannot be prepared or written.
- `load_x2_note_from_path` returns an error if the file is not a valid `.x2` note.
- `set_note_folder` returns an error if the selected path is not a directory.
- `export_note_pdf` returns an error if the PDF cannot be created or written.

This supports reliability because file system operations can fail for many reasons, such as missing permissions, deleted folders, invalid files, or corrupted settings. Instead of assuming everything succeeds, the backend reports failures through a controlled interface.

## 10. User-Centred Engineering
The main interaction model was designed around the user's typing flow. This is not only a UI decision, but also an engineering decision.

The command system avoids forcing users to memorise many shortcuts. Instead, users can type commands in natural text form and use the command menu for guidance.

The AI registry also follows the same principle. Rather than opening a separate chatbot window, the user can type `\\` inside the note, receive a response, and choose where to insert it.

This consistency matters because the app's features share a common interaction language. Formatting, saving, exporting, and AI assistance all feel like part of the same editor instead of separate tools bolted together.

## 11. Privacy-Conscious Design
x2pad stores notes locally and does not require a user account for normal note-taking. This supports the privacy-conscious user story directly.

By saving normal notes as local `.x2` files, the app gives users direct control over where their writing is stored. This is important for users who may be taking personal notes, lecture notes, project notes, or drafts that they do not want locked inside a cloud-only platform.

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

# User Testing and Validation

## Testing Done So Far

### 1. Command Registry Testing
We tested the `//` command registry to check that commands produce the expected editor behaviour and do not accidentally affect unrelated text.

Test scenarios included:
- Typing `//bold` to enable bold formatting for newly typed text
- Typing `//date` to insert the current date
- Typing `//wordcount` to return the current word count
- Typing invalid commands that are not in the command registry
- Checking that executed commands are removed from the editor after they run

From these tests, we checked whether:
- Commands executed correctly
- Invalid commands were ignored safely
- The command menu behaved predictably
- Command text was removed after execution
- The editor remained usable after commands were run

This is important because the command registry is the core interaction model of x2pad. If commands behave inconsistently, the keyboard-first workflow becomes unreliable.

### 2. `.x2` File Persistence Testing
We tested whether notes can be saved and reopened correctly using the `.x2` file format.

Test scenarios included:
- Saving a note with plain text and reopening it
- Saving a note with formatting such as bold, italic, underline, strikethrough, color, and font size changes
- Checking that saved files preserve the note title, content, style ranges, and timestamp
- Saving multiple notes and confirming that each file can be opened independently
- Opening invalid or unexpected files to check that the app handles them gracefully

From these tests, we checked whether:
- Notes were saved successfully
- Saved content could be loaded back into the editor
- Formatting information was preserved where supported
- Invalid files did not crash the app
- Local-first storage behaved reliably

This ensures that users do not lose their work and that x2pad's local file format can support the current editor features.

### 3. Cross-Feature Integration Testing
We tested whether different editor features work correctly together, instead of only testing each feature in isolation.

Test scenarios included:
- Applying formatting, saving the file, reopening it, and checking that the content is still present
- Using multiple commands in the same document without conflicts
- Inserting date, time, word count, and formatting commands in one note
- Exporting a saved note and checking that the exported output matches the editor content
- Combining AI-generated text with manually written notes

From these tests, we checked whether:
- Features continued to work when used together
- One command did not break another command
- Saved and exported content matched the editor state
- The writing workflow remained smooth across multiple actions

This helps ensure that x2pad works as a complete editor, not just as a set of isolated features.

### 4. Stress Testing
We tested the editor with larger amounts of text to check whether the app remains responsive during normal writing and editing.

The purpose of this test was to ensure that x2pad can handle longer notes without noticeable input lag, since students and developers may write long documents during lectures, study sessions, or project planning.

Test scenarios included:
- Typing continuously in the editor
- Pasting longer blocks of text into the editor
- Using formatting commands after the document becomes longer
- Opening the command menu after the document contains more content
- Saving and reopening larger `.x2` files
- Repeatedly applying formatting commands to check that the editor remains responsive

From these tests, we checked whether:
- Typing remained smooth
- The command menu still appeared quickly
- Formatting commands still worked correctly
- The editor did not freeze or crash

This ensures that x2pad remains smooth enough for real note-taking, long-form writing, and heavier usage.

### 5. Edge-Case Input Testing
We also tested unusual input cases to ensure that typed commands do not accidentally interfere with normal writing.

The purpose of this test was to check whether x2pad can distinguish between normal text and intentional commands, since commands are typed directly into the document.

Test scenarios included:
- Typing `//` without completing a command
- Typing incomplete commands such as `//bo` or `//col`
- Typing invalid commands that are not in the command registry
- Typing command-like text as part of normal notes
- Pasting text that contains `//` or `\\`
- Using special characters and symbols in the editor
- Using command-like text inside future code boxes without triggering editor commands accidentally

From these tests, we checked whether:
- Invalid commands were ignored safely
- The editor did not crash
- Normal writing was not accidentally deleted
- The command menu behaved predictably
- Users could continue typing after an incomplete or invalid command

### 6. AI Feature Testing
We tested the `\\` AI registry to check whether AI prompts can be triggered from inside the editor and handled without breaking the writing flow.

Test scenarios included:
- Submitting a normal writing prompt and checking that a response appears
- Submitting an empty or incomplete prompt
- Handling slow AI responses with a visible waiting state
- Handling failed AI requests without crashing the editor
- Confirming that AI-generated content can be inserted into the correct location in the document

From these tests, we checked whether:
- The AI command was detected correctly
- The editor collected the prompt and document context properly
- The app handled missing or invalid Gemini API key situations
- AI responses could be accepted, moved, or cancelled without disrupting the note
- The user could continue writing after the AI interaction

This ensures that the AI feature supports the writing flow without making the editor unreliable.

## Planned User Testing for Next Milestone
For the next milestone, we plan to distribute x2pad to a small group of friends and classmates for pilot testing. This will help us evaluate the app in more realistic note-taking situations.

The goal of this user testing is to find out whether the keyboard-first workflow is actually intuitive for new users, not just for the development team.

We plan to ask testers to complete tasks such as:
- Create a new note
- Apply formatting using `//bold`, `//header`, and `//color`
- Insert the date or time using a command
- Save the note as a `.x2` file
- Export the note as a PDF
- Try the `\\` AI prompt feature if available
- Give feedback on whether the command menu is easy to understand

We will collect feedback on:
- Ease of learning the command system
- Whether users prefer typing commands over clicking buttons
- Whether the command menu helps with discoverability
- Any confusing or unexpected behaviour
- Any bugs, crashes, or performance issues
- Suggestions for future commands or interface improvements

This feedback will help us decide what to improve before implementing larger features such as tables, code boxes, and full fuzzy search.

# Note
For the current state of our app, only the Windows version is available. However, for our final product, we would like to create a Mac version as well.
