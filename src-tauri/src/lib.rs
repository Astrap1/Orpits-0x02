use printpdf::{
    path::{PaintMode, WindingOrder},
    BuiltinFont, Color, IndirectFontRef, Line, Mm, PdfDocument, PdfDocumentReference,
    PdfLayerReference, Point, Polygon, Rgb,
};
use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const X2_FORMAT: &str = "x2pad.note";
const X2_VERSION: u8 = 2;
const PDF_PAGE_WIDTH_MM: f32 = 210.0;
const PDF_PAGE_HEIGHT_MM: f32 = 297.0;
const PDF_MARGIN_MM: f32 = 18.0;
const PDF_TITLE_FONT_SIZE: f32 = 18.0;
const PDF_BODY_FONT_SIZE: f32 = 11.0;
const PDF_BODY_LINE_HEIGHT_MM: f32 = 6.0;
const PDF_BODY_MAX_WIDTH_MM: f32 = PDF_PAGE_WIDTH_MM - (PDF_MARGIN_MM * 2.0);
const PDF_TABLE_MIN_ROW_HEIGHT_MM: f32 = 9.0;
const PDF_TABLE_CELL_PADDING_X_MM: f32 = 2.0;
const PDF_TABLE_CELL_PADDING_Y_MM: f32 = 1.5;
const PDF_CODE_HEADER_HEIGHT_MM: f32 = 9.0;
const PDF_CODE_PADDING_X_MM: f32 = 4.0;
const PDF_CODE_PADDING_Y_MM: f32 = 3.0;
const PDF_CODE_FONT_SIZE: f32 = 9.0;
const PDF_CODE_LINE_HEIGHT_MM: f32 = 4.8;
const PDF_CODE_META_FONT_SIZE: f32 = 8.0;
const PDF_DEFAULT_TEXT_COLOR: &str = "Black";
const PDF_POINT_TO_MM: f32 = 0.352_778;
const GEMINI_SETTINGS_FILE: &str = "gemini-settings.json";
const NOTE_FOLDER_SETTINGS_FILE: &str = "note-folder-settings.json";
const CODE_COMPILE_TIMEOUT_SECONDS: u64 = 15;
const CODE_RUN_TIMEOUT_SECONDS: u64 = 5;
const CODE_OUTPUT_LIMIT_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
struct NotePayload {
    title: String,
    content: String,
    #[serde(default)]
    styles: Vec<TextStyleRange>,
    #[serde(default)]
    tables: Vec<X2Table>,
    #[serde(rename = "codeOutputs", default)]
    code_outputs: Vec<PdfCodeOutput>,
}

#[derive(Clone, Deserialize)]
struct PdfCodeOutput {
    #[serde(rename = "blockFrom")]
    block_from: usize,
    status: String,
    stdout: String,
    stderr: String,
    #[serde(rename = "exitCode")]
    exit_code: Option<i32>,
    message: String,
}

#[derive(Deserialize, Serialize)]
struct GeminiSettings {
    #[serde(rename = "apiKey")]
    api_key: String,
}

