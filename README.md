# Motivation
Modern note-taking apps often prioritise a "click-heavy" visual interface that disrupts the "flow state" of power users. For developers and students, the constant context-switching 
between the keyboard and mouse is an ergonomic bottleneck that slows down thought-to-text translation.

# Aim
To build a keyboard-first note-taking editor where structure, computation, and AI assistance can be triggered without leaving the typing flow. By utilizing a "Command-Line Interface (CLI) within a Doc" approach, we hope to provide a seamless experience where structural changes, code execution, and AI assistance are all triggered via the home row. The best part of this would be that it will all be done without the need to memorise any keyboard shortcuts!

# User Stories
1. The Focused Student
- As a student taking fast-paced lecture notes, I want to create complex tables using only Tab and Enter so that I can structure information without interrupting my typing flow.
2. The Agile Developer
- As a coder brainstorming logic, I want to type //code to run a snippet and see the output in my notes to verify my ideas immediately
3. The Academic Writer
- As an essay writer, I want to type \\prompt to get instant AI feedback or expansion without leaving my editor.

# Feature 1
The Notepad (18 May - 31 May)
- Blank page for users to type
- Has all the standard features with good markup system
- Able to save and export (.x2pad format)

# Feature 2
The // Registry (1 Jun - 11 Jun)
- Type an action without having to click the mouse
- Change font sizes, text formats, create tables, code boxes, etc.
- //<cmd><enter>

# Feature 3
The \\ Registry (12 Jun - 29 Jun)
- AI search
- Generate suggestions or answer questions user has
- \\<prompt><enter>

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
- Given in dropbox format, and users can select using up/down arrows
- Eliminates need to memorise commands

# Tech Stack
1. Tauri V2
- Relies on the operating system's native webview, resulting in a significantly smaller application size and faster startup times
2. CodeMirror 6
- Standard text areas cannot support a "CLI within a Doc" experience. CodeMirror provides a highly modular state architecture that allows for the creation of custom parsers. This is essential for detecting specific character sequences (like // or \\) in real-time without lagging the editor.
3. Rust
- The backend requires low-level control for file I/O (saving custom .x2pad files) and process execution. Rust guarantees memory safety without a garbage collector, ensuring the desktop app remains fast and free of memory leaks.
4. Fuse.js
- A keyboard-only interface lives or dies by its search capability. Fuse.js provides a lightweight, zero-dependency fuzzy search algorithm. This ensures that when a user triggers the command menu, the list filters instantaneously, maintaining the "flow state" of a power user.
5. OpenAI API
- Building the \\<prompt> integration requires a reliable LLM backend. Using an established API allows the engineering focus to remain on complex UX challenges, such as asynchronous streaming and graceful degradation, rather than model hosting.

# Test & Quality Assurance Ideas
1. Sandboxing
- Isolated testing environment to ensure working features
2. Cross-format Integration Testing
- Ensuring that all features are able to work together without conflicts
3. Stress-testing
- Load large files into the app (10000+ lines) into the app to check for responsiveness
4. Edge-case Input Testing
- Inputting non-standard text inputs, checking that they do not run as code
5. Pilot Testing
- Distributing the application to a cohort of 10+ target users to evaluate the effectiveness of the "mouseless" workflow in real-world note-taking scenarios.