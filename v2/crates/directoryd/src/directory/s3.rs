//! An S3-compatible object store over HTTP(S) (R2 and S3 among them), with exactly the two conditional writes
//! (`If-None-Match: *` and `If-Match`), path-style requests and AWS Signature Version 4. Its settings come from the
//! process environment ([`S3::from_env`]); the endpoint is a machine's address and stays out of anything published
//! (`docs/process/publication-privacy.md`).

use std::time::Duration;

use replica::effects::Refusal;
use replica::encode::to_hex;
use ring::{digest, hmac};

use super::store::{Object, R, Store, When, refuse};

/// How long one request may take before the store counts as out of reach. A world never waits on it: it is the
/// directory's caller, not the tick, that makes these calls.
const TIMEOUT: Duration = Duration::from_secs(5);

/// One bucket of an S3-compatible store, and the prefix every key is put under.
pub struct S3 {
    agent: ureq::Agent,
    /// `scheme://host[:port]`, with no path.
    endpoint: String,
    host: String,
    bucket: String,
    region: String,
    access_key_id: String,
    secret_access_key: String,
    prefix: String,
}

/// The directory's store as one setting in the offsite bucket's form (O3c, #3529):
/// `s3:https://<host>/<bucket>[/<prefix>]`, its keys in `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. `worldd serve`
/// ships to it too when `--store` and `WORLDD_STORE` are not given, so the directory and the worlds' history share one
/// bucket.
pub const URL_ENV: &str = "DIRECTORY_STORE_URL";

/// The settings [`S3::from_env`] reads when [`URL_ENV`] is not set.
pub const ENV: [&str; 6] = [
    "DIRECTORY_STORE_ENDPOINT",
    "DIRECTORY_STORE_BUCKET",
    "DIRECTORY_STORE_REGION",
    "DIRECTORY_STORE_ACCESS_KEY_ID",
    "DIRECTORY_STORE_SECRET_ACCESS_KEY",
    "DIRECTORY_STORE_PREFIX",
];

impl S3 {
    /// A store at `endpoint` (`http://` or `https://`, host and optional port, no path).
    pub fn new(
        endpoint: &str,
        bucket: &str,
        region: &str,
        access_key_id: &str,
        secret_access_key: &str,
        prefix: &str,
    ) -> R<S3> {
        let endpoint = endpoint.trim_end_matches('/');
        let Some(host) = endpoint
            .strip_prefix("https://")
            .or_else(|| endpoint.strip_prefix("http://"))
        else {
            return refuse("store-settings", "the endpoint is http:// or https://");
        };
        if host.is_empty() || host.contains('/') || bucket.is_empty() {
            return refuse("store-settings", "an endpoint is a host, with a bucket");
        }
        // Keys come from the environment, never from the address (O3c, #3529); the refusal does not repeat it.
        if host.contains('@') {
            return refuse("store-settings", "the endpoint carries no credentials");
        }
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .http_status_as_error(false)
            .build()
            .into();
        Ok(S3 {
            agent,
            endpoint: endpoint.to_owned(),
            host: host.to_owned(),
            bucket: bucket.to_owned(),
            region: region.to_owned(),
            access_key_id: access_key_id.to_owned(),
            secret_access_key: secret_access_key.to_owned(),
            prefix: prefix.to_owned(),
        })
    }

    /// The store the environment names: [`URL_ENV`] in the offsite form ([`S3::from_url`], O3c #3529), else [`ENV`]
    /// (the region defaults to `auto`, R2's, and the prefix to none); `None` when neither `DIRECTORY_STORE_URL` nor
    /// `DIRECTORY_STORE_ENDPOINT` is set.
    pub fn from_env() -> Option<R<S3>> {
        S3::from_vars(|k| std::env::var(k).ok())
    }