#[derive(Deserialize, Serialize)]
struct NoteFolderSettings {
    #[serde(rename = "folderPath")]
    folder_path: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct TextStyle {
    #[serde(rename = "fontSize")]
    font_size: String,
    #[serde(rename = "textColor")]
    text_color: String,
    #[serde(rename = "isBold")]
    is_bold: bool,
    #[serde(rename = "isItalic")]
    is_italic: bool,
    #[serde(rename = "isStrike")]
    is_strike: bool,
    #[serde(rename = "isUnderline")]
    is_underline: bool,
}

impl Default for TextStyle {
    fn default() -> Self {
        Self {
            font_size: "14".to_string(),
            text_color: PDF_DEFAULT_TEXT_COLOR.to_string(),
            is_bold: false,
            is_italic: false,
            is_strike: false,
            is_underline: false,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct TextStyleRange {
    from: usize,
    to: usize,
    style: TextStyle,
}

#[derive(Clone, Deserialize, Serialize)]
struct X2TableCell {
    text: String,
    #[serde(default)]
    styles: Vec<TextStyleRange>,
    #[serde(rename = "activeStyle", default)]
    active_style: Option<TextStyle>,
}

#[derive(Clone, Deserialize, Serialize)]
struct X2Table {
    id: String,
    columns: Vec<String>,
    rows: Vec<Vec<X2TableCell>>,
}

#[derive(Serialize)]
struct X2NoteFile<'a> {
    format: &'static str,
    version: u8,
    title: &'a str,
    content: &'a str,
    styles: &'a [TextStyleRange],
    tables: &'a [X2Table],
    #[serde(rename = "savedAt")]
    saved_at: &'a str,
}

#[derive(Deserialize)]
struct X2NoteFileOwned {
    format: String,
    version: u8,
    title: String,
    content: String,
    #[serde(default)]
    styles: Vec<TextStyleRange>,
    #[serde(default)]
    tables: Vec<X2Table>,
    #[serde(rename = "savedAt")]
    saved_at: String,
}

#[derive(Clone, Serialize)]
struct LoadedX2Note {
    title: String,
    content: String,
    styles: Vec<TextStyleRange>,
    tables: Vec<X2Table>,
    #[serde(rename = "savedAt")]
    saved_at: String,
    path: String,
}

#[derive(Serialize)]
struct LoadedX2Folder {
    notes: Vec<LoadedX2Note>,
    #[serde(rename = "activePath")]
    active_path: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum CodeRunPhase {
    Compile,
    Run,
}

#[derive(Debug, Serialize)]
struct CodeRunResult {
    stdout: String,
    stderr: String,
    #[serde(rename = "exitCode")]
    exit_code: Option<i32>,
    phase: CodeRunPhase,
}

#[derive(Clone)]
struct StyledTextSegment {
    text: String,
    style: TextStyle,
}

struct PdfFonts {
    regular: IndirectFontRef,
    bold: IndirectFontRef,
    italic: IndirectFontRef,
    bold_italic: IndirectFontRef,
    mono: IndirectFontRef,
}

#[tauri::command]
fn save_x2_note(app: AppHandle, path: String, note: NotePayload) -> Result<(), String> {
    let saved_at = current_timestamp();
    let file = X2NoteFile {
        format: X2_FORMAT,
        version: X2_VERSION,
        title: note.title.trim(),
        content: &note.content,
        styles: &note.styles,
        tables: &note.tables,
        saved_at: &saved_at,
    };

    let serialized = serde_json::to_string_pretty(&file)
        .map_err(|error| format!("Could not prepare .x2 file: {error}"))?;

    std::fs::write(&path, serialized)
        .map_err(|error| format!("Could not save .x2 file: {error}"))?;
    remember_note_folder(&app, Path::new(&path))?;
    Ok(())
}

#[tauri::command]
fn load_x2_note(path: String) -> Result<LoadedX2Note, String> {
    load_x2_note_from_path(Path::new(&path))
}

#[tauri::command]
fn load_x2_folder(app: AppHandle, path: String) -> Result<LoadedX2Folder, String> {
    let folder = load_x2_folder_from_path(Path::new(&path))?;
    remember_note_folder(&app, Path::new(&path))?;
    Ok(folder)
}

#[tauri::command]
fn has_note_folder(app: AppHandle) -> Result<bool, String> {
    Ok(get_configured_note_folder_path(&app)?.is_some())
}

#[tauri::command]
fn set_note_folder(app: AppHandle, path: String) -> Result<LoadedX2Folder, String> {
    let directory = PathBuf::from(path);

    if !directory.is_dir() {
        return Err("Choose a folder for your .x2 notes.".to_string());
    }

    remember_note_directory(&app, &directory)?;
    load_x2_folder_from_path(&directory)
}

#[tauri::command]
fn load_startup_x2_note() -> Result<Option<LoadedX2Note>, String> {
    let Some(path) = find_x2_path(std::env::args().skip(1)) else {
        return Ok(None);
    };

    load_x2_note(path).map(Some)
}

#[tauri::command]
fn load_startup_x2_folder(app: AppHandle) -> Result<Option<LoadedX2Folder>, String> {
    if let Some(path) = find_x2_path(std::env::args().skip(1)) {
        return load_x2_folder(app, path).map(Some);
    }

    let Some(directory) = get_configured_note_folder_path(&app)? else {
        return Ok(None);
    };

    load_x2_folder(app, directory.to_string_lossy().to_string()).map(Some)
}

#[tauri::command]
fn get_default_note_folder(app: AppHandle) -> Result<String, String> {
    get_configured_note_folder_path(&app)?
        .map(|path| path.to_string_lossy().to_string())
        .ok_or_else(|| "Choose a notes folder before saving.".to_string())
}

#[tauri::command]
fn export_note_pdf(path: String, note: NotePayload) -> Result<(), String> {
    let title = if note.title.trim().is_empty() {
        "Untitled Note"
    } else {
        note.title.trim()
    };

    let (document, page, layer) = PdfDocument::new(
        title,
        Mm(PDF_PAGE_WIDTH_MM),
        Mm(PDF_PAGE_HEIGHT_MM),
        "Layer 1",
    );
    let fonts = PdfFonts {
        regular: document
            .add_builtin_font(BuiltinFont::Helvetica)
            .map_err(|error| format!("Could not load PDF font: {error}"))?,
        bold: document
            .add_builtin_font(BuiltinFont::HelveticaBold)
            .map_err(|error| format!("Could not load PDF font: {error}"))?,
        italic: document
            .add_builtin_font(BuiltinFont::HelveticaOblique)
            .map_err(|error| format!("Could not load PDF font: {error}"))?,
        bold_italic: document
            .add_builtin_font(BuiltinFont::HelveticaBoldOblique)
            .map_err(|error| format!("Could not load PDF font: {error}"))?,
        mono: document
            .add_builtin_font(BuiltinFont::Courier)
            .map_err(|error| format!("Could not load PDF font: {error}"))?,
    };
    let title_font = document
        .add_builtin_font(BuiltinFont::HelveticaBold)
        .map_err(|error| format!("Could not load PDF font: {error}"))?;

    let mut current_layer = document.get_page(page).get_layer(layer);
    let mut cursor_y = PDF_PAGE_HEIGHT_MM - PDF_MARGIN_MM;
    current_layer.set_fill_color(pdf_color(PDF_DEFAULT_TEXT_COLOR));
    write_pdf_line(
        &current_layer,
        title,
        PDF_TITLE_FONT_SIZE,
        PDF_MARGIN_MM,
        cursor_y,
        &title_font,
    );
    cursor_y -= PDF_BODY_LINE_HEIGHT_MM * 2.0;

    write_pdf_note_body(
        &document,
        &mut current_layer,
        &mut cursor_y,
        &note.content,
        &note.styles,
        &note.tables,
        &note.code_outputs,
        &fonts,
    );

    let output =
        File::create(path).map_err(|error| format!("Could not create PDF file: {error}"))?;
    document
        .save(&mut BufWriter::new(output))
        .map_err(|error| format!("Could not write PDF file: {error}"))
}

#[tauri::command]
fn run_code_snippet(language: String, code: String) -> Result<CodeRunResult, String> {
    match language.trim().to_lowercase().as_str() {
        "python" | "py" => run_python_snippet(code),
        "cpp" | "c++" => run_cpp_snippet(code),
        _ => Err(format!(
            "Unsupported code language '{language}'. Use Python or C++."
        )),
    }
}

fn run_python_snippet(code: String) -> Result<CodeRunResult, String> {
    if code.trim().is_empty() {
        return Err("Python code block is empty.".to_string());
    }

    let candidates = [("py", &["-3", "-"][..]), ("python", &["-"][..])];
    let mut failures = Vec::new();

    for (program, args) in candidates {
        match verify_python_command(program, args) {
            Ok(()) => return run_python_with_command(program, args, &code),
            Err(error) => failures.push(error),
        }
    }

    Err(format!(
        "Could not find a working Python 3 interpreter. {} Make sure Python is installed and \
         available as 'py -3' or 'python'.",
        failures.join(" ")
    ))
}

fn verify_python_command(program: &str, args: &[&str]) -> Result<(), String> {
    let probe = "import sys\nraise SystemExit(0 if sys.version_info.major == 3 else 1)";
    let result = run_python_with_command(program, args, probe)?;

    if result.exit_code == Some(0) {
        return Ok(());
    }

    let details = result.stderr.trim();
    if details.is_empty() {
        Err(format!(
            "{program} did not provide a working Python 3 interpreter."
        ))
    } else {
        Err(format!(
            "{program} did not provide a working Python 3 interpreter: {details}"
        ))
    }
}

fn run_python_with_command(
    program: &str,
    args: &[&str],
    code: &str,
) -> Result<CodeRunResult, String> {
    let args = args.iter().map(OsString::from).collect::<Vec<_>>();
    run_code_process(
        OsStr::new(program),
        &args,
        Some(code.as_bytes()),
        "Python snippet",
        CodeRunPhase::Run,
        CODE_RUN_TIMEOUT_SECONDS,
    )
}

fn run_cpp_snippet(code: String) -> Result<CodeRunResult, String> {
    if code.trim().is_empty() {
        return Err("C++ code block is empty.".to_string());
    }

    let unique_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Could not create a C++ build identifier: {error}"))?
        .as_nanos();
    let build_directory =
        std::env::temp_dir().join(format!("x2pad-cpp-{}-{unique_id}", std::process::id()));
    std::fs::create_dir(&build_directory)
        .map_err(|error| format!("Could not create the temporary C++ build directory: {error}"))?;

    let result = run_cpp_in_directory(&build_directory, &code);
    if let Err(error) = std::fs::remove_dir_all(&build_directory) {
        if result.is_ok() {
            return Err(format!(
                "C++ finished, but its temporary build directory could not be removed: {error}"
            ));
        }
    }
    result
}

fn run_cpp_in_directory(build_directory: &Path, code: &str) -> Result<CodeRunResult, String> {
    let source_path = build_directory.join("main.cpp");
    #[cfg(target_os = "windows")]
    let executable_path = build_directory.join("x2pad-snippet.exe");
    #[cfg(not(target_os = "windows"))]
    let executable_path = build_directory.join("x2pad-snippet");

    std::fs::write(&source_path, code)
        .map_err(|error| format!("Could not write the temporary C++ source file: {error}"))?;

    let mut compiler_failures = Vec::new();
    for compiler in ["g++", "clang++"] {
        let args = vec![
            source_path.as_os_str().to_owned(),
            OsString::from("-std=c++17"),
            OsString::from("-O0"),
            OsString::from("-o"),
            executable_path.as_os_str().to_owned(),
        ];

        match run_code_process(
            OsStr::new(compiler),
            &args,
            None,
            &format!("C++ compilation with {compiler}"),
            CodeRunPhase::Compile,
            CODE_COMPILE_TIMEOUT_SECONDS,
        ) {
            Ok(result) if result.exit_code == Some(0) => return run_compiled_cpp(&executable_path),
            Ok(result) => return Ok(result),
            Err(error) => compiler_failures.push(error),
        }
    }

    #[cfg(target_os = "windows")]
    {
        let object_path = build_directory.join("x2pad-snippet.obj");
        let args = vec![
            OsString::from("/nologo"),
            OsString::from("/EHsc"),
            OsString::from("/std:c++17"),
            source_path.as_os_str().to_owned(),
            OsString::from(format!("/Fe:{}", executable_path.display())),
            OsString::from(format!("/Fo:{}", object_path.display())),
        ];

        match run_code_process(
            OsStr::new("cl"),
            &args,
            None,
            "C++ compilation with cl",
            CodeRunPhase::Compile,
            CODE_COMPILE_TIMEOUT_SECONDS,
        ) {
            Ok(result) if result.exit_code == Some(0) => return run_compiled_cpp(&executable_path),
            Ok(result) => return Ok(result),
            Err(error) => compiler_failures.push(error),
        }
    }

    Err(format!(
        "Could not find a working C++ compiler. Install g++, clang++, or Microsoft C++ Build Tools. {}",
        compiler_failures.join(" ")
    ))
}

fn run_compiled_cpp(executable_path: &Path) -> Result<CodeRunResult, String> {
    run_code_process(
        executable_path.as_os_str(),
        &[],
        None,
        "C++ program",
        CodeRunPhase::Run,
        CODE_RUN_TIMEOUT_SECONDS,
    )
}

fn run_code_process(
    program: &OsStr,
    args: &[OsString],
    input: Option<&[u8]>,
    process_label: &str,
    phase: CodeRunPhase,
    timeout_seconds: u64,
) -> Result<CodeRunResult, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start {process_label}: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Could not capture {process_label} output."))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Could not capture {process_label} errors."))?;
    let stdout_reader = thread::spawn(move || read_code_stream(stdout));
    let stderr_reader = thread::spawn(move || read_code_stream(stderr));

    if let (Some(mut stdin), Some(input)) = (child.stdin.take(), input) {
        stdin
            .write_all(input)
            .map_err(|error| format!("Could not send input to {process_label}: {error}"))?;
    }

    let started_at = Instant::now();
    let mut timed_out = false;

    let status = loop {
        if let Some(_status) = child
            .try_wait()
            .map_err(|error| format!("Could not check {process_label}: {error}"))?
        {
            break child
                .wait()
                .map_err(|error| format!("Could not finish {process_label}: {error}"))?;
        }

        if started_at.elapsed() >= Duration::from_secs(timeout_seconds) {
            timed_out = true;
            let _ = child.kill();
            break child
                .wait()
                .map_err(|error| format!("Could not stop {process_label}: {error}"))?;
        }

        thread::sleep(Duration::from_millis(25));
    };

    let (stdout_bytes, stdout_truncated) = stdout_reader
        .join()
        .map_err(|_| format!("Could not finish reading {process_label} output."))??;
    let (stderr_bytes, stderr_truncated) = stderr_reader
        .join()
        .map_err(|_| format!("Could not finish reading {process_label} errors."))??;
    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let mut stderr = String::from_utf8_lossy(&stderr_bytes).to_string();

