//! A local S3 stand-in for tests (O3c, #3529): an HTTP server on `127.0.0.1` that answers the four calls
//! [`super::s3::S3`] makes, GET and PUT of one object (with `If-None-Match: *` and `If-Match`) and ListObjectsV2 by
//! prefix, page by page. It refuses a request that is not signed with its key id or whose body hash does not match
//! (403). It never stands for the production bucket: it holds its objects in memory and is gone when dropped.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use replica::encode::to_hex;
use ring::digest;

/// The stand-in's key id; its secret is never checked, as only the real store holds one.
pub const KEY_ID: &str = "stand-in-key";

type Objects = Arc<Mutex<BTreeMap<String, (String, Vec<u8>)>>>;

/// A running stand-in. Its address is [`StandIn::url`]; its threads end with the test process.
pub struct StandIn {
    port: u16,
    objects: Objects,
}

impl StandIn {
    /// A stand-in on a free port, listing at most `page` keys per answer (so a listing takes several pages).
    pub fn start(page: usize) -> std::io::Result<StandIn> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let objects: Objects = Arc::default();
        let shared = objects.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let objects = shared.clone();
                std::thread::spawn(move || serve(stream, &objects, page.max(1)));
            }
        });
        Ok(StandIn { port, objects })
    }

    /// The bucket's URL in the offsite form: `s3:http://127.0.0.1:<port>/<bucket>[/<prefix>]`.
    pub fn url(&self, bucket: &str) -> String {
        format!("s3:http://127.0.0.1:{}/{bucket}", self.port)
    }

    /// Every object's path (`<bucket>/<key>`), in order.
    pub fn paths(&self) -> Vec<String> {
        self.objects
            .lock()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default()
    }
}

/// Answers one connection's requests until it closes.
fn serve(stream: TcpStream, objects: &Objects, page: usize) {
    let Ok(mut out) = stream.try_clone() else {
        return;
    };
    let mut r = BufReader::new(stream);
    loop {
        let mut line = String::new();
        if r.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let mut head = BTreeMap::new();
        loop {
            let mut h = String::new();
            if r.read_line(&mut h).unwrap_or(0) == 0 {
                return;
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                head.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
            }
        }
        let len = head
            .get("content-length")
            .and_then(|l| l.parse().ok())
            .unwrap_or(0);
        let mut body = vec![0; len];
        if r.read_exact(&mut body).is_err() {
            return;
        }
        let mut parts = line.split_whitespace();
        let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let (code, etag, answer) = answer(method, target, &head, &body, objects, page);
        let mut res = format!("HTTP/1.1 {code} X\r\ncontent-length: {}\r\n", answer.len());
        if let Some(e) = etag {
            res.push_str(&format!("etag: \"{e}\"\r\n"));
        }
        res.push_str("\r\n");
        if out.write_all(res.as_bytes()).is_err() || out.write_all(&answer).is_err() {
            return;
        }
    }
}

fn answer(
    method: &str,
    target: &str,
    head: &BTreeMap<String, String>,
    body: &[u8],
    objects: &Objects,
    page: usize,
) -> (u16, Option<String>, Vec<u8>) {
    let hash = to_hex(digest::digest(&digest::SHA256, body).as_ref());
    let signed = head.get("authorization").is_some_and(|a| {
        a.starts_with(&format!("AWS4-HMAC-SHA256 Credential={KEY_ID}/")) && a.contains("Signature=")
    });
    if !signed || head.get("x-amz-content-sha256") != Some(&hash) {
        return (
            403,
            None,
            b"<Error><Code>AccessDenied</Code></Error>".to_vec(),
        );
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let path = decode(path.trim_start_matches('/'));
    let Ok(mut objects) = objects.lock() else {
        return (500, None, Vec::new());
    };
    match method {
        "GET" if !query.is_empty() => {
            let q: BTreeMap<&str, String> = query
                .split('&')
                .filter_map(|p| p.split_once('='))
                .map(|(k, v)| (k, decode(v)))
                .collect();
            let prefix = format!("{path}/{}", q.get("prefix").cloned().unwrap_or_default());
            let after = q.get("continuation-token").cloned().unwrap_or_default();
            let keys: Vec<&String> = objects
                .keys()
                .filter(|k| k.starts_with(&prefix) && **k > after)
                .collect();
            let shown = &keys[..keys.len().min(page)];
            let mut xml = String::from("<ListBucketResult>");
            for k in shown {
                let key = k.split_once('/').map_or("", |(_, key)| key);
                xml.push_str(&format!("<Contents><Key>{}</Key></Contents>", escape(key)));
            }
            if keys.len() > page {
                let last = shown.last().map_or(String::new(), |k| escape(k));
                xml.push_str(&format!(
                    "<IsTruncated>true</IsTruncated><NextContinuationToken>{last}</NextContinuationToken>"
                ));
            } else {
                xml.push_str("<IsTruncated>false</IsTruncated>");
            }
            xml.push_str("</ListBucketResult>");
            (200, None, xml.into_bytes())
        }
        "GET" => match objects.get(&path) {
            Some((e, b)) => (200, Some(e.clone()), b.clone()),
            None => (404, None, Vec::new()),
        },
        "PUT" => {
            let now = objects.get(&path).map(|o| o.0.clone());
            let ok = match (head.get("if-none-match"), head.get("if-match")) {
                (Some(_), _) => now.is_none(),
                (None, Some(e)) => {
                    if now.is_none() {
                        return (404, None, Vec::new());
                    }
                    now.as_deref() == Some(e.trim_matches('"'))
                }
                (None, None) => true,
            };
            if !ok {
                return (412, None, Vec::new());
            }
            objects.insert(path, (hash.clone(), body.to_vec()));
            (200, Some(hash), Vec::new())
        }
        _ => (405, None, Vec::new()),
    }
}

/// Percent-decoding.
fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = b
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (b[i], hex) {
            (b'%', Some(v)) => {
                out.push(v);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