    /// [`S3::from_env`] over settings read through `get` (`register-world`'s settings files, #1960 B3), so an operator
    /// command picks the store the directory's own environment picks.
    pub fn from_vars(get: impl Fn(&str) -> Option<String>) -> Option<R<S3>> {
        let var = |k: &str| get(k).unwrap_or_default();
        if let Some(url) = get(URL_ENV).filter(|u| !u.trim().is_empty()) {
            return Some(S3::from_url(url.trim(), var));
        }
        let endpoint = get(ENV[0])?;
        let region = Some(var(ENV[2])).filter(|r| !r.is_empty());
        Some(S3::new(
            &endpoint,
            &var(ENV[1]),
            region.as_deref().unwrap_or("auto"),
            &var(ENV[3]),
            &var(ENV[4]),
            &var(ENV[5]),
        ))
    }

    /// The bucket a URL names, in the offsite bucket's form (`BACKUP_OFFSITE_URL`'s, and O20b's `SOULS_BACKUP_URL`):
    /// `[s3:]http(s)://<host>/<bucket>[/<prefix>]`, its keys from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` and
    /// its region from `AWS_DEFAULT_REGION` (default `auto`, R2's), read through `var` (O3c, #3529). A refusal never
    /// repeats the URL: its host is a machine's address.
    pub fn from_url(url: &str, var: impl Fn(&str) -> String) -> R<S3> {
        let form = || {
            refuse(
                "store-settings",
                "a bucket is s3:https://<host>/<bucket>[/<prefix>]",
            )
        };
        let u = url.strip_prefix("s3:").unwrap_or(url);
        let Some((scheme, rest)) = u.split_once("://") else {
            return form();
        };
        let mut parts = rest.splitn(3, '/');
        let (Some(host), Some(bucket)) = (parts.next(), parts.next()) else {
            return form();
        };
        let prefix = match parts.next().map(|p| p.trim_matches('/')) {
            Some(p) if !p.is_empty() => format!("{p}/"),
            _ => String::new(),
        };
        let region = Some(var("AWS_DEFAULT_REGION"))
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| "auto".to_owned());
        S3::new(
            &format!("{scheme}://{host}"),
            bucket,
            &region,
            &var("AWS_ACCESS_KEY_ID"),
            &var("AWS_SECRET_ACCESS_KEY"),
            &prefix,
        )
    }

    /// The request path: `/<bucket>/<prefix><key>`, each segment percent-encoded.
    fn path(&self, key: &str) -> String {
        let full = format!("{}/{}{}", self.bucket, self.prefix, key);
        full.split('/').map(|s| format!("/{}", encode(s))).collect()
    }

    /// The headers that sign one request (SigV4): `x-amz-date`, `x-amz-content-sha256` and `authorization`.
    fn sign(&self, method: &str, path: &str, payload: &[u8]) -> [(&'static str, String); 3] {
        self.sign_query(method, path, "", payload)
    }

    /// [`S3::sign`] with a canonical query string (its pairs encoded and sorted by name).
    fn sign_query(
        &self,
        method: &str,
        path: &str,
        query: &str,
        payload: &[u8],
    ) -> [(&'static str, String); 3] {
        let (date, stamp) = now();
        let body = to_hex(digest::digest(&digest::SHA256, payload).as_ref());
        let signed = "host;x-amz-content-sha256;x-amz-date";
        let canonical = format!(
            "{method}\n{path}\n{query}\nhost:{}\nx-amz-content-sha256:{body}\nx-amz-date:{stamp}\n\n{signed}\n{body}",
            self.host
        );
        let scope = format!("{date}/{}/s3/aws4_request", self.region);
        let to_sign = format!(
            "AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{}",
            to_hex(digest::digest(&digest::SHA256, canonical.as_bytes()).as_ref())
        );
        let mac = |key: &[u8], data: &str| {
            hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data.as_bytes())
                .as_ref()
                .to_vec()
        };
        let mut k = mac(format!("AWS4{}", self.secret_access_key).as_bytes(), &date);
        for part in [self.region.as_str(), "s3", "aws4_request"] {
            k = mac(&k, part);
        }
        let signature = to_hex(&mac(&k, &to_sign));
        [
            ("x-amz-date", stamp),
            ("x-amz-content-sha256", body),
            (
                "authorization",
                format!(
                    "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={signature}",
                    self.access_key_id
                ),
            ),
        ]
    }

    /// After a 5xx or a lost answer to a create-only write, reads `key` back (#4014): the same bytes there count as
    /// applied (their ETag), other bytes as the key existing (`precondition-failed`, what a 412 says), and nothing
    /// there or no answer to the read leave the write `lost`, `store-unreachable`, so nothing is decided on it.
    fn read_back(&self, key: &str, bytes: &[u8], lost: Refusal) -> R<String> {
        match self.get(key) {
            Ok(Some(o)) if o.bytes == bytes => Ok(o.etag),
            Ok(Some(_)) => refuse(
                "precondition-failed",
                format!(
                    "{key}: exists, other bytes, read back after {}",
                    lost.detail
                ),
            ),
            Ok(None) | Err(_) => Err(lost),
        }
    }
}