    if timed_out {
        append_code_runner_message(
            &mut stderr,
            &format!("{process_label} timed out after {timeout_seconds} seconds."),
        );
    }

    if stdout_truncated || stderr_truncated {
        append_code_runner_message(
            &mut stderr,
            "Output was truncated after 256 KiB per stream.",
        );
    }

    Ok(CodeRunResult {
        stdout,
        stderr,
        exit_code: if timed_out { None } else { status.code() },
        phase,
    })
}

fn read_code_stream<R: Read>(mut stream: R) -> Result<(Vec<u8>, bool), String> {
    let mut captured = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;

    loop {
        let bytes_read = stream
            .read(&mut buffer)
            .map_err(|error| format!("Could not read code output: {error}"))?;

        if bytes_read == 0 {
            break;
        }

        let remaining = CODE_OUTPUT_LIMIT_BYTES.saturating_sub(captured.len());
        let bytes_to_keep = remaining.min(bytes_read);
        captured.extend_from_slice(&buffer[..bytes_to_keep]);
        truncated |= bytes_to_keep < bytes_read;
    }

    Ok((captured, truncated))
}

fn append_code_runner_message(output: &mut String, message: &str) {
    if !output.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }
    output.push_str(message);
}

#[cfg(test)]
mod code_runner_tests {
    use super::{
        read_code_stream, run_code_snippet, run_cpp_snippet, CodeRunPhase, CODE_OUTPUT_LIMIT_BYTES,
    };
    use std::io::Cursor;
    use std::process::Command;

    #[test]
    fn code_stream_keeps_normal_output() {
        let (captured, truncated) = read_code_stream(Cursor::new(b"hello\n".to_vec())).unwrap();

        assert_eq!(captured, b"hello\n");
        assert!(!truncated);
    }

    #[test]
    fn code_stream_caps_large_output() {
        let input = vec![b'x'; CODE_OUTPUT_LIMIT_BYTES + 1024];
        let (captured, truncated) = read_code_stream(Cursor::new(input)).unwrap();

        assert_eq!(captured.len(), CODE_OUTPUT_LIMIT_BYTES);
        assert!(truncated);
    }

    #[test]
    fn code_runner_rejects_unsupported_languages() {
        let error = run_code_snippet("javascript".to_string(), "1 + 1".to_string()).unwrap_err();
        assert!(error.contains("Unsupported code language"));
    }

    #[test]
    fn cpp_runner_compiles_code_and_reports_compile_errors_when_available() {
        if Command::new("g++").arg("--version").output().is_err() {
            return;
        }

        let success = run_cpp_snippet(
            "#include <iostream>\nint main() { std::cout << \"hello\"; }".to_string(),
        )
        .unwrap();
        assert_eq!(success.exit_code, Some(0));
        assert_eq!(success.stdout, "hello");
        assert_eq!(success.phase, CodeRunPhase::Run);

        let failure = run_cpp_snippet("int main( {".to_string()).unwrap();
        assert_ne!(failure.exit_code, Some(0));
        assert_eq!(failure.phase, CodeRunPhase::Compile);
        assert!(!failure.stderr.trim().is_empty());
    }
}

#[tauri::command]
fn has_gemini_api_key(app: AppHandle) -> Result<bool, String> {
    let path = gemini_settings_path(&app)?;

    if !path.exists() {
        return Ok(false);
    }

    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("Could not read Gemini settings: {error}"))?;
    let settings: GeminiSettings = serde_json::from_str(&content)
        .map_err(|error| format!("Could not parse Gemini settings: {error}"))?;

    Ok(!settings.api_key.trim().is_empty())
}

#[tauri::command]
fn get_gemini_api_key(app: AppHandle) -> Result<Option<String>, String> {
    let path = gemini_settings_path(&app)?;

    if !path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("Could not read Gemini settings: {error}"))?;
    let settings: GeminiSettings = serde_json::from_str(&content)
        .map_err(|error| format!("Could not parse Gemini settings: {error}"))?;
    let api_key = settings.api_key.trim();

    if api_key.is_empty() {
        return Ok(None);
    }

    Ok(Some(api_key.to_string()))
}

#[tauri::command]
fn save_gemini_api_key(app: AppHandle, api_key: String) -> Result<(), String> {
    let api_key = api_key.trim();

    if api_key.is_empty() {
        return Err("Enter a Gemini API key before saving.".to_string());
    }

    let path = gemini_settings_path(&app)?;
    let settings = GeminiSettings {
        api_key: api_key.to_string(),
    };
    let serialized = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("Could not prepare Gemini settings: {error}"))?;

    std::fs::write(path, serialized)
        .map_err(|error| format!("Could not save Gemini settings: {error}"))
}

fn gemini_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not find the app config directory: {error}"))?;

    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the app config directory: {error}"))?;

    Ok(directory.join(GEMINI_SETTINGS_FILE))
}

fn note_folder_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not find the app config directory: {error}"))?;

    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the app config directory: {error}"))?;

    Ok(directory.join(NOTE_FOLDER_SETTINGS_FILE))
}

fn get_configured_note_folder_path(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let settings_path = note_folder_settings_path(app)?;

    if settings_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&settings_path) {
            if let Ok(settings) = serde_json::from_str::<NoteFolderSettings>(&content) {
                let configured_path = PathBuf::from(settings.folder_path);
                let legacy_default_path = app
                    .path()
                    .document_dir()
                    .ok()
                    .map(|documents| documents.join("x2pad Notes"));
                let is_legacy_default = legacy_default_path
                    .as_ref()
                    .is_some_and(|legacy_path| paths_match(&configured_path, legacy_path));

                if configured_path.is_dir() && !is_legacy_default {
                    return Ok(Some(configured_path));
                }
            }
        }
    }

    Ok(None)
}

fn paths_match(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());

    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

fn remember_note_folder(app: &AppHandle, note_path: &Path) -> Result<(), String> {
    let directory = if note_path.is_dir() {
        note_path
    } else {
        note_path
            .parent()
            .ok_or_else(|| "Could not determine the note folder.".to_string())?
    };

    remember_note_directory(app, directory)
}

fn remember_note_directory(app: &AppHandle, directory: &Path) -> Result<(), String> {
    let resolved_directory = directory
        .canonicalize()
        .unwrap_or_else(|_| directory.to_path_buf());
    let settings = NoteFolderSettings {
        folder_path: resolved_directory.to_string_lossy().to_string(),
    };
    let serialized = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("Could not prepare note folder settings: {error}"))?;
    let settings_path = note_folder_settings_path(app)?;

    std::fs::write(settings_path, serialized)
        .map_err(|error| format!("Could not save note folder settings: {error}"))
}

fn load_x2_folder_from_path(path: &Path) -> Result<LoadedX2Folder, String> {
    if !path.is_dir() && !is_x2_path(path.to_string_lossy().as_ref()) {
        return Err("Only .x2 note files can be opened.".to_string());
    }

    let selected_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let directory = if selected_path.is_dir() {
        selected_path.as_path()
    } else {
        selected_path
            .parent()
            .ok_or_else(|| "Could not determine the note folder.".to_string())?
    };
    let mut note_paths = std::fs::read_dir(directory)
        .map_err(|error| format!("Could not read the note folder: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|entry_path| is_x2_path(entry_path.to_string_lossy().as_ref()))
        .collect::<Vec<_>>();

    note_paths.sort_by(|left, right| {
        left.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_lowercase()
            .cmp(
                &right
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_lowercase(),
            )
    });

    let active_path = if selected_path.is_dir() {
        note_paths
            .first()
            .cloned()
            .unwrap_or_else(|| selected_path.clone())
    } else {
        selected_path.clone()
    };
    let mut notes = Vec::new();

    for note_path in note_paths {
        if let Ok(note) = load_x2_note_from_path(&note_path) {
            notes.push(note);
        }
    }

    Ok(LoadedX2Folder {
        notes,
        active_path: active_path.to_string_lossy().to_string(),
    })
}

fn load_x2_note_from_path(path: &Path) -> Result<LoadedX2Note, String> {
    if !is_x2_path(path.to_string_lossy().as_ref()) {
        return Err("Only .x2 note files can be opened.".to_string());
    }

    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("Could not read .x2 file: {error}"))?;
    let parsed: X2NoteFileOwned = serde_json::from_str(&content)
        .map_err(|error| format!("Could not parse .x2 file: {error}"))?;

    if parsed.format != X2_FORMAT {
        return Err("This file is not an x2pad note.".to_string());
    }

    if parsed.version == 0 || parsed.version > X2_VERSION {
        return Err(format!(
            "Unsupported .x2 version {}. This app supports version {}.",
            parsed.version, X2_VERSION
        ));
    }

    Ok(LoadedX2Note {
        title: parsed.title,
        content: parsed.content,
        styles: parsed.styles,
        tables: parsed.tables,
        saved_at: parsed.saved_at,
        path: path.to_string_lossy().to_string(),
    })
}

fn is_x2_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("x2"))
}

