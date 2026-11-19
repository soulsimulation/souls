//! `o18-probe <out file> <lineage, 32 hex>`: writes the probe `deploy` sends (Engine v2 O18, #2811) for a scratch
//! world served by `worldd gateway-link --lineage <lineage> --epoch 1 --bodies 1`: its one body switches its toggle
//! on. Prints the world's name. The scratch machine (`scratch.sh`) uses it; a real world's probe is its owner's.

use std::collections::BTreeMap;

use replica::effects::Actor;
use replica::encode::{Name, encode, from_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Fallback, Intent, Target};
use supervisor::World;
use supervisor::deploy::now_us;
use worldd::checkers::toggles;

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("o18-probe: {msg}");
    std::process::exit(2)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (Some(out), Some(hex)) = (a.get(1), a.get(2)) else {
        fail("usage: o18-probe <out file> <lineage, 32 hex>")
    };
    let lineage: [u8; 16] = from_hex(hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .unwrap_or_else(|| fail("the lineage is 32 hex"));
    let zone = Id::new(Scope(lineage), 0).unwrap_or_else(|| fail("a zone"));
    let (body, thing) = toggles::World::build(1, 1, 0).pairs[0];
    let n = |s: &str| Name::new(s).unwrap_or_else(|| fail("a name"));
    let intent = Intent {
        actor: Actor::Soul(body),
        verb: n("r2:switch_on"),
        target: Some(Target::Node(thing)),
        parameters: BTreeMap::new(),
        sequence: 0,
        basis: Version {
            lineage: Scope(lineage),
            zone,
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: now_us() + 5_000_000,
        resources: Vec::new(),
        fallbacks: vec![Fallback {
            verb: n("r2:switch_off"),
            target: Some(Target::Node(thing)),
            parameters: BTreeMap::new(),
            resources: Vec::new(),
        }],
        replaces: None,
        body: None,
    };
    let bytes = encode(&intent.to_value()).unwrap_or_else(|e| fail(format!("{e:?}")));
    std::fs::write(out, bytes).unwrap_or_else(|e| fail(e));
    println!("{}", World { lineage, zone }.name());
}
