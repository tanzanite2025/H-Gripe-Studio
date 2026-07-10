use super::task_params::value_str;
use crate::model::ApiTask;
use crate::profiles::{load_provider_profile, ProviderProfile};
use crate::provider::{BrokerError, BrokerResult};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub(in crate::providers) struct ProfileMergePolicy {
    provider_name: &'static str,
    include_model: bool,
    path_param: Option<&'static str>,
    include_extra_body: bool,
    merge_profile_headers: bool,
    object_merge_keys: &'static [&'static str],
    object_merge_suffixes: &'static [&'static str],
}

pub(in crate::providers) const CUSTOM_HTTP_PROFILE_MERGE: ProfileMergePolicy = ProfileMergePolicy {
    provider_name: "custom_http",
    include_model: false,
    path_param: Some("url"),
    include_extra_body: false,
    merge_profile_headers: true,
    object_merge_keys: &["headers", "query"],
    object_merge_suffixes: &["_headers", "_query"],
};

pub(in crate::providers) const OPENAI_COMPATIBLE_PROFILE_MERGE: ProfileMergePolicy =
    ProfileMergePolicy {
        provider_name: "openai_compatible",
        include_model: true,
        path_param: Some("path"),
        include_extra_body: true,
        merge_profile_headers: false,
        object_merge_keys: &["extra_body", "headers"],
        object_merge_suffixes: &[],
    };

pub(in crate::providers) const REPLICATE_PROFILE_MERGE: ProfileMergePolicy = ProfileMergePolicy {
    provider_name: "replicate",
    include_model: true,
    path_param: None,
    include_extra_body: true,
    merge_profile_headers: false,
    object_merge_keys: &["extra_body", "headers", "input"],
    object_merge_suffixes: &[],
};

pub(in crate::providers) fn apply_provider_profile(
    task: &ApiTask,
    policy: &ProfileMergePolicy,
) -> BrokerResult<ApiTask> {
    let Some(profile_ref) = value_str(task, "profile_ref")
        .or_else(|| value_str(task, "provider_profile_ref"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(task.clone());
    };
    let profiles_file = value_str(task, "profiles_file");
    let profile = load_provider_profile(profile_ref, profiles_file)?.ok_or_else(|| {
        BrokerError::Provider(format!("provider profile '{profile_ref}' was not found"))
    })?;

    if let Some(provider) = profile.provider.as_deref() {
        let provider = provider.trim();
        if !provider.is_empty() && provider != policy.provider_name {
            return Err(BrokerError::Provider(format!(
                "provider profile '{profile_ref}' is for provider '{provider}', not '{}'",
                policy.provider_name
            )));
        }
    }

    Ok(merge_provider_profile(task, &profile, policy))
}

fn merge_provider_profile(
    task: &ApiTask,
    profile: &ProviderProfile,
    policy: &ProfileMergePolicy,
) -> ApiTask {
    let mut merged = task.clone();
    let task_params = task.params.clone();
    merged.params = BTreeMap::new();

    if let Some(params) = &profile.params {
        for (key, value) in params {
            insert_effective_param(&mut merged.params, key, value.clone());
        }
    }

    insert_optional_string(&mut merged.params, "base_url", profile.base_url.as_deref());
    if policy.include_model {
        insert_optional_string(&mut merged.params, "model", profile.model.as_deref());
    }
    if let Some(path_param) = policy.path_param {
        insert_optional_string(&mut merged.params, path_param, profile.path.as_deref());
    }
    insert_optional_string(
        &mut merged.params,
        "api_key_env",
        profile.api_key_env.as_deref(),
    );
    if let Some(no_auth) = profile.no_auth {
        merged.params.insert("no_auth".to_string(), json!(no_auth));
    }
    if let Some(headers) = &profile.headers {
        if policy.merge_profile_headers {
            merge_task_param(
                &mut merged.params,
                "headers".to_string(),
                json!(headers),
                policy,
            );
        } else {
            merged.params.insert("headers".to_string(), json!(headers));
        }
    }
    if policy.include_extra_body {
        if let Some(extra_body) = &profile.extra_body {
            merged
                .params
                .insert("extra_body".to_string(), json!(extra_body));
        }
    }

    for (key, value) in task_params {
        merge_task_param(&mut merged.params, key, value, policy);
    }

    if task
        .credentials_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        merged.credentials_ref = profile
            .credentials_ref
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
    }

    merged
}