fn find_x2_path<I>(args: I) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter().find(|argument| is_x2_path(argument))
}

fn write_pdf_note_body(
    document: &PdfDocumentReference,
    current_layer: &mut PdfLayerReference,
    cursor_y: &mut f32,
    content: &str,
    styles: &[TextStyleRange],
    tables: &[X2Table],
    code_outputs: &[PdfCodeOutput],
    fonts: &PdfFonts,
) {
    let mut cursor = 0;

    loop {
        let next_table = find_next_table_anchor(content, cursor);
        let next_code = find_next_code_block(content, cursor);
        let next_from = match (&next_table, &next_code) {
            (Some((table_from, _, _)), Some(code)) => (*table_from).min(code.from),
            (Some((table_from, _, _)), None) => *table_from,
            (None, Some(code)) => code.from,
            (None, None) => break,
        };

        write_pdf_text_block(
            document,
            current_layer,
            cursor_y,
            &content[cursor..next_from],
            &styles_for_content_range(content, styles, cursor, next_from),
            fonts,
        );

        if let Some(code) = next_code.filter(|code| code.from == next_from) {
            let block_from = content[..code.from]
                .chars()
                .map(char::len_utf16)
                .sum::<usize>();
            let output = code_outputs
                .iter()
                .find(|output| output.block_from == block_from);
            write_pdf_code_box(document, current_layer, cursor_y, &code, output, fonts);
            cursor = code.to;
            continue;
        }

        if let Some((from, to, table_id)) = next_table {
            if let Some(table) = tables.iter().find(|candidate| candidate.id == table_id) {
                write_pdf_table(document, current_layer, cursor_y, table, fonts);
            } else {
                write_pdf_text_block(
                    document,
                    current_layer,
                    cursor_y,
                    &content[from..to],
                    &[],
                    fonts,
                );
            }

            cursor = to;
        }
    }

    write_pdf_text_block(
        document,
        current_layer,
        cursor_y,
        &content[cursor..],
        &styles_for_content_range(content, styles, cursor, content.len()),
        fonts,
    );
}

struct PdfCodeBlock {
    from: usize,
    to: usize,
    language: String,
    code: String,
}

fn find_next_code_block(content: &str, start: usize) -> Option<PdfCodeBlock> {
    let mut search_from = start;

    while let Some(relative_from) = content[search_from..].find("```") {
        let from = search_from + relative_from;
        let opening_end = content[from..].find('\n').map(|offset| from + offset)?;
        let language = match content[from + 3..opening_end]
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "python" | "py" => "Python",
            "cpp" | "c++" => "C++",
            _ => {
                search_from = opening_end + 1;
                continue;
            }
        };
        let code_from = opening_end + 1;
        let relative_closing = content[code_from..].find("\n```")?;
        let closing_line_from = code_from + relative_closing + 1;
        let closing_to = closing_line_from + 3;

        if content
            .as_bytes()
            .get(closing_to)
            .is_some_and(|character| *character != b'\n' && *character != b'\r')
        {
            search_from = closing_to;
            continue;
        }

        let to = if content[closing_to..].starts_with("\r\n") {
            closing_to + 2
        } else if content[closing_to..].starts_with('\n') {
            closing_to + 1
        } else {
            closing_to
        };

        return Some(PdfCodeBlock {
            from,
            to,
            language: language.to_string(),
            code: content[code_from..closing_line_from - 1].to_string(),
        });
    }

    None
}

fn find_next_table_anchor(content: &str, start: usize) -> Option<(usize, usize, String)> {
    let relative_from = content[start..].find("[[x2-table:")?;
    let from = start + relative_from;
    let id_from = from + "[[x2-table:".len();
    let relative_to = content[id_from..].find("]]")?;
    let to = id_from + relative_to + 2;
    let id = content[id_from..id_from + relative_to].to_string();

    if id.trim().is_empty() {
        return None;
    }

    Some((from, to, id))
}

fn styles_for_content_range(
    content: &str,
    styles: &[TextStyleRange],
    byte_from: usize,
    byte_to: usize,
) -> Vec<TextStyleRange> {
    let code_unit_from = content[..byte_from]
        .chars()
        .map(char::len_utf16)
        .sum::<usize>();
    let code_unit_to = content[..byte_to]
        .chars()
        .map(char::len_utf16)
        .sum::<usize>();

    styles
        .iter()
        .filter_map(|range| {
            let from = range.from.max(code_unit_from);
            let to = range.to.min(code_unit_to);

            if from >= to {
                return None;
            }

            Some(TextStyleRange {
                from: from - code_unit_from,
                to: to - code_unit_from,
                style: range.style.clone(),
            })
        })
        .collect()
}

fn write_pdf_text_block(
    document: &PdfDocumentReference,
    current_layer: &mut PdfLayerReference,
    cursor_y: &mut f32,
    content: &str,
    styles: &[TextStyleRange],
    fonts: &PdfFonts,
) {
    for styled_line in build_pdf_text_block_lines(content, styles) {
        if styled_line.is_empty() {
            *cursor_y -= PDF_BODY_LINE_HEIGHT_MM;
            continue;
        }

        for line in wrap_styled_pdf_line(&styled_line, PDF_BODY_MAX_WIDTH_MM) {
            ensure_pdf_space(document, current_layer, cursor_y, PDF_BODY_LINE_HEIGHT_MM);
            *cursor_y =
                write_styled_pdf_line(current_layer, &line, PDF_MARGIN_MM, *cursor_y, fonts);
        }
    }
}

fn build_pdf_text_block_lines(
    content: &str,
    styles: &[TextStyleRange],
) -> Vec<Vec<StyledTextSegment>> {
    if content.is_empty() {
        return Vec::new();
    }

    let mut lines = build_styled_pdf_lines(content, styles);
    if content.ends_with('\n') && lines.last().is_some_and(Vec::is_empty) {
        lines.pop();
    }
    lines
}

struct PdfCodeDisplayLine {
    text: String,
    color: &'static str,
    mono: bool,
}

fn write_pdf_code_box(
    document: &PdfDocumentReference,
    current_layer: &mut PdfLayerReference,
    cursor_y: &mut f32,
    block: &PdfCodeBlock,
    output: Option<&PdfCodeOutput>,
    fonts: &PdfFonts,
) {
    let source_lines = wrap_pdf_mono_text(
        &block.code,
        PDF_BODY_MAX_WIDTH_MM - PDF_CODE_PADDING_X_MM * 2.0,
        PDF_CODE_FONT_SIZE,
    );
    let output_lines = build_pdf_code_output_lines(output);
    let complete_height = PDF_CODE_HEADER_HEIGHT_MM * 2.0
        + PDF_CODE_PADDING_Y_MM * 4.0
        + (source_lines.len() + output_lines.len()) as f32 * PDF_CODE_LINE_HEIGHT_MM;
    let printable_height = PDF_PAGE_HEIGHT_MM - PDF_MARGIN_MM * 2.0;

    *cursor_y -= 3.0;
    if complete_height <= printable_height {
        ensure_pdf_space(document, current_layer, cursor_y, complete_height);
    }

    write_pdf_code_source(
        document,
        current_layer,
        cursor_y,
        &block.language,
        &source_lines,
        fonts,
    );
    write_pdf_code_output(
        document,
        current_layer,
        cursor_y,
        &block.language,
        output,
        &output_lines,
        fonts,
    );
    *cursor_y -= 4.0;
}

fn write_pdf_code_source(
    document: &PdfDocumentReference,
    current_layer: &mut PdfLayerReference,
    cursor_y: &mut f32,
    language: &str,
    lines: &[String],
    fonts: &PdfFonts,
) {
    let mut line_index = 0;
    let lines = if lines.is_empty() {
        vec![String::new()]
    } else {
        lines.to_vec()
    };

    while line_index < lines.len() {
        let fixed_height = PDF_CODE_HEADER_HEIGHT_MM + PDF_CODE_PADDING_Y_MM * 2.0;
        if !has_pdf_space(*cursor_y, fixed_height + PDF_CODE_LINE_HEIGHT_MM) {
            add_pdf_page(document, current_layer, cursor_y);
        }

        let available_lines = (((*cursor_y - PDF_MARGIN_MM - fixed_height)
            / PDF_CODE_LINE_HEIGHT_MM)
            .floor() as usize)
            .max(1);
        let end = (line_index + available_lines).min(lines.len());
        let chunk = &lines[line_index..end];
        let panel_height = fixed_height + chunk.len() as f32 * PDF_CODE_LINE_HEIGHT_MM;
        draw_pdf_panel(
            current_layer,
            PDF_MARGIN_MM,
            *cursor_y,
            PDF_BODY_MAX_WIDTH_MM,
            panel_height,
            "#12141a",
            "#343740",
        );

        let header = if line_index == 0 {
            language.to_string()
        } else {
            format!("{language} - continued")
        };
        write_pdf_colored_text(
            current_layer,
            &header.to_uppercase(),
            PDF_CODE_META_FONT_SIZE,
            PDF_MARGIN_MM + PDF_CODE_PADDING_X_MM,
            *cursor_y - 5.8,
            "#dffbff",
            &fonts.bold,
        );
        draw_pdf_horizontal_rule(
            current_layer,
            PDF_MARGIN_MM,
            *cursor_y - PDF_CODE_HEADER_HEIGHT_MM,
            PDF_BODY_MAX_WIDTH_MM,
            "#343740",
        );

        let mut line_y = *cursor_y
            - PDF_CODE_HEADER_HEIGHT_MM
            - PDF_CODE_PADDING_Y_MM
            - PDF_CODE_LINE_HEIGHT_MM * 0.72;
        for line in chunk {
            write_pdf_colored_text(
                current_layer,
                line,
                PDF_CODE_FONT_SIZE,
                PDF_MARGIN_MM + PDF_CODE_PADDING_X_MM,
                line_y,
                "#edfaff",
                &fonts.mono,
            );
            line_y -= PDF_CODE_LINE_HEIGHT_MM;
        }

        *cursor_y -= panel_height;
        line_index = end;
        if line_index < lines.len() {
            add_pdf_page(document, current_layer, cursor_y);
        }
    }
}

