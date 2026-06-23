use printpdf::{
    BuiltinFont, Color, IndirectFontRef, Line, Mm, PdfDocument, PdfLayerReference, Point, Rgb,
};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
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
const PDF_DEFAULT_TEXT_COLOR: &str = "White";
const GEMINI_SETTINGS_FILE: &str = "gemini-settings.json";

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
    let base_width = pdf_font_size(style) * 0.35;
    let bold_multiplier = if style.is_bold { 1.06 } else { 1.0 };

    text.chars()
        .map(|character| {
            let width_multiplier = if character == ' ' {
                0.48
            } else if character.is_ascii_punctuation() {
                0.62
            } else if character.is_ascii_uppercase() {
                1.05
            } else {
                1.0
            };

            base_width * width_multiplier * bold_multiplier
        })
        .sum()
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
        "black" => "#111111".to_string(),
        "white" => "#f7f2ff".to_string(),
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
            load_startup_x2_note,
            export_note_pdf,
            has_gemini_api_key,
            save_gemini_api_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
