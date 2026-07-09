use printpdf::{
    BuiltinFont, Color, IndirectFontRef, Line, Mm, PdfDocument, PdfLayerReference, Point, Rgb,
};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const X2_FORMAT: &str = "x2pad.note";
const X2_VERSION: u8 = 1;
const PDF_PAGE_WIDTH_MM: f32 = 210.0;
const PDF_PAGE_HEIGHT_MM: f32 = 297.0;
const PDF_MARGIN_MM: f32 = 18.0;
const PDF_TITLE_FONT_SIZE: f32 = 18.0;
const PDF_BODY_FONT_SIZE: f32 = 11.0;
const PDF_BODY_LINE_HEIGHT_MM: f32 = 6.0;
const PDF_BODY_MAX_WIDTH_MM: f32 = PDF_PAGE_WIDTH_MM - (PDF_MARGIN_MM * 2.0);
const PDF_DEFAULT_TEXT_COLOR: &str = "Black";
const PDF_POINT_TO_MM: f32 = 0.352_778;
const GEMINI_SETTINGS_FILE: &str = "gemini-settings.json";
const NOTE_FOLDER_SETTINGS_FILE: &str = "note-folder-settings.json";
const PYTHON_SNIPPET_TIMEOUT_SECONDS: u64 = 5;

#[derive(Deserialize)]
struct NotePayload {
    title: String,
    content: String,
    #[serde(default)]
    styles: Vec<TextStyleRange>,
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

#[derive(Serialize)]
struct X2NoteFile<'a> {
    format: &'static str,
    version: u8,
    title: &'a str,
    content: &'a str,
    styles: &'a [TextStyleRange],
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
    #[serde(rename = "savedAt")]
    saved_at: String,
}

#[derive(Clone, Serialize)]
struct LoadedX2Note {
    title: String,
    content: String,
    styles: Vec<TextStyleRange>,
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

#[derive(Serialize)]
struct CodeRunResult {
    stdout: String,
    stderr: String,
    #[serde(rename = "exitCode")]
    exit_code: Option<i32>,
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

    for styled_line in build_styled_pdf_lines(&note.content, &note.styles) {
        if styled_line.is_empty() {
            cursor_y -= PDF_BODY_LINE_HEIGHT_MM;
            continue;
        }

        for line in wrap_styled_pdf_line(&styled_line, PDF_BODY_MAX_WIDTH_MM) {
            if cursor_y < PDF_MARGIN_MM {
                let (page, layer) =
                    document.add_page(Mm(PDF_PAGE_WIDTH_MM), Mm(PDF_PAGE_HEIGHT_MM), "Layer");
                current_layer = document.get_page(page).get_layer(layer);
                cursor_y = PDF_PAGE_HEIGHT_MM - PDF_MARGIN_MM;
            }

            cursor_y =
                write_styled_pdf_line(&current_layer, &line, PDF_MARGIN_MM, cursor_y, &fonts);
        }
    }

    let output =
        File::create(path).map_err(|error| format!("Could not create PDF file: {error}"))?;
    document
        .save(&mut BufWriter::new(output))
        .map_err(|error| format!("Could not write PDF file: {error}"))
}

#[tauri::command]
fn run_python_snippet(code: String) -> Result<CodeRunResult, String> {
    if code.trim().is_empty() {
        return Err("Python code block is empty.".to_string());
    }

    run_python_with_command("py", &["-3", "-"], &code)
        .or_else(|_| run_python_with_command("python", &["-"], &code))
        .map_err(|error| {
            format!(
                "{error} Make sure Python is installed and available as 'py -3' or 'python'."
            )
        })
}

fn run_python_with_command(
    program: &str,
    args: &[&str],
    code: &str,
) -> Result<CodeRunResult, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start {program}: {error}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(code.as_bytes())
            .map_err(|error| format!("Could not send code to Python: {error}"))?;
    }

    let started_at = Instant::now();

    loop {
        if let Some(_status) = child
            .try_wait()
            .map_err(|error| format!("Could not check Python process: {error}"))?
        {
            let output = child
                .wait_with_output()
                .map_err(|error| format!("Could not read Python output: {error}"))?;

            return Ok(CodeRunResult {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                exit_code: output.status.code(),
            });
        }

        if started_at.elapsed() >= Duration::from_secs(PYTHON_SNIPPET_TIMEOUT_SECONDS) {
            let _ = child.kill();
            let output = child
                .wait_with_output()
                .map_err(|error| format!("Could not stop Python process: {error}"))?;
            let mut stderr = String::from_utf8_lossy(&output.stderr).to_string();

            if !stderr.is_empty() && !stderr.ends_with('\n') {
                stderr.push('\n');
            }
            stderr.push_str("Python snippet timed out after 5 seconds.");

            return Ok(CodeRunResult {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr,
                exit_code: None,
            });
        }

        thread::sleep(Duration::from_millis(25));
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

    if parsed.version != X2_VERSION {
        return Err(format!(
            "Unsupported .x2 version {}. This app supports version {}.",
            parsed.version, X2_VERSION
        ));
    }

    Ok(LoadedX2Note {
        title: parsed.title,
        content: parsed.content,
        styles: parsed.styles,
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

fn build_styled_pdf_lines(content: &str, styles: &[TextStyleRange]) -> Vec<Vec<StyledTextSegment>> {
    let mut lines = Vec::new();
    let mut current_line = Vec::new();
    let mut current_text = String::new();
    let mut current_style = TextStyle::default();

    for (byte_index, character) in content.char_indices() {
        if character == '\n' {
            if !current_text.is_empty() {
                current_line.push(StyledTextSegment {
                    text: std::mem::take(&mut current_text),
                    style: current_style.clone(),
                });
            }
            lines.push(std::mem::take(&mut current_line));
            continue;
        }

        let style = style_at_byte_index(byte_index, styles);

        if !current_text.is_empty() && !text_style_matches(&style, &current_style) {
            current_line.push(StyledTextSegment {
                text: std::mem::take(&mut current_text),
                style: current_style,
            });
        }

        current_style = style;
        current_text.push(character);
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

fn style_at_byte_index(byte_index: usize, styles: &[TextStyleRange]) -> TextStyle {
    styles
        .iter()
        .rev()
        .find(|range| range.from <= byte_index && byte_index < range.to)
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
    let line_height = segments
        .iter()
        .map(|segment| pdf_font_size(&segment.style) * 0.43)
        .fold(PDF_BODY_LINE_HEIGHT_MM, f32::max);

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
        .map(|character| {
            font_size_mm * pdf_character_width_em(character) * bold_multiplier
        })
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
            run_python_snippet,
            has_gemini_api_key,
            get_gemini_api_key,
            save_gemini_api_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
