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

/// How long a read (GET, HEAD, a listing page) waits for its answer's head before it is sent once more, on another
/// connection, within the same [`TIMEOUT`] ([`S3::read`]). The offsite bucket, measured from the production host on
/// 25 Nov 2026 (3,036 authenticated requests in 10 min): p50 0.14 s, p99 4.2 s; 3.0% past 2 s and 0.76% past 5 s,
/// every one of them waiting for the answer's head after a connect and TLS of under 0.03 s, alike over IPv4 and IPv6
/// and on fresh and kept connections; unauthenticated requests never passed 0.11 s. The stalls are one request's: a
/// request sent 2 s into another's stall was answered within 3 s in 88 of 100 samples, which puts reads unanswered at
/// 5 s from 0.69% to about 0.3% (an estimate from those requests, not measured with this client). Not for an
/// operator's tool or the probe ([`Reads::Limit`]): those have their own bounds and tries.
const HEDGE: Duration = Duration::from_secs(2);

/// The largest object a world's store reads ([`S3::for_world`]): 1 GiB, the largest legitimate object (a large
/// world's stream-recovery object or checkpoint, tens of MB) with a wide margin.
pub const WORLD_READ_LIMIT: u64 = 1 << 30;

/// How long an operator's request may wait for one phase (the lookup, the connection, the request, the answer's
/// head) before it is given up on ([`S3::for_operator`]).
const OPERATOR_PHASE: Duration = Duration::from_secs(30);

/// How long one object's body may take to send or receive in a world's store ([`S3::for_world`]).
const BODY_TIMEOUT: Duration = Duration::from_secs(120);

/// The slowest link a world's write is waited on at, bytes a second ([`S3::for_world`]): a body is sent once the
/// connection's buffer holds it, not once the store has it, so the wait for the answer runs while its tail is still on
/// the wire. Each write waits [`TIMEOUT`] for its answer, and a second more for each this many bytes of its body; a
/// store that does not answer a small write is still found within [`TIMEOUT`].
const SLOWEST_LINK: u64 = 1 << 20;

/// How long a write of `len` bytes waits for its answer's head once its body is sent ([`SLOWEST_LINK`]).
fn answer_within(len: usize) -> Duration {
    TIMEOUT + Duration::from_millis((len as u64).saturating_mul(1000) / SLOWEST_LINK)
}

/// The largest object a store's read takes, and how its write waits for an answer (one field, so [`S3`] stays small).
#[derive(Clone, Copy)]
enum Reads {
    /// ureq's own cap (10 MiB), which every program but a world's store and an operator's tool keeps.
    Capped,
    /// A world's ([`S3::for_world`]): up to [`WORLD_READ_LIMIT`], and a write waits by its body ([`answer_within`]).
    World,
    /// An operator's tool's ([`S3::for_operator`], [`S3::for_probe`]): up to this many bytes.
    Limit(u64),
}

