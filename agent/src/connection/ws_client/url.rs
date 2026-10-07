//! The WebSocket URL the agent connects to, and its log-safe form.

use crate::config::Config;

/// Build the full WebSocket URL, appending `?name=<agent_name>`.
///
/// Agent authentication is sent in the WebSocket handshake `Authorization` header
/// (not in the query string) to avoid leaking secrets via proxy/access logs.
pub(super) fn build_ws_url(cfg: &Config) -> String {
    let base = cfg.server_url.trim_end_matches('/');
    let mut url = base.to_string();

    fn enc(v: &str) -> String {
        use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
        // Encode everything except a conservative unreserved set.
        const SAFE: &AsciiSet = &CONTROLS
            .add(b' ')
            .add(b'"')
            .add(b'#')
            .add(b'%')
            .add(b'&')
            .add(b'+')
            .add(b',')
            .add(b'/')
            .add(b':')
            .add(b';')
            .add(b'<')
            .add(b'=')
            .add(b'>')
            .add(b'?')
            .add(b'@')
            .add(b'\\')
            .add(b'|')
            .add(b'[')
            .add(b']')
            .add(b'{')
            .add(b'}');
        utf8_percent_encode(v, SAFE).to_string()
    }

    let first_param = !url.contains('?');
    if !cfg.agent_name.is_empty() {
        url.push(if first_param { '?' } else { '&' });
        url.push_str("name=");
        url.push_str(&enc(cfg.agent_name.trim()));
    }
    url
}

/// Redact `secret=...` query parameter so agent secrets don't leak via logs.
///
/// (Kept for backward compatibility with older URLs/logs; current versions do not
/// place secrets in the query string.)
pub(super) fn redact_secret_from_ws_url(url: &str) -> String {
    let Some(secret_start) = url.find("secret=") else {
        return url.to_string();
    };
    let mut out = url.to_string();
    let value_start = secret_start + "secret=".len();
    if value_start >= out.len() {
        return out;
    }
    let value_end = out[value_start..]
        .find('&')
        .map_or(out.len(), |i| value_start + i);
    out.replace_range(value_start..value_end, "***");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(server_url: &str, agent_name: &str) -> Config {
        Config {
            server_url: server_url.into(),
            agent_name: agent_name.into(),
            ..Config::default()
        }
    }

    #[test]
    fn the_agent_name_is_appended_percent_encoded() {
        assert_eq!(
            build_ws_url(&cfg("wss://example.com/ws/", " My PC & Co ")),
            "wss://example.com/ws?name=My%20PC%20%26%20Co"
        );
    }

    #[test]
    fn an_existing_query_gets_an_ampersand_and_no_name_adds_nothing() {
        assert_eq!(
            build_ws_url(&cfg("wss://example.com/ws?x=1", "a")),
            "wss://example.com/ws?x=1&name=a"
        );
        assert_eq!(
            build_ws_url(&cfg("wss://example.com/ws", "")),
            "wss://example.com/ws"
        );
    }

    #[test]
    fn a_secret_query_value_is_redacted_for_logs() {
        assert_eq!(
            redact_secret_from_ws_url("wss://h/ws?secret=abc123&name=a"),
            "wss://h/ws?secret=***&name=a"
        );
        assert_eq!(
            redact_secret_from_ws_url("wss://h/ws?secret=abc"),
            "wss://h/ws?secret=***"
        );
        assert_eq!(redact_secret_from_ws_url("wss://h/ws"), "wss://h/ws");
    }
}
