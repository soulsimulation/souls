//! Page-facing samples: retain the seven positional columns and append exact frame-local Q30 orientation.

use crate::pose::HandOff;

pub(super) fn samples_json(samples: &[HandOff]) -> String {
    let key =
        |id: crate::ids::Id| format!("{}.{}", crate::encode::to_hex(&id.scope().0), id.counter());
    let rows: Vec<String> = samples
        .iter()
        .map(|h| {
            let p = h.pose.position;
            let [w, x, y, z] = h.pose.orientation.parts();
            format!(
                r#"["{}","{}",{},{},{},{},{},[{w},{x},{y},{z}]]"#,
                key(h.node),
                key(h.pose.frame.node),
                h.pose
                    .frame
                    .slot
                    .map_or("null".to_owned(), |s| s.to_string()),
                h.at,
                p.x,
                p.y,
                p.z,
            )
        })
        .collect();
    format!("[{}]", rows.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::{
        Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, FIXTURE_HEADER, Header, Part,
        Rest, State, fixture_bytes,
    };
    use crate::encode::{Value, decode, encode};
    use crate::ids::{Id, Scope};
    use crate::pose::{Frame, Owner, Pose, Quat, Support, Vec3};
    use crate::stream::{Player, StreamPart, public};
    use crate::world_model::Audience;
    use std::collections::BTreeMap;

    #[test]
    fn sample_json_preserves_orientation_and_positional_prefix_for_both_players() {
        let id = |n| Id::new(Scope([0xee; 16]), n).unwrap();
        let pose = |slot: Option<u64>, orientation: Quat| Pose {
            frame: Frame {
                node: if slot.is_some() { id(2) } else { id(1) },
                slot,
            },
            position: if slot.is_some() {
                Vec3::new(12_000, -34_000, 56_000)
            } else {
                Vec3::new(-1_234_567, 800_000, 987_654)
            },
            orientation,
            support: if slot.is_some() {
                Support::Slot
            } else {
                Support::Surface {
                    surface: id(1),
                    height: 0,
                }
            },
        };
        let samples: Vec<_> = [
            (
                2,
                4_000_000,
                pose(
                    None,
                    Quat::new(536_870_912, 536_870_912, 536_870_912, 536_870_912).unwrap(),
                ),
            ),
            (
                2,
                4_050_000,
                pose(None, Quat::new(0, 1 << 30, 0, 0).unwrap()),
            ),
            (
                4,
                4_100_000,
                pose(
                    Some(2),
                    Quat::new(536_870_912, -536_870_912, 536_870_912, -536_870_912).unwrap(),
                ),
            ),
        ]
        .into_iter()
        .map(|(node, at, pose)| {
            let owner = if pose.frame.slot.is_some() {
                Owner::Slot
            } else {
                Owner::Mover
            };
            HandOff {
                node: id(node),
                at,
                from: owner,
                to: owner,
                pose,
                linear: Vec3::ZERO,
                angular: Vec3::ZERO,
            }
        })
        .collect();
        assert_eq!(
            samples[0].pose.position, samples[1].pose.position,
            "stationary pivot"
        );
        assert_ne!(samples[0].pose.orientation, samples[1].pose.orientation);
        let scope = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        let expected = format!(
            concat!(
                "[[\"{s}.2\",\"{s}.1\",null,4000000,-1234567,800000,987654,[536870912,536870912,536870912,536870912]],",
                "[\"{s}.2\",\"{s}.1\",null,4050000,-1234567,800000,987654,[0,1073741824,0,0]],",
                "[\"{s}.4\",\"{s}.2\",2,4100000,12000,-34000,56000,[536870912,-536870912,536870912,-536870912]]]"
            ),
            s = scope
        );
        assert_eq!(samples_json(&[]), "[]");
        assert_eq!(samples_json(&samples), expected);

        // The same valid source effects feed the legacy and fully checked public players, then the WASM serializer.
        let header = Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap();
        let base = fixture_bytes(include_str!("../../fixtures/effects/0-base.diag")).unwrap();
        let part = Part::of_effects(
            header.hash().to_bytes(),
            samples
                .iter()
                .enumerate()
                .map(|(i, h)| Effect {
                    envelope: Envelope {
                        sequence: 2 + i as u64,
                        at: h.at,
                        cause: Cause::World,
                        actor: Actor::World,
                        audience: Audience::Everyone,
                        node: h.node,
                    },
                    body: Body::Changes(vec![ChangeRec {
                        change: Change::Motion(*h),
                        rest: Rest::new(),
                    }]),
                    events: None,
                    rest: Rest::new(),
                })
                .collect(),
        )
        .unwrap();
        let stream = |number, first, from, to, entries, part| {
            StreamPart {
                number,
                first,
                from,
                to,
                entries,
                part,
                hash: None,
                gaps: vec![],
                carried: vec![],
            }
            .to_bytes()
            .unwrap()
        };
        let start = stream(0, 0, 0, 0, 2, base.clone());
        let motion = stream(1, 2, 4_000_000, 4_100_000, 3, part.stored().to_vec());
        let mut legacy = Player::start(header.stored()).unwrap();
        legacy.play(&start).unwrap();
        legacy.play(&motion).unwrap();
        assert_eq!(legacy.samples(), samples);
        assert_eq!(samples_json(legacy.samples()), expected);

        let root_kind = header
            .kinds
            .iter()
            .find(|k| k.as_str().starts_with("souls:place@"))
            .unwrap();
        let mut state = State::start(header.zone, root_kind.clone());
        state.apply(&header, &Part::read(&base).unwrap()).unwrap();
        let baseline = public::baseline(&header, &state, 1).unwrap();
        let before = public::project(&header, &state).unwrap();
        state.apply(&header, &part).unwrap();
        let after = public::project(&header, &state).unwrap();
        let context = public::context(
            &baseline,
            &before,
            &after,
            2,
            &[],
            &[(id(2), 4), (id(4), 5)],
        )
        .unwrap();
        let public_motion = stream(0, 2, 4_000_000, 4_100_000, 3, part.stored().to_vec());
        let Value::Map(mut wire) = decode(&public_motion).unwrap().value else {
            unreachable!()
        };
        wire.insert(7, Value::Bytes(public::digest(&after).unwrap()));
        wire.insert(10, Value::Bytes(context));
        let public_motion = encode(&Value::Map(wire)).unwrap();
        let mut public = public::PublicPlayer::start(header.stored(), &baseline).unwrap();
        public.play(&public_motion).unwrap();
        assert_eq!(public.samples(), samples);
        assert_eq!(samples_json(public.samples()), expected);

        // Optional ignored fixture for loading this exact test's validated effects through the real WASM export.
        if let Some(dir) = std::env::var_os("SAMPLE_JSON_FIXTURE_DIR") {
            let dir = std::path::PathBuf::from(dir);
            std::fs::create_dir_all(&dir).unwrap();
            for (name, bytes) in BTreeMap::from([
                ("header", header.stored()),
                ("start", start.as_slice()),
                ("motion", motion.as_slice()),
                ("baseline", baseline.as_slice()),
                ("public-motion", public_motion.as_slice()),
                ("expected.json", expected.as_bytes()),
            ]) {
                std::fs::write(dir.join(name), bytes).unwrap();
            }
        }
    }
}
