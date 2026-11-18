//! O1 A5 (#2730): the world's unit file holds no start limit and no processor quota, and its restart delays are the
//! ones the health record's next try is judged by.

use supervisor::{RESTART_MAX_MS, RESTART_SEC_MS, RESTART_STEPS};

const UNIT: &str = include_str!("../../../tools/ops/units/worldd@.service");

/// The unit's settings, `key=value` lines with comments left out.
fn settings() -> Vec<(&'static str, &'static str)> {
    UNIT.lines()
        .map(str::trim)
        .filter(|l| !l.starts_with('#') && !l.starts_with('['))
        .filter_map(|l| l.split_once('='))
        .collect()
}

fn get(key: &str) -> Vec<&'static str> {
    settings()
        .into_iter()
        .filter(|(k, _)| *k == key)
        .map(|(_, v)| v)
        .collect()
}

#[test]
fn a5_no_start_limit_and_no_processor_quota() {
    // A start limit: systemd's default is 5 starts in 10 s, then the unit is held stopped. 0 turns it off.
    assert_eq!(
        get("StartLimitIntervalSec"),
        ["0"],
        "the start limit is off"
    );
    for held in [
        "StartLimitBurst",
        "StartLimitAction",
        "StartLimitInterval",
        "StartLimitIntervalSec",
    ] {
        assert!(get(held).iter().all(|v| *v == "0"), "{held} holds a world");
    }
    // A processor quota throttles the clock, so world time slows: never.
    assert!(get("CPUQuota").is_empty(), "CPUQuota throttles world time");
    assert!(
        get("CPUQuotaPeriodSec").is_empty(),
        "CPUQuotaPeriodSec throttles world time"
    );
    // Retried for ever, every failure.
    assert_eq!(get("Restart"), ["always"]);
    assert_eq!(get("Type"), ["notify"]);
    assert_eq!(get("MemorySwapMax"), ["0"]);
    assert_eq!(get("MemoryMax").len(), 1);
    // A memory high mark below the limit holds a leaking world slow instead of ending it.
    assert_eq!(get("MemoryHigh"), ["infinity"]);
    assert_eq!(get("CPUWeight").len(), 1);
}

#[test]
fn a5_restart_delays_match_the_health_record() {
    assert_eq!(get("RestartSec"), [format!("{RESTART_SEC_MS}ms").as_str()]);
    assert_eq!(get("RestartSteps"), [RESTART_STEPS.to_string().as_str()]);
    assert_eq!(
        get("RestartMaxDelaySec"),
        [format!("{}s", RESTART_MAX_MS / 1000).as_str()]
    );
}
