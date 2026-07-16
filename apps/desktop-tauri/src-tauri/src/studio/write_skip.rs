//! Write-skip analysis for compute-node outputs: decides which output ports
//! never need a PNG on disk because every consumer is served from the shared
//! in-memory [`image_buffer`](super::image_buffer).

use std::collections::{HashMap, HashSet};

use super::exec::{studio_executor_for_kind, StudioExecutor};
use super::graph::{StudioGraphNode, StudioWorkflowGraph};

/// Whether a consumer of a compute output can be served *without a file on
/// disk*, so the producer may skip that output's PNG write: only another
/// `Compute` card — it loads the surface in-process through the shared
/// [`image_buffer`], so the file is never read.
///
/// Every file-backed consumer — a native `Local` card, an `Api` upload, or a
/// `save` / export sink — reads the file and forces a materialised output.
///
/// [`image_buffer`]: super::image_buffer
fn studio_consumer_permits_write_skip(consumer: &StudioGraphNode) -> bool {
    studio_executor_for_kind(consumer.kind.as_str()) == Some(StudioExecutor::Compute)
}

/// The set of a compute node's output ports whose PNG write may be skipped: an
/// output is skippable when it has at least one consumer and *every* consumer
/// [permits a write-skip](studio_consumer_permits_write_skip) (all in-process
/// compute cards, never a file reader). Only compute nodes can skip; every
/// other kind returns empty.
pub(super) fn studio_skippable_output_ports(
    node: &StudioGraphNode,
    graph: &StudioWorkflowGraph,
    nodes_by_id: &HashMap<String, &StudioGraphNode>,
) -> HashSet<String> {
    let mut skippable = HashSet::new();
    if studio_executor_for_kind(node.kind.as_str()) != Some(StudioExecutor::Compute) {
        return skippable;
    }
    let ports: HashSet<&str> = graph
        .edges
        .iter()
        .filter(|edge| edge.source == node.id)
        .map(|edge| edge.source_port.as_str())
        .collect();
    for port in ports {
        let mut has_consumer = false;
        let mut all_skippable = true;
        for edge in graph
            .edges
            .iter()
            .filter(|edge| edge.source == node.id && edge.source_port == port)
        {
            has_consumer = true;
            let consumer_ok = nodes_by_id
                .get(&edge.target)
                .map(|target| studio_consumer_permits_write_skip(target))
                .unwrap_or(false);
            if !consumer_ok {
                all_skippable = false;
                break;
            }
        }
        if has_consumer && all_skippable {
            skippable.insert(port.to_string());
        }
    }
    skippable
}

#[cfg(test)]
mod tests {
    use super::super::graph::StudioGraphEdge;
    use super::*;
    use std::collections::BTreeMap;

    fn node(id: &str, kind: &str) -> StudioGraphNode {
        StudioGraphNode {
            id: id.to_string(),
            kind: kind.to_string(),
            params: BTreeMap::new(),
        }
    }

    fn edge(id: &str, source: &str, source_port: &str, target: &str) -> StudioGraphEdge {
        StudioGraphEdge {
            id: id.to_string(),
            source: source.to_string(),
            source_port: source_port.to_string(),
            target: target.to_string(),
            target_port: "image".to_string(),
        }
    }

    #[test]
    fn skippable_ports_feed_only_compute_consumers() {
        // crop1.image -> a second crop (Compute): skippable.
        // crop1.crop_report -> a `save` sink: the sink reads the file, so the
        //   report output must keep its PNG.
        // crop2.image fans out to a compute card *and* a Local imageEnhance: the
        //   Local card reads the file, so nothing on crop2 is skippable.
        let graph = StudioWorkflowGraph {
            version: 1,
            nodes: vec![
                node("crop1", "crop"),
                node("crop2", "crop"),
                node("sink", "save"),
                node("enh", "imageEnhance"),
            ],
            edges: vec![
                edge("e1", "crop1", "image", "crop2"),
                edge("e2", "crop1", "crop_report", "sink"),
                edge("e3", "crop2", "image", "crop1"),
                edge("e4", "crop2", "image", "enh"),
            ],
        };
        let nodes_by_id: HashMap<String, &StudioGraphNode> =
            graph.nodes.iter().map(|n| (n.id.clone(), n)).collect();

        let crop1 = nodes_by_id.get("crop1").unwrap();
        assert_eq!(
            studio_skippable_output_ports(crop1, &graph, &nodes_by_id),
            HashSet::from(["image".to_string()]),
            "only the output feeding a compute card is skippable"
        );

        // crop2.image fans out to a compute card *and* a Local imageEnhance, so
        // the file must stay — nothing is skippable.
        let crop2 = nodes_by_id.get("crop2").unwrap();
        assert!(
            studio_skippable_output_ports(crop2, &graph, &nodes_by_id).is_empty(),
            "a mixed fan-out (compute + local) always keeps the file"
        );

        // A non-compute node never skips, even when its consumer is compute.
        let sink = nodes_by_id.get("sink").unwrap();
        assert!(studio_skippable_output_ports(sink, &graph, &nodes_by_id).is_empty());
    }

    #[test]
    fn an_output_with_no_consumer_is_not_skippable() {
        // A terminal-ish crop whose image port has no outgoing edge must keep
        // its file: it is the run's returned artifact / a thumbnail source.
        let graph = StudioWorkflowGraph {
            version: 1,
            nodes: vec![node("crop1", "crop")],
            edges: vec![],
        };
        let nodes_by_id: HashMap<String, &StudioGraphNode> =
            graph.nodes.iter().map(|n| (n.id.clone(), n)).collect();
        let crop1 = nodes_by_id.get("crop1").unwrap();
        assert!(studio_skippable_output_ports(crop1, &graph, &nodes_by_id).is_empty());
    }
}