/// One page of a bucket listing (ListObjectsV2): its keys, and the token for the next page when it is cut short.
fn listing(xml: &str) -> (Vec<String>, Option<String>) {
    let tag = |s: &str, name: &str| -> Vec<String> {
        let (open, close) = (format!("<{name}>"), format!("</{name}>"));
        let mut out = Vec::new();
        let mut rest = s;
        while let Some(i) = rest.find(&open) {
            let after = &rest[i + open.len()..];
            let Some(j) = after.find(&close) else { break };
            out.push(after[..j].to_owned());
            rest = &after[j + close.len()..];
        }
        out
    };
    let truncated = tag(xml, "IsTruncated").first().is_some_and(|t| t == "true");
    let next = tag(xml, "NextContinuationToken")
        .first()
        .map(|t| unescape(t));
    let keys = tag(xml, "Contents")
        .iter()
        .flat_map(|c| tag(c, "Key"))
        .map(|k| unescape(&k))
        .collect();
    (keys, next.filter(|_| truncated))
}

/// XML's five escapes, `&amp;` last.
fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Percent-encodes one path segment: all but `A-Z a-z 0-9 - . _ ~`.
fn encode(segment: &str) -> String {
    segment
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The UTC date (`YYYYMMDD`) and time stamp (`YYYYMMDDTHHMMSSZ`) a signature carries.
#[allow(clippy::disallowed_methods)] // A request signature carries the wall-clock time; no world reads it (K7).
fn now() -> (String, String) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let (days, rest) = (secs / 86_400, secs % 86_400);
    // Days since 1970-01-01 to a civil date (H. Hinnant's algorithm), for dates after 1970.
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    let date = format!("{year:04}{month:02}{day:02}");
    let stamp = format!(
        "{date}T{:02}{:02}{:02}Z",
        rest / 3_600,
        rest / 60 % 60,
        rest % 60
    );
    (date, stamp)
}

/// Sorts an answer's status into the store's refusals.
fn status(code: u16, what: &str) -> R<()> {
    match code {
        200..=299 => Ok(()),
        // 412: the condition failed; 409: another conditional write to the key is in flight (S3 asks for a retry);
        // 404 on a write: `If-Match` named a key that is gone.
        404 | 409 | 412 => refuse("precondition-failed", format!("{what}: HTTP {code}")),
        500..=599 => refuse("store-unreachable", format!("{what}: HTTP {code}")),
        _ => refuse("store-error", format!("{what}: HTTP {code}")),
    }
}

fn unreachable(what: &str, e: ureq::Error) -> R<ureq::http::Response<ureq::Body>> {
    refuse("store-unreachable", format!("{what}: {e}"))
}

