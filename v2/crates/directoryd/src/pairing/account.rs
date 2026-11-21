//! Account connections (W15): private, revocable computer grants; Soul tokens and memories are independent.
use super::{Pairing, is_name, is_soul_grant};
use crate::accounts::serve::{App, now};
use crate::accounts::{b64url, random, view::follow_of};
use replica::{encode::to_hex, ids::sha256};
use ring::hmac;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS agent_login_requests_v1(
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL, device_name TEXT NOT NULL, label TEXT NOT NULL,
 secret_hash TEXT NOT NULL, idem_hash TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, nonce TEXT NOT NULL,
 created INTEGER NOT NULL, state TEXT NOT NULL, account TEXT, grant_id TEXT, ended TEXT);
CREATE TABLE IF NOT EXISTS agent_logins_v1(
 id TEXT PRIMARY KEY, account TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT NOT NULL,
 label TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER, token_hash TEXT UNIQUE, ended TEXT);
CREATE TABLE IF NOT EXISTS agent_pair_deliveries_v1(
 login TEXT NOT NULL, idem_hash TEXT NOT NULL, input_hash TEXT NOT NULL, grant_text TEXT NOT NULL,
 PRIMARY KEY(login,idem_hash));";

type Result<T> = std::result::Result<T, &'static str>;
fn sql<T>(r: rusqlite::Result<T>) -> Result<T> {
    r.map_err(|_| "store")
}
fn text<'a>(b: &'a Value, k: &str) -> Result<&'a str> {
    b[k].as_str().ok_or("request")
}
fn id(prefix: &str) -> String {
    format!("{prefix}{}", to_hex(&random::<16>()))
}
fn secret(s: &str) -> bool {
    s.len() == 43
        && crate::accounts::from_b64url(s).is_some_and(|v| v.len() == 32 && b64url(&v) == s)
}
fn hash(s: &str) -> String {
    to_hex(&sha256(s.as_bytes()))
}
fn confirm(id: &str) -> String {
    const ABC: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    sha256(id.as_bytes())[..4]
        .iter()
        .map(|b| ABC[usize::from(*b) % ABC.len()] as char)
        .collect()
}
#[derive(Clone)]
struct Request {
    id: String,
    device: String,
    name: String,
    label: String,
    secret: String,
    input: String,
    nonce: String,
    created: u64,
    state: String,
    account: Option<String>,
    grant: Option<String>,
    ended: Option<String>,
}
impl Request {
    fn dto(&self) -> Value {
        json!({"id":self.id,"kind":"login","status":self.state,
        "agentLabel":self.label,"device":{"name":self.name},"confirm":confirm(&self.id),
        "createdAt":self.created * 1000,"inWindow":false,"soul":null,"ended":self.ended})
    }
}
#[derive(Clone)]
struct Login {
    id: String,
    account: String,
    name: String,
    label: String,
}
impl Pairing {
    fn login_request(&self, id: &str) -> Result<Request> {
        sql(self.db.lock().expect("the store").query_row(
            "SELECT id,device_id,device_name,label,secret_hash,input_hash,nonce,created,state,account,grant_id,ended FROM agent_login_requests_v1 WHERE id=?1",
            params![id], |r| Ok(Request { id:r.get(0)?,device:r.get(1)?,name:r.get(2)?,label:r.get(3)?,secret:r.get(4)?,input:r.get(5)?,nonce:r.get(6)?,created:r.get::<_,i64>(7)? as u64,state:r.get(8)?,account:r.get(9)?,grant:r.get(10)?,ended:r.get(11)? })).optional())?.ok_or("not-found")
    }
    fn start_login(&self, b: &Value, at: u64) -> Result<Request> {
        let device = text(&b["device"], "id")?;
        let name = text(&b["device"], "name")?;
        let label = text(b, "agentLabel")?;
        let poll = text(b, "pollSecret")?;
        let idem = text(b, "idempotencyKey")?;
        if !device.strip_prefix("dev_").is_some_and(|s| {
            s.len() == 32
                && s.bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        }) || !is_name(name)
            || name.chars().count() > 60
            || !(1..=120).contains(&label.chars().count())
            || label.chars().any(char::is_control)
            || !secret(poll)
            || !(16..=256).contains(&idem.len())
        {
            return Err("request");
        }
        let input = hash(&json!([device, name, label]).to_string());
        let previous: Option<String> = sql(self
            .db
            .lock()
            .expect("the store")
            .query_row(
                "SELECT id FROM agent_login_requests_v1 WHERE idem_hash=?1",
                params![hash(idem)],
                |r| r.get(0),
            )
            .optional())?;
        if let Some(id) = previous {
            let r = self.login_request(&id)?;
            if r.secret != hash(poll) {
                return Err("poll-secret");
            }
            if r.input != input {
                return Err("idempotency-conflict");
            }
            return Ok(r);
        }
        let request = id("aq_");
        {
            let mut db = self.db.lock().expect("the store");
            let tx = sql(db.transaction())?;
            sql(tx.execute("UPDATE agent_login_requests_v1 SET state='cancelled',ended='replaced' WHERE device_id=?1 AND state='pending'",params![device]))?;
            sql(tx.execute("INSERT INTO agent_login_requests_v1(id,device_id,device_name,label,secret_hash,idem_hash,input_hash,nonce,created,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'pending')",params![request,device,name,label,hash(poll),hash(idem),input,id("an_"),at as i64]))?;
            sql(tx.commit())?;
        }
        self.login_request(&request)
    }
    fn addressed(&self, id: &str, account: &str) -> Result<Request> {
        let r = self.login_request(id)?;
        if r.account.as_deref().is_some_and(|a| a != account) {
            return Err("not-yours");
        }
        Ok(r)
    }
    fn approve_login(&self, request: &str, account: &str, at: u64) -> Result<Request> {
        let r = self.addressed(request, account)?;
        if r.state != "pending" {
            return Ok(r);
        }
        {
            let mut db = self.db.lock().expect("the store");
            let tx = sql(db.transaction())?;
            // Re-read under the writer lock: only one approver can claim a request.
            let state: String = sql(tx.query_row(
                "SELECT state FROM agent_login_requests_v1 WHERE id=?1",
                params![request],
                |r| r.get(0),
            ))?;
            if state == "pending" {
                let grant = id("ag_");
                sql(tx.execute("UPDATE agent_logins_v1 SET ended='replaced' WHERE account=?1 AND device_id=?2 AND ended IS NULL",params![account,r.device]))?;
                sql(tx.execute("INSERT INTO agent_logins_v1(id,account,device_id,device_name,label,created) VALUES(?1,?2,?3,?4,?5,?6)",params![grant,account,r.device,r.name,r.label,at as i64]))?;
                sql(tx.execute("UPDATE agent_login_requests_v1 SET state='ready',account=?2,grant_id=?3 WHERE id=?1 AND state='pending'",params![request,account,grant]))?;
            }
            sql(tx.commit())?;
        }
        self.addressed(request, account)
    }
    fn cancel_login(&self, r: &Request, ended: &str) -> Result<Value> {
        if r.state == "ready" {
            return Err("cannot-cancel");
        }
        sql(self.db.lock().expect("the store").execute("UPDATE agent_login_requests_v1 SET state='cancelled',ended=?2 WHERE id=?1 AND state='pending'",params![r.id,ended]))?;
        Ok(json!({"request":self.login_request(&r.id)?.dto()}))
    }
    fn poll_login(&self, b: &Value) -> Result<Value> {
        let poll = text(b, "pollSecret")?;
        let r = self.login_request(text(b, "requestId")?)?;
        if !secret(poll) || r.secret != hash(poll) {
            return Err("poll-secret");
        }
        let mut out = json!({"request":r.dto()});
        if r.state != "ready" {
            return Ok(out);
        }
        let grant = r.grant.as_deref().ok_or("store")?;
        let account = r.account.as_deref().ok_or("store")?;
        let token = format!(
            "sacct_{}",
            b64url(
                hmac::sign(
                    &hmac::Key::new(hmac::HMAC_SHA256, poll.as_bytes()),
                    json!(["soul-account-grant/1", grant, r.nonce])
                        .to_string()
                        .as_bytes()
                )
                .as_ref()
            )
        );
        let db = self.db.lock().expect("the store");
        let live: bool = sql(db.query_row("SELECT EXISTS(SELECT 1 FROM agent_logins_v1 WHERE id=?1 AND account=?2 AND ended IS NULL)",params![grant,account],|r|r.get(0)))?;
        if !live {
            return Ok(out);
        }
        sql(db.execute("UPDATE agent_logins_v1 SET token_hash=?2 WHERE id=?1 AND token_hash IS NULL AND ended IS NULL",params![grant,hash(&token)]))?;
        out["token"] = json!(token);
        out["account"] = json!({"id":account});
        out["grant"] = json!({"id":grant,"createdAt":r.created*1000});
        Ok(out)
    }
    fn login(&self, token: Option<&str>, at: u64) -> Result<Login> {
        let token = token
            .filter(|s| s.starts_with("sacct_") && s.len() <= 256)
            .ok_or("account.unknown")?;
        let db = self.db.lock().expect("the store");
        let found = sql(db.query_row("SELECT id,account,device_name,label,ended FROM agent_logins_v1 WHERE token_hash=?1",params![hash(token)],|r| Ok((Login{id:r.get(0)?,account:r.get(1)?,name:r.get(2)?,label:r.get(3)?},r.get::<_,Option<String>>(4)?))).optional())?.ok_or("account.unknown")?;
        if found.1.is_some() {
            return Err("account.revoked");
        }
        sql(db.execute("UPDATE agent_logins_v1 SET last_used=?2 WHERE id=?1 AND (last_used IS NULL OR last_used<=?2-30)",params![found.0.id,at as i64]))?;
        Ok(found.0)
    }
    fn agents(&self, account: &str) -> Result<Value> {
        let db = self.db.lock().expect("the store");
        let mut q = sql(db.prepare("SELECT id,label,device_name,created,last_used FROM agent_logins_v1 WHERE account=?1 AND ended IS NULL ORDER BY created DESC,id"))?;
        let rows = sql(q.query_map(params![account],|r| Ok(json!({"id":r.get::<_,String>(0)?,"agentLabel":r.get::<_,String>(1)?,"device":{"name":r.get::<_,String>(2)?},"createdAt":r.get::<_,i64>(3)?*1000,"lastUsedAt":r.get::<_,Option<i64>>(4)?.map(|n|n*1000)}))))?;
        Ok(json!({"agents":sql(rows.collect::<rusqlite::Result<Vec<_>>>())?}))
    }
    fn end_login(&self, account: &str, grant: &str, reason: &str) -> Result<Value> {
        let changed = sql(self.db.lock().expect("the store").execute(
            "UPDATE agent_logins_v1 SET ended=?3 WHERE account=?1 AND id=?2",
            params![account, grant, reason],
        ))?;
        if changed == 0 {
            return Err("not-found");
        }
        // Soul tokens and memories are deliberately independent of the account connection.
        Ok(json!({"ok":true}))
    }
    fn account_souls(&self, store: &crate::accounts::store::Store, account: &str) -> Result<Value> {
        let rows = self
            .mine_with_imports(store, account)?
            .iter()
            .map(|m| {
                let world = m
                    .world
                    .as_deref()
                    .and_then(|w| self.authority(Some(w)).ok().flatten())
                    .map(|a| a.world)
                    .or_else(|| m.world.clone());
                json!({"id":m.soul,"name":m.name,"world":world,"device":m.device})
            })
            .collect::<Vec<_>>();
        Ok(Value::Array(rows))
    }
    // An unpaired import is only a candidate: no database or lifecycle file changes before live-session checks.
    fn existing_import(
        &self,
        store: &crate::accounts::store::Store,
        login: &Login,
        b: &Value,
    ) -> Result<Option<(String, String, String)>> {
        if b["new"].as_bool() == Some(true) {
            return Ok(None);
        }
        let grant = text(b, "soul")?;
        if self.soul_of(grant)?.is_some() {
            return Ok(None);
        }
        let selected = self
            .authority(Some(text(b, "world")?))?
            .ok_or("world-authority-unavailable")?;
        let rows = store.imported_souls(&login.account).map_err(|_| "store")?;
        let (_, world, name, description) = rows
            .into_iter()
            .find(|(g, _, _, _)| g == grant)
            .ok_or("not-yours")?;
        if self
            .authority(Some(&world))?
            .is_none_or(|a| a.world != selected.world)
        {
            return Err("soul-in-another-world");
        }
        Ok(Some((world, name, description)))
    }
    fn account_pair(
        &self,
        login: &Login,
        b: &Value,
        credential: &str,
        imported: Option<&(String, String, String)>,
    ) -> std::result::Result<(String, String), (&'static str, Option<String>)> {
        let err = |e| (e, None);
        let world = text(b, "world").map_err(err)?;
        let authority = self
            .authority(Some(world))
            .map_err(err)?
            .ok_or_else(|| err("world-authority-unavailable"))?;
        let key = text(b, "idempotencyKey").map_err(err)?;
        if !(16..=256).contains(&key.len()) {
            return Err(err("request"));
        }
        let input = hash(&json!([authority.world, b["new"], b["soul"], b["move"]]).to_string());
        let token_for = |grant: &str| {
            format!(
                "{grant}.{}",
                to_hex(
                    hmac::sign(
                        &hmac::Key::new(hmac::HMAC_SHA256, credential.as_bytes()),
                        json!(["soul-account-pair/1", login.id, key, grant])
                            .to_string()
                            .as_bytes()
                    )
                    .as_ref()
                )
            )
        };
        let previous: Option<(String,String)> = sql(self.db.lock().expect("the store").query_row(
            "SELECT input_hash,grant_text FROM agent_pair_deliveries_v1 WHERE login=?1 AND idem_hash=?2",
            params![login.id,hash(key)],|r|Ok((r.get(0)?,r.get(1)?))).optional()).map_err(err)?;
        if let Some((previous, grant)) = previous {
            if previous != input {
                return Err(err("idempotency-conflict"));
            }
            let token = token_for(&grant);
            let current: bool = sql(self.db.lock().expect("the store").query_row(
                "SELECT EXISTS(SELECT 1 FROM paired_world_tokens_v1 t JOIN paired_souls_v1 s USING(grant_text)
                 JOIN soul_profiles_v1 p USING(grant_text) JOIN agent_logins_v1 a ON a.id=?1
                 WHERE t.grant_text=?2 AND t.world=?3 AND t.token_hash=?4 AND s.account=?5
                 AND p.retired_at IS NULL AND a.account=?5 AND a.ended IS NULL)",
                params![login.id,grant,authority.world,hash(&token),login.account],|r|r.get(0))).map_err(err)?;
            return if current {
                Ok((grant, token))
            } else {
                Err(err("pair-superseded"))
            };
        }