fn write_pdf_code_output(
    document: &PdfDocumentReference,
    current_layer: &mut PdfLayerReference,
    cursor_y: &mut f32,
    language: &str,
    output: Option<&PdfCodeOutput>,
    lines: &[PdfCodeDisplayLine],
    fonts: &PdfFonts,
) {
    let mut line_index = 0;
    let status = code_output_status(output);
    let status_color = match output.map(|output| output.status.as_str()) {
        Some("success") => "#8ee6a8",
        Some("error") => "#ff8f9b",
        _ => "#777181",
    };

    while line_index < lines.len() {
        let fixed_height = PDF_CODE_HEADER_HEIGHT_MM + PDF_CODE_PADDING_Y_MM * 2.0;
        if !has_pdf_space(*cursor_y, fixed_height + PDF_CODE_LINE_HEIGHT_MM) {
            add_pdf_page(document, current_layer, cursor_y);
        }

        let available_lines = (((*cursor_y - PDF_MARGIN_MM - fixed_height)
            / PDF_CODE_LINE_HEIGHT_MM)
            .floor() as usize)
            .max(1);
        let end = (line_index + available_lines).min(lines.len());
        let chunk = &lines[line_index..end];
        let panel_height = fixed_height + chunk.len() as f32 * PDF_CODE_LINE_HEIGHT_MM;
        draw_pdf_panel(
            current_layer,
            PDF_MARGIN_MM,
            *cursor_y,
            PDF_BODY_MAX_WIDTH_MM,
            panel_height,
            "#0c0e12",
            "#343740",
        );

        let header = if line_index == 0 {
            format!("Output - {language}")
        } else {
            format!("Output - {language} - continued")
        };
        write_pdf_colored_text(
            current_layer,
            &header.to_uppercase(),
            PDF_CODE_META_FONT_SIZE,
            PDF_MARGIN_MM + PDF_CODE_PADDING_X_MM,
            *cursor_y - 5.8,
            "#f5efff",
            &fonts.bold,
        );
        write_pdf_colored_text(
            current_layer,
            &status,
            7.0,
            PDF_MARGIN_MM + PDF_BODY_MAX_WIDTH_MM - 20.0,
            *cursor_y - 5.8,
            status_color,
            &fonts.bold,
        );
        draw_pdf_horizontal_rule(
            current_layer,
            PDF_MARGIN_MM,
            *cursor_y - PDF_CODE_HEADER_HEIGHT_MM,
            PDF_BODY_MAX_WIDTH_MM,
            "#343740",
        );

        let mut line_y = *cursor_y
            - PDF_CODE_HEADER_HEIGHT_MM
            - PDF_CODE_PADDING_Y_MM
            - PDF_CODE_LINE_HEIGHT_MM * 0.72;
        for line in chunk {
            write_pdf_colored_text(
                current_layer,
                &line.text,
                if line.mono { 8.5 } else { 8.0 },
                PDF_MARGIN_MM + PDF_CODE_PADDING_X_MM,
                line_y,
                line.color,
                if line.mono {
                    &fonts.mono
                } else {
                    &fonts.regular
                },
            );
            line_y -= PDF_CODE_LINE_HEIGHT_MM;
        }

        *cursor_y -= panel_height;
        line_index = end;
        if line_index < lines.len() {
            add_pdf_page(document, current_layer, cursor_y);
        }
    }
}

fn build_pdf_code_output_lines(output: Option<&PdfCodeOutput>) -> Vec<PdfCodeDisplayLine> {
    let message = output
        .map(|output| output.message.as_str())
        .filter(|message| !message.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "Not run yet.".to_string());
    let mut lines = wrap_pdf_mono_text(
        &message,
        PDF_BODY_MAX_WIDTH_MM - PDF_CODE_PADDING_X_MM * 2.0,
        8.0,
    )
    .into_iter()
    .map(|text| PdfCodeDisplayLine {
        text,
        color: "#8e8799",
        mono: false,
    })
    .collect::<Vec<_>>();

    if let Some(output) = output {
        lines.extend(wrap_pdf_code_stream(&output.stdout, "#dffbff"));
        lines.extend(wrap_pdf_code_stream(&output.stderr, "#ffb4bd"));
    }

    lines
}

fn wrap_pdf_code_stream(content: &str, color: &'static str) -> Vec<PdfCodeDisplayLine> {
    if content.is_empty() {
        return Vec::new();
    }

    wrap_pdf_mono_text(
        content.trim_end_matches(['\r', '\n']),
        PDF_BODY_MAX_WIDTH_MM - PDF_CODE_PADDING_X_MM * 2.0,
        8.5,
    )
    .into_iter()
    .map(|text| PdfCodeDisplayLine {
        text,
        color,
        mono: true,
    })
    .collect()
}

fn code_output_status(output: Option<&PdfCodeOutput>) -> String {
    match output {
        Some(output) => output
            .exit_code
            .map(|exit_code| format!("exit {exit_code}"))
            .unwrap_or_else(|| output.status.clone()),
        None => "idle".to_string(),
    }
}

fn wrap_pdf_mono_text(content: &str, max_width_mm: f32, font_size: f32) -> Vec<String> {
    let character_width = font_size * PDF_POINT_TO_MM * 0.6;
    let max_characters = (max_width_mm / character_width).floor().max(1.0) as usize;
    let mut lines = Vec::new();

    for logical_line in content.split('\n') {
        let characters = logical_line.chars().collect::<Vec<_>>();
        if characters.is_empty() {
            lines.push(String::new());
            continue;
        }

        for chunk in characters.chunks(max_characters) {
            lines.push(chunk.iter().collect());
        }
    }

    lines
}

fn draw_pdf_panel(
    layer: &PdfLayerReference,
    x: f32,
    top: f32,
    width: f32,
    height: f32,
    fill: &str,
    outline: &str,
) {
    layer.set_fill_color(pdf_color(fill));
    layer.set_outline_color(pdf_color(outline));
    layer.set_outline_thickness(0.45);
    layer.add_polygon(Polygon {
        rings: vec![vec![
            (Point::new(Mm(x), Mm(top)), false),
            (Point::new(Mm(x + width), Mm(top)), false),
            (Point::new(Mm(x + width), Mm(top - height)), false),
            (Point::new(Mm(x), Mm(top - height)), false),
        ]],
        mode: PaintMode::FillStroke,
        winding_order: WindingOrder::NonZero,
    });
}

fn draw_pdf_horizontal_rule(layer: &PdfLayerReference, x: f32, y: f32, width: f32, color: &str) {
    layer.set_outline_color(pdf_color(color));
    layer.set_outline_thickness(0.35);
    layer.add_line(Line {
        points: vec![
            (Point::new(Mm(x), Mm(y)), false),
            (Point::new(Mm(x + width), Mm(y)), false),
        ],
        is_closed: false,
    });
}

fn write_pdf_colored_text(
    layer: &PdfLayerReference,
    text: &str,
    font_size: f32,
    x: f32,
    y: f32,
    color: &str,
    font: &IndirectFontRef,
) {
    layer.set_fill_color(pdf_color(color));
    layer.use_text(sanitize_pdf_text(text), font_size, Mm(x), Mm(y), font);
}

