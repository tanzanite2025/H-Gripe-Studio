use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;

const MAX_LAYERED_ASSETS: usize = 256;

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct LayeredAssetLayer {
    #[serde(rename = "layerId")]
    pub layer_id: String,
    #[serde(rename = "rgbaPath")]
    pub rgba_path: String,
}

pub(super) struct LayeredAssetRegistry {
    pub(super) map: HashMap<String, HashMap<String, String>>,
    pub(super) order: Vec<String>,
}

static LAYERED_ASSETS: OnceLock<Mutex<LayeredAssetRegistry>> = OnceLock::new();

pub(super) fn layered_assets() -> &'static Mutex<LayeredAssetRegistry> {
    LAYERED_ASSETS.get_or_init(|| {
        Mutex::new(LayeredAssetRegistry {
            map: HashMap::new(),
            order: Vec::new(),
        })
    })
}

pub(super) fn layered_asset_layer_path(asset_id: &str, layer_id: &str) -> Result<String, String> {
    let reg = layered_assets()
        .lock()
        .map_err(|_| "layered asset registry poisoned")?;
    let layers = reg
        .map
        .get(asset_id)
        .ok_or_else(|| format!("unknown layered asset id: {asset_id}"))?;
    layers
        .get(layer_id)
        .cloned()
        .ok_or_else(|| format!("unknown layer id {layer_id} on layered asset {asset_id}"))
}

