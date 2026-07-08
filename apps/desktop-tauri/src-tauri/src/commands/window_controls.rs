//! App-level window chrome commands used by the self-drawn title bar.

#[tauri::command]
pub(crate) fn window_minimize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn window_toggle_maximize(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_maximized().map_err(|err| err.to_string())? {
        window.unmaximize().map_err(|err| err.to_string())
    } else {
        window.maximize().map_err(|err| err.to_string())
    }
}

#[tauri::command]
pub(crate) fn window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn window_start_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|err| err.to_string())
}