/// One bucket of an S3-compatible store, and the prefix every key is put under.
pub struct S3 {
    agent: ureq::Agent,
    /// The largest object a read takes, and how a write waits for its answer.
    reads: Reads,
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
            reads: Reads::Capped,
            endpoint: endpoint.to_owned(),
            host: host.to_owned(),
            bucket: bucket.to_owned(),
            region: region.to_owned(),
            access_key_id: access_key_id.to_owned(),
            secret_access_key: secret_access_key.to_owned(),
            prefix: prefix.to_owned(),
        })
    }

    /// This store as a world's (`worldd`'s history, checkpoints, log parts and stream recovery): reads of whole objects
    /// up to [`WORLD_READ_LIMIT`], where ureq's own cap is 10 MiB and a fresh Eden's stream-recovery object is already
    /// 11.8 MB (its checkpoint 10.1 MB, its import part 9.6 MB). A store out of reach is still found within [`TIMEOUT`]:
    /// the name's lookup, the connection, the request and the answer's head each have that long; only an object's body, sent or
    /// received, has [`BODY_TIMEOUT`], and a write's answer a second more for each [`SLOWEST_LINK`] bytes it sent.
    pub fn for_world(mut self) -> S3 {
        self.agent = ureq::Agent::config_builder()
            .timeout_global(None)
            .timeout_resolve(Some(TIMEOUT))
            .timeout_connect(Some(TIMEOUT))
            .timeout_send_request(Some(TIMEOUT))
            .timeout_recv_response(Some(TIMEOUT))
            .timeout_send_body(Some(BODY_TIMEOUT))
            .timeout_recv_body(Some(BODY_TIMEOUT))
            .http_status_as_error(false)
            .build()
            .into();
        self.reads = Reads::World;
        self
    }

    /// This store for an operator's tool that copies whole objects (`world-aside`): reads of any size up to
    /// `read_limit` bytes and `timeout` per request, where every other program keeps ureq's 10 MiB cap and
    /// [`TIMEOUT`]. A world's stream-recovery objects pass 10 MiB.
    pub fn for_operator(mut self, read_limit: u64, timeout: Duration) -> S3 {
        // Each phase on its own bound: a store that stalls mid-answer is given up on and the caller tries again,
        // rather than one request holding the whole `timeout` (0.132.1: a bucket over IPv6 that stalls 30 s and more).
        let phase = Some(timeout.min(OPERATOR_PHASE));
        self.agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .timeout_resolve(phase)
            .timeout_connect(phase)
            .timeout_send_request(phase)
            .timeout_recv_response(phase)
            .http_status_as_error(false)
            .build()
            .into();
        self.reads = Reads::Limit(read_limit);
        self
    }

    /// This store for `store-probe` (0.133), which measures the link itself: one bound, `timeout`, on each whole request
    /// and no bound per phase, so a stall shows as its own length up to `timeout`; reads of whole objects up to
    /// `read_limit` bytes.
    pub fn for_probe(mut self, read_limit: u64, timeout: Duration) -> S3 {
        self.agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            .build()
            .into();
        self.reads = Reads::Limit(read_limit);
        self
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
        self.sign_with(method, path, query, payload, &[])
    }

    /// [`S3::sign_query`] with `extra` headers (lowercase `x-amz-*` names) signed too, as SigV4 asks of every
    /// `x-amz-*` header a request sends (CopyObject's `x-amz-copy-source`).
    fn sign_with(
        &self,
        method: &str,
        path: &str,
        query: &str,
        payload: &[u8],
        extra: &[(&str, &str)],
    ) -> [(&'static str, String); 3] {
        let (date, stamp) = now();
        let body = to_hex(digest::digest(&digest::SHA256, payload).as_ref());
        let mut headers: Vec<(&str, &str)> = vec![
            ("host", self.host.as_str()),
            ("x-amz-content-sha256", body.as_str()),
            ("x-amz-date", stamp.as_str()),
        ];
        headers.extend_from_slice(extra);
        headers.sort();
        let signed = headers
            .iter()
            .map(|(k, _)| *k)
            .collect::<Vec<_>>()
            .join(";");
        let lines: String = headers.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
        let canonical = format!("{method}\n{path}\n{query}\n{lines}\n{signed}\n{body}");
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

    /// Sends a read (`GET` or `HEAD` of `path`, with `query`), signed afresh for each try. A directory's or a world's
    /// read whose answer's head has not come within [`HEDGE`] is given up on and sent once more, on another
    /// connection (ureq drops the one that timed out), with what is left of [`TIMEOUT`]: the bucket's stalls are one
    /// request's, not the link's ([`HEDGE`]). Any other failure, and a second try's, is the store out of reach, as
    /// before; a store that does not answer at all is still found within [`TIMEOUT`].
    fn read(
        &self,
        method: &str,
        path: &str,
        query: &str,
        what: &str,
    ) -> R<ureq::http::Response<ureq::Body>> {
        let url = match query {
            "" => format!("{}{path}", self.endpoint),
            q => format!("{}{path}?{q}", self.endpoint),
        };
        let hedged = !matches!(self.reads, Reads::Limit(_));
        // `second`: whether this is the try sent once the first went unanswered for [`HEDGE`].
        let send = |second: bool| {
            let mut req = match method {
                "HEAD" => self.agent.head(&url),
                _ => self.agent.get(&url),
            };
            for (k, v) in self.sign_query(method, path, query, b"") {
                req = req.header(k, v);
            }
            let rest = TIMEOUT.saturating_sub(HEDGE);
            match (hedged, second, self.reads) {
                (false, _, _) => req.call(),
                (true, false, _) => req
                    .config()
                    .timeout_recv_response(Some(HEDGE))
                    .build()
                    .call(),
                // The directory's client bounds each whole request ([`S3::new`]): the second try has the rest of it.
                (true, true, Reads::Capped) => {
                    req.config().timeout_global(Some(rest)).build().call()
                }
                (true, true, _) => req
                    .config()
                    .timeout_recv_response(Some(rest))
                    .build()
                    .call(),
            }
        };
        match send(false) {
            Err(ureq::Error::Timeout(ureq::Timeout::RecvResponse)) if hedged => {
                send(true).or_else(|e| unreachable(what, e))
            }
            answered => answered.or_else(|e| unreachable(what, e)),
        }
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

/// Sorts an answer's status into the store's refusals. R18: a rate-limited store (429, or S3's 503 Slow Down) is
/// `store-unreachable`, so it is tried again as any 5xx is; its `Retry-After` in seconds, when it gives one, goes in
/// the detail as `retry after <s> s` for the caller's wait ([`super::store::retry_after`]).
fn status(res: &ureq::http::Response<ureq::Body>, what: &str) -> R<()> {
    let code = res.status().as_u16();
    match code {
        200..=299 => Ok(()),
        // 412: the condition failed; 409: another conditional write to the key is in flight (S3 asks for a retry);
        // 404 on a write: `If-Match` named a key that is gone.
        404 | 409 | 412 => refuse("precondition-failed", format!("{what}: HTTP {code}")),
        429 | 500..=599 => {
            // Seconds only: an HTTP date is passed over, and the caller's own waits apply.
            let after = res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok());
            let detail = match after {
                Some(s) => format!("{what}: HTTP {code}, retry after {s} s"),
                None => format!("{what}: HTTP {code}"),
            };
            refuse("store-unreachable", detail)
        }
        _ => refuse("store-error", format!("{what}: HTTP {code}")),
    }
}

fn unreachable(what: &str, e: ureq::Error) -> R<ureq::http::Response<ureq::Body>> {
    refuse("store-unreachable", format!("{what}: {e}"))
}

impl Store for S3 {
    fn get(&self, key: &str) -> R<Option<Object>> {
        let mut res = self.read("GET", &self.path(key), "", key)?;
        if res.status().as_u16() == 404 {
            return Ok(None);
        }
        status(&res, key)?;
        let etag = etag(&res, key)?;
        let body = res.body_mut();
        let bytes = match self.reads {
            Reads::World => body.with_config().limit(WORLD_READ_LIMIT).read_to_vec(),
            Reads::Limit(n) => body.with_config().limit(n).read_to_vec(),
            Reads::Capped => body.read_to_vec(),
        }
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
        if matches!(self.reads, Reads::World) {
            req = req
                .config()
                .timeout_recv_response(Some(answer_within(bytes.len())))
                .build();
        }
        let answered = req
            .send(bytes)
            .or_else(|e| unreachable(key, e))
            .and_then(|res| status(&res, key).map(|()| res));
        match answered {
            Ok(res) => etag(&res, key),
            // A create-only write the store may have applied, though its answer was a 5xx or never came (#4014).
            Err(e) if e.name == "store-unreachable" && when == When::Absent => {
                self.read_back(key, bytes, e)
            }
            Err(e) => Err(e),
        }
    }

    /// HeadObject: the object's length and ETag, with no body.
    fn head(&self, key: &str) -> R<Option<(u64, String)>> {
        let res = self.read("HEAD", &self.path(key), "", key)?;
        if res.status().as_u16() == 404 {
            return Ok(None);
        }
        status(&res, key)?;
        let len = res
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        let Some(len) = len else {
            return refuse("store-error", format!("{key}: the answer has no length"));
        };
        Ok(Some((len, etag(&res, key)?)))
    }

    /// CopyObject: the bucket copies `from` to `to` itself, so no byte of the object passes through this machine. An
    /// error the store reports in the body of a 200 (as S3 may for a long copy) is a refusal.
    fn copy(&self, from: &str, to: &str) -> R<String> {
        let (path, source) = (self.path(to), self.path(from));
        let mut req = self.agent.put(format!("{}{path}", self.endpoint));
        for (k, v) in self.sign_with("PUT", &path, "", b"", &[("x-amz-copy-source", &source)]) {
            req = req.header(k, v);
        }
        let mut res = req
            .header("x-amz-copy-source", &source)
            .send_empty()
            .or_else(|e| unreachable(to, e))?;
        status(&res, to)?;
        let xml = res
            .body_mut()
            .read_to_string()
            .or_else(|e| refuse("store-unreachable", format!("{to}: {e}")))?;
        if xml.contains("<Error>") {
            return refuse(
                "store-unreachable",
                format!("{to}: the copy failed in the store"),
            );
        }
        let etag = xml
            .split_once("<ETag>")
            .and_then(|(_, r)| r.split_once("</ETag>"))
            .map(|(e, _)| e.replace("&quot;", "").trim_matches('"').to_owned())
            .unwrap_or_default();
        Ok(etag)
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
            _ => status(&res, key),
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
            let mut res = self.read("GET", &path, &query, prefix)?;
            status(&res, prefix)?;
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