#[tauri::command]
pub(crate) fn viewport_register_layered_asset(
    asset_id: String,
    layers: Vec<LayeredAssetLayer>,
) -> Result<(), String> {
    if asset_id.is_empty() {
        return Err("layered asset id must not be empty".to_string());
    }
    if layers.is_empty() {
        return Err(format!(
            "layered asset {asset_id} has no layers to register"
        ));
    }
    let mut set = HashMap::new();
    for layer in layers {
        if layer.layer_id.is_empty() {
            return Err(format!(
                "layered asset {asset_id} has a layer with an empty id"
            ));
        }
        if !Path::new(&layer.rgba_path).is_file() {
            return Err(format!(
                "layer {} of asset {asset_id} points at a missing file: {}",
                layer.layer_id, layer.rgba_path
            ));
        }
        set.insert(layer.layer_id, layer.rgba_path);
    }
    let mut reg = layered_assets()
        .lock()
        .map_err(|_| "layered asset registry poisoned")?;
    if reg.map.insert(asset_id.clone(), set).is_none() {
        reg.order.push(asset_id);
        while reg.map.len() > MAX_LAYERED_ASSETS {
            if reg.order.is_empty() {
                break;
            }
            let oldest = reg.order.remove(0);
            reg.map.remove(&oldest);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn viewport_unregister_layered_asset(asset_id: String) -> Result<(), String> {
    let mut reg = layered_assets()
        .lock()
        .map_err(|_| "layered asset registry poisoned")?;
    if reg.map.remove(&asset_id).is_some() {
        reg.order.retain(|id| id != &asset_id);
    }
    Ok(())
}

const MAX_TIMELINES: usize = 64;

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TimelineClipRef {
    #[serde(rename = "clipId")]
    pub clip_id: String,
    pub kind: String,
    pub path: String,
    #[serde(rename = "startSec")]
    pub start_sec: f64,
    #[serde(rename = "durationSec")]
    pub duration_sec: f64,
}

pub(super) struct TimelineRegistry {
    pub(super) map: HashMap<String, HashMap<String, TimelineClipRef>>,
    pub(super) order: Vec<String>,
}

static TIMELINES: OnceLock<Mutex<TimelineRegistry>> = OnceLock::new();

pub(super) fn timelines() -> &'static Mutex<TimelineRegistry> {
    TIMELINES.get_or_init(|| {
        Mutex::new(TimelineRegistry {
            map: HashMap::new(),
            order: Vec::new(),
        })
    })
}

pub(super) fn timeline_clip(timeline_id: &str, clip_id: &str) -> Result<TimelineClipRef, String> {
    let reg = timelines()
        .lock()
        .map_err(|_| "timeline registry poisoned")?;
    let clips = reg
        .map
        .get(timeline_id)
        .ok_or_else(|| format!("unknown timeline id: {timeline_id}"))?;
    clips
        .get(clip_id)
        .cloned()
        .ok_or_else(|| format!("unknown clip id {clip_id} on timeline {timeline_id}"))
}

#[tauri::command]
pub(crate) fn viewport_register_timeline(
    timeline_id: String,
    clips: Vec<TimelineClipRef>,
) -> Result<(), String> {
    if timeline_id.is_empty() {
        return Err("timeline id must not be empty".to_string());
    }
    let mut set = HashMap::new();
    for clip in clips {
        if clip.clip_id.is_empty() {
            return Err(format!(
                "timeline {timeline_id} has a clip with an empty id"
            ));
        }
        if clip.kind != "video" && clip.kind != "still" {
            return Err(format!(
                "clip {} of timeline {timeline_id} has an unknown kind: {}",
                clip.clip_id, clip.kind
            ));
        }
        if !(clip.duration_sec > 0.0) || !clip.start_sec.is_finite() {
            return Err(format!(
                "clip {} of timeline {timeline_id} has an invalid placement",
                clip.clip_id
            ));
        }
        if !Path::new(&clip.path).is_file() {
            return Err(format!(
                "clip {} of timeline {timeline_id} points at a missing file: {}",
                clip.clip_id, clip.path
            ));
        }
        set.insert(clip.clip_id.clone(), clip);
    }
    let mut reg = timelines()
        .lock()
        .map_err(|_| "timeline registry poisoned")?;
    if reg.map.insert(timeline_id.clone(), set).is_none() {
        reg.order.push(timeline_id);
        while reg.map.len() > MAX_TIMELINES {
            if reg.order.is_empty() {
                break;
            }
            let oldest = reg.order.remove(0);
            reg.map.remove(&oldest);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn viewport_unregister_timeline(timeline_id: String) -> Result<(), String> {
    let mut reg = timelines()
        .lock()
        .map_err(|_| "timeline registry poisoned")?;
    if reg.map.remove(&timeline_id).is_some() {
        reg.order.retain(|id| id != &timeline_id);
    }
    Ok(())
}

const MAX_NODE_OUTPUTS: usize = 256;

pub(super) struct NodeOutputRegistry {
    pub(super) map: HashMap<(String, Option<String>), String>,
    pub(super) order: Vec<(String, Option<String>)>,
}

static NODE_OUTPUTS: OnceLock<Mutex<NodeOutputRegistry>> = OnceLock::new();

pub(super) fn node_outputs() -> &'static Mutex<NodeOutputRegistry> {
    NODE_OUTPUTS.get_or_init(|| {
        Mutex::new(NodeOutputRegistry {
            map: HashMap::new(),
            order: Vec::new(),
        })
    })
}

pub(super) fn node_output_path(node_id: &str, output_port: Option<&str>) -> Result<String, String> {
    let reg = node_outputs()
        .lock()
        .map_err(|_| "node output registry poisoned")?;
    let key = (node_id.to_string(), output_port.map(str::to_string));
    reg.map.get(&key).cloned().ok_or_else(|| match output_port {
        Some(port) => format!("unknown node output: {node_id}:{port}"),
        None => format!("unknown node output: {node_id}"),
    })
}

#[tauri::command]
pub(crate) fn viewport_register_node_output(
    node_id: String,
    output_port: Option<String>,
    path: String,
) -> Result<(), String> {
    if node_id.is_empty() {
        return Err("node id must not be empty".to_string());
    }
    if output_port.as_deref() == Some("") {
        return Err(format!("node {node_id} has an empty output port"));
    }
    if !Path::new(&path).is_file() {
        return Err(format!(
            "node output {node_id} points at a missing file: {path}"
        ));
    }
    let mut reg = node_outputs()
        .lock()
        .map_err(|_| "node output registry poisoned")?;
    let key = (node_id, output_port);
    if reg.map.insert(key.clone(), path).is_none() {
        reg.order.push(key);
        while reg.map.len() > MAX_NODE_OUTPUTS {
            if reg.order.is_empty() {
                break;
            }
            let oldest = reg.order.remove(0);
            reg.map.remove(&oldest);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn viewport_unregister_node_output(node_id: String) -> Result<(), String> {
    let mut reg = node_outputs()
        .lock()
        .map_err(|_| "node output registry poisoned")?;
    reg.map.retain(|(id, _), _| id != &node_id);
    reg.order.retain(|(id, _)| id != &node_id);
    Ok(())
}
