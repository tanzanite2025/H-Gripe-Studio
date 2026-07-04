//! Provider-profile summaries used by the desktop production surfaces.
//!
//! H-Gripe no longer ships an in-app account/config editor. Credentials and
//! provider profiles remain local API configuration files handled by the CLI and
//! broker, while the desktop UI only reads provider-profile summaries.

use hgripe_api::{list_provider_profile_summaries, ProviderProfileSummary};

#[tauri::command]
pub(crate) fn get_profiles() -> Result<Vec<ProviderProfileSummary>, String> {
    list_provider_profile_summaries(None).map_err(|err| err.to_string())
}

/// Manual weights probe for the system model manager: whether the bound
/// weights path (file or HF-snapshot directory) exists on this box. Only ever
/// invoked from the manager's `Test` action, never automatically.
#[tauri::command]
pub(crate) fn probe_model_weights(path: String) -> bool {
    let p = std::path::Path::new(path.trim());
    p.is_file() || p.is_dir()
}