impl Store for S3 {
    fn get(&self, key: &str) -> R<Option<Object>> {
        let path = self.path(key);
        let mut req = self.agent.get(format!("{}{path}", self.endpoint));
        for (k, v) in self.sign("GET", &path, b"") {
            req = req.header(k, v);
        }
        let mut res = req.call().or_else(|e| unreachable(key, e))?;
        let code = res.status().as_u16();
        if code == 404 {
            return Ok(None);
        }
        status(code, key)?;
        let etag = etag(&res, key)?;
        let bytes = res
            .body_mut()
            .read_to_vec()
            .or_else(|e| refuse("store-unreachable", format!("{key}: {e}")))?;
        Ok(Some(Object { etag, bytes }))
    }

    fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
        let path = self.path(key);
        let mut req = self.agent.put(format!("{}{path}", self.endpoint));
        for (k, v) in self.sign("PUT", &path, bytes) {
            req = req.header(k, v);
        }
        req = match when {
            When::Absent => req.header("if-none-match", "*"),
            // The ETag bare, without quotes: R2 refuses a quoted `If-Match` on PutObject (412 even when it is the
            // object's ETag) and takes the bare one (#1960).
            When::Is(e) => req.header("if-match", e),
        };
        let answered = req
            .send(bytes)
            .or_else(|e| unreachable(key, e))
            .and_then(|res| status(res.status().as_u16(), key).map(|()| res));
        match answered {
            Ok(res) => etag(&res, key),
            // A create-only write the store may have applied, though its answer was a 5xx or never came (#4014).
            Err(e) if e.name == "store-unreachable" && when == When::Absent => {
                self.read_back(key, bytes, e)
            }
            Err(e) => Err(e),
        }
    }

    /// DeleteObject; a key that is not there is no refusal.
    fn delete(&self, key: &str) -> R<()> {
        let path = self.path(key);
        let mut req = self.agent.delete(format!("{}{path}", self.endpoint));
        for (k, v) in self.sign("DELETE", &path, b"") {
            req = req.header(k, v);
        }
        let res = req.call().or_else(|e| unreachable(key, e))?;
        match res.status().as_u16() {
            404 => Ok(()),
            code => status(code, key),
        }
    }

    /// ListObjectsV2 under the store's prefix and `prefix`, page by page; the keys without the store's prefix.
    fn list(&self, prefix: &str) -> R<Vec<String>> {
        let path = format!("/{}", encode(&self.bucket));
        let full = format!("{}{prefix}", self.prefix);
        let mut keys = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut pairs = vec![("list-type", "2".to_owned()), ("prefix", full.clone())];
            if let Some(t) = &token {
                pairs.push(("continuation-token", t.clone()));
            }
            pairs.sort();
            let query = pairs
                .iter()
                .map(|(k, v)| format!("{k}={}", encode(v)))
                .collect::<Vec<_>>()
                .join("&");
            let mut req = self.agent.get(format!("{}{path}?{query}", self.endpoint));
            for (k, v) in self.sign_query("GET", &path, &query, b"") {
                req = req.header(k, v);
            }
            let mut res = req.call().or_else(|e| unreachable(prefix, e))?;
            status(res.status().as_u16(), prefix)?;
            let xml = res
                .body_mut()
                .read_to_string()
                .or_else(|e| refuse("store-unreachable", format!("{prefix}: {e}")))?;
            let (page, next) = listing(&xml);
            keys.extend(
                page.into_iter()
                    .filter_map(|k| k.strip_prefix(&self.prefix).map(str::to_owned)),
            );
            match next {
                Some(t) => token = Some(t),
                None => break,
            }
        }
        keys.sort();
        Ok(keys)
    }
}

/// An answer's ETag, without its quotes.
fn etag(res: &ureq::http::Response<ureq::Body>, key: &str) -> R<String> {
    match res.headers().get("etag").and_then(|v| v.to_str().ok()) {
        Some(e) => Ok(e.trim_matches('"').to_owned()),
        None => refuse("store-error", format!("{key}: the answer has no ETag")),
    }
}
