//! What the program starts with, and what it refuses to start with (W1). The sign-in for local and test worlds signs
//! a named test person in with no provider; with it on, the program refuses a public address (`https://`, or a host
//! that is not loopback, for the page or for the listener) and refuses the real provider beside it, as today's server
//! does (`DEV_AUTH=1` with a public `PUBLIC_URL`, `apps/server/src/auth.ts`).

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

/// The issuer recorded for a test person: never a provider's, so a test account cannot be a real one.
pub const TEST_ISSUER: &str = "test:local";

/// The real provider: its issuer (an `https` origin) and the origins its tokens may be made for (`azp`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Provider {
    pub issuer: String,
    pub parties: Vec<String>,
}

impl Provider {
    pub fn jwks_url(&self) -> String {
        format!("{}/.well-known/jwks.json", self.issuer)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub listen: SocketAddr,
    pub public_url: String,
    pub store: PathBuf,
    pub provider: Option<Provider>,
    pub test_sign_in: bool,
    /// The file holding the key the gateway reads and closes the mailbox with (R13); without it those requests are off.
    pub mailbox_key: Option<PathBuf>,
    /// Pairing's store (W2), and the gateway's tokens file it writes; pairing is off without the store.
    pub pairing: Option<PathBuf>,
    pub gateway_tokens: Option<PathBuf>,
}

pub const USAGE: &str = "directoryd --listen <addr:port> --public-url <origin> --store <absolute path> \
(--issuer <https origin> --parties <origin,origin> | --test-sign-in) [--pairing <path> [--gateway-tokens <path>]] \
[--mailbox-key <file>]";

/// Reads the arguments (without the program's name) and refuses what must not run. A refusal starts with
/// "refusing to start".
pub fn parse(args: &[String]) -> Result<Config, String> {
    let mut listen = None;
    let mut public_url = None;
    let mut store = None;
    let mut issuer = None;
    let mut parties = None;
    let mut test_sign_in = false;
    let mut mailbox_key = None;
    let (mut pairing, mut gateway_tokens) = (None, None);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut value = || {
            it.next()
                .cloned()
                .ok_or(format!("refusing to start: {a} needs a value; {USAGE}"))
        };
        match a.as_str() {
            "--listen" => listen = Some(value()?),
            "--public-url" => public_url = Some(value()?),
            "--store" => store = Some(PathBuf::from(value()?)),
            "--issuer" => issuer = Some(value()?),
            "--parties" => parties = Some(value()?),
            "--test-sign-in" => test_sign_in = true,
            "--mailbox-key" => mailbox_key = Some(PathBuf::from(value()?)),
            "--pairing" => pairing = Some(PathBuf::from(value()?)),
            "--gateway-tokens" => gateway_tokens = Some(PathBuf::from(value()?)),
            _ => return Err(format!("refusing to start: unknown argument {a}; {USAGE}")),
        }
    }
    let refuse = |why: &str| Err(format!("refusing to start: {why}"));
    let (Some(listen), Some(public_url), Some(store)) = (listen, public_url, store) else {
        return refuse(&format!(
            "--listen, --public-url and --store are needed; {USAGE}"
        ));
    };
    let listen: SocketAddr = listen
        .parse()
        .map_err(|_| "refusing to start: --listen is an address and port".to_string())?;
    if !store.is_absolute() {
        return refuse("--store is an absolute path");
    }
    let page = origin(&public_url).ok_or_else(|| {
        "refusing to start: --public-url is an http or https origin with no path".to_string()
    })?;
    let provider = match (issuer, parties) {
        (None, None) => None,
        (Some(issuer), Some(parties)) => {
            if !issuer.starts_with("https://") || origin(&issuer).as_deref() != Some(&issuer) {
                return refuse("--issuer is an https origin with no path");
            }
            let parties: Vec<String> = parties.split(',').map(|p| p.trim().to_string()).collect();
            if parties
                .iter()
                .any(|p| origin(p).as_deref() != Some(p.as_str()))
            {
                return refuse("--parties holds bare origins only");
            }
            if !parties.contains(&page) {
                return refuse("--parties includes the origin of --public-url");
            }
            Some(Provider { issuer, parties })
        }
        _ => return refuse("--issuer and --parties go together"),
    };
    if test_sign_in {
        if provider.is_some() {
            return refuse("--test-sign-in with the real provider (--issuer)");
        }
        if public_url.starts_with("https://") {
            return refuse("--test-sign-in with a public https --public-url");
        }
        if !loopback_host(host(&page)) {
            return refuse("--test-sign-in with a --public-url that is not loopback");
        }
        if !listen.ip().is_loopback() {
            return refuse("--test-sign-in listening on an address that is not loopback");
        }
    } else if provider.is_none() {
        return refuse("no sign-in: give --issuer and --parties, or --test-sign-in on loopback");
    }
    Ok(Config {
        listen,
        public_url,
        store,
        provider,
        test_sign_in,
        mailbox_key,
        pairing,
        gateway_tokens,
    })
}

/// `scheme://host[:port]` of an http or https URL with no path, query or fragment beyond a single `/`.
fn origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.is_empty() || rest.contains(['/', '?', '#', '@']) {
        return None;
    }
    Some(format!("{scheme}://{rest}"))
}

fn host(origin: &str) -> &str {
    let rest = origin.split_once("://").map_or(origin, |(_, r)| r);
    if let Some(v6) = rest.strip_prefix('[') {
        return v6.split(']').next().unwrap_or("");
    }
    rest.rsplit_once(':').map_or(rest, |(h, _)| h)
}

fn loopback_host(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}
