//! #5067: six Souls seat one rack beam in a rack bay, each at its own grip, by their own intents through a real
//! gateway on a served world (N2's yard world, [`yard_world`]). The beam's entry (`content/kinds/construction/
//! rack_beam.json`) has six grips: its two ends and four between, so a crew of six holds it with one carrier at each.
//!
//! Two Souls stand the bay's frames in its uprights' slots and hold them (B18: a frame stands held until beams join
//! it). Two carry the yard's easternmost beam out to open ground and lay it down; four, then three, take it, carry it
//! 3 m and lay it down again (crews of two, three and four still carry the beam). Then six take it and carry it to the
//! bay's mouth, 0.45 m west of `beam_high_l`'s line: the frames' columns stand on that line, so nobody can stand on
//! it within reach of an end grip. They put it in from there: on the set-in track the front and the back stand (each
//! 0.57 m from its hold when the beam is seated) and the four sides walk beside the beam, the two east of it into the
//! open bay, each keeping its place at its grip (#5067's walking set-in). Each word of who holds which grip
//! (`souls:carry-grips`) names six distinct grips, the same holds from the take through the set-in; seated, each
//! carrier stands within reach of its hold, the sides having walked as far as the beam went.

use super::*;
use sim::activity::carry::grips::{GRIPS, Holds};
use sim::activity::carry::{GRIP_REACH, Load};

/// Every word of who holds which grip for crew `crew`, in order.
fn holds_of(w: &Seeded, crew: Id) -> Vec<Holds> {
    logged(w)
        .iter()
        .flat_map(|p| p.effects.iter())
        .flat_map(|e| e.events.iter().flatten())
        .filter(|ev| ev.name.as_str() == GRIPS && ev.fields.get(&1) == Some(&crew.to_value()))
        .filter_map(|ev| Holds::read(&Value::Map(ev.fields.clone())))
        .collect()
}

/// Each Soul walks to its own place, all at once; each walk ends.
async fn walk_all(s: &Site<'_>, souls: &mut [&mut GwSoul], to: &[Vec3], what: &str) {
    for (a, p) in souls.iter_mut().zip(to) {
        a.send("eden:walk", s.g, to_point(*p)).await;
    }
    for (k, a) in souls.iter_mut().enumerate() {
        let got = a.end().await;
        assert_eq!(got.kind, 1, "{what}: carrier {k} walks: {got:?}");
    }
}

/// A crew of all `souls` on the ground: the first offers in front, the rest accept in turn.
async fn crew_all(s: &Site<'_>, souls: &mut [&mut GwSoul]) -> Id {
    let asked: Vec<Value> = souls[1..]
        .iter()
        .map(|a| body_of(s.w, a.soul).to_value())
        .collect();
    let got = souls[0]
        .act(
            "activity:offer",
            s.g,
            BTreeMap::from([
                (1, s.crew.clone()),
                (2, Value::Text(Name::new("mars:front").unwrap())),
                (3, Value::Array(asked)),
            ]),
        )
        .await;
    assert_eq!(got.kind, 1, "offered: {got:?}");
    let c = created_by(s.w, &got.entries, "mars:carry_activity@");
    for a in souls[1..].iter_mut() {
        let got = a.act("activity:accept", c, BTreeMap::new()).await;
        assert_eq!(got.kind, 1, "accepted: {got:?}");
    }
    c
}

/// Where a crew of `n` stands at a beam lying along z, its middle at `at`, its front north (+z): the front and the
/// back `end` from its middle, its sides at their places ([`Load::side_places`]), in join order.
fn places(at: Vec3, l: &Load, n: usize, end: i64) -> Vec<Vec3> {
    let mut p = vec![v3(at.x, 0, at.z + end), v3(at.x, 0, at.z - end)];
    for side in l.side_places().iter().take(n - 2) {
        let o = worldd::engine::on_plan(*side, [0, M]);
        p.push(v3(at.x + o[0], 0, at.z + o[1]));
    }
    p
}

fn on_ground(s: &Site<'_>, at: Vec3) -> BTreeMap<u64, Value> {
    BTreeMap::from([
        (1, s.g.to_value()),
        (3, Value::Array(vec![int(at.x), int(0), int(at.z)])),
    ])
}

