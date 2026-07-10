use super::task_params::value_str;
use crate::credentials::{load_credential_ref, CredentialEntry};
use crate::model::ApiTask;
use crate::provider::{BrokerError, BrokerResult};

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
}
