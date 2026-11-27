//! Operator test Souls (O24): direct machine admission, normal W2 delivery and K10 retirement.
//! No provider account is made. The immutable registry survives profile edits and retirement.
use super::{Pairing, is_soul_grant, route::Answer};
use crate::accounts::{
    random,
    serve::{App, now},
};
use replica::encode::to_hex;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

pub(super) const OWNER: &str = "operator:test-souls";
pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS operator_test_souls_v1(
    grant_text TEXT PRIMARY KEY, world TEXT NOT NULL);";

impl Pairing {
    /// Approve only a pending, new Soul request for this exact world. The mark and approval commit together.
    pub fn operator_approve(
        &self,
        world: &str,
        code: &str,
        now: u64,
    ) -> Result<String, &'static str> {
        if !super::souls::is_world(world) {
            return Err("world");
        }
        let (code, ..) = self.guess(OWNER, code, now)?;
        let mut db = self.db.lock().expect("the store");
        let tx = db.transaction().map_err(|_| "store")?;
        let eligible: bool = tx
            .query_row(
                "SELECT 1 FROM pair_requests_v1 r JOIN pair_request_worlds_v1 w ON w.code = r.code
             WHERE r.code = ?1 AND r.state = 'pending' AND r.scope = 'soul' AND r.soul IS NULL
               AND r.force = 0 AND w.world = ?2
               AND NOT EXISTS(SELECT 1 FROM pair_request_formers_v1 f WHERE f.code = r.code)",
                params![code, world],
                |_| Ok(true),
            )
            .optional()
            .map_err(|_| "store")?
            .unwrap_or(false);
        if !eligible {
            return Err("operator.new-world-request-only");
        }
        // Exactly W2's new-Soul identifier; the existing poll alone mints and persists its token.
        let grant = format!("soul-{}-0", to_hex(&random::<16>()));
        tx.execute(
            "INSERT INTO paired_souls_v1(grant_text, account) VALUES (?1, ?2)",
            params![grant, OWNER],
        )
        .map_err(|_| "store")?;
        tx.execute(
            "INSERT INTO operator_test_souls_v1(grant_text, world) VALUES (?1, ?2)",
            params![grant, world],
        )
        .map_err(|_| "store")?;
        tx.execute(
            "INSERT INTO soul_profiles_v1(grant_text, world) VALUES (?1, ?2)",
            params![grant, world],
        )
        .map_err(|_| "store")?;
        let changed = tx
            .execute(
                "UPDATE pair_requests_v1 SET state = 'approved', account = ?2, grant_text = ?3
            WHERE code = ?1 AND state = 'pending'",
                params![code, OWNER, grant],
            )
            .map_err(|_| "store")?;
        if changed != 1 {
            return Err("unknown-code");
        }
        tx.commit().map_err(|_| "store")?;
        Ok(grant)
    }

    /// Retires every active test Soul of `world` by normal retirement, in one pass that writes the world's files
    /// once. How many were retired.
    pub fn operator_retire_all(&self, world: &str, now: u64) -> Result<usize, &'static str> {
        if !super::souls::is_world(world) {
            return Err("world");
        }
        let grants: Vec<String> = {
            let db = self.db.lock().expect("the store");
            let mut q = db
                .prepare(
                    "SELECT s.grant_text FROM paired_souls_v1 s
                       JOIN operator_test_souls_v1 t ON t.grant_text = s.grant_text
                       JOIN soul_profiles_v1 p ON p.grant_text = s.grant_text
                     WHERE s.account = ?1 AND p.world = ?2 AND p.retired_at IS NULL ORDER BY 1",
                )
                .map_err(|_| "store")?;
            let rows = q
                .query_map(params![OWNER, world], |r| r.get(0))
                .map_err(|_| "store")?;
            rows.collect::<Result<_, _>>().map_err(|_| "store")?
        };
        self.retire_many(OWNER, &grants, now)?;
        Ok(grants.len())
    }

    /// Only this registry is consulted: ordinary and unknown identities have the same answer.
    pub fn is_operator_test(&self, grant: &str) -> Result<bool, &'static str> {
        if !is_soul_grant(grant) {
            return Ok(false);
        }
        self.db
            .lock()
            .expect("the store")
            .query_row(
                "SELECT 1 FROM operator_test_souls_v1 WHERE grant_text = ?1",
                params![grant],
                |_| Ok(true),
            )
            .optional()
            .map(|v| v.unwrap_or(false))
            .map_err(|_| "store")
    }
}

fn answer(status: u16, body: Value, note: &str) -> Answer {
    (status, "application/json", body.to_string(), note.into())
}
fn refuse(status: u16, reason: &str) -> Answer {
    answer(status, json!({"refused": reason}), reason)
}

/// Called with private transport evidence from the listener, never a claimed header or provider session.
pub fn route(app: &App, method: &str, path: &str, body: &[u8], direct: bool) -> Option<Answer> {
    let public = path == "/v1/pair/test-status";
    if !public && !path.starts_with("/v1/pair/operator/") {
        return None;
    }
    if !public && !direct {
        return Some(refuse(403, "operator.direct-only"));
    }
    if method != "POST" {
        return Some(refuse(405, "method"));
    }
    let Some(p) = &app.pairing else {
        return Some(refuse(404, "pairing-off"));
    };
    let Ok(b) = serde_json::from_slice::<Value>(body) else {
        return Some(refuse(400, "request"));
    };
    let text = |key| b.get(key).and_then(Value::as_str);
    if public {
        return Some(match p.is_operator_test(text("soul").unwrap_or("")) {
            Ok(test) => answer(200, json!({"test": test}), "test-status"),
            Err(e) => refuse(500, e),
        });
    }
    Some(match path {
        "/v1/pair/operator/approve" => match (text("world"), text("code")) {
            (Some(world), Some(code)) => match p.operator_approve(world, code, now()) {
                Ok(soul) => answer(
                    200,
                    json!({"ok": true, "soul": soul, "world": world, "test": true}),
                    "operator-approved",
                ),
                Err(e) => refuse(400, e),
            },
            _ => refuse(400, "request"),
        },
        "/v1/pair/operator/list" => match p.mine(OWNER) {
            Ok(souls) => answer(
                200,
                json!({"souls": souls.iter().map(|s| json!({"soul": s.soul, "world": s.world, "test": true})).collect::<Vec<_>>()}),
                "operator-list",
            ),
            Err(e) => refuse(500, e),
        },
        "/v1/pair/operator/retire" => match text("soul") {
            Some(soul) => match p.is_operator_test(soul).and_then(|test| {
                if test {
                    p.retire(OWNER, soul, now())
                } else {
                    Err("operator.not-test")
                }
            }) {
                Ok(()) => answer(
                    200,
                    json!({"ok": true, "soul": soul, "test": true}),
                    "operator-retired",
                ),
                Err(e) => refuse(400, e),
            },
            None => refuse(400, "request"),
        },
        "/v1/pair/operator/retire-all" => match text("world") {
            Some(world) => match p.operator_retire_all(world, now()) {
                Ok(retired) => answer(
                    200,
                    json!({"ok": true, "world": world, "retired": retired, "test": true}),
                    "operator-retired-all",
                ),
                Err(e) => refuse(400, e),
            },
            None => refuse(400, "request"),
        },
        _ => refuse(404, "not-found"),
    })
}