fn write_pdf_table(
    document: &PdfDocumentReference,
    current_layer: &mut PdfLayerReference,
    cursor_y: &mut f32,
    table: &X2Table,
    fonts: &PdfFonts,
) {
    let column_count = table.columns.len().max(1);
    let column_width = PDF_BODY_MAX_WIDTH_MM / column_count as f32;
    let header_cells = table
        .columns
        .iter()
        .map(|column| X2TableCell {
            text: column.clone(),
            styles: vec![TextStyleRange {
                from: 0,
                to: column.chars().map(char::len_utf16).sum(),
                style: TextStyle {
                    is_bold: true,
                    ..TextStyle::default()
                },
            }],
            active_style: None,
        })
        .collect::<Vec<_>>();
    let header_layout = layout_pdf_table_row(&header_cells, column_width, column_count);
    let row_layouts = table
        .rows
        .iter()
        .map(|row| layout_pdf_table_row(row, column_width, column_count))
        .collect::<Vec<_>>();

    *cursor_y -= 2.0;
    let opening_height = header_layout.height
        + row_layouts
            .first()
            .map(|layout| layout.height)
            .unwrap_or(0.0);
    ensure_pdf_space(document, current_layer, cursor_y, opening_height);
    draw_pdf_table_row(
        current_layer,
        *cursor_y,
        column_width,
        &header_layout,
        fonts,
    );
    *cursor_y -= header_layout.height;

    for row_layout in row_layouts {
        if !has_pdf_space(*cursor_y, row_layout.height) {
            add_pdf_page(document, current_layer, cursor_y);
            draw_pdf_table_row(
                current_layer,
                *cursor_y,
                column_width,
                &header_layout,
                fonts,
            );
            *cursor_y -= header_layout.height;
        }

        draw_pdf_table_row(current_layer, *cursor_y, column_width, &row_layout, fonts);
        *cursor_y -= row_layout.height;
    }

    *cursor_y -= 3.0;
}

struct PdfTableRowLayout {
    cells: Vec<Vec<Vec<StyledTextSegment>>>,
    height: f32,
}