fn insert_optional_string(params: &mut BTreeMap<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        params.insert(key.to_string(), json!(value));
    }
}

fn insert_effective_param(params: &mut BTreeMap<String, Value>, key: &str, value: Value) {
    if !value_is_blank_string(&value) {
        params.insert(key.to_string(), value);
    }
}

fn merge_task_param(
    params: &mut BTreeMap<String, Value>,
    key: String,
    value: Value,
    policy: &ProfileMergePolicy,
) {
    if value_is_blank_string(&value) && params.contains_key(&key) {
        return;
    }

    let merge_object = policy.object_merge_keys.contains(&key.as_str())
        || policy
            .object_merge_suffixes
            .iter()
            .any(|suffix| key.ends_with(suffix));
    if merge_object {
        if let (Some(existing), Some(incoming)) = (
            params.get_mut(&key).and_then(Value::as_object_mut),
            value.as_object(),
        ) {
            for (item_key, item_value) in incoming {
                if !value_is_blank_string(item_value) {
                    existing.insert(item_key.clone(), item_value.clone());
                }
            }
            return;
        }
    }

    params.insert(key, value);
}

fn value_is_blank_string(value: &Value) -> bool {
    value.as_str().map(str::trim).is_some_and(str::is_empty)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_http_policy_merges_dynamic_header_and_query_objects() {
        let mut task = ApiTask::new("custom_http", "request");
        task.params.insert(
            "poll_headers".to_string(),
            json!({"task": "yes", "blank": ""}),
        );
        task.params
            .insert("query".to_string(), json!({"task": "yes"}));
        let profile = ProviderProfile {
            path: Some("/profile".to_string()),
            model: Some("ignored-model".to_string()),
            headers: Some(BTreeMap::from([("profile".to_string(), "yes".to_string())])),
            params: Some(BTreeMap::from([
                ("headers".to_string(), json!({"param": "yes"})),
                (
                    "poll_headers".to_string(),
                    json!({"profile": "yes", "blank": "profile"}),
                ),
                ("query".to_string(), json!({"profile": "yes"})),
            ])),
            extra_body: Some(BTreeMap::from([("ignored".to_string(), json!(true))])),
            ..ProviderProfile::default()
        };

        let merged = merge_provider_profile(&task, &profile, &CUSTOM_HTTP_PROFILE_MERGE);

        assert_eq!(merged.params["url"], json!("/profile"));
        assert_eq!(
            merged.params["headers"],
            json!({"param": "yes", "profile": "yes"})
        );
        assert_eq!(
            merged.params["poll_headers"],
            json!({"blank": "profile", "profile": "yes", "task": "yes"})
        );
        assert_eq!(
            merged.params["query"],
            json!({"profile": "yes", "task": "yes"})
        );
        assert!(!merged.params.contains_key("model"));
        assert!(!merged.params.contains_key("extra_body"));
    }

    #[test]
    fn replicate_policy_merges_input_and_inherits_profile_credentials() {
        let mut task = ApiTask::new("replicate", "run");
        task.params
            .insert("input".to_string(), json!({"task": "yes"}));
        task.params.insert("model".to_string(), json!(" "));
        let profile = ProviderProfile {
            credentials_ref: Some("replicate-local".to_string()),
            model: Some("owner/model".to_string()),
            params: Some(BTreeMap::from([(
                "input".to_string(),
                json!({"profile": "yes"}),
            )])),
            extra_body: Some(BTreeMap::from([("webhook".to_string(), json!("url"))])),
            ..ProviderProfile::default()
        };

        let merged = merge_provider_profile(&task, &profile, &REPLICATE_PROFILE_MERGE);

        assert_eq!(merged.params["model"], json!("owner/model"));
        assert_eq!(
            merged.params["input"],
            json!({"profile": "yes", "task": "yes"})
        );
        assert_eq!(merged.params["extra_body"], json!({"webhook": "url"}));
        assert_eq!(merged.credentials_ref.as_deref(), Some("replicate-local"));
    }
}