/// A crew of all `souls` takes `beam` lying at `at`, carries it `by` east and lays it there; they go. Each grips word
/// names as many distinct grips as carriers.
async fn carry_by(
    s: &Site<'_>,
    souls: &mut [&mut GwSoul],
    l: &Load,
    beam: Id,
    at: Vec3,
    by: i64,
) -> Vec3 {
    let n = souls.len();
    let what = format!("a crew of {n}");
    walk_all(s, souls, &places(at, l, n, l.places()[1]), &what).await;
    let c = crew_all(s, souls).await;
    let got = souls[0].act("part:take", c, part_of(beam)).await;
    assert_eq!(got.kind, 1, "{what} takes the beam: {got:?}");
    let to = v3(at.x + by, 0, at.z);
    walk_all(s, souls, &places(to, l, n, l.places()[1]), &what).await;
    let got = put_part(&mut *souls[0], c, on_ground(s, to)).await;
    assert_eq!(got.kind, 1, "{what} lays it down: {got:?}");
    for h in holds_of(s.w, c) {
        let mut g: Vec<&str> = h.holds.iter().map(|x| x.grip.as_str()).collect();
        g.sort_unstable();
        g.dedup();
        assert_eq!(g.len(), n, "{what}: {} holds distinct grips", h.phase);
    }
    println!("{what} carried the beam {} m and laid it down", by / M);
    for a in souls.iter_mut() {
        leave_crew(a, c, &what).await;
    }
    where_is(s.w, beam).2
}

