use std::time::Duration;

use anyhow::{Context, Result};

const UPDATER_ENDPOINT: &str =
    "https://github.com/gladsonsam/Vantyr/releases/latest/download/latest.json";

#[derive(Debug, Clone)]
pub struct LatestInfo {
    pub version: String,
    pub url: String,
    pub signature: String,
}

fn pick_windows_platform(obj: &serde_json::Value) -> Option<&serde_json::Value> {
    let platforms = obj.get("platforms")?.as_object()?;
    let preferred = [
        "windows-x86_64",
        "windows-x86_64-msvc",
        "windows-x64",
        "windows",
    ];
    for k in preferred {
        if let Some(v) = platforms.get(k) {
            return Some(v);
        }
    }
    for (k, v) in platforms {
        if k.to_lowercase().contains("windows") {
            return Some(v);
        }
    }
    None
}

pub async fn fetch_latest_info() -> Result<LatestInfo> {
    let body = reqwest::Client::new()
        .get(UPDATER_ENDPOINT)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .context("fetch latest.json failed")?
        .error_for_status()
        .context("latest.json returned non-2xx")?
        .text()
        .await
        .context("read latest.json body failed")?;

    let json: serde_json::Value =
        serde_json::from_str(&body).context("latest.json is not valid JSON")?;
    let version = json
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if version.is_empty() {
        anyhow::bail!("latest.json missing version");
    }

    let plat =
        pick_windows_platform(&json).context("latest.json missing windows platform entry")?;
    let url = plat
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let signature = plat
        .get("signature")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if url.is_empty() {
        anyhow::bail!("latest.json windows entry missing url");
    }
    if signature.is_empty() {
        anyhow::bail!("latest.json windows entry missing signature");
    }

    Ok(LatestInfo {
        version,
        url,
        signature,
    })
}
