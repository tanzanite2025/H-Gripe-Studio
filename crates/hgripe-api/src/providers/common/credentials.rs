use super::task_params::{value_bool, value_str};
use crate::credentials::{load_credential_ref, CredentialEntry};
use crate::model::ApiTask;
use crate::provider::{BrokerError, BrokerResult};
use std::env;

pub(in crate::providers) struct ApiKeyPolicy {
    fallback_envs: &'static [&'static str],
}

pub(in crate::providers) const CUSTOM_HTTP_API_KEY: ApiKeyPolicy = ApiKeyPolicy {
    fallback_envs: &["HGRIPE_CUSTOM_HTTP_API_KEY"],
};

pub(in crate::providers) const OPENAI_COMPATIBLE_API_KEY: ApiKeyPolicy = ApiKeyPolicy {
    fallback_envs: &["HGRIPE_OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"],
};

pub(in crate::providers) const REPLICATE_API_KEY: ApiKeyPolicy = ApiKeyPolicy {
    fallback_envs: &["HGRIPE_REPLICATE_API_KEY", "REPLICATE_API_TOKEN"],
};

pub(in crate::providers) fn credentials_file(task: &ApiTask) -> Option<&str> {
    value_str(task, "credentials_file")
}

pub(in crate::providers) fn resolve_credentials(
    task: &ApiTask,
    provider_name: &str,
) -> BrokerResult<Option<CredentialEntry>> {
    let Some(credential_ref) = task.credentials_ref.as_deref() else {
        return Ok(None);
    };
    let credential_ref = credential_ref.trim();
    if credential_ref.is_empty() {
        return Ok(None);
    }

    let credential =
        load_credential_ref(credential_ref, credentials_file(task))?.ok_or_else(|| {
            BrokerError::Provider(format!("credentials_ref '{credential_ref}' was not found"))
        })?;
    if let Some(provider) = credential.provider.as_deref() {
        let provider = provider.trim();
        if !provider.is_empty() && provider != provider_name {
            return Err(BrokerError::Provider(format!(
                "credentials_ref '{credential_ref}' is for provider '{provider}', not {provider_name}"
            )));
        }
    }

    Ok(Some(credential))
}

pub(in crate::providers) fn resolve_api_key(
    task: &ApiTask,
    credentials: Option<&CredentialEntry>,
    policy: &ApiKeyPolicy,
) -> BrokerResult<Option<String>> {
    if value_bool(task, "no_auth").unwrap_or(false) {
        return Ok(None);
    }

    if let Some(api_key) = value_str(task, "api_key") {
        let api_key = api_key.trim();
        if !api_key.is_empty() {
            return Ok(Some(api_key.to_string()));
        }
    }

    if let Some(api_key_env) = value_str(task, "api_key_env") {
        let api_key_env = api_key_env.trim();
        if api_key_env.is_empty() {
            return Ok(None);
        }
        return Ok(env::var(api_key_env).ok().filter(|value| !value.is_empty()));
    }

    if let Some(credentials) = credentials {
        if let Some(api_key) = credentials.api_key.as_deref() {
            let api_key = api_key.trim();
            if !api_key.is_empty() {
                return Ok(Some(api_key.to_string()));
            }
        }

        if let Some(api_key_env) = credentials.api_key_env.as_deref() {
            let api_key_env = api_key_env.trim();
            if api_key_env.is_empty() {
                return Ok(None);
            }
            return Ok(env::var(api_key_env).ok().filter(|value| !value.is_empty()));
        }
    }

    Ok(policy
        .fallback_envs
        .iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.is_empty())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn rejects_credentials_for_another_provider() {
        let path = std::env::temp_dir().join(format!(
            "hgripe-provider-credentials-{}.json",
            Uuid::new_v4()
        ));
        fs::write(
            &path,
            json!({
                "profiles": {
                    "wrong-provider": {
                        "provider": "custom_http",
                        "api_key": "test-only"
                    }
                }
            })
            .to_string(),
        )
        .expect("credentials fixture should be written");

        let mut task = ApiTask::new("openai_compatible", "chat.completions");
        task.credentials_ref = Some("wrong-provider".to_string());
        task.params.insert(
            "credentials_file".to_string(),
            json!(path.to_string_lossy().to_string()),
        );

        let error = resolve_credentials(&task, "openai_compatible")
            .expect_err("provider mismatch should be rejected");
        let _ = fs::remove_file(path);

        assert_eq!(
            error.to_string(),
            "provider error: credentials_ref 'wrong-provider' is for provider 'custom_http', not openai_compatible"
        );
    }

    #[test]
    fn explicit_task_api_key_precedes_credential_values() {
        let mut task = ApiTask::new("custom_http", "request");
        task.params
            .insert("api_key".to_string(), json!(" task-key "));
        let credentials = CredentialEntry {
            api_key: Some("credential-key".to_string()),
            ..CredentialEntry::default()
        };

        assert_eq!(
            resolve_api_key(&task, Some(&credentials), &CUSTOM_HTTP_API_KEY)
                .expect("API key resolution should succeed")
                .as_deref(),
            Some("task-key")
        );
    }
}