        let fresh = b["new"].as_bool() == Some(true);
        let grant = if fresh {
            if b.get("soul").is_some() {
                return Err(err("request"));
            }
            format!("soul-{}-0", to_hex(&random::<16>()))
        } else {
            text(b, "soul").map_err(err)?.to_owned()
        };
        if !is_soul_grant(&grant) {
            return Err(err("not-a-soul"));
        }
        let force = b["move"].as_bool() == Some(true);
        let validate = || -> Result<(Option<String>, Option<String>)> {
            if fresh {
                return if self.at_soul_cap(&login.account)? {
                    Err("too-many")
                } else {
                    Ok((None, None))
                };
            }
            match self.soul_of(&grant)? {
                Some((a, _)) if a == login.account => {}
                None if imported.is_some() => {}
                _ => return Err("not-yours"),
            }
            if self.retired(&grant)? {
                return Err("soul-retired");
            }
            let db = self.db.lock().expect("the store");
            let previous: Option<String> = sql(db
                .query_row(
                    "SELECT world FROM soul_profiles_v1 WHERE grant_text=?1",
                    params![grant],
                    |r| r.get(0),
                )
                .optional())?
            .flatten()
            .or_else(|| imported.map(|i| i.0.clone()));
            drop(db);
            if previous
                .as_deref()
                .and_then(|w| self.authority(Some(w)).ok().flatten())
                .is_none_or(|a| a.world != authority.world)
            {
                return Err("soul-in-another-world");
            }
            let device = sql(self
                .db
                .lock()
                .expect("the store")
                .query_row(
                    "SELECT device FROM paired_world_tokens_v1 WHERE grant_text=?1 AND world=?2",
                    params![grant, authority.world],
                    |r| r.get(0),
                )
                .optional())?;
            Ok((device, previous))
        };
        // Approval and pre-mint checks both use the actual gateway session, outside the database lock.
        // This is a check-to-mint race, as today's control lookup is; it is not an atomic distributed acquisition.
        let mut expected_world = None;
        for _ in 0..2 {
            let (device, previous) = validate().map_err(err)?;
            expected_world = previous;
            let connected = authority.connected(&grant).map_err(err)?;
            if connected && !force {
                return Err(("soul-connected", device));
            }
        }
        let token = token_for(&grant);
        let mut db = self.db.lock().expect("the store");
        let tx = sql(db.transaction()).map_err(err)?;
        let live: bool = sql(tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_logins_v1 WHERE id=?1 AND account=?2 AND ended IS NULL)",params![login.id,login.account],|r|r.get(0))).map_err(err)?;
        if !live {
            return Err(err("account.revoked"));
        }
        if fresh {
            sql(tx.execute(
                "INSERT INTO paired_souls_v1(grant_text,account) VALUES(?1,?2)",
                params![grant, login.account],
            ))
            .map_err(err)?;
            sql(tx.execute(
                "INSERT INTO soul_profiles_v1(grant_text,world) VALUES(?1,?2)",
                params![grant, world],
            ))
            .map_err(err)?;
        } else {
            if let Some((world, name, description)) = imported {
                let owner: Option<String> = sql(tx
                    .query_row(
                        "SELECT account FROM paired_souls_v1 WHERE grant_text=?1",
                        params![grant],
                        |r| r.get(0),
                    )
                    .optional())
                .map_err(err)?;
                if owner.as_deref().is_some_and(|a| a != login.account) {
                    return Err(err("not-yours"));
                }
                let profile: Option<(Option<String>, bool)> = sql(tx.query_row("SELECT world,retired_at IS NOT NULL FROM soul_profiles_v1 WHERE grant_text=?1",params![grant],|r|Ok((r.get(0)?,r.get(1)?))).optional()).map_err(err)?;
                if profile.as_ref().is_some_and(|p| p.1) {
                    return Err(err("soul-retired"));
                }
                let current_world = profile.and_then(|p| p.0).unwrap_or_else(|| world.clone());
                if Some(&current_world) != expected_world.as_ref() {
                    return Err(err("soul-in-another-world"));
                }
                sql(tx.execute(
                    "INSERT OR IGNORE INTO paired_souls_v1(grant_text,account) VALUES(?1,?2)",
                    params![grant, login.account],
                ))
                .map_err(err)?;
                Self::import_profile(&tx, &grant, world, name, description).map_err(err)?;
            }
            let owned: bool = sql(tx.query_row("SELECT EXISTS(SELECT 1 FROM paired_souls_v1 s JOIN soul_profiles_v1 p USING(grant_text) WHERE s.grant_text=?1 AND s.account=?2 AND p.retired_at IS NULL AND p.world=?3)",params![grant,login.account,expected_world],|r|r.get(0))).map_err(err)?;
            if !owned {
                return Err(err("not-yours"));
            }
        }
        sql(tx.execute(
            "UPDATE paired_souls_v1 SET device=?2,token_hash=?3 WHERE grant_text=?1",
            params![grant, login.name, hash(&token)],
        ))
        .map_err(err)?;
        sql(tx.execute(
            "DELETE FROM paired_world_tokens_v1 WHERE grant_text=?1",
            params![grant],
        ))
        .map_err(err)?;
        sql(tx.execute("INSERT INTO paired_world_tokens_v1(grant_text,world,device,token_hash) VALUES(?1,?2,?3,?4)",params![grant,authority.world,login.name,hash(&token)])).map_err(err)?;
        sql(tx.execute("INSERT INTO agent_pair_deliveries_v1(login,idem_hash,input_hash,grant_text) VALUES(?1,?2,?3,?4)",params![login.id,hash(key),input,grant])).map_err(err)?;
        self.write_tokens(&tx).map_err(|_| err("tokens-file"))?;
        sql(tx.commit()).map_err(err)?;
        Ok((grant, token))
    }
}