fn layout_pdf_table_row(
    cells: &[X2TableCell],
    column_width: f32,
    column_count: usize,
) -> PdfTableRowLayout {
    let max_text_width = (column_width - PDF_TABLE_CELL_PADDING_X_MM * 2.0).max(1.0);
    let cells = (0..column_count)
        .map(|index| {
            let cell = cells.get(index);
            let logical_lines = cell
                .map(|cell| build_styled_pdf_lines(&cell.text, &cell.styles))
                .unwrap_or_else(|| vec![Vec::new()]);

            logical_lines
                .into_iter()
                .flat_map(|line| wrap_styled_pdf_line(&line, max_text_width))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let content_height = cells
        .iter()
        .map(|lines| {
            lines
                .iter()
                .map(|line| styled_pdf_line_height(line))
                .sum::<f32>()
        })
        .fold(PDF_BODY_LINE_HEIGHT_MM, f32::max);

    PdfTableRowLayout {
        cells,
        height: (content_height + PDF_TABLE_CELL_PADDING_Y_MM * 2.0)
            .max(PDF_TABLE_MIN_ROW_HEIGHT_MM),
    }
}

fn draw_pdf_table_row(
    layer: &PdfLayerReference,
    y: f32,
    column_width: f32,
    layout: &PdfTableRowLayout,
    fonts: &PdfFonts,
) {
    let x = PDF_MARGIN_MM;
    let column_count = layout.cells.len();
    let table_width = column_width * column_count as f32;

    layer.set_outline_color(Color::Rgb(Rgb::new(0.72, 0.74, 0.78, None)));
    layer.set_outline_thickness(0.45);

    for index in 0..=column_count {
        let column_x = x + column_width * index as f32;
        layer.add_line(Line {
            points: vec![
                (Point::new(Mm(column_x), Mm(y)), false),
                (Point::new(Mm(column_x), Mm(y - layout.height)), false),
            ],
            is_closed: false,
        });
    }

    for row_y in [y, y - layout.height] {
        layer.add_line(Line {
            points: vec![
                (Point::new(Mm(x), Mm(row_y)), false),
                (Point::new(Mm(x + table_width), Mm(row_y)), false),
            ],
            is_closed: false,
        });
    }

    for (index, lines) in layout.cells.iter().enumerate() {
        let cell_x = x + column_width * index as f32 + PDF_TABLE_CELL_PADDING_X_MM;
        let mut line_top = y - PDF_TABLE_CELL_PADDING_Y_MM;

        for line in lines {
            let line_height = styled_pdf_line_height(line);
            let baseline = line_top - line_height * 0.72;
            write_styled_pdf_line(layer, line, cell_x, baseline, fonts);
            line_top -= line_height;
        }
    }
}

fn has_pdf_space(cursor_y: f32, needed_height: f32) -> bool {
    cursor_y - needed_height >= PDF_MARGIN_MM
}

fn add_pdf_page(
    document: &PdfDocumentReference,
    current_layer: &mut PdfLayerReference,
    cursor_y: &mut f32,
) {
    let (page, layer) = document.add_page(Mm(PDF_PAGE_WIDTH_MM), Mm(PDF_PAGE_HEIGHT_MM), "Layer");
    *current_layer = document.get_page(page).get_layer(layer);
    *cursor_y = PDF_PAGE_HEIGHT_MM - PDF_MARGIN_MM;
}

fn ensure_pdf_space(
    document: &PdfDocumentReference,
    current_layer: &mut PdfLayerReference,
    cursor_y: &mut f32,
    needed_height: f32,
) {
    if has_pdf_space(*cursor_y, needed_height) {
        return;
    }

    add_pdf_page(document, current_layer, cursor_y);
}

fn build_styled_pdf_lines(content: &str, styles: &[TextStyleRange]) -> Vec<Vec<StyledTextSegment>> {
    let mut lines = Vec::new();
    let mut current_line = Vec::new();
    let mut current_text = String::new();
    let mut current_style = TextStyle::default();
    let mut code_unit_index = 0;

    for character in content.chars() {
        if character == '\n' {
            if !current_text.is_empty() {
                current_line.push(StyledTextSegment {
                    text: std::mem::take(&mut current_text),
                    style: current_style.clone(),
                });
            }
            lines.push(std::mem::take(&mut current_line));
            code_unit_index += character.len_utf16();
            continue;
        }

        let style = style_at_code_unit_index(code_unit_index, styles);

        if !current_text.is_empty() && !text_style_matches(&style, &current_style) {
            current_line.push(StyledTextSegment {
                text: std::mem::take(&mut current_text),
                style: current_style,
            });
        }

        current_style = style;
        current_text.push(character);
        code_unit_index += character.len_utf16();
    }

    if !current_text.is_empty() {
        current_line.push(StyledTextSegment {
            text: current_text,
            style: current_style,
        });
    }

    lines.push(current_line);
    lines
}

fn style_at_code_unit_index(code_unit_index: usize, styles: &[TextStyleRange]) -> TextStyle {
    styles
        .iter()
        .rev()
        .find(|range| range.from <= code_unit_index && code_unit_index < range.to)
        .map(|range| range.style.clone())
        .unwrap_or_default()
}

fn text_style_matches(left: &TextStyle, right: &TextStyle) -> bool {
    left.font_size == right.font_size
        && left.text_color == right.text_color
        && left.is_bold == right.is_bold
        && left.is_italic == right.is_italic
        && left.is_strike == right.is_strike
        && left.is_underline == right.is_underline
}

fn wrap_styled_pdf_line(
    segments: &[StyledTextSegment],
    max_width_mm: f32,
) -> Vec<Vec<StyledTextSegment>> {
    let mut lines = Vec::new();
    let mut current_line = Vec::new();
    let mut current_width = 0.0;

    for segment in segments {
        for token in split_text_for_wrapping(&segment.text) {
            let token_width = estimate_pdf_text_width_mm(&token, &segment.style);

            if current_width > 0.0 && current_width + token_width > max_width_mm {
                lines.push(std::mem::take(&mut current_line));
                current_width = 0.0;
            }

            if token_width > max_width_mm && !token.trim().is_empty() {
                for character in token.chars() {
                    let text = character.to_string();
                    let character_width = estimate_pdf_text_width_mm(&text, &segment.style);

                    if current_width > 0.0 && current_width + character_width > max_width_mm {
                        lines.push(std::mem::take(&mut current_line));
                        current_width = 0.0;
                    }

                    current_line.push(StyledTextSegment {
                        text,
                        style: segment.style.clone(),
                    });
                    current_width += character_width;
                }
                continue;
            }

            current_line.push(StyledTextSegment {
                text: token,
                style: segment.style.clone(),
            });
            current_width += token_width;
        }
    }

    if !current_line.is_empty() {
        lines.push(current_line);
    }

    if lines.is_empty() {
        lines.push(Vec::new());
    }

    lines
}

fn split_text_for_wrapping(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for character in text.chars() {
        current.push(character);

        if character.is_whitespace() {
            tokens.push(std::mem::take(&mut current));
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

fn write_styled_pdf_line(
    layer: &PdfLayerReference,
    segments: &[StyledTextSegment],
    start_x: f32,
    y: f32,
    fonts: &PdfFonts,
) -> f32 {
    let mut cursor_x = start_x;
    let line_height = styled_pdf_line_height(segments);

    for segment in segments {
        if segment.text.is_empty() {
            continue;
        }

        let font_size = pdf_font_size(&segment.style);
        let width = estimate_pdf_text_width_mm(&segment.text, &segment.style);
        layer.set_fill_color(pdf_color(&segment.style.text_color));
        layer.use_text(
            sanitize_pdf_text(&segment.text),
            font_size,
            Mm(cursor_x),
            Mm(y),
            pdf_font_for_style(&segment.style, fonts),
        );

        if segment.style.is_underline {
            draw_pdf_text_rule(layer, cursor_x, y - 1.2, width, &segment.style);
        }

        if segment.style.is_strike {
            draw_pdf_text_rule(layer, cursor_x, y + font_size * 0.13, width, &segment.style);
        }

        cursor_x += width;
    }

    y - line_height
}

fn styled_pdf_line_height(segments: &[StyledTextSegment]) -> f32 {
    segments
        .iter()
        .map(|segment| pdf_font_size(&segment.style) * 0.43)
        .fold(PDF_BODY_LINE_HEIGHT_MM, f32::max)
}

fn draw_pdf_text_rule(layer: &PdfLayerReference, x: f32, y: f32, width: f32, style: &TextStyle) {
    layer.set_outline_color(pdf_color(&style.text_color));
    layer.set_outline_thickness((pdf_font_size(style) / 18.0).max(0.5));
    layer.add_line(Line {
        points: vec![
            (Point::new(Mm(x), Mm(y)), false),
            (Point::new(Mm(x + width), Mm(y)), false),
        ],
        is_closed: false,
    });
}

fn pdf_font_for_style<'a>(style: &TextStyle, fonts: &'a PdfFonts) -> &'a IndirectFontRef {
    match (style.is_bold, style.is_italic) {
        (true, true) => &fonts.bold_italic,
        (true, false) => &fonts.bold,
        (false, true) => &fonts.italic,
        (false, false) => &fonts.regular,
    }
}

fn pdf_font_size(style: &TextStyle) -> f32 {
    style
        .font_size
        .parse::<f32>()
        .ok()
        .filter(|size| *size > 0.0)
        .unwrap_or(PDF_BODY_FONT_SIZE)
}

fn estimate_pdf_text_width_mm(text: &str, style: &TextStyle) -> f32 {
    let font_size_mm = pdf_font_size(style) * PDF_POINT_TO_MM;
    let bold_multiplier = if style.is_bold { 1.06 } else { 1.0 };

    text.chars()
        .map(|character| font_size_mm * pdf_character_width_em(character) * bold_multiplier)
        .sum()
}

fn pdf_character_width_em(character: char) -> f32 {
    match character {
        ' ' | '\t' => 0.28,
        'i' | 'j' | 'l' | 'I' | '!' | '|' | '\'' | ':' | ';' | ',' | '.' => 0.25,
        'f' | 'r' | 't' | '(' | ')' | '[' | ']' | '{' | '}' | '"' => 0.35,
        'm' | 'w' | 'M' | 'W' => 0.82,
        character if character.is_ascii_digit() => 0.56,
        character if character.is_ascii_uppercase() => 0.67,
        character if character.is_ascii_punctuation() => 0.42,
        character if character.is_ascii() => 0.52,
        _ => 0.6,
    }
}

fn pdf_color(color: &str) -> Color {
    let lower_color = color.to_lowercase();
    let normalized = match lower_color.as_str() {
        "red" => "#ff8f9b".to_string(),
        "orange" => "#f59e5b".to_string(),
        "yellow" => "#f5d76e".to_string(),
        "green" => "#8ee6a8".to_string(),
        "blue" => "#7aa2ff".to_string(),
        "purple" => "#c4a7ff".to_string(),
        "black" | "white" => "#111111".to_string(),
        value => value.to_string(),
    };

    let (red, green, blue) = parse_hex_color(&normalized).unwrap_or((17, 17, 17));
    Color::Rgb(Rgb::new(
        f32::from(red) / 255.0,
        f32::from(green) / 255.0,
        f32::from(blue) / 255.0,
        None,
    ))
}

fn parse_hex_color(color: &str) -> Option<(u8, u8, u8)> {
    let hex = color.strip_prefix('#')?;

    if hex.len() != 6 {
        return None;
    }

    let red = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let green = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let blue = u8::from_str_radix(&hex[4..6], 16).ok()?;

    Some((red, green, blue))
}

fn write_pdf_line(
    layer: &PdfLayerReference,
    text: &str,
    font_size: f32,
    x_mm: f32,
    y_mm: f32,
    font: &printpdf::IndirectFontRef,
) {
    layer.use_text(sanitize_pdf_text(text), font_size, Mm(x_mm), Mm(y_mm), font);
}

fn sanitize_pdf_text(text: &str) -> String {
    text.chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

fn current_timestamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod feature_stress_tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("x2pad-{label}-{}-{sequence}", std::process::id()));
            std::fs::create_dir_all(&path).expect("create test directory");
            Self { path }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn sample_style() -> TextStyle {
        TextStyle {
            font_size: "18".to_string(),
            text_color: "Blue".to_string(),
            is_bold: true,
            is_italic: true,
            is_strike: true,
            is_underline: true,
        }
    }

    fn sample_table() -> X2Table {
        X2Table {
            id: "table-one".to_string(),
            columns: vec!["Name".to_string(), "Value".to_string()],
            rows: vec![vec![
                X2TableCell {
                    text: "alpha".to_string(),
                    styles: vec![],
                    active_style: None,
                },
                X2TableCell {
                    text: "42".to_string(),
                    styles: vec![TextStyleRange {
                        from: 0,
                        to: 2,
                        style: sample_style(),
                    }],
                    active_style: Some(sample_style()),
                },
            ]],
        }
    }

    #[test]
    fn x2_loading_preserves_unicode_styles_and_tables() {
        let directory = TestDirectory::new("load-valid");
        let path = directory.path.join("Unicode.X2");
        let content = "Hello 👋 世界";
        let note = json!({
            "format": X2_FORMAT,
            "version": X2_VERSION,
            "title": "Unicode note",
            "content": content,
            "styles": [{
                "from": 6,
                "to": 8,
                "style": {
                    "fontSize": "18",
                    "textColor": "Blue",
                    "isBold": true,
                    "isItalic": true,
                    "isStrike": true,
                    "isUnderline": true
                }
            }],
            "tables": [{
                "id": "table-one",
                "columns": ["Name", "Value"],
                "rows": [[
                    {"text": "alpha", "styles": []},
                    {"text": "42", "styles": [], "activeStyle": null}
                ]]
            }],
            "savedAt": "2026-07-26T00:00:00Z"
        });
        std::fs::write(&path, serde_json::to_vec_pretty(&note).unwrap()).unwrap();

        let loaded = load_x2_note_from_path(&path).unwrap();
        assert_eq!(loaded.title, "Unicode note");
        assert_eq!(loaded.content, content);
        assert_eq!(loaded.styles.len(), 1);
        assert_eq!(loaded.styles[0].from, 6);
        assert_eq!(loaded.styles[0].to, 8);
        assert_eq!(loaded.tables.len(), 1);
        assert_eq!(loaded.tables[0].rows[0][1].text, "42");
        assert_eq!(loaded.saved_at, "2026-07-26T00:00:00Z");
    }

    #[test]
    fn x2_loading_accepts_v1_and_rejects_bad_inputs() {
        let directory = TestDirectory::new("load-invalid");
        let valid_v1 = directory.path.join("old.x2");
        std::fs::write(
            &valid_v1,
            json!({
                "format": X2_FORMAT,
                "version": 1,
                "title": "Old",
                "content": "still readable",
                "savedAt": "2026-01-01T00:00:00Z"
            })
            .to_string(),
        )
        .unwrap();
        let old_note = load_x2_note_from_path(&valid_v1).unwrap();
        assert!(old_note.styles.is_empty());
        assert!(old_note.tables.is_empty());

        let wrong_extension = directory.path.join("note.json");
        std::fs::write(&wrong_extension, "{}").unwrap();
        assert!(load_x2_note_from_path(&wrong_extension)
            .err()
            .unwrap()
            .contains("Only .x2"));

        for (file_name, body, expected_error) in [
            ("broken.x2", "{", "Could not parse"),
            (
                "wrong-format.x2",
                r#"{"format":"other","version":1,"title":"","content":"","savedAt":""}"#,
                "not an x2pad note",
            ),
            (
                "zero.x2",
                r#"{"format":"x2pad.note","version":0,"title":"","content":"","savedAt":""}"#,
                "Unsupported .x2 version 0",
            ),
            (
                "future.x2",
                r#"{"format":"x2pad.note","version":99,"title":"","content":"","savedAt":""}"#,
                "Unsupported .x2 version 99",
            ),
        ] {
            let path = directory.path.join(file_name);
            std::fs::write(&path, body).unwrap();
            assert!(
                load_x2_note_from_path(&path)
                    .err()
                    .unwrap()
                    .contains(expected_error),
                "{file_name} should report {expected_error}"
            );
        }
    }

    #[test]
    fn folder_loading_sorts_notes_and_skips_corrupt_files() {
        let directory = TestDirectory::new("folder");
        for (file_name, title) in [("z-last.x2", "Z"), ("A-first.X2", "A")] {
            std::fs::write(
                directory.path.join(file_name),
                json!({
                    "format": X2_FORMAT,
                    "version": X2_VERSION,
                    "title": title,
                    "content": title,
                    "savedAt": "2026-01-01T00:00:00Z"
                })
                .to_string(),
            )
            .unwrap();
        }
        std::fs::write(directory.path.join("middle.x2"), "not json").unwrap();
        std::fs::write(directory.path.join("ignored.txt"), "ignored").unwrap();

        let folder = load_x2_folder_from_path(&directory.path).unwrap();
        assert_eq!(
            folder
                .notes
                .iter()
                .map(|note| note.title.as_str())
                .collect::<Vec<_>>(),
            vec!["A", "Z"]
        );
        assert!(folder.active_path.to_lowercase().ends_with("a-first.x2"));
    }

    #[test]
    fn path_detection_is_case_insensitive_and_uses_first_x2_argument() {
        assert!(is_x2_path(r"C:\Notes\ONE.X2"));
        assert!(!is_x2_path(r"C:\Notes\x2"));
        assert!(!is_x2_path(r"C:\Notes\one.x2.txt"));
        assert_eq!(
            find_x2_path(vec![
                "--flag".to_string(),
                "first.X2".to_string(),
                "second.x2".to_string()
            ]),
            Some("first.X2".to_string())
        );
    }

    #[test]
    fn pdf_export_handles_code_boxes_long_notes_and_structured_tables() {
        let directory = TestDirectory::new("pdf");
        let path = directory.path.join("stress.pdf");
        let mut content = String::from(
            "Styled opening\n```python\nprint(\"Hello from PDF\")\n```\n```cpp\n#include <iostream>\nint main() {\n    std::cout << \"Hello from C++\";\n}\n```\n[[x2-table:table-one]]\n",
        );
        let python_block_from = content
            .find("```python")
            .map(|from| content[..from].chars().map(char::len_utf16).sum())
            .unwrap();
        let mut table = sample_table();
        table.rows = (0..45)
            .map(|index| {
                vec![
                    X2TableCell {
                        text: format!(
                            "Row {index}: a long table value that must wrap without losing any text"
                        ),
                        styles: vec![],
                        active_style: None,
                    },
                    X2TableCell {
                        text: format!("Value {index}\ncontinued"),
                        styles: vec![],
                        active_style: None,
                    },
                ]
            })
            .collect();
        for index in 0..250 {
            content.push_str(&format!(
                "Line {index}: a deliberately long sentence that must wrap safely across PDF pages.\n"
            ));
        }
        let note = NotePayload {
            title: "PDF stress".to_string(),
            content,
            styles: vec![TextStyleRange {
                from: 0,
                to: 14,
                style: sample_style(),
            }],
            tables: vec![table],
            code_outputs: vec![PdfCodeOutput {
                block_from: python_block_from,
                status: "success".to_string(),
                stdout: "Hello from PDF\n".to_string(),
                stderr: String::new(),
                exit_code: Some(0),
                message: "Python finished.".to_string(),
            }],
        };

        export_note_pdf(path.to_string_lossy().to_string(), note).unwrap();
        let bytes = std::fs::read(path).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        assert!(bytes.len() > 10_000);
    }

    #[test]
    fn python_runner_captures_success_stderr_failure_and_large_output() {
        assert!(run_python_snippet("  \n".to_string())
            .err()
            .unwrap()
            .contains("empty"));

        let success = run_python_snippet(
            "import sys\nprint('hello')\nprint('warning', file=sys.stderr)".to_string(),
        )
        .unwrap();
        assert_eq!(success.exit_code, Some(0));
        assert_eq!(success.stdout.lines().collect::<Vec<_>>(), vec!["hello"]);
        assert_eq!(success.stderr.lines().collect::<Vec<_>>(), vec!["warning"]);

        let failure = run_python_snippet("raise ValueError('boom')".to_string()).unwrap();
        assert_ne!(failure.exit_code, Some(0));
        assert!(failure.stderr.contains("ValueError: boom"));

        let large = run_python_snippet("print('x' * 300000)".to_string()).unwrap();
        assert_eq!(large.stdout.len(), CODE_OUTPUT_LIMIT_BYTES);
        assert!(large.stderr.contains("Output was truncated"));
    }

    #[test]
    fn python_runner_stops_infinite_work_at_the_timeout() {
        let started = Instant::now();
        let result =
            run_python_snippet("while True:\n    pass".to_string()).expect("run timed snippet");

        assert_eq!(result.exit_code, None);
        assert!(result.stderr.contains("timed out after 5 seconds"));
        assert!(started.elapsed() < Duration::from_secs(8));
    }

    #[test]
    fn pdf_helpers_handle_utf16_ranges_wrapping_and_colors() {
        let content = "A👋B";
        let styles = vec![TextStyleRange {
            from: 1,
            to: 3,
            style: sample_style(),
        }];
        let lines = build_styled_pdf_lines(content, &styles);
        assert_eq!(lines.len(), 1);
        assert_eq!(
            lines[0]
                .iter()
                .map(|segment| segment.text.as_str())
                .collect::<Vec<_>>(),
            vec!["A", "👋", "B"]
        );
        assert!(lines[0][1].style.is_bold);
        assert!(!lines[0][0].style.is_bold);

        let wrapped = wrap_styled_pdf_line(&lines[0], 1.0);
        assert!(wrapped.len() >= 3);
        assert_eq!(parse_hex_color("#7aa2ff"), Some((122, 162, 255)));
        assert_eq!(parse_hex_color("#xyzxyz"), None);
        assert_eq!(sanitize_pdf_text("a\0b\nc"), "a b c");

        assert_eq!(
            find_next_table_anchor("before [[x2-table:abc-123]] after", 0),
            Some((7, 27, "abc-123".to_string()))
        );
        assert_eq!(find_next_table_anchor("[[x2-table:]]", 0), None);
    }

    #[test]
    fn pdf_table_layout_keeps_all_wrapped_and_explicit_lines() {
        let text =
            "First explicit line\nSecond line contains enough words to wrap across several lines";
        let cell = X2TableCell {
            text: text.to_string(),
            styles: vec![],
            active_style: None,
        };
        let layout = layout_pdf_table_row(&[cell], 28.0, 1);
        let rendered_text = layout.cells[0]
            .iter()
            .flat_map(|line| line.iter())
            .map(|segment| segment.text.as_str())
            .collect::<String>();

        assert!(layout.cells[0].len() >= 3);
        assert_eq!(rendered_text, text.replace('\n', ""));
        assert!(layout.height > PDF_TABLE_MIN_ROW_HEIGHT_MM);
    }

    #[test]
    fn pdf_code_box_parser_and_output_layout_keep_visible_content() {
        let content = "before 👋\n```python\nprint('hello')\nprint('second')\n```\nafter";
        let block = find_next_code_block(content, 0).expect("Python code block");
        let block_from = content[..block.from]
            .chars()
            .map(char::len_utf16)
            .sum::<usize>();
        let output = PdfCodeOutput {
            block_from,
            status: "error".to_string(),
            stdout: "first line\nsecond line\n".to_string(),
            stderr: "ValueError: boom\n".to_string(),
            exit_code: Some(1),
            message: "Python finished with errors.".to_string(),
        };
        let output_lines = build_pdf_code_output_lines(Some(&output));
        let visible_text = output_lines
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        assert_eq!(block.language, "Python");
        assert_eq!(block.code, "print('hello')\nprint('second')");
        assert_eq!(block_from, 10);
        assert!(visible_text.contains("Python finished with errors."));
        assert!(visible_text.contains("first line\nsecond line"));
        assert!(visible_text.contains("ValueError: boom"));
        assert!(!visible_text.contains("Ctrl+Enter"));
        assert!(!visible_text.contains("Esc select"));
        assert_eq!(code_output_status(Some(&output)), "exit 1");
    }

    #[test]
    fn pdf_text_block_spacing_ignores_empty_ranges_and_trailing_cursor_lines() {
        assert!(build_pdf_text_block_lines("", &[]).is_empty());
        assert_eq!(build_pdf_text_block_lines("paragraph", &[]).len(), 1);
        assert_eq!(build_pdf_text_block_lines("paragraph\n", &[]).len(), 1);
        assert_eq!(build_pdf_text_block_lines("paragraph\n\n", &[]).len(), 2);

        let idle_lines = build_pdf_code_output_lines(None);
        assert_eq!(idle_lines.len(), 1);
        assert_eq!(idle_lines[0].text, "Not run yet.");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            save_x2_note,
            load_x2_note,
            load_x2_folder,
            has_note_folder,
            set_note_folder,
            load_startup_x2_note,
            load_startup_x2_folder,
            get_default_note_folder,
            export_note_pdf,
            run_code_snippet,
            has_gemini_api_key,
            get_gemini_api_key,
            save_gemini_api_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
