pub(in crate::providers) fn normalized_content_type(content_type: &str) -> Option<String> {
    content_type
        .split(';')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(in crate::providers) fn normalized_content_type_or_original(content_type: &str) -> String {
    normalized_content_type(content_type).unwrap_or_else(|| content_type.to_string())
}

pub(in crate::providers) const CUSTOM_HTTP_EXTRA_EXTENSIONS: &[(&str, &str)] = &[
    ("application/xml", "xml"),
    ("text/csv", "csv"),
    ("text/html", "html"),
    ("text/xml", "xml"),
];

pub(in crate::providers) fn extension_for_content_type(
    content_type: Option<&str>,
    additional_extensions: &[(&str, &str)],
) -> String {
    let content_type = content_type.unwrap_or("").to_ascii_lowercase();
    if let Some((_, extension)) = additional_extensions
        .iter()
        .find(|(mime_type, _)| *mime_type == content_type)
    {
        return (*extension).to_string();
    }

    match content_type.as_str() {
        "application/json" => "json",
        "application/pdf" => "pdf",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/webm" => "webm",
        "image/gif" => "gif",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "text/plain" => "txt",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => "bin",
    }
    .to_string()
}