pub(super) fn route(
    app: &App,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    bytes: &[u8],
) -> Option<super::route::Answer> {
    let p = app.pairing.as_ref()?;
    if !(path == "/v1/agent/account"
        || path.starts_with("/v1/agent/account/")
        || path.starts_with("/v1/account/requests/")
        || path == "/v1/account/agents"
        || path.starts_with("/v1/account/agents/"))
    {
        return None;
    }
    let b: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
    let run = || -> Result<Value> {
        if method != "POST" {
            return Err("method");
        }
        match path {
            "/v1/agent/account/login" => {
                let r = p.start_login(&b, now())?;
                Ok(
                    json!({"request":r.dto(),"approvalURL":format!("{}/pair?request={}",p.public_url,r.id),"delivery":"link","intervalSeconds":3}),
                )
            }
            "/v1/agent/account/requests/poll" => p.poll_login(&b),
            "/v1/agent/account/requests/cancel" => {
                let r = p.login_request(text(&b, "requestId")?)?;
                let s = text(&b, "pollSecret")?;
                if !secret(s) || r.secret != hash(s) {
                    return Err("poll-secret");
                }
                p.cancel_login(&r, "cancelled")
            }
            _ if path.starts_with("/v1/account/") => {
                let account = super::route::signed_in(app, bearer, &b)?;
                if path == "/v1/account/agents" {
                    return p.agents(&account);
                }
                if let Some(grant) = path
                    .strip_prefix("/v1/account/agents/")
                    .and_then(|s| s.strip_suffix("/revoke"))
                {
                    return p.end_login(&account, grant, "revoked");
                }
                let rest = path
                    .strip_prefix("/v1/account/requests/")
                    .ok_or("not-found")?;
                let (request, op) = rest.split_once('/').unwrap_or((rest, "show"));
                let r = p.addressed(request, &account)?;
                match op {
                    "show" => Ok(json!({"request":r.dto()})),
                    "approve" if b["confirm"].as_bool() == Some(true) => {
                        Ok(json!({"request":p.approve_login(request,&account,now())?.dto()}))
                    }
                    "cancel" => p.cancel_login(&r, "refused"),
                    _ => Err("confirm"),
                }
            }
            _ => {
                let login = p.login(bearer, now())?;
                match path {
                    "/v1/agent/account" => Ok(
                        json!({"account":{"id":login.account},"grant":{"id":login.id,"agentLabel":login.label,"device":{"name":login.name}},"souls":p.account_souls(&app.store,&login.account)?}),
                    ),
                    "/v1/agent/account/logout" => p.end_login(&login.account, &login.id, "logout"),
                    _ => Err("not-found"),
                }
            }
        }
    };
    let result = if method == "POST" && path == "/v1/agent/account/pair" {
        match p.login(bearer, now()) {
            Err(e) => Err((e, None)),
            Ok(login) => p
                .existing_import(&app.store, &login, &b)
                .map_err(|e| (e, None))
                .and_then(|imported| {
                    p.account_pair(&login, &b, bearer.unwrap_or_default(), imported.as_ref())
                })
                .and_then(|(grant, token)| {
                    app.store
                        .own(&login.account, &grant, follow_of(&grant).as_deref())
                        .map_err(|_| ("store", None))?;
                    p.initialize_imported_profile(&app.store, &login.account, &grant)
                        .map_err(|e| (e, None))?;
                    Ok(json!({"ok":true,"grant":grant,"token":token,"memoryTransferred":false}))
                }),
        }
    } else {
        run().map_err(|e| (e, None))
    };
    let (status, body, note) = match result {
        Ok(value) => (200, value, "account-connection"),
        Err((e, device)) => (
            if e == "method" {
                405
            } else if e.starts_with("account.") || matches!(e, "signed-out" | "poll-secret") {
                401
            } else {
                409
            },
            json!({"refused":e,"device":device}),
            e,
        ),
    };
    Some((
        status,
        "application/json",
        body.to_string(),
        note.to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        os::unix::{
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
        },
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };
    fn folder() -> std::path::PathBuf {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.local")
            .join(format!("a{}", to_hex(&random::<4>())));
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }
    fn input(device: &str) -> Value {
        json!({"agentLabel":"test agent","device":{"id":format!("dev_{device:0<32}"),"name":"new computer"},"idempotencyKey":id("idem_"),"pollSecret":b64url(&random::<32>())})
    }
    fn issued(p: &Pairing, account: &str, b: &Value) -> (String, Login) {
        let r = p.start_login(b, 100).unwrap();
        p.approve_login(&r.id, account, 101).unwrap();
        let got = p
            .poll_login(&json!({"requestId":r.id,"pollSecret":b["pollSecret"]}))
            .unwrap();
        let token = got["token"].as_str().unwrap().to_owned();
        let login = p.login(Some(&token), 102).unwrap();
        (token, login)
    }
    fn pairing(
        p: &Pairing,
        login: &Login,
        b: &Value,
    ) -> std::result::Result<(String, String), (&'static str, Option<String>)> {
        let mut b = b.clone();
        if b.get("idempotencyKey").is_none() {
            b["idempotencyKey"] = json!(id("pair_"));
        }
        p.account_pair(login, &b, "synthetic-private-account-credential", None)
    }
    #[test]
    fn login_is_idempotent_nonexpiring_account_bound_and_revocable() {
        let root = folder();
        let p = Pairing::open(&root.join("db"), None, "https://example.invalid").unwrap();
        let b = input("a");
        let r = p.start_login(&b, 100).unwrap();
        assert_eq!(p.start_login(&b, 100_000_000).unwrap().id, r.id);
        assert_eq!(p.login_request(&r.id).unwrap().state, "pending");
        let mut changed = b.clone();
        changed["agentLabel"] = json!("different");
        assert!(matches!(
            p.start_login(&changed, 100),
            Err("idempotency-conflict")
        ));
        p.approve_login(&r.id, "owner", 100_000_001).unwrap();
        assert!(matches!(
            p.approve_login(&r.id, "other", 100_000_002),
            Err("not-yours")
        ));
        let poll = json!({"requestId":r.id,"pollSecret":b["pollSecret"]});
        let first = p.poll_login(&poll).unwrap();
        assert_eq!(first, p.poll_login(&poll).unwrap());
        assert!(
            p.poll_login(&json!({"requestId":r.id,"pollSecret":b64url(&random::<32>())}))
                .is_err()
        );
        let token = first["token"].as_str().unwrap();
        let login = p.login(Some(token), 100_000_003).unwrap();
        assert_eq!(login.account, "owner");
        assert!(
            !std::fs::read(root.join("db"))
                .unwrap()
                .windows(token.len())
                .any(|v| v == token.as_bytes())
        );
        assert!(p.end_login("other", &login.id, "revoked").is_err());
        p.end_login("owner", &login.id, "revoked").unwrap();
        assert!(matches!(
            p.login(Some(token), 100_000_004),
            Err("account.revoked")
        ));
        assert!(p.poll_login(&poll).unwrap().get("token").is_none());
        let newer = input("a");
        let (second, _) = issued(&p, "owner", &newer);
        assert_ne!(token, second);
        assert!(p.login(Some(&second), 100_000_005).is_ok());
        let pending = input("b");
        let pending = p.start_login(&pending, 102).unwrap();
        p.cancel_login(&pending, "refused").unwrap();
        assert_eq!(p.login_request(&pending.id).unwrap().state, "cancelled");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn adoption_uses_live_control_without_db_lock_and_preserves_account_world_and_memory_authority()
    {
        // Cargo starts tests in the package folder. Only this subprocess changes cwd, so the complete Unix
        // address stays short under the repository's ignored scratch without racing parallel tests.
        if std::env::var_os("SOULS_W15_ACCOUNT_CHILD").is_none() {
            let status=std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact","pairing::account::tests::adoption_uses_live_control_without_db_lock_and_preserves_account_world_and_memory_authority","--nocapture"])
                .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
                .env("SOULS_W15_ACCOUNT_CHILD","1").status().unwrap();
            assert!(status.success(), "owned account-presence child failed");
            return;
        }

        let root = folder();
        let instance = format!("{}-{}-0", "01".repeat(16), "02".repeat(16));
        let world = root.join("worlds").join(&instance);
        std::fs::create_dir_all(&world).unwrap();
        std::fs::write(world.join("tokens"), "").unwrap();
        let map = root.join("map.json");
        std::fs::write(&map,json!({"format":"souls/world-authority/1","worldsRoot":root,"worlds":{"garden":{"instance":instance,"creator":format!("{}:0","03".repeat(16))}},"aliases":{"old-garden":"garden"}}).to_string()).unwrap();
        let mut p = Pairing::open(&root.join("db"), None, "https://example.invalid").unwrap();
        p.authority_file = Some(map);
        let p = Arc::new(p);
        let socket = world.join("ctl.sock");
        let cwd = std::env::current_dir().unwrap();
        let short = socket.strip_prefix(&cwd).unwrap();
        assert!(short.as_os_str().len() < 104);
        let listener = UnixListener::bind(short).unwrap();
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
        let connected = Arc::new(AtomicBool::new(false));
        let stopping = Arc::new(AtomicBool::new(false));
        let worker = {
            let p = p.clone();
            let connected = connected.clone();
            let stopping = stopping.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let mut s = stream.unwrap();
                    if stopping.load(Ordering::SeqCst) {
                        break;
                    }
                    s.set_read_timeout(Some(std::time::Duration::from_secs(1)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    std::io::Read::by_ref(&mut s)
                        .take(129)
                        .read_to_end(&mut bytes)
                        .unwrap();
                    assert!(
                        p.db.try_lock().is_ok(),
                        "presence I/O holds no database mutex"
                    );
                    assert!(bytes.starts_with(b"presence/1 soul-"));
                    s.write_all(if connected.load(Ordering::SeqCst) {
                        b"connected\n"
                    } else {
                        b"disconnected\n"
                    })
                    .unwrap();
                }
            })
        };
        let accounts = root.join("accounts");
        let imported = format!("{}:0", "04".repeat(16));
        let imported_grant = format!("soul-{}-0", "04".repeat(16));
        {
            let db = rusqlite::Connection::open(&accounts).unwrap();
            db.execute_batch("CREATE TABLE imported_souls_v1(world TEXT,old_soul TEXT,soul TEXT); CREATE TABLE souls_v1(soul TEXT,account_id TEXT,name TEXT,description TEXT);").unwrap();
            db.execute(
                "INSERT INTO imported_souls_v1 VALUES('old-garden','s_old',?1)",
                params![imported],
            )
            .unwrap();
            db.execute(
                "INSERT INTO souls_v1 VALUES(?1,'owner','Imported Soul','Imported description')",
                params![imported],
            )
            .unwrap();
        }
        let store = crate::accounts::store::Store::open(&accounts).unwrap();
        let (_, owner) = issued(&p, "owner", &input("a"));
        let (_, other) = issued(&p, "other", &input("b"));
        let adopt = json!({"world":"garden","soul":imported_grant});
        assert_eq!(p.existing_import(&store, &other, &adopt), Err("not-yours"));
        let imported_rows = p.account_souls(&store, "owner").unwrap();
        assert_eq!(imported_rows[0]["world"], "garden");
        assert_eq!(imported_rows[0]["name"], "Imported Soul");
        let candidate = p.existing_import(&store, &owner, &adopt).unwrap();
        assert!(
            p.soul_of(&imported_grant).unwrap().is_none(),
            "candidate lookup does not pair"
        );
        let mut approval = adopt.clone();
        approval["idempotencyKey"] = json!(id("import_"));
        connected.store(true, Ordering::SeqCst);
        assert_eq!(
            p.account_pair(
                &owner,
                &approval,
                "synthetic-private-account-credential",
                candidate.as_ref()
            ),
            Err(("soul-connected", None))
        );
        assert!(
            p.soul_of(&imported_grant).unwrap().is_none(),
            "refused adoption never pairs an import"
        );
        assert_eq!(
            p.db.lock()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM soul_profiles_v1 WHERE grant_text=?1",
                    params![imported_grant],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
        connected.store(false, Ordering::SeqCst);
        let result = p.account_pair(
            &owner,
            &approval,
            "synthetic-private-account-credential",
            candidate.as_ref(),
        );
        assert!(
            result.is_ok(),
            "imported adoption refusal: {:?}",
            result.as_ref().err()
        );
        assert!(
            p.account_souls(&store, "other")
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
        p.retire("owner", &imported_grant, 123).unwrap();
        p.existing_import(&store, &owner, &adopt).unwrap();
        assert_eq!(pairing(&p, &owner, &adopt), Err(("soul-retired", None)));
        assert!(
            p.account_souls(&store, "owner")
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );

        let (grant, first) = pairing(&p, &owner, &json!({"world":"garden","new":true})).unwrap();
        let retry = json!({"world":"garden","new":true,"idempotencyKey":id("retry_")});
        let delivered = pairing(&p, &owner, &retry).unwrap();
        assert_eq!(pairing(&p, &owner, &retry).unwrap(), delivered);
        assert!(
            std::fs::read_to_string(world.join("tokens"))
                .unwrap()
                .contains(&hash(&first))
        );
        assert_eq!(
            pairing(&p, &other, &json!({"world":"garden","soul":grant})),
            Err(("not-yours", None))
        );
        connected.store(true, Ordering::SeqCst);
        assert_eq!(
            pairing(&p, &owner, &json!({"world":"garden","soul":grant})),
            Err(("soul-connected", Some("new computer".into())))
        );
        let (_, moved) = pairing(
            &p,
            &owner,
            &json!({"world":"garden","soul":grant,"move":true}),
        )
        .unwrap();
        assert_ne!(first, moved);
        let published = std::fs::read_to_string(world.join("tokens")).unwrap();
        assert!(published.contains(&hash(&moved)) && !published.contains(&hash(&first)));
        connected.store(false, Ordering::SeqCst);
        // A stored token is not live presence: the ordinary (no --move) account adoption now succeeds.
        assert!(pairing(&p, &owner, &json!({"world":"garden","soul":grant})).is_ok());
        assert!(
            pairing(
                &p,
                &owner,
                &json!({"world":"other","soul":grant,"move":true})
            )
            .is_err()
        );
        stopping.store(true, Ordering::SeqCst);
        drop(UnixStream::connect(short).unwrap());
        worker.join().unwrap();
        std::fs::remove_file(&socket).unwrap();
        assert_eq!(
            pairing(
                &p,
                &owner,
                &json!({"world":"garden","soul":grant,"move":true})
            ),
            Err(("presence-unavailable", None))
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
