use crate::model::ApiTask;
use serde_json::Value;

pub(in crate::providers) fn value<'a>(task: &'a ApiTask, key: &str) -> Option<&'a Value> {
    task.params.get(key).or_else(|| task.inputs.get(key))
}

pub(in crate::providers) fn value_str<'a>(task: &'a ApiTask, key: &str) -> Option<&'a str> {
    value(task, key).and_then(Value::as_str)
}

pub(in crate::providers) fn value_bool(task: &ApiTask, key: &str) -> Option<bool> {
    value(task, key).and_then(Value::as_bool)
}

pub(in crate::providers) fn value_u64(task: &ApiTask, key: &str) -> Option<u64> {
    match value(task, key)? {
        Value::Number(number) => number.as_u64(),
        Value::String(value) => value.trim().parse().ok(),
        _ => None,
    }
}