#[tokio::test(flavor = "multi_thread")]
async fn six_souls_seat_one_rack_beam_each_at_its_own_grip() {
    let d = scratch("sixbeam");
    let (facts, slots) = yard_world(&d);
    let w = seed_entries(&d, &facts, 8, (52, -30), Some(&d.join("entries")));
    let socket = d.join("s");
    let served = serve_with(&w, &socket, None);
    served.line("listening ", 120);
    let im = import_eden::load(&facts).unwrap();
    let n = |k: &str| im.nodes[k];
    let (bay, fa, fb, beam) = (
        n("site-bay"),
        n("yard-frame-1"),
        n("yard-frame-2"),
        n("yard-beam-4"),
    );
    let g = w.ground;
    let actors: Vec<Actor> = w.souls.iter().map(|s| Actor::Soul(*s)).collect();
    let (url, tokens) = gateway(&socket, &actors).await;
    let mut souls = Vec::new();
    for (k, t) in tokens.iter().enumerate() {
        souls.push(GwSoul::new(&url, t, &w, w.souls[k]).await);
    }
    let s = Site {
        w: &w,
        g,
        crew: pinned_activity(&w, "mars:carry_activity"),
    };
    let (ua, ub, hl) = (slots["upright_a"], slots["upright_b"], slots["beam_high_l"]);
    let (m_a, m_b, m_hl) = {
        let (copy, _) = served_copy(&w);
        let t = copy.tree();
        let p = sim::ground::scene::slot_points(t, t.handle(bay).unwrap(), t.handle(g).unwrap())
            .unwrap();
        let at = |k: u64| p.iter().find(|(n, _)| *n == k).unwrap().1;
        (at(ua), at(ub), at(hl))
    };
    let l = Load::of(
        &json::parse(&std::fs::read_to_string(d.join("entries/rack_beam.json")).unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(l.most(), 6, "six grips");
    let [s1, s2, s3, s4, s5, s6, s7, s8] = &mut souls[..] else {
        unreachable!()
    };

    // The frames: B into `upright_b`, then A into `upright_a`, each held by its east carrier (Souls 4 and 1), east of
    // the bay: clear of the bay's west mouth, where the beam's crew stands.
    let crew_b = carry_in(
        &s,
        s4,
        s3,
        fb,
        frame_ends,
        &[m_b],
        into_slot(bay, ub),
        "frame B",
    )
    .await;
    leave_crew(s3, crew_b, "Soul 3 lets go of frame B; Soul 4 holds it").await;
    let crew_a = carry_in(
        &s,
        s1,
        s2,
        fa,
        frame_ends,
        &[m_a],
        into_slot(bay, ua),
        "frame A",
    )
    .await;
    leave_crew(s2, crew_a, "Soul 2 lets go of frame A; Soul 1 holds it").await;

    // Crews of two, four and three carry the beam on open ground.
    let at = where_is(&w, beam).2;
    let at = carry_by(&s, &mut [&mut *s2, &mut *s3], &l, beam, at, 8 * M).await;
    let at = carry_by(
        &s,
        &mut [&mut *s2, &mut *s3, &mut *s5, &mut *s6],
        &l,
        beam,
        at,
        3 * M,
    )
    .await;
    let at = carry_by(&s, &mut [&mut *s2, &mut *s3, &mut *s5], &l, beam, at, 3 * M).await;

    // Six take it, carry it to 2.5 m west of the slot and step east to the bay's mouth: the front and the back in line
    // with the beam, [`BEAM_MOUTH`] west of the slot's line, the sides beside their grips either side of it.
    let six: &mut [&mut GwSoul] = &mut [&mut *s2, &mut *s3, &mut *s5, &mut *s6, &mut *s7, &mut *s8];
    walk_all(&s, six, &places(at, &l, 6, l.places()[1]), "six gather").await;
    let c = crew_all(&s, six).await;
    let got = six[0].act("part:take", c, part_of(beam)).await;
    println!("six take the beam: {got:?}");
    assert_eq!(got.kind, 1, "six take the beam");
    let end = l.places()[1];
    let slot = v3(m_hl.x, 0, m_hl.z);
    let west = v3(slot.x - 2_500_000, 0, slot.z);
    let mouth = v3(slot.x - BEAM_MOUTH, 0, slot.z);
    walk_all(
        &s,
        six,
        &places(west, &l, 6, end),
        "six carry it to the bay",
    )
    .await;
    walk_all(&s, six, &places(mouth, &l, 6, end), "six step to the mouth").await;
    let stood: Vec<Vec3> = six
        .iter()
        .map(|a| body_at(&w, body_of(&w, a.soul)))
        .collect();
    // Where each stands from the slot's line as the put is asked (across it, along it), mm.
    for (k, a) in six.iter().enumerate() {
        let b = body_at(&w, body_of(&w, a.soul));
        println!(
            "carrier {k}: {} mm across the slot's line, {} mm along it",
            (b.x - slot.x) / 1000,
            (b.z - slot.z) / 1000
        );
    }
    let got = put_part(&mut *six[0], c, into_slot(bay, hl)).await;
    println!("six seat the beam in beam_high_l: {got:?}");
    assert_eq!(got.kind, 1, "seated");
    assert_eq!(where_is(&w, beam).0, Some(bay), "the beam is in the bay");

    // Who holds which grip, from the take through the set-in: six carriers, six distinct grips, the same throughout.
    let words = holds_of(&w, c);
    let phases: Vec<&str> = words.iter().map(|h| h.phase.as_str()).collect();
    println!("phases: {phases:?}");
    assert!(words.len() >= 2, "said at the take and the set-in");
    for h in &words {
        let mut g: Vec<&str> = h.holds.iter().map(|x| x.grip.as_str()).collect();
        g.sort_unstable();
        g.dedup();
        assert_eq!(g.len(), 6, "{}: six distinct grips", h.phase);
    }
    assert!(
        words.windows(2).all(|p| p[0].holds == p[1].holds),
        "the same holds throughout"
    );
    // The sides walked beside the beam as far as it went on the plan (the set-in's own track, east); the ends stood.
    let seated = where_is(&w, beam).2;
    let went = [
        seated.x - (stood[0].x + stood[1].x) / 2,
        seated.z - (stood[0].z + stood[1].z) / 2,
    ];
    for (k, a) in six.iter().enumerate() {
        let b = body_at(&w, body_of(&w, a.soul));
        let (dx, dz) = (b.x - stood[k].x, b.z - stood[k].z);
        println!(
            "carrier {k} went {} mm east, {} mm south",
            dx / 1000,
            dz / 1000
        );
        let want = if k < 2 { [0, 0] } else { went };
        assert!(
            (dx - want[0]).abs() <= 30_000 && (dz - want[1]).abs() <= 30_000,
            "carrier {k} went ({dx}, {dz}) µm; the beam {went:?} µm"
        );
    }
    // Seated: each carrier within reach of its grip, on the plan.
    let (copy, _) = served_copy(&w);
    let t = copy.tree();
    let x = sim::ground::scene::xform_to(t, t.handle(beam).unwrap(), t.handle(g).unwrap()).unwrap();
    let last = words.last().unwrap();
    for h in &last.holds {
        let p = x.rot.rotate(h.at).unwrap();
        let grip = [x.pos.x + p.x, x.pos.z + p.z];
        let b = body_at(&w, h.body);
        let off =
            (((b.x - grip[0]) as f64).powi(2) + ((b.z - grip[1]) as f64).powi(2)).sqrt() as i64;
        println!("{}: {} mm from its grip", h.grip, off / 1000);
        assert!(off <= GRIP_REACH + l.half_width, "{} within reach", h.grip);
    }
    for a in six.iter_mut() {
        leave_crew(a, c, "the six let go").await;
    }
    drop(served);
}
