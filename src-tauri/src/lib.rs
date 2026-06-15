use printpdf::{BuiltinFont, Mm, PdfDocument, PdfLayerReference};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

const X2_FORMAT: &str = "x2pad.note";
const X2_VERSION: u8 = 1;
const PDF_PAGE_WIDTH_MM: f32 = 210.0;
const PDF_PAGE_HEIGHT_MM: f32 = 297.0;
const PDF_MARGIN_MM: f32 = 18.0;
const PDF_TITLE_FONT_SIZE: f32 = 18.0;
const PDF_BODY_FONT_SIZE: f32 = 11.0;
const PDF_BODY_LINE_HEIGHT_MM: f32 = 6.0;
const PDF_BODY_CHARS_PER_LINE: usize = 92;

#[derive(Deserialize)]
struct NotePayload {
    title: String,
    content: String,
    #[serde(default)]
    styles: Vec<TextStyleRange>,
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

#[tauri::command]
fn save_x2_note(path: String, note: NotePayload) -> Result<(), String> {
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

    std::fs::write(path, serialized).map_err(|error| format!("Could not save .x2 file: {error}"))
}

#[tauri::command]
fn load_x2_note(path: String) -> Result<LoadedX2Note, String> {
    load_x2_note_from_path(Path::new(&path))
}

#[tauri::command]
fn load_startup_x2_note() -> Result<Option<LoadedX2Note>, String> {
    let Some(path) = find_x2_path(std::env::args().skip(1)) else {
        return Ok(None);
    };

    load_x2_note(path).map(Some)
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
    let font = document
        .add_builtin_font(BuiltinFont::Helvetica)
        .map_err(|error| format!("Could not load PDF font: {error}"))?;

    let mut current_layer = document.get_page(page).get_layer(layer);
    let mut cursor_y = PDF_PAGE_HEIGHT_MM - PDF_MARGIN_MM;
    write_pdf_line(
        &current_layer,
        title,
        PDF_TITLE_FONT_SIZE,
        PDF_MARGIN_MM,
        cursor_y,
        &font,
    );
    cursor_y -= PDF_BODY_LINE_HEIGHT_MM * 2.0;

    for source_line in note.content.lines() {
        let wrapped_lines = wrap_pdf_line(source_line, PDF_BODY_CHARS_PER_LINE);

        for line in wrapped_lines {
            if cursor_y < PDF_MARGIN_MM {
                let (page, layer) =
                    document.add_page(Mm(PDF_PAGE_WIDTH_MM), Mm(PDF_PAGE_HEIGHT_MM), "Layer");
                current_layer = document.get_page(page).get_layer(layer);
                cursor_y = PDF_PAGE_HEIGHT_MM - PDF_MARGIN_MM;
            }

            write_pdf_line(
                &current_layer,
                &line,
                PDF_BODY_FONT_SIZE,
                PDF_MARGIN_MM,
                cursor_y,
                &font,
            );
            cursor_y -= PDF_BODY_LINE_HEIGHT_MM;
        }
    }

    let output =
        File::create(path).map_err(|error| format!("Could not create PDF file: {error}"))?;
    document
        .save(&mut BufWriter::new(output))
        .map_err(|error| format!("Could not write PDF file: {error}"))
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

fn wrap_pdf_line(line: &str, max_chars: usize) -> Vec<String> {
    if line.trim().is_empty() {
        return vec![String::new()];
    }

    let mut wrapped = Vec::new();
    let mut current = String::new();

    for word in line.split_whitespace() {
        let separator_len = usize::from(!current.is_empty());
        if current.chars().count() + separator_len + word.chars().count() > max_chars {
            if !current.is_empty() {
                wrapped.push(current);
                current = String::new();
            }

            if word.chars().count() > max_chars {
                wrapped.extend(split_long_word(word, max_chars));
                continue;
            }
        }

        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }

    if !current.is_empty() {
        wrapped.push(current);
    }

    wrapped
}

fn split_long_word(word: &str, max_chars: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();

    for character in word.chars() {
        if current.chars().count() >= max_chars {
            chunks.push(current);
            current = String::new();
        }
        current.push(character);
    }

    if !current.is_empty() {
        chunks.push(current);
    }

    chunks
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
            load_startup_x2_note,
            export_note_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
